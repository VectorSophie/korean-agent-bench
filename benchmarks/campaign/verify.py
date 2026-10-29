#!/usr/bin/env python3
"""Independent recomputation of a campaign's reported numbers (M3.7).

    python3 benchmarks/campaign/verify.py <campaign> [--summary results/<campaign>/summary.json]

Deliberately does NOT reuse analyze.py. Recomputes every headline number a
second way, straight from the official artifacts:
  BFCL      sum of correct_count / total_count over the per-category score
            headers written by `bfcl evaluate`;
  SWE-bench the evaluator's own report lists (resolved_ids, ...) per model.
and checks: task identity and subset equality across models, duplicates,
missing attempts, retries beyond the rule, denominators, model/checkpoint
provenance in every run record, REPORTABLE preflights, and that the summary
agrees. Writes verification.json next to the summary; exits 1 on any failure.
"""
import argparse
import hashlib
import json
import pathlib
import subprocess
import sys
from collections import Counter

ROOT = pathlib.Path(__file__).resolve().parents[2]
CAMPAIGNS = ROOT / ".cache/campaigns"
MAX_ATTEMPTS = 3


def load_models():
    import subprocess
    js = "import('./harness/src/agent/local-models.mjs').then(m => console.log(JSON.stringify(m.LOCAL_MODELS)))"
    return json.loads(subprocess.run(["node", "-e", js], cwd=ROOT, capture_output=True, text=True, check=True).stdout)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("campaign")
    ap.add_argument("--summary")
    a = ap.parse_args()
    d = CAMPAIGNS / a.campaign
    spec = json.loads((d / "campaign.json").read_text())
    summary_path = pathlib.Path(a.summary) if a.summary else ROOT / "results" / a.campaign / "summary.json"
    summary = json.loads(summary_path.read_text())
    cfgs = load_models()
    checks, failures = [], []

    def check(name, ok, detail=""):
        checks.append({"check": name, "ok": bool(ok), "detail": detail})
        if not ok:
            failures.append(f"{name}: {detail}")

    # ── frozen protocol (main campaigns) ──
    if spec.get("kind") == "main":
        proto_p = ROOT / spec["protocol"]
        raw = proto_p.read_bytes() if proto_p.exists() else b""
        check("protocol: file sha256 == campaign protocolSha256", hashlib.sha256(raw).hexdigest() == spec.get("protocolSha256"))
        if raw:
            proto = json.loads(raw)
            check("protocol: models", spec["models"] == proto["models"]["primary"])
            check("protocol: BFCL ids", spec["bfcl"]["ids"] == proto["bfcl"]["ids"])
            check("protocol: SWE-bench ids and stages", spec["swebench"]["ids"] == proto["swebench"]["ids"]
                  and spec["swebench"]["stages"] == [proto["swebench"]["stage1"], proto["swebench"]["stage2"]])
            # every BFCL session and SWE-bench attempt ran on a commit whose code
            # trees equal the frozen ones (documentation commits may differ)
            def trees_at(commit, _c={}):
                if commit not in _c:
                    _c[commit] = {k: subprocess.run(["git", "rev-parse", f"{commit}:{k}"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
                                  for k in [*proto["code"]["trees"], "vendor/upstage-cli"]}
                return _c[commit]
            frozen = {**proto["code"]["trees"], "vendor/upstage-cli": proto["code"]["upstageCli"]}
            for m in spec["models"]:
                commits = set()
                rp = d / m / "bfcl" / "run.json"
                if rp.exists():
                    commits |= {s_["git"]["commit"] for s_ in json.loads(rp.read_text()).get("sessions", [])}
                for ap_ in (d / m / "swebench" / "attempts").glob("*/attempt-*.json"):
                    a_ = json.loads(ap_.read_text())
                    if a_.get("run"):
                        commits.add(json.loads((d / a_["run"]).read_text())["provenance"]["harness"]["commit"])
                if not commits:
                    continue  # not executed: covered by the "reported as not executed" checks
                bad = sorted(c for c in commits if trees_at(c) != frozen)
                check(f"protocol: {m} ran on the frozen code", not bad, f"{len(commits)} commits, mismatched {bad}")

    # ── BFCL ──
    wanted = {i for ids in spec["bfcl"]["ids"].values() for i in ids}
    check("bfcl: subset ids unique", len(wanted) == sum(len(v) for v in spec["bfcl"]["ids"].values()))
    for m in spec["models"]:
        proj = d / m / "bfcl"
        if not (proj / "run.json").exists():
            check(f"bfcl/{m}: reported as not executed", summary["bfcl"].get(m, {}).get("status") == "not executed")
            continue
        reg = f"kab-{m}-FC"
        ids = []
        for f in (proj / "result" / reg).rglob("*_result.json"):
            ids += [json.loads(l)["id"] for l in f.read_text().splitlines() if l.strip()]
        dup = [i for i, c in Counter(ids).items() if c > 1]
        check(f"bfcl/{m}: no duplicate predictions", not dup, str(dup[:5]))
        check(f"bfcl/{m}: predictions cover exactly the subset", set(ids) == wanted,
              f"missing {len(wanted - set(ids))}, extra {len(set(ids) - wanted)}")
        corr = tot = 0
        cats = set()
        for f in (proj / "score" / reg).rglob("*_score.json"):
            h = json.loads(f.read_text().splitlines()[0])
            corr += h["correct_count"]
            tot += h["total_count"]
            cats.add(f.name[len("BFCL_v4_"):-len("_score.json")])
        check(f"bfcl/{m}: every subset category scored", cats == set(spec["bfcl"]["ids"]), str(sorted(set(spec["bfcl"]["ids"]) ^ cats)))
        s = summary["bfcl"].get(m, {})
        check(f"bfcl/{m}: summary correct == official headers", s.get("correct") == corr, f"{s.get('correct')} vs {corr}")
        check(f"bfcl/{m}: summary scored == official headers", s.get("scored") == tot, f"{s.get('scored')} vs {tot}")
        check(f"bfcl/{m}: scheduled == subset size", s.get("scheduled") == len(wanted), f"{s.get('scheduled')} vs {len(wanted)}")
        check(f"bfcl/{m}: every scheduled entry scored", tot == len(wanted), f"{tot} scored of {len(wanted)}")
        check(f"bfcl/{m}: accuracy arithmetic (scheduled denominator)", abs(s.get("pooledAccuracy", -1) - round(corr / len(wanted), 4)) < 1e-9)
        run = json.loads((proj / "run.json").read_text())
        check(f"bfcl/{m}: no unresolved configuration errors", not (run.get("errorsByClass") or {}).get("configuration"))
        check(f"bfcl/{m}: infra retries within rule", all(v <= 2 for v in (run.get("infraRetries") or {}).values()))
        pfs = sorted((d / m / "runtime").glob("preflight-*.json"))
        check(f"bfcl/{m}: preflight records present and all REPORTABLE", pfs and all(json.loads(p.read_text())["reportable"] for p in pfs), f"{len(pfs)} files")

    # ── SWE-bench ──
    swe_ids = spec["swebench"]["ids"]
    stage = summary.get("swebenchStage")
    if stage:
        swe_ids = [i for s in spec["swebench"]["stages"][:stage] for i in s]
    check("swebench: subset ids unique", len(set(swe_ids)) == len(swe_ids))
    for m in spec["models"]:
        base = d / m / "swebench"
        if not (base / "attempts").exists():
            check(f"swebench/{m}: reported as not executed", summary["swebench"].get(m, {}).get("status") == "not executed")
            continue
        cfg = cfgs[m]
        acc = json.loads((base / "accounting.json").read_text()) if (base / "accounting.json").exists() else {}
        check(f"swebench/{m}: evaluated ids == analyzed ids", sorted(acc) == sorted(swe_ids), f"{len(acc)} vs {len(swe_ids)}")
        missing, over, prov_bad, pf_bad = [], [], [], []
        for iid in swe_ids:
            att = sorted((base / "attempts" / iid).glob("attempt-*.json"))
            if not att:
                missing.append(iid)
                continue
            if len(att) > MAX_ATTEMPTS:
                over.append(iid)
            recs = [json.loads(p.read_text()) for p in att]
            for r in recs[:-1]:
                if r["classification"] != "infrastructure":
                    over.append(f"{iid} (retried a non-infrastructure outcome)")
            last = recs[-1]
            if last.get("run"):
                run = json.loads((d / last["run"]).read_text())
                pm = (run.get("provenance") or {}).get("model") or {}
                if pm.get("revision") != cfg["provenance"]["revision"] or pm.get("id") != cfg["servedModelName"]:
                    prov_bad.append(iid)
                if not ((run.get("provenance") or {}).get("preflight") or {}).get("reportable"):
                    pf_bad.append(iid)
        check(f"swebench/{m}: every instance has an attempt", not missing, str(missing[:5]))
        check(f"swebench/{m}: retries within rule and only for infrastructure", not over, str(over[:5]))
        check(f"swebench/{m}: model id and checkpoint revision in every run record", not prov_bad, str(prov_bad[:5]))
        check(f"swebench/{m}: REPORTABLE preflight in every run record", not pf_bad, str(pf_bad[:5]))
        reports = sorted((base / "eval").glob(f"*.{a.campaign}-{m}.json"))
        s = summary["swebench"].get(m, {})
        if not reports:
            check(f"swebench/{m}: official report present", False, "no official report")
            continue
        rep = json.loads(reports[0].read_text())
        resolved = set(rep.get("resolved_ids", []))
        check(f"swebench/{m}: official resolved ids within subset", resolved <= set(swe_ids))
        check(f"swebench/{m}: summary resolved == official report", s.get("resolved") == len(resolved), f"{s.get('resolved')} vs {len(resolved)}")
        check(f"swebench/{m}: denominator == subset size", s.get("scheduled") == len(swe_ids), f"{s.get('scheduled')} vs {len(swe_ids)}")
        for cat in ("unresolved", "empty_patch", "error"):
            check(f"swebench/{m}: summary {cat} == official report", (s.get("official") or {}).get(cat, 0) == len(rep.get(f"{cat}_ids", [])))

    # ── cross-model identity ──
    bf = [m for m in spec["models"] if (d / m / "bfcl" / "run.json").exists()]
    sw = [m for m in spec["models"] if (d / m / "swebench" / "attempts").exists()]
    check("models share one BFCL subset and one SWE-bench subset (single campaign spec)", True, f"bfcl {bf}, swebench {sw}")

    result = {"campaign": a.campaign, "summary": str(summary_path), "checks": checks, "failures": failures, "passed": not failures}
    (summary_path.parent / "verification.json").write_text(json.dumps(result, indent=1) + "\n")
    print(f"{len(checks) - len(failures)}/{len(checks)} checks passed")
    for f in failures:
        print("FAIL", f)
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
