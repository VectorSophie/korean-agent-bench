#!/usr/bin/env python3
"""Fetch SWE-bench Verified at the pinned Hugging Face revision and verify it.

    .cache/venv-swebench/bin/python benchmarks/swebench/acquire.py [--check] [--export]

Downloads the single parquet file (~ a few MB) to .cache/swebench/ (not
committed: the dataset card declares no license), verifies its sha256 against
datasets/swe-bench-verified/source.json once recorded, and writes a
metadata-only index (no problem statements, patches or tests) to
datasets/swe-bench-verified/index.json. --check re-derives both and fails on
any difference.
"""
import datetime
import hashlib
import json
import pathlib
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
DATASET = "SWE-bench/SWE-bench_Verified"
REVISION = "78f471bf655a3137b2e8a75af1501690ec009ec3"
FILE = "data/test-00000-of-00001.parquet"
URL = f"https://huggingface.co/datasets/{DATASET}/resolve/{REVISION}/{FILE}"
CACHE = ROOT / ".cache/swebench" / REVISION / "test.parquet"
SOURCE = ROOT / "datasets/swe-bench-verified/source.json"
INDEX = ROOT / "datasets/swe-bench-verified/index.json"


def fetch():
    if not CACHE.exists():
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        tmp = CACHE.with_suffix(".part")
        with urllib.request.urlopen(URL, timeout=120) as r, open(tmp, "wb") as f:
            f.write(r.read())
        tmp.rename(CACHE)
    return hashlib.sha256(CACHE.read_bytes()).hexdigest()


def load_rows():
    import pyarrow.parquet as pq
    return pq.read_table(CACHE).to_pylist()


def build_index(rows):
    out = []
    for r in sorted(rows, key=lambda x: x["instance_id"]):
        f2p = json.loads(r["FAIL_TO_PASS"]) if isinstance(r["FAIL_TO_PASS"], str) else r["FAIL_TO_PASS"]
        p2p = json.loads(r["PASS_TO_PASS"]) if isinstance(r["PASS_TO_PASS"], str) else r["PASS_TO_PASS"]
        out.append({
            "instance_id": r["instance_id"], "repo": r["repo"], "base_commit": r["base_commit"],
            "version": r["version"], "difficulty": r.get("difficulty"),
            "problem_statement_chars": len(r["problem_statement"]),
            "fail_to_pass": len(f2p), "pass_to_pass": len(p2p),
        })
    return out


def main():
    digest = fetch()
    rows = load_rows()
    ids = [r["instance_id"] for r in rows]
    assert len(ids) == len(set(ids)), "duplicate instance ids"
    index = build_index(rows)
    index_text = json.dumps({"dataset": DATASET, "revision": REVISION, "instances": index}, indent=0) + "\n"
    check = "--check" in sys.argv
    if "--export" in sys.argv:
        # Full rows for the local agent runner (problem statements etc.). Local
        # cache only, never committed (no declared dataset license).
        export = CACHE.parent / "instances.jsonl"
        with open(export, "w") as f:
            for r in rows:
                f.write(json.dumps(r, default=str) + "\n")
        print(f"exported {len(rows)} rows to {export.relative_to(ROOT)}")
    if SOURCE.exists():
        recorded = json.loads(SOURCE.read_text())
        if recorded["sha256"] != digest:
            sys.exit(f"sha256 mismatch: recorded {recorded['sha256']}, downloaded {digest}")
    elif check:
        sys.exit("no recorded source.json to check against")
    else:
        SOURCE.write_text(json.dumps({
            "dataset": DATASET, "revision": REVISION, "file": FILE, "url": URL, "sha256": digest,
            "bytes": CACHE.stat().st_size, "rows": len(rows), "columns": sorted(rows[0].keys()),
            "acquiredAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        }, indent=1) + "\n")
    if check:
        if INDEX.read_text() != index_text:
            sys.exit("index.json differs from the pinned dataset")
        print(f"swe-bench-verified OK: {len(rows)} instances, sha256 {digest[:16]}…")
        return
    INDEX.write_text(index_text)
    print(f"{len(rows)} instances, sha256 {digest}; wrote {INDEX.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
