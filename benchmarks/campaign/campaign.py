#!/usr/bin/env python3
"""Campaign runner: serve one local model at a time, verify it, run a frozen
BFCL and/or SWE-bench workload, score with the official evaluators, and keep
every attempt on disk (atomic writes, safe resume). ADR 0011.

    python3 benchmarks/campaign/campaign.py inspect  <campaign> <model>
    python3 benchmarks/campaign/campaign.py serve    <campaign> <model>
    python3 benchmarks/campaign/campaign.py stop     <campaign> <model>
    python3 benchmarks/campaign/campaign.py bfcl     <campaign> <model> [--threads N]
    python3 benchmarks/campaign/campaign.py swebench <campaign> <model> [--concurrency N]
    python3 benchmarks/campaign/campaign.py swebench-eval <campaign> <model> [--workers N]
    python3 benchmarks/campaign/campaign.py pull-images <campaign>

<campaign> is a directory name under .cache/campaigns/ (raw, local) that holds
campaign.json (written by freeze tooling): models, BFCL ids, SWE-bench ids,
protocol hash. Raw records stay local (SWE-bench run records contain dataset
text); aggregate, shareable outputs are produced by analyze.py.

Rules enforced here (frozen in the protocol):
- one kserve-* server at a time; launchers' GPU gate is never bypassed;
- a REPORTABLE harness preflight before any inference, saved per session;
- an attempt record, once final, is never overwritten; resume skips it;
  a record written under a different configuration hash aborts the run;
- infrastructure failures (independently classified) are retried at most
  twice; model, tool, context and budget outcomes are never retried.
"""
import argparse
import datetime
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

ROOT = pathlib.Path(__file__).resolve().parents[2]
CAMPAIGNS = ROOT / ".cache/campaigns"
NODE_CLI = ROOT / "harness/bin/harness.mjs"
VENV_BFCL = ROOT / ".cache/venv-bfcl/bin/python"
VENV_SWE = ROOT / ".cache/venv-swebench/bin/python"
MAX_INFRA_RETRIES = 2
SERVE = {
    "kanana": (["models/serving/kserve.sh", "start", "kanana", "16384"], ["models/serving/kserve.sh", "wait", "kanana"], ["models/serving/kserve.sh", "stop", "kanana"], "kserve-kanana"),
    "exaone": (["models/serving/kserve.sh", "start", "exaone", "16384"], ["models/serving/kserve.sh", "wait", "exaone"], ["models/serving/kserve.sh", "stop", "exaone"], "kserve-exaone"),
    "exaone-nothink": (["models/serving/kserve.sh", "start", "exaone", "16384"], ["models/serving/kserve.sh", "wait", "exaone"], ["models/serving/kserve.sh", "stop", "exaone"], "kserve-exaone"),
    "ax": (["models/serving/kserve.sh", "start", "ax", "16384"], ["models/serving/kserve.sh", "wait", "ax"], ["models/serving/kserve.sh", "stop", "ax"], "kserve-ax"),
    "solar-open2": (["models/serving/kserve-solar.sh", "start", "8192"], ["models/serving/kserve-solar.sh", "wait"], ["models/serving/kserve-solar.sh", "stop"], "kserve-solar"),
}
# Documented allowance for the small resident Sinsan processes (~0.8-1.2 GB
# per GPU); kserve-solar.sh already defaults to it. The gate itself still runs.
LAUNCH_ENV = {"KSERVE_ALLOW_FOREIGN_MIB": "2048"}


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def atomic_write(path, obj):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".tmp{os.getpid()}")
    tmp.write_text(json.dumps(obj, indent=1) + "\n")
    os.replace(tmp, path)


def sha256_file(p):
    return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()


def sh(cmd, **kw):
    return subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, **kw)


def campaign(name):
    d = CAMPAIGNS / name
    spec = json.loads((d / "campaign.json").read_text())
    return d, spec


