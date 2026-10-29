#!/usr/bin/env python3
"""Build result tables for a campaign from the raw official scorer outputs.

    python3 benchmarks/campaign/analyze.py <campaign> [--out results/<campaign>]

Reads only .cache/campaigns/<campaign>/ (raw, local): BFCL result + official
score files, kab-diagnostics, SWE-bench attempt records, accounting and
official evaluator outcomes. Writes summary.json, per-task-results.csv and
SUMMARY.md. Per-task truth comes from the official artifacts:
  BFCL: an entry is correct iff it has a result and is NOT listed as an error
        in BFCL's own score file for its category (score files list failures).
  SWE-bench: the official category from the evaluator's report; ids without a
        run record keep their attempt classification.
Statistics: Wilson 95% intervals; paired exact McNemar tests on shared tasks
with Holm correction across the 6 model pairs; paired bootstrap (10,000,
seed 0) for differences; SWE-bench also a repository-cluster bootstrap.
BFCL pooled accuracy is an unweighted pool over the frozen subset, not
BFCL's leaderboard overall score.
"""
import argparse
import csv
import json
import math
import pathlib
import random
import statistics
from collections import Counter, defaultdict
from itertools import combinations

ROOT = pathlib.Path(__file__).resolve().parents[2]
CAMPAIGNS = ROOT / ".cache/campaigns"
Z = 1.959963984540054


def wilson(k, n):
    if n == 0:
        return [None, None]
    p = k / n
    d = 1 + Z * Z / n
    c = (p + Z * Z / (2 * n)) / d
    h = Z * math.sqrt(p * (1 - p) / n + Z * Z / (4 * n * n)) / d
    return [round(max(0.0, c - h), 4), round(min(1.0, c + h), 4)]


def mcnemar_exact(b, c):
    """Two-sided exact McNemar p-value (binomial on discordant pairs)."""
    n = b + c
    if n == 0:
        return 1.0
    k = min(b, c)
    p = sum(math.comb(n, i) for i in range(0, k + 1)) / 2 ** n
    return min(1.0, 2 * p)


def holm(pvals):
    order = sorted(range(len(pvals)), key=lambda i: pvals[i])
    adj = [None] * len(pvals)
    running = 0.0
    m = len(pvals)
    for rank, i in enumerate(order):
        running = max(running, min(1.0, (m - rank) * pvals[i]))
        adj[i] = running
    return adj


def paired_bootstrap(x, y, reps=10000, seed=0, clusters=None):
    """95% percentile CI for mean(x) - mean(y) over paired items; optionally
    resampling whole clusters (lists of indices)."""
    rng = random.Random(seed)
    n = len(x)
    diffs = []
    for _ in range(reps):
        if clusters:
            idx = [i for cl in (rng.choice(clusters) for _ in clusters) for i in cl]
        else:
            idx = [rng.randrange(n) for _ in range(n)]
        if not idx:
            continue
        diffs.append(sum(x[i] - y[i] for i in idx) / len(idx))
    diffs.sort()
    return [round(diffs[int(0.025 * len(diffs))], 4), round(diffs[int(0.975 * len(diffs)) - 1], 4)]


def cluster_bootstrap_rate(x, clusters, reps=10000, seed=0):
    rng = random.Random(seed)
    vals = []
    for _ in range(reps):
        idx = [i for cl in (rng.choice(clusters) for _ in clusters) for i in cl]
        vals.append(sum(x[i] for i in idx) / len(idx))
    vals.sort()
    return [round(vals[int(0.025 * reps)], 4), round(vals[int(0.975 * reps) - 1], 4)]


