#!/usr/bin/env python3
"""Render a campaign's committed report from analyze.py / verify.py output.

    python3 benchmarks/campaign/report.py <campaign> [--results results/<campaign>]

Reads results/<campaign>/summary.json and verification.json (written by
analyze.py and verify.py) and the campaign's runtime records, and writes into
the same directory:
  SUMMARY.md       Tables A-D (every number is taken from summary.json)
  provenance.json  protocol, code, tools, serving identity, preflights, occupancy
  MANIFEST.sha256  sha256 of every committed result file
Nothing here computes a score; it only formats what analyze.py computed and
verify.py recomputed. Refuses if verification did not pass.
"""
import argparse
import hashlib
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
CAMPAIGNS = ROOT / ".cache/campaigns"
LABEL = {"kanana": "Kanana 2 30B-A3B Thinking", "exaone": "EXAONE 4.5 33B (thinking)", "ax": "A.X 4.0",
         "solar-open2": "Solar Open 2 (8K arm, unofficial NVFP4)"}


def pct(x):
    return "—" if x is None else f"{100 * x:.1f}%"


def ci(c):
    return "—" if not c else f"[{100 * c[0]:.1f}, {100 * c[1]:.1f}]"


def num(x, nd=1):
    return "—" if x is None else (f"{x:.{nd}f}" if isinstance(x, float) else str(x))


def table(head, rows):
    out = ["| " + " | ".join(head) + " |", "|" + "|".join("---" for _ in head) + "|"]
    out += ["| " + " | ".join(str(c) for c in r) + " |" for r in rows]
    return "\n".join(out)