def local_models():
    js = "import('./harness/src/agent/local-models.mjs').then(m => console.log(JSON.stringify(m.LOCAL_MODELS)))"
    return json.loads(sh(["node", "-e", js], check=True).stdout)


def git_state():
    head = sh(["git", "rev-parse", "HEAD"]).stdout.strip()
    dirty = bool(sh(["git", "status", "--porcelain", "--", "harness", "benchmarks", "datasets", "models/serving"]).stdout.strip())
    sub = sh(["git", "-C", "vendor/upstage-cli", "rev-parse", "HEAD"]).stdout.strip()
    sub_dirty = bool(sh(["git", "-C", "vendor/upstage-cli", "status", "--porcelain"]).stdout.strip())
    return {"commit": head, "dirty": dirty, "upstageCli": sub, "upstageCliDirty": sub_dirty}


def config_hash(spec, model, benchmark):
    """Everything that defines an attempt except time: model config, benchmark
    definition, protocol hash, code revisions."""
    # The endpoint URL is excluded: it is env-dependent and the served
    # identity is verified by the preflight, not by where it listens.
    cfg = {k: v for k, v in local_models()[model].items() if k != "baseUrl"}
    g = git_state()
    payload = {"model": cfg, "benchmark": benchmark, "protocolSha256": spec.get("protocolSha256"),
               "upstageCli": g["upstageCli"], "benchmarkSpec": spec[benchmark]}
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


# ── runtime inspection / serving ────────────────────────────────────────────

def inspect(name, model, save=True):
    d, spec = campaign(name)
    cfg = local_models()[model]
    gpus = sh(["nvidia-smi", "--query-gpu=index,memory.used,memory.total,utilization.gpu", "--format=csv,noheader,nounits"]).stdout.strip().splitlines()
    apps = sh(["nvidia-smi", "--query-compute-apps=pid,used_memory,process_name", "--format=csv,noheader,nounits"]).stdout.strip().splitlines()
    containers = sh(["docker", "ps", "--format", "{{.Names}}\t{{.Image}}\t{{.Status}}"]).stdout.strip().splitlines()
    kserve = [c.split("\t")[0] for c in containers if c.startswith("kserve-")]
    du = shutil.disk_usage("/")
    snap = pathlib.Path("/data/jackb/krasis/huggingface/hub") / f"models--{cfg['provenance']['hfRepo'].replace('/', '--')}" / "snapshots" / cfg["provenance"]["revision"]
    img = cfg["provenance"]["servingImage"]
    digests = sh(["docker", "image", "inspect", "--format", "{{json .RepoDigests}}", img]).stdout.strip()
    rec = {
        "at": now(), "model": model,
        "gpus": gpus, "computeApps": apps, "containers": containers, "kserveRunning": kserve,
        "diskFreeGB": round(du.free / 1e9, 1),
        "checkpointSnapshot": str(snap), "checkpointPresent": (snap / "config.json").exists(),
        "servingImage": img, "servingImagePresent": bool(digests), "servingImageRepoDigests": json.loads(digests) if digests else None,
        "git": git_state(),
    }
    blockers = []
    if not rec["checkpointPresent"]:
        blockers.append("checkpoint snapshot missing (no downloads allowed)")
    if not rec["servingImagePresent"]:
        blockers.append("serving image not present locally")
    if any(k != SERVE[model][3] for k in kserve):
        blockers.append(f"another kserve server is running: {kserve}")
    if rec["diskFreeGB"] < 200:
        blockers.append(f"free disk {rec['diskFreeGB']} GB below 200 GB floor")
    rec["blockers"] = blockers
    if save:
        atomic_write(d / model / "runtime" / f"inspect-{rec['at'].replace(':', '')}.json", rec)
    return rec