def pairwise(models, outcome_by_model, ids, clusters=None):
    rows = []
    for a, b in combinations(models, 2):
        xa = [1 if outcome_by_model[a].get(i) else 0 for i in ids]
        xb = [1 if outcome_by_model[b].get(i) else 0 for i in ids]
        b10 = sum(1 for u, v in zip(xa, xb) if u and not v)
        b01 = sum(1 for u, v in zip(xa, xb) if v and not u)
        rows.append({"a": a, "b": b, "n": len(ids), "rateA": round(sum(xa) / len(ids), 4), "rateB": round(sum(xb) / len(ids), 4),
                     "diff": round((sum(xa) - sum(xb)) / len(ids), 4), "aOnly": b10, "bOnly": b01,
                     "mcnemarP": round(mcnemar_exact(b10, b01), 6),
                     "diffCI95": paired_bootstrap(xa, xb, clusters=clusters)})
    adj = holm([r["mcnemarP"] for r in rows])
    for r, p in zip(rows, adj):
        r["holmP"] = round(p, 6)
    return rows


# ── BFCL ────────────────────────────────────────────────────────────────────

def bfcl_model(d, spec, model):
    proj = d / model / "bfcl"
    reg = f"kab-{model}-FC"
    results = {}
    for f in (proj / "result" / reg).rglob("*_result.json"):
        for line in f.read_text().splitlines():
            e = json.loads(line)
            results[e["id"]] = e
    failed, score_totals = set(), {}
    for f in (proj / "score" / reg).rglob("*_score.json"):
        lines = f.read_text().splitlines()
        head = json.loads(lines[0])
        cat = f.name[len("BFCL_v4_"):-len("_score.json")]
        score_totals[cat] = head
        for line in lines[1:]:
            failed.add(json.loads(line)["id"])
    diag = defaultdict(list)
    dp = proj / "kab-diagnostics.jsonl"
    if dp.exists():
        for line in dp.read_text().splitlines():
            r = json.loads(line)
            diag[r["id"]].append(r)
    run = json.loads((proj / "run.json").read_text()) if (proj / "run.json").exists() else {}
    err_class = {i: c for c, ids in (run.get("errorsByClass") or {}).items() for i in ids}
    rows = []
    for cat, ids in spec["bfcl"]["ids"].items():
        for i in ids:
            e = results.get(i)
            dg = diag.get(i, [])
            res = e.get("result") if e else None
            is_err = isinstance(res, str) and res.startswith("Error during inference")
            rows.append({
                "benchmark": "bfcl", "model": model, "task_id": i, "group": cat,
                "executed": e is not None, "scored": e is not None and cat in score_totals,
                "correct": bool(e) and cat in score_totals and i not in failed,
                "error_class": err_class.get(i) if is_err else None,
                "truncated": any(x.get("finish_reason") == "length" for x in dg),
                "empty_output": bool(dg) and all(x.get("tool_calls", 0) == 0 and x.get("content_chars", 0) == 0 for x in dg),
                "responses": len(dg),
                "latency_s": e.get("latency") if e else None,
                "input_tokens": e.get("input_token_count") if e else None,
                "output_tokens": e.get("output_token_count") if e else None,
            })
    # The official per-category numbers must equal the per-task reconstruction.
    for cat, head in score_totals.items():
        mine = [r for r in rows if r["group"] == cat]
        assert head["total_count"] == sum(r["scored"] for r in mine), f"{model}/{cat}: total mismatch"
        assert head["correct_count"] == sum(r["correct"] for r in mine), f"{model}/{cat}: correct mismatch"
    return rows, score_totals, run


def flat(v):
    if isinstance(v, list):
        return sum(flat(x) for x in v)
    return v or 0


# ── SWE-bench ───────────────────────────────────────────────────────────────

