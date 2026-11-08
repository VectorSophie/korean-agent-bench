#!/usr/bin/env python3
"""Offline validation of mini-swe-agent (Harness v2) into the OFFICIAL SWE-bench
evaluator. No model, no GPU, no image pulls (unless --allow-pull).

    .cache/venv-swebench/bin/python benchmarks/swebench/validate_mini_offline.py \
        [--instance psf__requests-6028] [--out DIR] [--allow-pull]

REAL: `harness swebench run --agent mini-swe-agent` (kab.task/v2, mini-swe-agent
2.4.6 loop and config through the KAB bridge, the official instance image in
KAB's Docker sandbox), `harness swebench predictions`, the official evaluator.
FAKE: only the model. A scripted OpenAI-compatible server on 127.0.0.1 replays
bash commands as tool calls, following upstream's own submit instructions
(`git diff > patch.txt`, then `echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT &&
cat patch.txt`):
  gold   applies the upstream gold patch, submits it      expect: resolved
  empty  submits nothing                                    expect: empty_patch
  wrong  applies a valid but ineffective diff, submits it   expect: unresolved
These are pipeline checks, NOT scores. Outputs stay under .cache/ (SWE-bench
content is never committed).
"""
import argparse
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from validate_offline import NODE_CLI, PY, ROOT, canonical_diff, sh, wrong_patch  # noqa: E402

SUBMIT = "COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT"
EXPECT = {"gold": "resolved", "empty": "empty_patch", "wrong": "unresolved"}
SCRIPT: list[str] = []
REQUESTS: list[dict] = []


