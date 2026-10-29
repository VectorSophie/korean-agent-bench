#!/usr/bin/env python3
"""Deterministic, repository-stratified SWE-bench Verified subset.

    python3 benchmarks/swebench/select_subset.py [--check]

Reads only datasets/swe-bench-verified/index.json (instance ids and repo
names from the pinned dataset); no model output is ever read. Allocation:
n=100 split across repositories in proportion to their size (largest
remainder), at least 1 per repository; within a repository, ids are ranked by
sha256(seed + ':' + instance_id). Writes datasets/swe-bench-verified/subset-v1.json.
"""
import collections
import hashlib
import json
import math
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
INDEX = ROOT / "datasets/swe-bench-verified/index.json"
OUT = ROOT / "datasets/swe-bench-verified/subset-v1.json"
SEED = "korean-agent-bench/swe-bench-verified/subset-v1"
N = 100


def allocate(sizes, n):
    total = sum(sizes.values())
    quotas = {r: n * s / total for r, s in sizes.items()}
    alloc = {r: max(1, math.floor(q)) for r, q in quotas.items()}
    # largest remainder until the total is n (ties broken by repo name)
    order = sorted(sizes, key=lambda r: (-(quotas[r] - math.floor(quotas[r])), r))
    i = 0
    while sum(alloc.values()) < n:
        r = order[i % len(order)]
        if alloc[r] < sizes[r]:
            alloc[r] += 1
        i += 1
    while sum(alloc.values()) > n:  # only if the floor of 1 overshoots
        r = max(alloc, key=lambda x: (alloc[x] - quotas[x], x))
        alloc[r] -= 1
    return alloc


def build():
    index = json.loads(INDEX.read_text())
    by_repo = collections.defaultdict(list)
    for inst in index["instances"]:
        by_repo[inst["repo"]].append(inst["instance_id"])
    alloc = allocate({r: len(v) for r, v in by_repo.items()}, N)
    selected = []
    for repo in sorted(by_repo):
        ranked = sorted(by_repo[repo], key=lambda i: hashlib.sha256(f"{SEED}:{i}".encode()).hexdigest())
        selected += sorted(ranked[: alloc[repo]])
    return {
        "subset": "swe-bench-verified-kab-subset-v1",
        "dataset": index["dataset"], "revision": index["revision"],
        "frozenOn": "2026-10-29",
        "seed": SEED, "n": N,
        "method": "Repository-stratified: proportional allocation (largest remainder, >=1 per repository); within a repository, rank by sha256(seed + ':' + instance_id). Inputs: instance ids and repository names only.",
        "sampleSizeRationale": "Resolve rate is reported per model on the same instances (paired). n=100 gives a worst-case 95% Wald half-width of 9.8 points for a single model; paired model differences are tested per instance (McNemar). Each instance is a full agent episode plus an evaluation container, so 100 bounds cost; the full 500 remain runnable.",
        "allocation": dict(sorted(alloc.items())),
        "instance_ids": selected,
    }


def main():
    result = build()
    text = json.dumps(result, indent=1) + "\n"
    if "--check" in sys.argv:
        if OUT.read_text() != text:
            sys.exit(f"{OUT} does not match a fresh selection")
        print(f"subset OK: {len(result['instance_ids'])} instances")
        return
    OUT.write_text(text)
    print(f"wrote {OUT.relative_to(ROOT)}: {len(result['instance_ids'])} instances")
    print(json.dumps(result["allocation"]))


if __name__ == "__main__":
    main()
