#!/usr/bin/env python3
"""Offline validation of the SWE-bench Verified pipeline. No model, no GPU.

    .cache/venv-swebench/bin/python benchmarks/swebench/validate_offline.py \
        [--instance psf__requests-6028] [--out DIR] [--allow-pull]

For one official instance, four predictions go to the OFFICIAL evaluator:
  gold        upstream gold patch replayed THROUGH the harness agent pipeline
              (checkout at base_commit, official image sandbox, patch capture,
              `harness swebench predictions`)              expect: resolved
  empty       no change, through the same pipeline          expect: empty_patch
  wrong       a valid diff that does not fix the issue, same pipeline
                                                            expect: unresolved
  unparseable a malformed diff written directly as a prediction
                                                            expect: recorded as returned
The last case has no fixed expectation: it documents what the official
evaluator does with a malformed patch. These are pipeline checks, NOT scores.
"""
import argparse
import json
import pathlib
import re
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
NODE_CLI = ROOT / "harness/bin/harness.mjs"
PY = sys.executable
EXPECT = {"gold": "resolved", "empty": "empty_patch", "wrong": "unresolved", "unparseable": None}


def sh(cmd, log):
    p = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
    log.write_text(p.stdout + p.stderr)
    if p.returncode != 0:
        sys.exit(f"command failed ({p.returncode}): {' '.join(map(str, cmd))}; see {log}")
    return p.stdout


def wrong_patch(instance):
    # Valid unified diff against a file the gold patch touches: adds a comment
    # line at the top. Applies cleanly, changes nothing the tests check.
    from unidiff import PatchSet
    target = PatchSet(instance["patch"])[0].path
    src = subprocess.run(["git", "show", f"{instance['base_commit']}:{target}"], cwd=ROOT / ".cache/swebench/repos" / instance["repo"].replace("/", "__"),
                         capture_output=True, text=True, check=True).stdout.splitlines()
    first = src[0] if src else ""
    return (f"diff --git a/{target} b/{target}\n--- a/{target}\n+++ b/{target}\n"
            f"@@ -1 +1,2 @@\n+# kab offline validation: intentionally ineffective change\n {first}\n")


def canonical_diff(instance, patch, scratch):
    cache = ROOT / ".cache/swebench/repos" / instance["repo"].replace("/", "__")
    subprocess.run(["git", "clone", "-q", "--shared", "--no-checkout", str(cache), str(scratch)], check=True)
    g = lambda *a, **k: subprocess.run(["git", "-C", str(scratch), *a], check=True, capture_output=True, text=True, **k)
    g("checkout", "-q", instance["base_commit"])
    if patch:
        g("apply", "--whitespace=nowarn", "-", input=patch)
    g("add", "-A")
    diff = g("diff", "--cached", instance["base_commit"]).stdout
    shutil.rmtree(scratch)
    return diff


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--instance", default="psf__requests-6028")
    ap.add_argument("--out", default=str(ROOT / ".cache/swebench-offline-validation"))
    ap.add_argument("--allow-pull", action="store_true")
    a = ap.parse_args()
    out = pathlib.Path(a.out).resolve()
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    rows = {json.loads(l)["instance_id"]: json.loads(l) for l in (ROOT / ".cache/swebench").glob("*/instances.jsonl").__next__().read_text().splitlines() if l.strip()}
    inst = rows[a.instance]

    sh(["node", NODE_CLI, "swebench", "prepare", "--instance", a.instance], out / "prepare.log")
    patches = {"gold": inst["patch"], "empty": ""}
    results = {}
    for name in ["gold", "empty", "wrong"]:
        d = out / name
        d.mkdir()
        if name == "wrong":  # repo clone exists after the first run
            patches["wrong"] = wrong_patch(inst)
        (d / "replay.diff").write_text(patches[name])
        sh(["node", NODE_CLI, "swebench", "run", "--instance", a.instance, "--replay-patch", d / "replay.diff", "--runs-dir", d / "runs"], d / "agent-run.log")
        run_file = next((d / "runs").glob("run_*.json"))
        sh(["node", NODE_CLI, "swebench", "predictions", "--model-name", f"kab-offline-{name}", "--out", d / "predictions.jsonl", run_file], d / "predictions.log")
    d = out / "unparseable"
    d.mkdir()
    (d / "predictions.jsonl").write_text(json.dumps({"instance_id": a.instance, "model_name_or_path": "kab-offline-unparseable",
                                                     "model_patch": "this is not a diff\n@@ nonsense @@\n"}) + "\n")

    failures = []
    for name, expect in EXPECT.items():
        d = out / name
        cmd = [PY, ROOT / "benchmarks/swebench/evaluate.py", "--predictions", d / "predictions.jsonl", "--run-id", f"kab-offline-{name}", "--out", d / "eval"]
        if a.allow_pull:
            cmd.append("--allow-pull")
        sh(cmd, d / "evaluate.log")
        o = json.loads((d / "eval/outcomes.json").read_text())["outcomes"][a.instance]
        results[name] = {"official": o["official"], "expected": expect, "validationFindings": o["validationFindings"],
                         "imageRepoDigests": o["imageRepoDigests"]}
        if name in ("gold", "empty", "wrong"):
            run = json.loads(next((d / "runs").glob("run_*.json")).read_text())
            results[name]["agentRun"] = {"status": run["status"], "reason": run["outcome"]["reason"], "filesChanged": run["patch"]["filesChanged"],
                                         "promptTemplate": run["provenance"]["task"].get("dataset"), "sandboxImage": run["sandbox"].get("image")}
            pred = json.loads((d / "predictions.jsonl").read_text())
            # The captured patch must equal git's own diff of the replayed change
            # applied at base_commit (git canonicalizes hunk context), byte for byte.
            # git abbreviates blob ids in "index a..b" lines to a length that grows
            # with the repository's object count (snapshot vs full clone), so
            # only that line is compared as full-length-agnostic.
            norm = lambda t: re.sub(r"(?m)^index [0-9a-f]+\.\.[0-9a-f]+", "index <blobs>", t)
            if norm(pred["model_patch"]) != norm(canonical_diff(inst, patches[name], out / f"canon-{name}")):
                failures.append(f"{name}: captured patch differs from git's diff of the replayed change")
        if expect and o["official"] != expect:
            failures.append(f"{name}: official outcome {o['official']} != expected {expect}")

    summary = {"kind": "swebench-offline-validation", "note": "Pipeline validation with replayed patches; NOT model scores.",
               "instance": a.instance, "results": results, "passed": not failures, "failures": failures}
    (out / "summary.json").write_text(json.dumps(summary, indent=1) + "\n")
    print(json.dumps({k: (v["official"], v["expected"]) for k, v in results.items()}, indent=1))
    if failures:
        print("FAIL:\n  " + "\n  ".join(failures))
        sys.exit(1)
    print(f"swebench offline validation: PASS ({out})")


if __name__ == "__main__":
    main()