def serve(name, model):
    d, spec = campaign(name)
    rec = inspect(name, model)
    if rec["blockers"]:
        sys.exit(f"BLOCKED before launch: {rec['blockers']}")
    start, wait, _, container = SERVE[model]
    t0 = time.time()
    env = {**os.environ, **LAUNCH_ENV}
    r = sh(start, env=env)
    log = d / model / "runtime" / f"serve-{int(t0)}.log"
    log.parent.mkdir(parents=True, exist_ok=True)
    log.write_text(r.stdout + r.stderr)
    if r.returncode != 0 or "ABORT" in r.stdout:
        sys.exit(f"launcher refused or failed (exit {r.returncode}); see {log}")
    w = sh(wait, env=env, timeout=3600)
    (d / model / "runtime" / f"wait-{int(t0)}.log").write_text(w.stdout + w.stderr)
    if w.returncode != 0:
        sys.exit(f"server did not become healthy; see logs in {log.parent}")
    load_s = round(time.time() - t0, 1)
    pf = sh(["node", str(NODE_CLI), "preflight", "--agent", model, "--json"])
    path = d / model / "runtime" / f"preflight-{int(time.time())}.json"
    path.write_text(pf.stdout)
    result = json.loads(pf.stdout)
    atomic_write(d / model / "runtime" / "session.json", {"servedAt": now(), "loadSeconds": load_s, "container": container,
                                                          "preflight": str(path.relative_to(d)), "reportable": result["reportable"]})
    if not result["reportable"]:
        sys.exit(f"preflight BLOCKED: {result['blocking']} (server left running for inspection; stop it with `stop`)")
    print(f"{model}: serving, preflight REPORTABLE (load {load_s}s)")


def stop(name, model):
    d, _ = campaign(name)
    r = sh(SERVE[model][2])
    (d / model / "runtime" / f"stop-{int(time.time())}.log").write_text(r.stdout + r.stderr)
    print(r.stdout.strip())


def require_session(d, model):
    s = d / model / "runtime" / "session.json"
    if not s.exists() or not json.loads(s.read_text()).get("reportable"):
        sys.exit("no REPORTABLE preflight for this model in this campaign; run `serve` first")
    return json.loads(s.read_text())


# ── BFCL ────────────────────────────────────────────────────────────────────

INFRA_PATTERNS = re.compile(r"APIConnectionError|APITimeoutError|InternalServerError|ConnectionError|ConnectError|ReadTimeout|RemoteDisconnected|ServiceUnavailable|502|503|504")
CONTEXT_PATTERNS = re.compile(r"maximum context length|context_length_exceeded|too many tokens|is longer than the model's context", re.I)


def classify_bfcl_error(entry):
    tb = json.dumps(entry.get("traceback") or entry.get("metadata") or "") + str(entry.get("result"))
    if CONTEXT_PATTERNS.search(tb):
        return "context"
    if INFRA_PATTERNS.search(tb):
        return "infrastructure"
    return "model"


def bfcl_result_files(proj, registry):
    return sorted((proj / "result" / registry).rglob("*_result.json"))


def bfcl_errors(proj, registry):
    errs = {}
    for f in bfcl_result_files(proj, registry):
        for line in f.read_text().splitlines():
            e = json.loads(line)
            if isinstance(e.get("result"), str) and e["result"].startswith("Error during inference"):
                errs[e["id"]] = (f, classify_bfcl_error(e))
    return errs


