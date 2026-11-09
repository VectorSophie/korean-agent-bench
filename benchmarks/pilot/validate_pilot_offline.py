#!/usr/bin/env python3
"""Offline validation of the Harness v2 pilot driver (ADR 0012): the real
`harness pilot run --validation` and `harness pilot evaluate` on the two
development instances whose images are local, real KAB Docker sandboxes and
the OFFICIAL SWE-bench evaluator. Only the model is fake. No GPU, no pulls.

    .cache/venv-swebench/bin/python benchmarks/pilot/validate_pilot_offline.py [--out DIR]

Scripted model (one server, each harness in its own protocol):
  arm A   (upstage-cli)     answers without a tool call     expect: empty_patch
  arm B   (mini-swe-agent)  applies the upstream gold patch expect: the gold reference
  arm B30 (mini-swe-agent)  same                            expect: the gold reference
The gold reference is the official evaluator's verdict on the bare gold
patches in this environment (an instance whose tests need the network can be
unresolved even with the gold patch). These are pipeline checks, NOT results.
Outputs stay under .cache/.
"""
import argparse
import json
import os
import pathlib
import shutil
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = pathlib.Path(__file__).resolve().parents[2]
NODE_CLI = ROOT / "harness/bin/harness.mjs"
SPEC = ROOT / "benchmarks/pilot/harness-pilot-validation.json"
SUBMIT = "COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT"
GOLD: dict[str, str] = {}


def mini_step(body: dict) -> str:
    user = next(m["content"] for m in body["messages"] if m["role"] == "user")
    iid = next(i for i, g in GOLD.items() if g["problem"] in user)
    step = sum(1 for m in body["messages"] if m["role"] == "assistant")
    script = [f"git apply --whitespace=nowarn <<'KAB_PATCH_EOF'\n{GOLD[iid]['patch']}KAB_PATCH_EOF",
              "git diff > patch.txt", f"echo {SUBMIT} && cat patch.txt"]
    return script[min(step, len(script) - 1)]


class FakeModel(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers["content-length"])) or b"{}")
        if self.path.endswith("/tokenize"):
            out = {"count": len(json.dumps(body)) // 4}
        else:
            usage = {"prompt_tokens": 100, "completion_tokens": 5, "total_tokens": 105}
            if [t["function"]["name"] for t in body.get("tools", [])] == ["bash"]:
                msg = {"role": "assistant", "content": "THOUGHT: scripted", "tool_calls": [
                    {"id": "c", "type": "function", "function": {"name": "bash", "arguments": json.dumps({"command": mini_step(body)})}}]}
                finish = "tool_calls"
            else:
                msg, finish = {"role": "assistant", "content": "No change (scripted validation)."}, "stop"
            out = {"id": "fake", "object": "chat.completion", "created": 0, "model": "fake", "usage": usage,
                   "choices": [{"index": 0, "finish_reason": finish, "message": msg}]}
        b = json.dumps(out).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def log_message(self, *_):
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / ".cache/pilot-validation"))
    a = ap.parse_args()
    out = pathlib.Path(a.out).resolve()
    if out.exists():
        shutil.rmtree(out)
    spec = json.loads(SPEC.read_text())
    rows = {json.loads(l)["instance_id"]: json.loads(l) for l in next((ROOT / ".cache/swebench").glob("*/instances.jsonl")).read_text().splitlines() if l.strip()}
    for iid in spec["instances"]:
        GOLD[iid] = {"problem": rows[iid]["problem_statement"], "patch": rows[iid]["patch"]}

    srv = ThreadingHTTPServer(("127.0.0.1", 0), FakeModel)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    env = {**os.environ, "EXAONE_BASE_URL": f"http://127.0.0.1:{srv.server_address[1]}/v1"}
    for cmd in (["run", "--spec", str(SPEC), "--out", str(out), "--validation"], ["evaluate", "--out", str(out)]):
        p = subprocess.run(["node", str(NODE_CLI), "pilot", *cmd], cwd=ROOT, env=env, capture_output=True, text=True)
        (out.parent / f"{out.name}-{cmd[0]}.log").write_text(p.stdout + p.stderr)
        if p.returncode != 0:
            sys.exit(f"pilot {cmd[0]} failed ({p.returncode}); see {out.parent / f'{out.name}-{cmd[0]}.log'}")
    srv.shutdown()

    # the official evaluator on the bare gold patches: what the mini arms must reproduce
    gold_preds = out.parent / f"{out.name}-gold.jsonl"
    gold_preds.write_text("".join(json.dumps({"instance_id": i, "model_name_or_path": "kab-gold-reference", "model_patch": g["patch"]}) + "\n" for i, g in GOLD.items()))
    gold_out = out.parent / f"{out.name}-gold-eval"
    shutil.rmtree(gold_out, ignore_errors=True)
    subprocess.run([sys.executable, str(ROOT / "benchmarks/swebench/evaluate.py"), "--predictions", str(gold_preds), "--run-id", "kab-pilot-gold-reference",
                    "--out", str(gold_out)], cwd=ROOT, check=True, capture_output=True)
    gold = {i: o["official"] for i, o in json.loads((gold_out / "outcomes.json").read_text())["outcomes"].items()}
    expect = lambda arm, inst: "empty_patch" if arm == "A" else gold[inst]

    results = json.loads((out / "results.json").read_text())
    manifest = json.loads((out / "manifest.json").read_text())
    failures = []
    for r in results["rows"]:
        if r["state"] != "done":
            failures.append(f"{r['id']}: state {r['state']}")
        elif r["official"] != expect(r["arm"], r["instance"]):
            failures.append(f"{r['id']}: official {r['official']} != {expect(r['arm'], r['instance'])}")
        acc = r["accounting"] or {}
        if acc.get("logicalCalls") is None or acc.get("transportAttempts") != acc.get("logicalCalls"):
            failures.append(f"{r['id']}: call accounting {acc.get('logicalCalls')} / {acc.get('transportAttempts')}")
    if results["scheduled"] != len(manifest["schedule"]) or results["executed"] != results["scheduled"]:
        failures.append(f"denominator: scheduled {results['scheduled']}, executed {results['executed']}")
    check = subprocess.run(["sha256sum", "-c", "--quiet", "SHA256SUMS"], cwd=out, capture_output=True, text=True)
    if check.returncode != 0:
        failures.append(f"SHA256SUMS: {check.stdout}{check.stderr}")
    summary = {"kind": "harness-pilot-offline-validation", "note": "Scripted fake model; NOT pilot results.",
               "specSha256": manifest["specSha256"], "arms": {k: v for k, v in manifest["arms"].items()},
               "goldReference": gold, "outcomes": {r["id"]: r["official"] for r in results["rows"]}, "passed": not failures, "failures": failures}
    (out.parent / f"{out.name}-summary.json").write_text(json.dumps(summary, indent=1) + "\n")
    print(json.dumps({"goldReference": gold, "outcomes": summary["outcomes"]}, indent=1))
    if failures:
        print("FAIL:\n  " + "\n  ".join(failures))
        sys.exit(1)
    print(f"pilot offline validation: PASS ({out})")


if __name__ == "__main__":
    main()
