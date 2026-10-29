#!/usr/bin/env python3
"""Deterministically select the BFCL subset from the installed, pinned bfcl-eval data.

    .cache/venv-bfcl/bin/python benchmarks/bfcl/select_subset.py [--check]

Writes datasets/bfcl/subset-v1.json (ids, counts, per-file sha256, versions).
--check recomputes and fails if the committed file differs (CI/offline guard).
"""
import hashlib
import importlib.metadata as md
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
CONFIG = json.loads((ROOT / "benchmarks/bfcl/subset-v1.config.json").read_text())
OUT = ROOT / "datasets/bfcl/subset-v1.json"


def data_dir():
    import bfcl_eval
    return pathlib.Path(bfcl_eval.__file__).parent / "data"


def load_jsonl(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build():
    d = data_dir()
    cap = CONFIG["perCategoryCap"]
    categories = {}
    files = {}
    for cat in CONFIG["include"]:
        f = d / f"BFCL_v4_{cat}.json"
        entries = load_jsonl(f)
        ids = [e["id"] for e in entries]
        assert len(ids) == len(set(ids)), f"duplicate ids in {f.name}"
        assert all(i.startswith(cat + "_") for i in ids), f"unexpected id prefix in {f.name}"
        ranked = sorted(ids, key=lambda i: hashlib.sha256(f"{CONFIG['seed']}:{i}".encode()).hexdigest())
        chosen = set(ranked[: min(cap, len(ids))])
        categories[cat] = {"size": len(ids), "selected": len(chosen), "ids": [i for i in ids if i in chosen]}
        files[f.name] = sha256(f)
        ans = d / "possible_answer" / f.name
        if ans.exists():
            files[f"possible_answer/{f.name}"] = sha256(ans)
    return {
        "subset": CONFIG["subset"],
        "source": {
            "package": f"bfcl-eval=={md.version('bfcl-eval')}",
            "repository": "https://github.com/ShishirPatil/gorilla/tree/6ea57973c7a6097fd7c5915698c54c17c5b1b6c8/berkeley-function-call-leaderboard",
            "dataFilesSha256": files,
        },
        "seed": CONFIG["seed"],
        "method": CONFIG["method"],
        "perCategoryCap": CONFIG["perCategoryCap"],
        "excluded": CONFIG["exclude"],
        "totals": {"selected": sum(c["selected"] for c in categories.values()), "available": sum(c["size"] for c in categories.values())},
        "categories": categories,
    }


def main():
    result = build()
    text = json.dumps(result, indent=1) + "\n"
    if "--check" in sys.argv:
        if not OUT.exists() or OUT.read_text() != text:
            sys.exit(f"{OUT} does not match a fresh selection from the installed bfcl-eval data")
        print(f"subset OK: {result['totals']}")
        return
    OUT.write_text(text)
    print(f"wrote {OUT.relative_to(ROOT)}: {result['totals']}")
    for cat, c in result["categories"].items():
        print(f"  {cat:24} {c['selected']:4}/{c['size']}")


if __name__ == "__main__":
    main()