def swe_model(d, spec, model, repo_of):
    base = d / model / "swebench"
    acc_p = base / "accounting.json"
    accounting = json.loads(acc_p.read_text()) if acc_p.exists() else {}
    out_p = base / "eval" / "outcomes.json"
    official = json.loads(out_p.read_text())["outcomes"] if out_p.exists() else {}
    rows = []
    for iid in spec["swebench"]["ids"]:
        att = sorted((base / "attempts" / iid).glob("attempt-*.json"))
        last = json.loads(att[-1].read_text()) if att else None
        off = official.get(iid, {}).get("official")
        rows.append({
            "benchmark": "swebench", "model": model, "task_id": iid, "group": repo_of.get(iid),
            "attempts": len(att), "agent_outcome": last["classification"] if last else "missing",
            "stop_reason": last.get("stopReason") if last else None,
            "official": off if isinstance(off, str) else ("not_evaluated" if last and last.get("run") else "no_run"),
            "resolved": off == "resolved",
            "turns": last.get("turns") if last else None, "tool_calls": last.get("toolCalls") if last else None,
            "tool_errors": last.get("toolErrors") if last else None, "compactions": last.get("compactions") if last else None,
            "patch_bytes": last.get("patchBytes") if last else None, "seconds": last.get("seconds") if last else None,
            "prompt_tokens": (last.get("usage") or {}).get("promptTokens") if last else None,
            "completion_tokens": (last.get("usage") or {}).get("completionTokens") if last else None,
            "validation_findings": "; ".join(official.get(iid, {}).get("validationFindings") or []),
        })
    return rows, accounting


def med(xs):
    xs = [x for x in xs if isinstance(x, (int, float))]
    return round(statistics.median(xs), 2) if xs else None


