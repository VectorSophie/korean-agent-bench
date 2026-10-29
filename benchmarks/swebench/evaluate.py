#!/usr/bin/env python3
"""Score SWE-bench Verified predictions with the OFFICIAL evaluator.

    .cache/venv-swebench/bin/python benchmarks/swebench/evaluate.py \
        --predictions preds.jsonl --run-id NAME --out DIR [--max-workers 1] [--allow-pull]

1. Validates the predictions file (schema; ids in the pinned dataset; one row
   per instance; patch parses as a unified diff). Findings are RECORDED next
   to the official outcome; they never change it.
2. Runs swebench.harness.run_evaluation on the sha256-verified local parquet
   (never a floating Hugging Face revision), so environments, test commands
   and log parsing are upstream's.
3. Copies the official report verbatim and writes outcomes.json: each
   instance's official category (resolved, unresolved, empty_patch, error,
   infra_failure, ambiguous_failure, incomplete) plus provenance (swebench
   version, dataset sha256, the digest each instance image resolved to).
Without --allow-pull it refuses to run when an instance image is not already
present locally (each is ~1 GB compressed).
"""
import argparse
import hashlib
import importlib.metadata as md
import json
import pathlib
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
SOURCE = json.loads((ROOT / "datasets/swe-bench-verified/source.json").read_text())
PARQUET = ROOT / ".cache/swebench" / SOURCE["revision"] / "test.parquet"
CATEGORIES = ["resolved", "unresolved", "empty_patch", "error", "infra_failure", "ambiguous_failure", "incomplete"]


def load_dataset():
    if hashlib.sha256(PARQUET.read_bytes()).hexdigest() != SOURCE["sha256"]:
        sys.exit(f"{PARQUET} does not match the recorded sha256; run acquire.py")
    import pyarrow.parquet as pq
    return {r["instance_id"]: r for r in pq.read_table(PARQUET).to_pylist()}


def validate(preds, dataset):
    from unidiff import PatchSet
    findings, seen = {}, set()
    for p in preds:
        iid = p.get("instance_id")
        f = []
        if set(p) != {"instance_id", "model_name_or_path", "model_patch"}:
            f.append(f"keys {sorted(p)}")
        if iid not in dataset:
            sys.exit(f"prediction for unknown instance {iid!r}")
        if iid in seen:
            sys.exit(f"duplicate prediction for {iid}")
        seen.add(iid)
        patch = p.get("model_patch")
        if not isinstance(patch, str):
            f.append("model_patch is not a string")
        elif not patch.strip():
            f.append("empty patch")
        else:
            try:
                ps = PatchSet(patch)
                if len(ps) == 0:
                    f.append("no file diffs parsed")
            except Exception as e:  # unidiff raises several types
                f.append(f"unparseable diff: {e}")
        findings[iid] = f
    return findings


def image_digest(image):
    r = subprocess.run(["docker", "image", "inspect", "--format", "{{json .RepoDigests}}", image], capture_output=True, text=True)
    return json.loads(r.stdout) if r.returncode == 0 else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--predictions", required=True)
    ap.add_argument("--run-id", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--max-workers", type=int, default=1)
    ap.add_argument("--timeout", type=int, default=1800)
    ap.add_argument("--allow-pull", action="store_true")
    a = ap.parse_args()
    out = pathlib.Path(a.out).resolve()
    out.mkdir(parents=True, exist_ok=True)

    dataset = load_dataset()
    preds = [json.loads(l) for l in pathlib.Path(a.predictions).read_text().splitlines() if l.strip()]
    findings = validate(preds, dataset)
    ids = [p["instance_id"] for p in preds]
    images = {i: dataset[i]["image"] for i in ids}
    missing = [img for img in images.values() if image_digest(img) is None]
    if missing and not a.allow_pull:
        sys.exit(f"official images not present locally (pass --allow-pull to fetch ~1 GB each): {missing}")
    shutil.copy(a.predictions, out / "predictions.jsonl")

    cmd = [sys.executable, "-m", "swebench.harness.run_evaluation", "-d", str(PARQUET), "-i", *ids,
           "-p", str(out / "predictions.jsonl"), "--max_workers", str(a.max_workers), "-t", str(a.timeout),
           "-id", a.run_id, "--report_dir", str(out)]
    proc = subprocess.run(cmd, cwd=out, capture_output=True, text=True)
    (out / "run_evaluation.log").write_text(proc.stdout + proc.stderr)
    if proc.returncode != 0:
        sys.exit(f"run_evaluation exited {proc.returncode}; see {out / 'run_evaluation.log'}")
    reports = sorted(out.glob(f"*.{a.run_id}.json"))
    if len(reports) != 1:
        sys.exit(f"expected one official report, found {reports}")
    report = json.loads(reports[0].read_text())

    outcomes = {}
    for iid in ids:
        cats = [c for c in CATEGORIES if iid in report.get(f"{c}_ids", [])]
        outcomes[iid] = {"official": cats[0] if len(cats) == 1 else (cats or ["not_reported"]),
                         "validationFindings": findings[iid], "image": images[iid], "imageRepoDigests": image_digest(images[iid])}
    summary = {
        "kind": "swebench-official-evaluation",
        "evaluator": f"swebench=={md.version('swebench')}", "dataset": SOURCE["dataset"], "revision": SOURCE["revision"],
        "datasetSha256": SOURCE["sha256"], "runId": a.run_id, "officialReport": reports[0].name,
        "counts": {**{c: sum(1 for o in outcomes.values() if o["official"] == c) for c in CATEGORIES},
                   "not_reported": sum(1 for o in outcomes.values() if o["official"] not in CATEGORIES)},
        "outcomes": outcomes,
    }
    (out / "outcomes.json").write_text(json.dumps(summary, indent=1) + "\n")
    print(json.dumps({"counts": summary["counts"], "outcomes": {i: o["official"] for i, o in outcomes.items()}}, indent=1))


if __name__ == "__main__":
    main()
