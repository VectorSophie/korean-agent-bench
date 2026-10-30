"""Independent BFCL recomputation for main-2026-10-30-v1 (does not import analyze.py/verify.py).

    python3 -I results/main-2026-10-30-v1/records/bfcl_independent.py OUT.json

Needs the local campaign records under .cache/campaigns/main-2026-10-30-v1/."""
import glob, json, math, os, pathlib, subprocess, sys
from itertools import combinations

ROOT = str(pathlib.Path(__file__).resolve().parents[3])
C = f"{ROOT}/.cache/campaigns/main-2026-10-30-v1"
proto = json.load(open(f"{ROOT}/protocol/main-v1.json"))
ids = proto["bfcl"]["ids"]
sched = {i: c for c, v in ids.items() for i in v}
assert len(sched) == 1106 and len(ids) == 14
MODELS = proto["models"]["primary"]


def wilson(k, n, z=1.959964):
    p = k / n; d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d; h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return round(c - h, 4), round(c + h, 4)


def mcnemar_exact(b, c):
    n = b + c
    if n == 0:
        return 1.0
    k = min(b, c)
    return min(1.0, 2 * sum(math.comb(n, i) for i in range(k + 1)) / 2 ** n)


def lines(path):
    with open(path) as f:
        for l in f:
            if l.strip():
                yield json.loads(l)


out = {"models": {}, "checks": []}
correct = {}
frozen_trees = proto["code"]["trees"]
for m in MODELS:
    reg = f"kab-{m}-FC"
    base = f"{C}/{m}/bfcl"
    res_ids = []
    res_err = {}
    for f in glob.glob(f"{base}/result/{reg}/**/*_result.json", recursive=True):
        for e in lines(f):
            res_ids.append(e["id"])
            r = e.get("result")
            if isinstance(r, str) and ("Error during inference" in r or "error" in r.lower()[:40]):
                res_err[e["id"]] = r[:160]
    dup = len(res_ids) - len(set(res_ids))
    missing = set(sched) - set(res_ids); extra = set(res_ids) - set(sched)
    failed, cats = set(), {}
    for f in glob.glob(f"{base}/score/{reg}/**/*_score.json", recursive=True):
        it = lines(f)
        head = next(it)
        cat = os.path.basename(f).replace("BFCL_v4_", "").replace("_score.json", "")
        fl = [e["id"] for e in it]
        failed |= set(fl)
        cats[cat] = {"official_correct": head["correct_count"], "official_total": head["total_count"], "official_accuracy": head["accuracy"],
                     "recomputed_correct": len([i for i in ids.get(cat, []) if i not in set(fl)]), "scheduled": len(ids.get(cat, []))}
    corr = {i: (i in set(res_ids) and i not in failed) for i in sched}
    correct[m] = corr
    k = sum(corr.values())
    run = json.load(open(f"{base}/run.json"))
    commits = {s["git"]["commit"] for s in run["sessions"]}
    trees_ok = all(subprocess.run(["git", "-C", ROOT, "rev-parse", f"{c}:{p}"], capture_output=True, text=True).stdout.strip() == t
                   for c in commits for p, t in frozen_trees.items())
    pre = [json.load(open(p)) for p in sorted(glob.glob(f"{C}/{m}/runtime/preflight-*.json"))]
    # context errors and where they landed
    ctx = run["errorsByClass"].get("context", [])
    ctx_cat = {}
    for i in ctx:
        ctx_cat[sched[i]] = ctx_cat.get(sched[i], 0) + 1
    ctx_scored_correct = [i for i in ctx if corr[i]]
    out["models"][m] = {
        "scheduled": len(sched), "results": len(res_ids), "duplicates": dup, "missing": len(missing), "extra": len(extra),
        "categoriesScored": len(cats), "correct": k, "accuracy": round(k / 1106, 4), "wilson95": wilson(k, 1106),
        "officialHeaderCorrectSum": sum(v["official_correct"] for v in cats.values()),
        "headerTotalsEqualScheduled": all(v["official_total"] == v["scheduled"] for v in cats.values()),
        "perCategoryRecomputeMatchesOfficial": all(v["official_correct"] == v["recomputed_correct"] for v in cats.values()),
        "categories": {c: {"correct": v["official_correct"], "n": v["official_total"], "accuracy": v["official_accuracy"]} for c, v in sorted(cats.items())},
        "errorsByClass": {c: len(v) for c, v in run["errorsByClass"].items()}, "infraRetries": run["infraRetries"],
        "contextErrorsByCategory": ctx_cat, "contextErrorsScoredCorrect": ctx_scored_correct,
        "resultFileErrorStrings": len(res_err),
        "sessions": len(run["sessions"]), "commits": sorted(commits), "codeTreesFrozen": trees_ok,
        "preflights": [{"reportable": p["reportable"], "mismatch": p["counts"]["mismatch"], "verified": p["counts"]["verified"]} for p in pre],
    }
pairs = []
for a, b in combinations(MODELS, 2):
    bo = sum(correct[a][i] and not correct[b][i] for i in sched)
    co = sum(correct[b][i] and not correct[a][i] for i in sched)
    pairs.append({"a": a, "b": b, "diff": round((sum(correct[a].values()) - sum(correct[b].values())) / 1106, 4), "aOnly": bo, "bOnly": co, "p": mcnemar_exact(bo, co)})
order = sorted(range(len(pairs)), key=lambda j: pairs[j]["p"])
running = 0
for r, j in enumerate(order):
    running = max(running, min(1.0, (len(pairs) - r) * pairs[j]["p"]))
    pairs[j]["holm"] = running
out["pairwise"] = pairs
json.dump(out, open(sys.argv[1], "w"), indent=1)
for m, v in out["models"].items():
    print(m, {k: v[k] for k in ("results", "duplicates", "missing", "extra", "categoriesScored", "correct", "accuracy", "wilson95", "officialHeaderCorrectSum",
                                 "headerTotalsEqualScheduled", "perCategoryRecomputeMatchesOfficial", "errorsByClass", "infraRetries", "contextErrorsByCategory",
                                 "codeTreesFrozen", "sessions")}, "ctxScoredCorrect", len(v["contextErrorsScoredCorrect"]), "preflights", v["preflights"])
for p in pairs:
    print(p)