def bfcl(name, model, threads):
    d, spec = campaign(name)
    require_session(d, model)
    registry = f"kab-{model}-FC"
    proj = d / model / "bfcl"
    proj.mkdir(parents=True, exist_ok=True)
    ids = spec["bfcl"]["ids"]
    (proj / "test_case_ids_to_generate.json").write_text(json.dumps(ids))
    marker = proj / "config-hash.txt"
    h = config_hash(spec, model, "bfcl")
    if marker.exists() and marker.read_text().strip() != h:
        sys.exit(f"{marker} was written under a different configuration; refusing to mix runs")
    marker.write_text(h)
    env = {**os.environ, "BFCL_PROJECT_ROOT": str(proj)}
    log = []
    retries = {}
    for round_no in range(MAX_INFRA_RETRIES + 1):
        t0 = time.time()
        g = sh([str(VENV_BFCL), "benchmarks/bfcl/kab_bfcl.py", "generate", "--model", registry, "--run-ids", "--num-threads", str(threads)], env=env)
        (proj / f"generate-{round_no}.log").write_text(g.stdout + g.stderr)
        log.append({"round": round_no, "seconds": round(time.time() - t0, 1), "exit": g.returncode})
        if g.returncode != 0:
            sys.exit(f"bfcl generate failed; see {proj}/generate-{round_no}.log")
        infra = {i: f for i, (f, c) in bfcl_errors(proj, registry).items() if c == "infrastructure"}
        if not infra or round_no == MAX_INFRA_RETRIES:
            break
        # Move only infrastructure-failed entries out (kept in quarantine) so
        # generate re-runs exactly those; the record of the failure survives.
        for f in {f for f in infra.values()}:
            keep, quarantine = [], []
            for line in f.read_text().splitlines():
                (quarantine if json.loads(line)["id"] in infra else keep).append(line)
            with open(proj / "quarantine-infra.jsonl", "a") as q:
                for line in quarantine:
                    q.write(json.dumps({"round": round_no, "file": f.name, "entry": json.loads(line)}) + "\n")
            f.write_text("\n".join(keep) + ("\n" if keep else ""))
        for i in infra:
            retries[i] = retries.get(i, 0) + 1
    cats = sorted(spec["bfcl"]["ids"].keys())
    t0 = time.time()
    e = sh([str(VENV_BFCL), "benchmarks/bfcl/kab_bfcl.py", "evaluate", "--model", registry, "--test-category", ",".join(cats), "--partial-eval"], env=env)
    (proj / "evaluate.log").write_text(e.stdout + e.stderr)
    if e.returncode != 0:
        sys.exit(f"bfcl evaluate failed; see {proj}/evaluate.log")
    errs = bfcl_errors(proj, registry)
    atomic_write(proj / "run.json", {"model": model, "registry": registry, "configHash": h, "finishedAt": now(),
                                     "generateRounds": log, "evaluateSeconds": round(time.time() - t0, 1),
                                     "infraRetries": retries, "errorsByClass": {c: sorted(i for i, (_, k) in errs.items() if k == c) for c in ("infrastructure", "context", "model")},
                                     "git": git_state()})
    print(f"{model}: BFCL done; errors {{{', '.join(f'{c}: {sum(1 for _, k in errs.values() if k == c)}' for c in ('infrastructure', 'context', 'model'))}}}")


# ── SWE-bench ───────────────────────────────────────────────────────────────

INFRA_REASONS = {"infrastructure_error", "agent_adapter_error", "check_infrastructure_error"}


def classify_run(run):
    """Final agent-side classification of one run record (official resolution
    comes later from the evaluator)."""
    if run.get("status") == "error" and (run.get("outcome") or {}).get("reason") in INFRA_REASONS:
        return "infrastructure"
    stop = (run.get("trace") or {}).get("stopReason")
    return {"done": "completed", "context_exhausted": "context_exhausted", "budget_exhausted": "budget_exhausted",
            "output_truncated": "output_truncated", "tool_error": "tool_error"}.get(stop, f"other:{stop}")