def pairwise_rows(pw, confirmatory):
    rows = []
    for p in pw or []:
        rows.append([f"{p['a']} − {p['b']}", p["n"], pct(p["rateA"]), pct(p["rateB"]), f"{100 * p['diff']:+.1f}",
                     ci(p.get("diffCI95")), f"{p['aOnly']}/{p['bOnly']}", f"{p['mcnemarP']:.4g}",
                     f"{p['holmP']:.4g}" + (" *" if confirmatory and p["holmP"] < 0.05 else "")])
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("campaign")
    ap.add_argument("--results")
    a = ap.parse_args()
    d = CAMPAIGNS / a.campaign
    res = pathlib.Path(a.results) if a.results else ROOT / "results" / a.campaign
    s = json.loads((res / "summary.json").read_text())
    v = json.loads((res / "verification.json").read_text())
    if v.get("failures"):
        sys.exit(f"verification has failures; no report: {v['failures'][:3]}")
    spec = json.loads((d / "campaign.json").read_text())
    models = s["models"]
    stage = s.get("swebenchStage")
    am_p = d / "amendments.json"
    amendments = json.loads(am_p.read_text()) if am_p.exists() else []
    md = [f"# {a.campaign} — results", "",
          f"Protocol `{spec.get('protocol')}` sha256 `{s.get('protocolSha256')}` (ADR 0011). "
          f"Independent recomputation: {sum(c['ok'] for c in v['checks'])}/{len(v['checks'])} checks passed (`verification.json`).", "",
          *([f"Protocol amendments applied: " + "; ".join(f"`{r['file']}` (sha256 `{r['sha256'][:12]}…`, {len(r['moved'])} cells re-run)" for r in amendments) + ".", ""] if amendments else []),
          "BFCL and SWE-bench are reported separately and never combined. Both are English benchmarks; nothing here "
          "measures Korean-language ability. Solar Open 2 is a separately constrained arm (8K context, unofficial "
          "quantization, different runtime).", ""]

    # Table A — BFCL
    md += ["## Table A — BFCL subset-v1 (official `bfcl evaluate --partial-eval`)", "",
           "Pooled accuracy over the scheduled entries (unweighted; not BFCL's overall score), Wilson 95% CI. "
           "Sensitivity: caught inference errors and truncated outputs counted wrong.", ""]
    rows = []
    for m in models:
        b = s["bfcl"].get(m, {})
        if b.get("status") == "not executed":
            rows.append([LABEL[m], "not executed"] + ["—"] * 6)
            continue
        errs = sum(len(x) if isinstance(x, list) else x for x in (b.get("errorsByClass") or {}).values())
        rows.append([LABEL[m], f"{b['correct']}/{b['scheduled']}", pct(b["pooledAccuracy"]), ci(b["ci95"]),
                     pct(b.get("pooledAccuracySensitivity")), errs, b.get("truncatedEntries"), num(b.get("latencyMedian_s"), 2)])
    md += [table(["Model", "Correct", "Accuracy", "95% CI", "Sensitivity", "Errors", "Truncated", "Median latency s"], rows), ""]
    cats = []
    for m in models:
        for c in (s["bfcl"].get(m, {}).get("categories") or {}):
            if c not in cats:
                cats.append(c)
    if cats:
        md += ["Per category (exploratory; n < 30 descriptive only):", "",
               table(["Category", "n"] + [m for m in models],
                     [[c, next((s["bfcl"][m]["categories"][c]["scored"] for m in models if c in (s["bfcl"].get(m, {}).get("categories") or {})), "—")]
                      + [pct((s["bfcl"].get(m, {}).get("categories") or {}).get(c, {}).get("accuracy")) for m in models] for c in cats]), ""]

    # Table B — SWE-bench
    md += [f"## Table B — SWE-bench Verified subset-v1{f', stage(s) 1–{stage}' if stage else ''} (official `swebench.harness.run_evaluation`)", "",
           "Resolve rate over the scheduled instances; Wilson and repository-cluster bootstrap 95% CIs. "
           "Exploratory (ADR 0011).", ""]
    rows = []
    for m in models:
        w = s["swebench"].get(m, {})
        if w.get("status") == "not executed":
            rows.append([LABEL[m], "not executed"] + ["—"] * 5)
            continue
        rows.append([LABEL[m], f"{w['resolved']}/{w['scheduled']}", pct(w["resolveRate"]), ci(w["ci95"]), ci(w.get("ci95RepoCluster")),
                     ", ".join(f"{k} {n}" for k, n in sorted((w.get("official") or {}).items())),
                     ", ".join(f"{k} {n}" for k, n in sorted((w.get("agentOutcome") or {}).items()))])
    md += [table(["Model", "Resolved", "Rate", "Wilson 95% CI", "Repo-cluster 95% CI", "Official outcomes", "Agent stop reasons"], rows), ""]

    # Table C — behaviour and efficiency
    md += ["## Table C — behaviour and efficiency (descriptive)", ""]
    rows = []
    for m in models:
        b, w = s["bfcl"].get(m, {}), s["swebench"].get(m, {})
        rows.append([LABEL[m], num(b.get("generateSeconds"), 0), num(b.get("outputTokensMedian"), 0),
                     pct(w.get("cleanCompletionRate")), w.get("budgetExhausted", "—"), w.get("contextInfeasible", "—"),
                     num(w.get("toolCallsMedian")), pct(w.get("toolErrorRate")), num(w.get("secondsMedian"))])
    md += [table(["Model", "BFCL generate s", "BFCL median output tokens", "SWE clean completion", "SWE budget exhausted",
                  "SWE context exhausted", "SWE median tool calls", "SWE tool-error rate", "SWE median episode s"], rows), ""]

    # Table D — pairwise
    md += ["## Table D — pairwise comparisons (same tasks, paired)", "",
           "BFCL pooled accuracy: **confirmatory** — exact McNemar, Holm-adjusted over the 6 pairs, α = 0.05 (* = significant). "
           "Difference CI: paired bootstrap. Discordant = tasks only A / only B got right.", "",
           table(["Pair (A − B)", "n", "A", "B", "Diff (pp)", "Diff 95% CI", "Discordant", "McNemar p", "Holm p"],
                 pairwise_rows(s["bfcl"].get("pairwise"), True)), "",
           "SWE-bench resolve rate: **exploratory** (descriptive; p-values not used for claims).", "",
           table(["Pair (A − B)", "n", "A", "B", "Diff (pp)", "Diff 95% CI", "Discordant", "McNemar p", "Holm p"],
                 pairwise_rows(s["swebench"].get("pairwise"), False)), ""]
    (res / "SUMMARY.md").write_text("\n".join(md))

    # provenance
    prov = {"campaign": a.campaign, "protocol": spec.get("protocol"), "protocolSha256": spec.get("protocolSha256"),
            "swebenchStage": stage,
            "amendments": [{k: r[k] for k in ("id", "file", "sha256", "appliedAt", "carriedConfigHashes")} | {"cellsInvalidated": len(r["moved"])} for r in amendments],
            "models": {}}
    for m in models:
        rt = d / m / "runtime"
        pre = [json.loads(p.read_text()) for p in sorted(rt.glob("preflight-*.json"))] if rt.exists() else []
        insp = [json.loads(p.read_text()) for p in sorted(rt.glob("inspect-*.json"))] if rt.exists() else []
        runs = {}
        for b in ("bfcl",):
            rp = d / m / b / "run.json"
            if rp.exists():
                r = json.loads(rp.read_text())
                runs[b] = {"configHash": r.get("configHash"), "commits": sorted({x["git"]["commit"] for x in r.get("sessions", [])}),
                           "infraRetries": r.get("infraRetries")}
        ep = d / m / "swebench" / "eval-provenance.json"
        prov["models"][m] = {
            "preflights": [{"checkedAt": p.get("checkedAt"), "reportable": p.get("reportable"), "counts": p.get("counts")} for p in pre],
            "servingImageRepoDigests": sorted({x for i in insp for x in (i.get("servingImageRepoDigests") or [])}),
            # snapshot revision only (the local cache path is not published)
            "checkpointRevision": sorted({pathlib.PurePath(str(i.get("checkpointSnapshot"))).name for i in insp}),
            "runs": runs,
            "swebenchEvaluation": json.loads(ep.read_text()) if ep.exists() else None,
        }
    occ = d / "occupancy.tsv"
    if occ.exists():
        rows = [l.split("\t") for l in occ.read_text().splitlines() if l.strip()]
        prov["serverOccupancy"] = [{"phase": r[0], "model": r[1], "start": r[2], "end": r[3], "seconds": int(r[4])} for r in rows]
        prov["serverOccupancyHours"] = round(sum(int(r[4]) for r in rows) / 3600, 2)
    (res / "provenance.json").write_text(json.dumps(prov, indent=1) + "\n")

    files = sorted(p for p in res.iterdir() if p.is_file() and p.name != "MANIFEST.sha256")
    (res / "MANIFEST.sha256").write_text("".join(f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n" for p in files))
    print(f"wrote {res}/SUMMARY.md, provenance.json, MANIFEST.sha256 ({len(files)} files)")


if __name__ == "__main__":
    main()