def mean(xs):
    xs = [x for x in xs if isinstance(x, (int, float))]
    return round(statistics.fmean(xs), 2) if xs else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("campaign")
    ap.add_argument("--out")
    a = ap.parse_args()
    d = CAMPAIGNS / a.campaign
    spec = json.loads((d / "campaign.json").read_text())
    if spec.get("kind") == "dryrun":
        raise SystemExit("dry-run campaigns are never analyzed")
    out = pathlib.Path(a.out) if a.out else ROOT / "results" / a.campaign
    out.mkdir(parents=True, exist_ok=True)
    models = spec["models"]
    index = json.loads((ROOT / "datasets/swe-bench-verified/index.json").read_text())["instances"]
    repo_of = {x["instance_id"]: x["repo"] for x in index}
    summary = {"campaign": a.campaign, "kind": spec.get("kind"), "protocolSha256": spec.get("protocolSha256"), "models": models, "bfcl": {}, "swebench": {}}
    all_rows = []

    # BFCL
    bfcl_ids = [i for ids in spec["bfcl"]["ids"].values() for i in ids]
    bfcl_correct = {}
    for m in models:
        if not (d / m / "bfcl" / "run.json").exists():
            summary["bfcl"][m] = {"status": "not executed"}
            continue
        rows, totals, run = bfcl_model(d, spec, m)
        all_rows += rows
        bfcl_correct[m] = {r["task_id"]: r["correct"] for r in rows}
        n_sched = len(rows)
        n_exec = sum(r["executed"] for r in rows)
        n_scored = sum(r["scored"] for r in rows)
        k = sum(r["correct"] for r in rows)
        cats = {}
        for cat in spec["bfcl"]["ids"]:
            cr = [r for r in rows if r["group"] == cat]
            ck = sum(r["correct"] for r in cr)
            cn = sum(r["scored"] for r in cr)
            cats[cat] = {"scored": cn, "correct": ck, "accuracy": round(ck / cn, 4) if cn else None, "ci95": wilson(ck, cn),
                         "errors": sum(1 for r in cr if r["error_class"]), "truncated": sum(r["truncated"] for r in cr),
                         "errorsCountedCorrect": sum(1 for r in cr if r["error_class"] and r["correct"]),
                         "truncatedCountedCorrect": sum(1 for r in cr if r["truncated"] and r["correct"])}
        summary["bfcl"][m] = {
            "scheduled": n_sched, "executed": n_exec, "scored": n_scored, "correct": k, "incorrect": n_scored - k,
            # denominator = scheduled entries (unscored entries count as wrong)
            "pooledAccuracy": round(k / n_sched, 4) if n_sched else None, "ci95": wilson(k, n_sched),
            # pre-registered sensitivity: caught inference errors and truncated
            # outputs counted wrong (BFCL counts them correct on irrelevance)
            "pooledAccuracySensitivity": round(sum(r["correct"] and not r["error_class"] and not r["truncated"] for r in rows) / n_sched, 4) if n_sched else None,
            "missingOrInvalid": n_sched - n_scored,
            "errorsByClass": dict(Counter(r["error_class"] for r in rows if r["error_class"])),
            "infraRetries": len(run.get("infraRetries") or {}),
            "truncatedEntries": sum(r["truncated"] for r in rows),
            "latencyMean_s": mean([flat(r["latency_s"]) for r in rows]), "latencyMedian_s": med([flat(r["latency_s"]) for r in rows]),
            "outputTokensMedian": med([flat(r["output_tokens"]) for r in rows]),
            "generateSeconds": sum(x["seconds"] for x in run.get("generateRounds", [])),
            "categories": cats,
        }
    done = [m for m in models if m in bfcl_correct]
    if len(done) >= 2:
        summary["bfcl"]["pairwise"] = pairwise(done, bfcl_correct, bfcl_ids)

    # SWE-bench
    swe_ids = spec["swebench"]["ids"]
    swe_res = {}
    for m in models:
        if not (d / m / "swebench" / "attempts").exists():
            summary["swebench"][m] = {"status": "not executed"}
            continue
        rows, accounting = swe_model(d, spec, m, repo_of)
        all_rows += rows
        swe_res[m] = {r["task_id"]: r["resolved"] for r in rows}
        n = len(rows)
        k = sum(r["resolved"] for r in rows)
        by = Counter(r["official"] for r in rows)
        agent = Counter(r["agent_outcome"] for r in rows)
        repos = sorted({r["group"] for r in rows})
        clusters = [[i for i, r in enumerate(rows) if r["group"] == g] for g in repos]
        x = [1 if r["resolved"] else 0 for r in rows]
        valid = [r for r in rows if r["agent_outcome"] not in ("infrastructure", "missing")]
        summary["swebench"][m] = {
            "scheduled": n, "resolved": k, "resolveRate": round(k / n, 4) if n else None, "ci95": wilson(k, n),
            "ci95RepoCluster": cluster_bootstrap_rate(x, clusters) if n and len(clusters) > 1 else None,
            "official": dict(by), "agentOutcome": dict(agent),
            "contextInfeasible": agent.get("context_exhausted", 0), "budgetExhausted": agent.get("budget_exhausted", 0),
            "infraErrors": agent.get("infrastructure", 0), "missingAttempts": agent.get("missing", 0),
            "resolvedAmongValidAttempts": [sum(r["resolved"] for r in valid), len(valid)],
            "cleanCompletionRate": round(agent.get("completed", 0) / n, 4) if n else None,
            "toolCallsMean": mean([r["tool_calls"] for r in rows]), "toolCallsMedian": med([r["tool_calls"] for r in rows]),
            "toolErrorRate": round(sum(r["tool_errors"] or 0 for r in rows) / max(1, sum(r["tool_calls"] or 0 for r in rows)), 4),
            "secondsMedian": med([r["seconds"] for r in rows]),
        }
    done = [m for m in models if m in swe_res]
    if len(done) >= 2:
        repos = sorted({repo_of[i] for i in swe_ids})
        clusters = [[k for k, i in enumerate(swe_ids) if repo_of[i] == g] for g in repos]
        summary["swebench"]["pairwise"] = pairwise(done, swe_res, swe_ids, clusters=clusters if len(clusters) > 1 else None)

    (out / "summary.json").write_text(json.dumps(summary, indent=1) + "\n")
    keys = sorted({k for r in all_rows for k in r})
    with open(out / "per-task-results.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=keys)
        w.writeheader()
        for r in all_rows:
            w.writerow(r)
    print(json.dumps({b: {m: {k: v for k, v in s.items() if k in ("scored", "correct", "pooledAccuracy", "ci95", "scheduled", "resolved", "resolveRate", "official", "agentOutcome")}
                          for m, s in summary[b].items() if m != "pairwise"} for b in ("bfcl", "swebench")}, indent=1))


if __name__ == "__main__":
    main()
