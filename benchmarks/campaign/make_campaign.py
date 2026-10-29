#!/usr/bin/env python3
"""Write a campaign definition (.cache/campaigns/<name>/campaign.json).

    python3 benchmarks/campaign/make_campaign.py pilot <name>
    python3 benchmarks/campaign/make_campaign.py main  <name> <protocol.json>

pilot: real upstream BFCL entries and SWE-bench Verified instances chosen
DISJOINT from the main subsets (datasets/*/subset-v1.json), ranked by a
separate seed; never reused in the main comparison.
main:  ids and resources exactly as frozen in the protocol file (ADR 0011).
"""
import hashlib
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
PRIMARY = ["kanana", "exaone", "ax", "solar-open2"]
PILOT_BFCL_CATS = ["simple_python", "multiple", "parallel", "parallel_multiple", "irrelevance",
                   "live_simple", "live_multiple", "live_irrelevance", "multi_turn_base"]


def rank(seed, ids):
    return sorted(ids, key=lambda i: hashlib.sha256(f"{seed}:{i}".encode()).hexdigest())


def bfcl_all_ids(cat):
    import importlib.util
    spec = importlib.util.find_spec("bfcl_eval")
    data = pathlib.Path(spec.origin).parent / "data" / f"BFCL_v4_{cat}.json"
    return [json.loads(l)["id"] for l in data.read_text().splitlines() if l.strip()]


def pilot(name):
    bsub = json.loads((ROOT / "datasets/bfcl/subset-v1.json").read_text())
    ssub = json.loads((ROOT / "datasets/swe-bench-verified/subset-v1.json").read_text())
    index = json.loads((ROOT / "datasets/swe-bench-verified/index.json").read_text())["instances"]
    seed = "korean-agent-bench/pilot-v1"
    bfcl = {}
    for cat in PILOT_BFCL_CATS:
        used = set(bsub["categories"][cat]["ids"])
        bfcl[cat] = sorted(rank(seed, [i for i in bfcl_all_ids(cat) if i not in used])[:3])
    # smallest evaluation environments: psf/requests instances outside the main subset
    cand = [x["instance_id"] for x in index if x["repo"] == "psf/requests" and x["instance_id"] not in set(ssub["instance_ids"])]
    swe = sorted(rank(seed, cand)[:2])
    spec = {"name": name, "kind": "pilot", "seed": seed, "models": PRIMARY,
            "bfcl": {"ids": bfcl, "disjointFrom": "datasets/bfcl/subset-v1.json"},
            "swebench": {"ids": swe, "disjointFrom": "datasets/swe-bench-verified/subset-v1.json"},
            "resources": {"dockerBudgetGB": 100}, "protocolSha256": None}
    return spec


def main_campaign(name, protocol_path):
    raw = pathlib.Path(protocol_path).read_bytes()
    proto = json.loads(raw)
    return {"name": name, "kind": "main", "models": proto["models"]["primary"],
            "bfcl": {"ids": proto["bfcl"]["ids"]}, "swebench": {"ids": proto["swebench"]["ids"]},
            "resources": proto["resources"], "protocol": str(protocol_path), "protocolSha256": hashlib.sha256(raw).hexdigest()}


if __name__ == "__main__":
    kind, name = sys.argv[1], sys.argv[2]
    spec = pilot(name) if kind == "pilot" else main_campaign(name, sys.argv[3])
    d = ROOT / ".cache/campaigns" / name
    d.mkdir(parents=True, exist_ok=True)
    p = d / "campaign.json"
    if p.exists() and json.loads(p.read_text()) != spec:
        sys.exit(f"{p} exists with a different definition; refusing to overwrite")
    p.write_text(json.dumps(spec, indent=1) + "\n")
    print(json.dumps({k: (v if k not in ("bfcl", "swebench") else {"n": sum(len(x) for x in v["ids"].values()) if isinstance(v["ids"], dict) else len(v["ids"])}) for k, v in spec.items()}, indent=1))