class FakeModel(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        REQUESTS.append(json.loads(self.rfile.read(int(self.headers["content-length"]))))
        cmd = SCRIPT.pop(0) if SCRIPT else f"echo {SUBMIT}"
        body = json.dumps({"id": "fake", "object": "chat.completion", "created": 0, "model": "fake",
                           "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
                           "choices": [{"index": 0, "finish_reason": "tool_calls", "message": {
                               "role": "assistant", "content": "THOUGHT: scripted (offline validation)",
                               "tool_calls": [{"id": f"c{len(REQUESTS)}", "type": "function",
                                               "function": {"name": "bash", "arguments": json.dumps({"command": cmd})}}]}}]}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


def script_for(patch):
    if not patch:
        return [f"echo {SUBMIT}"]
    return [f"git apply --whitespace=nowarn <<'KAB_PATCH_EOF'\n{patch}KAB_PATCH_EOF",
            "git diff > patch.txt",
            f"echo {SUBMIT} && cat patch.txt"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--instance", default="psf__requests-6028")
    ap.add_argument("--out", default=str(ROOT / ".cache/swebench-mini-offline-validation"))
    ap.add_argument("--allow-pull", action="store_true")
    a = ap.parse_args()
    out = pathlib.Path(a.out).resolve()
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    rows = {json.loads(l)["instance_id"]: json.loads(l) for l in next((ROOT / ".cache/swebench").glob("*/instances.jsonl")).read_text().splitlines() if l.strip()}
    inst = rows[a.instance]

    srv = ThreadingHTTPServer(("127.0.0.1", 0), FakeModel)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    env = {**os.environ, "KANANA_BASE_URL": f"http://127.0.0.1:{srv.server_address[1]}/v1"}

    sh(["node", NODE_CLI, "swebench", "prepare", "--instance", a.instance], out / "prepare.log")
    patches = {"gold": inst["patch"], "empty": ""}
    failures, results = [], {}
    for name, expect in EXPECT.items():
        d = out / name
        d.mkdir()
        if name == "wrong":
            patches["wrong"] = wrong_patch(inst)
        SCRIPT[:] = script_for(patches[name])
        n_script = len(SCRIPT)
        REQUESTS.clear()
        p = subprocess.run(["node", NODE_CLI, "swebench", "run", "--instance", a.instance, "--agent", "mini-swe-agent", "--model", "kanana",
                            "--runs-dir", d / "runs"], cwd=ROOT, env=env, capture_output=True, text=True)
        (d / "agent-run.log").write_text(p.stdout + p.stderr)
        if p.returncode != 0:
            sys.exit(f"{name}: harness swebench run failed ({p.returncode}); see {d / 'agent-run.log'}")
        run = json.loads(next((d / "runs").glob("run_*.json")).read_text())
        sh(["node", NODE_CLI, "swebench", "predictions", "--model-name", f"kab-mini-offline-{name}", "--out", d / "predictions.jsonl",
            next((d / "runs").glob("run_*.json"))], d / "predictions.log")
        pred = json.loads((d / "predictions.jsonl").read_text())
        cmd = [PY, ROOT / "benchmarks/swebench/evaluate.py", "--predictions", d / "predictions.jsonl", "--run-id", f"kab-mini-offline-{name}", "--out", d / "eval"]
        if a.allow_pull:
            cmd.append("--allow-pull")
        sh(cmd, d / "evaluate.log")
        o = json.loads((d / "eval/outcomes.json").read_text())["outcomes"][a.instance]

        h, m = run["provenance"]["agentHarness"], run["provenance"]["model"]
        checks = {
            "official_outcome": o["official"] == expect,
            "task_schema_v2": run["provenance"]["task"].get("schema") == "kab.task/v2",
            "stop_reason_done": run["trace"]["stopReason"] == "done",
            "prediction_source_agent_submission": run["patch"]["prediction_source"] == "agent_submission",
            "prediction_is_submission": pred["model_patch"] == (run["patch"]["agent_submission"] or ""),
            "harness_pinned_mini": h["pinned"] and h["implementation"]["name"] == "mini-swe-agent" and bool(h.get("harnessId")) and bool(h.get("budgetId")),
            # the declared checkpoint, the fake endpoint, and the sampling actually sent
            "model_identity": m.get("hfRepo") == "kakaocorp/kanana-2-30b-a3b-thinking-2601" and m.get("revision", "").startswith("cdcbf8b8")
                              and m.get("baseUrl") == env["KANANA_BASE_URL"] and REQUESTS[0].get("temperature") == m["sampling"]["temperature"],
            "install_verified": h["implementation"].get("installVerifiedFiles", 0) > 0,
            "every_action_through_sandbox": len(run["trace"]["toolCalls"]) == n_script and run["sandbox"]["type"] == "docker",
            "model_called_once_per_step": len(REQUESTS) == n_script,
            "trajectory_kept": bool(run["trace"].get("agentTrajectory")),
        }
        if name != "empty":
            norm = lambda t: re.sub(r"(?m)^index [0-9a-f]+\.\.[0-9a-f]+", "index <blobs>", t)
            checks["submission_equals_canonical_diff"] = norm(pred["model_patch"]) == norm(canonical_diff(inst, patches[name], out / f"canon-{name}"))
        failures += [f"{name}: {k}" for k, ok in checks.items() if not ok]
        results[name] = {"official": o["official"], "expected": expect, "checks": checks,
                         "imageRepoDigests": o["imageRepoDigests"], "validationFindings": o["validationFindings"],
                         "harnessId": h.get("harnessId"), "budgetId": h.get("budgetId"), "revision": h["implementation"].get("revision"),
                         "stopReason": run["trace"]["stopReason"], "toolCalls": len(run["trace"]["toolCalls"]), "modelRequests": len(REQUESTS)}
    srv.shutdown()
    if len({(r["harnessId"], r["budgetId"]) for r in results.values()}) != 1:
        failures.append("harnessId/budgetId differ between cases with the same harness and budget")

    summary = {"kind": "swebench-mini-offline-validation", "note": "Pipeline validation with a scripted fake model; NOT model scores.",
               "instance": a.instance, "results": results, "passed": not failures, "failures": failures}
    (out / "summary.json").write_text(json.dumps(summary, indent=1) + "\n")
    print(json.dumps({k: (v["official"], v["expected"]) for k, v in results.items()}, indent=1))
    if failures:
        print("FAIL:\n  " + "\n  ".join(failures))
        sys.exit(1)
    print(f"swebench mini offline validation: PASS ({out})")


if __name__ == "__main__":
    main()