def swebench_attempt(d, spec, model, iid, h):
    base = d / model / "swebench" / "attempts" / iid
    base.mkdir(parents=True, exist_ok=True)
    existing = sorted(base.glob("attempt-*.json"))
    for p in existing:
        rec = json.loads(p.read_text())
        if rec["configHash"] != h:
            raise SystemExit(f"{p} was written under a different configuration; refusing to mix runs")
    if existing and json.loads(existing[-1].read_text())["final"]:
        return "skipped"
    n = len(existing)
    if n > MAX_INFRA_RETRIES:
        return "exhausted"
    runs_dir = base / f"runs-{n}"
    t0 = time.time()
    started = now()
    # Per-run preflight is mandatory; only a "dryrun" campaign (fake model, never
    # analyzed) may skip it.
    pre = [] if spec.get("kind") == "dryrun" else ["--preflight"]
    r = sh(["node", str(NODE_CLI), "swebench", "run", "--instance", iid, "--agent", model, *pre, "--runs-dir", str(runs_dir)])
    if r.returncode == 3:
        # Preflight blocked: the serving setup is wrong. Halt the campaign; no
        # attempt is recorded, so a later resume runs this instance normally.
        shutil.rmtree(runs_dir, ignore_errors=True)
        raise SystemExit(f"preflight BLOCKED on {iid}; campaign halted:\n{r.stdout[-1500:]}")
    runs = sorted(runs_dir.glob("run_*.json")) if runs_dir.exists() else []
    if not runs:
        # no run record at all: harness/preflight refused before running
        rec = {"instance_id": iid, "attempt": n, "configHash": h, "startedAt": started, "endedAt": now(),
               "seconds": round(time.time() - t0, 1), "classification": "infrastructure", "final": n >= MAX_INFRA_RETRIES,
               "detail": (r.stdout + r.stderr)[-2000:]}
    else:
        run = json.loads(runs[-1].read_text())
        cls = classify_run(run)
        patch = (run.get("patch") or {}).get("model_patch") or ""
        trace = run.get("trace") or {}
        rec = {"instance_id": iid, "attempt": n, "configHash": h, "startedAt": started, "endedAt": now(),
               "seconds": round(time.time() - t0, 1), "classification": cls,
               "final": cls != "infrastructure" or n >= MAX_INFRA_RETRIES,
               "run": str(runs[-1].relative_to(d)), "runSha256": sha256_file(runs[-1]),
               "status": run.get("status"), "outcomeReason": (run.get("outcome") or {}).get("reason"),
               "stopReason": trace.get("stopReason"), "turns": (run.get("metrics") or {}).get("turns"),
               "toolCalls": len(trace.get("toolCalls") or []),
               "toolErrors": sum(1 for t in (trace.get("toolCalls") or []) if t.get("ok") is False),
               "compactions": len(trace.get("compactions") or []),
               "patchBytes": len(patch.encode()), "patchSha256": hashlib.sha256(patch.encode()).hexdigest(),
               "filesChanged": (run.get("patch") or {}).get("filesChanged"),
               "usage": {k: (run.get("metrics") or {}).get(k) for k in ("promptTokens", "completionTokens", "totalTokens")},
               "agentDurationMs": (run.get("metrics") or {}).get("agentDurationMs"),
               "preflightReportable": ((run.get("provenance") or {}).get("preflight") or {}).get("reportable"),
               "provenance": {k: (run.get("provenance") or {}).get(k) for k in ("harness", "model", "task", "repo", "environment")}}
    atomic_write(base / f"attempt-{n}.json", rec)
    return rec["classification"]


def swebench(name, model, concurrency):
    d, spec = campaign(name)
    require_session(d, model)
    h = config_hash(spec, model, "swebench")
    ids = spec["swebench"]["ids"]

    def work(iid):
        while True:
            c = swebench_attempt(d, spec, model, iid, h)
            if c != "infrastructure":
                return iid, c
            last = sorted((d / model / "swebench" / "attempts" / iid).glob("attempt-*.json"))[-1]
            if json.loads(last.read_text())["final"]:
                return iid, c

    with ThreadPoolExecutor(concurrency) as ex:
        for iid, c in ex.map(work, ids):
            print(f"{model} {iid}: {c}", flush=True)


def final_attempt(d, model, iid):
    p = sorted((d / model / "swebench" / "attempts" / iid).glob("attempt-*.json"))
    return json.loads(p[-1].read_text()) if p else None


