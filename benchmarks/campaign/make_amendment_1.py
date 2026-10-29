#!/usr/bin/env python3
"""Generate protocol/main-v1-amendment-1.json (ADR 0011 rule 10).

Defect: the task runner copied the workspace with Node's cpSync default,
which rewrites relative symlinks to absolute paths into the source checkout;
the sandboxed tools' escaping-symlink guard then removed them, and every
captured patch carried spurious symlink deletions, so the official evaluator
could not apply it.

The invalidated cells are chosen by a deterministic property of the
instance, never by results: an already-run main-campaign instance is
invalidated, for every model, iff its base_commit tree contains a symlink
(git mode 120000). Stage-2 instances had not been run.

    python3 benchmarks/campaign/make_amendment_1.py protocol/main-v1-amendment-1.json
"""
import hashlib
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]


def sh(cmd, **kw):
    return subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, check=True, **kw).stdout.strip()


def has_symlink(iid):
    snap = ROOT / ".cache/swebench/snapshots" / iid
    return any(l.startswith("120000") for l in sh(["git", "-C", str(snap), "ls-files", "-s"]).splitlines())


def main(out):
    proto_raw = (ROOT / "protocol/main-v1.json").read_bytes()
    proto = json.loads(proto_raw)
    stage1 = proto["swebench"]["stage1"]
    affected = sorted(i for i in stage1 if has_symlink(i))
    am = {
        "id": "main-v1-amendment-1",
        "amends": {"file": "protocol/main-v1.json", "sha256": hashlib.sha256(proto_raw).hexdigest()},
        "date": "2026-10-30",
        "adr": "docs/adr/0011-main-protocol-freeze.md (Amendment 1)",
        "defect": "harness/src/task/runner.mjs copied the workspace with cpSync({recursive:true}); Node rewrites relative symlinks to absolute paths into the source snapshot, i.e. outside the workspace. The escaping-symlink guard (harness/src/agent/sandboxed-tools.mjs removeEscapingSymlinks, correct security behaviour), which runs on Docker tasks when the agent's tool registry is built (harness/src/agent/adapters/upstage.mjs) and after every sandbox command, then removed them before the agent's first turn, so every captured patch for a repository with symlinks contained spurious symlink deletions whose pre-image does not exist upstream, and swebench.harness.run_evaluation failed with 'Patch Apply Failed'. The offline validation (replay agent, no tool registry) did not exercise the guard.",
        "evidence": "Stage 1: for each of the four models the set of instances classified 'error' by the official evaluator equals exactly the set of stage-1 instances whose base_commit tree contains a symlink (26 of 50: django 23, matplotlib 3). Reproduced on the real django__django-11119 snapshot: old copy + guard removes the same 4 links that appear in the failing patches; fixed copy + guard removes none. Regression test h29 (fails without the fix).",
        "fix": "cpSync(..., {recursive: true, verbatimSymlinks: true}) for the workspace copy and the evaluation-file restore; nothing else changes (model settings, envelope, prompt, subset, scoring unchanged).",
        "scope": {
            "affectsAllModelsAlike": True,
            "bfcl": "not affected (BFCL does not use the harness task runner); BFCL results stand",
            "swebenchUnaffected": "stage-1 instances without symlinks: the workspace copy is identical with or without the fix, so their attempts stand",
        },
        "invalidated": {"criterion": "stage-1 instance whose base_commit tree contains a git mode 120000 entry",
                        "models": proto["models"]["primary"], "swebench": affected},
        "rerun": "Every invalidated (model, instance) cell is re-run once under the amended code with the frozen envelope; previous attempts and evaluation logs are kept under attempts-invalidated/ and eval-invalidated/. Stage 2 (if run) uses the amended code.",
        "code": {"generatedAtCommit": sh(["git", "rev-parse", "HEAD"]), "upstageCli": sh(["git", "rev-parse", "HEAD:vendor/upstage-cli"]),
                 "trees": {p: sh(["git", "rev-parse", f"HEAD:{p}"]) for p in proto["code"]["trees"]}},
    }
    pathlib.Path(out).write_text(json.dumps(am, indent=1) + "\n")
    print(f"wrote {out}: {len(affected)} invalidated instances x {len(am['invalidated']['models'])} models; sha256 {hashlib.sha256(pathlib.Path(out).read_bytes()).hexdigest()}")


if __name__ == "__main__":
    main(sys.argv[1])