def swebench_eval(name, model, workers):
    d, spec = campaign(name)
    out = d / model / "swebench" / "eval"
    preds = d / model / "swebench" / "predictions.jsonl"
    rows, runs = [], []
    for iid in spec["swebench"]["ids"]:
        a = final_attempt(d, model, iid)
        if a and a.get("run"):
            runs.append(str(d / a["run"]))
    r = sh(["node", str(NODE_CLI), "swebench", "predictions", "--model-name", f"kab-{model}", "--out", str(preds), *runs])
    if r.returncode != 0:
        sys.exit(r.stdout + r.stderr)
    e = sh([str(VENV_SWE), "benchmarks/swebench/evaluate.py", "--predictions", str(preds), "--run-id", f"{name}-{model}",
            "--out", str(out), "--max-workers", str(workers), "--allow-pull"], timeout=6 * 3600)
    (d / model / "swebench" / "evaluate.log").write_text(e.stdout + e.stderr)
    if e.returncode != 0:
        sys.exit(f"official evaluation failed; see {d / model / 'swebench' / 'evaluate.log'}")
    print(e.stdout[-1500:])


def pull_images(name):
    """Pull every SWE-bench instance image once, pacing on Docker Hub rate
    limits; record each image's digest and the disk used."""
    d, spec = campaign(name)
    import pyarrow  # noqa: F401  (run with the swebench venv)
    import pyarrow.parquet as pq
    src = json.loads((ROOT / "datasets/swe-bench-verified/source.json").read_text())
    rows = {r["instance_id"]: r for r in pq.read_table(ROOT / ".cache/swebench" / src["revision"] / "test.parquet", columns=["instance_id", "image"]).to_pylist()}
    budget_gb = spec["resources"]["dockerBudgetGB"]
    log = d / "images.jsonl"
    before = sh(["docker", "system", "df", "--format", "{{json .}}"]).stdout
    for iid in spec["swebench"]["ids"]:
        img = rows[iid]["image"]
        if sh(["docker", "image", "inspect", img]).returncode == 0:
            continue
        while True:
            p = sh(["docker", "pull", "-q", img], timeout=3600)
            if p.returncode == 0:
                break
            if "toomanyrequests" in p.stderr:
                print("rate limited; waiting 10 min", flush=True)
                time.sleep(600)
                continue
            sys.exit(f"pull failed for {img}: {p.stderr[-500:]}")
        size = sh(["docker", "image", "inspect", "--format", "{{.Size}}", img]).stdout.strip()
        digest = sh(["docker", "image", "inspect", "--format", "{{json .RepoDigests}}", img]).stdout.strip()
        with open(log, "a") as f:
            f.write(json.dumps({"at": now(), "instance_id": iid, "image": img, "sizeBytes": int(size), "repoDigests": json.loads(digest)}) + "\n")
        used = sum(json.loads(l)["sizeBytes"] for l in log.read_text().splitlines()) / 1e9
        print(f"pulled {img} (cumulative logical size {used:.1f} GB)", flush=True)
    atomic_write(d / "images-summary.json", {"at": now(), "dockerDfBefore": before, "dockerDfAfter": sh(["docker", "system", "df", "--format", "{{json .}}"]).stdout, "budgetGB": budget_gb})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd")
    ap.add_argument("campaign")
    ap.add_argument("model", nargs="?")
    ap.add_argument("--threads", type=int, default=8)
    ap.add_argument("--concurrency", type=int, default=4)
    ap.add_argument("--workers", type=int, default=4)
    a = ap.parse_args()
    if a.cmd == "pull-images":
        return pull_images(a.campaign)
    if a.model not in SERVE:
        sys.exit(f"model must be one of {list(SERVE)}")
    {"inspect": lambda: print(json.dumps(inspect(a.campaign, a.model), indent=1)),
     "serve": lambda: serve(a.campaign, a.model),
     "stop": lambda: stop(a.campaign, a.model),
     "bfcl": lambda: bfcl(a.campaign, a.model, a.threads),
     "swebench": lambda: swebench(a.campaign, a.model, a.concurrency),
     "swebench-eval": lambda: swebench_eval(a.campaign, a.model, a.workers)}[a.cmd]()


if __name__ == "__main__":
    main()
