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
    python3 benchmarks/campaign/campaign.py prepare <campaign>     (clones + single-commit snapshots, serial)

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
import fcntl
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


def tree(path):
    return sh(["git", "rev-parse", f"HEAD:{path}"]).stdout.strip()


def tool_versions():
    v = {}
    for name, py, dist in (("bfcl-eval", VENV_BFCL, "bfcl-eval"), ("swebench", VENV_SWE, "swebench")):
        r = sh([str(py), "-c", f"import importlib.metadata as m; print(m.version('{dist}'))"])
        v[name] = r.stdout.strip() or None
    return v


def prompt_template_sha():
    js = "import('./harness/src/benchmarks/swebench.mjs').then(m => console.log(m.PROMPT_TEMPLATE_SHA256))"
    return sh(["node", "-e", js]).stdout.strip()


def config_hash(spec, model, benchmark):
    """Everything that defines an attempt except time and endpoint: the model's
    declared configuration, the benchmark definition, the protocol hash, the
    content of the code that runs it (git trees, so docs commits do not change
    it), the official tool versions and the SWE-bench prompt template."""
    # The endpoint URL is excluded: it is env-dependent and the served
    # identity is verified by the preflight, not by where it listens.
    cfg = {k: v for k, v in local_models()[model].items() if k != "baseUrl"}
    payload = {"model": cfg, "benchmark": benchmark, "protocolSha256": spec.get("protocolSha256"),
               "benchmarkSpec": spec[benchmark],
               "trees": {p: tree(p) for p in ("harness", "benchmarks", "models/serving", "vendor/upstage-cli")},
               "toolVersions": tool_versions(), "promptTemplateSha256": prompt_template_sha(),
               "bfclTemperature": 0.001}
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


def require_clean(spec):
    if spec.get("kind") == "dryrun":
        return
    g = git_state()
    if g["dirty"] or g["upstageCliDirty"]:
        sys.exit(f"working tree not clean ({g}); commit before running a {spec.get('kind')} campaign")


class Lock:
    """One process per (campaign, model, benchmark)."""
    def __init__(self, path):
        self.path = pathlib.Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def __enter__(self):
        self.f = open(self.path, "w")
        try:
            fcntl.flock(self.f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            sys.exit(f"another campaign process holds {self.path}")
        return self

    def __exit__(self, *a):
        fcntl.flock(self.f, fcntl.LOCK_UN)
        self.f.close()


def run_preflight(d, model):
    pf = sh(["node", str(NODE_CLI), "preflight", "--agent", model, "--json"], timeout=120)
    path = d / model / "runtime" / f"preflight-{int(time.time())}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(pf.stdout)
    try:
        result = json.loads(pf.stdout)
    except json.JSONDecodeError:
        sys.exit(f"preflight produced no JSON: {pf.stderr[-500:]}")
    if not result["reportable"]:
        sys.exit(f"preflight BLOCKED: {result['blocking']} ({path})")
    return path


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
    path = run_preflight(d, model)  # exits (server left running for inspection) if BLOCKED
    atomic_write(d / model / "runtime" / "session.json", {"servedAt": now(), "loadSeconds": load_s, "container": container,
                                                          "preflight": str(path.relative_to(d)), "reportable": True})
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

CONTEXT_PATTERNS = re.compile(r"maximum context length|context_length_exceeded|too many tokens|is longer than the model's context|max_model_len", re.I)
# Matched on the exception type / HTTP status in BFCL's stored traceback, never
# on free text (ids such as live_multiple_503-1-2 must not match).
TRANSIENT = re.compile(r"openai\.(APIConnectionError|APITimeoutError|InternalServerError|RateLimitError)\b|Error code: 5\d\d\b|httpx\.(ConnectError|ReadTimeout|RemoteProtocolError)\b")
CONFIG = re.compile(r"openai\.(NotFoundError|AuthenticationError|PermissionDeniedError|BadRequestError|UnprocessableEntityError)\b|Error code: 4\d\d\b")


def classify_bfcl_error(entry):
    """context: the request did not fit; infrastructure: transient serving
    fault (retried); configuration: the server rejected the request (wrong
    model id, missing parser flag, ...) — the run is aborted, never scored;
    model: anything else BFCL caught while handling the model's response."""
    tb = str(entry.get("traceback") or "") + " " + str(entry.get("result") or "")
    if CONTEXT_PATTERNS.search(tb):
        return "context"
    if TRANSIENT.search(tb):
        return "infrastructure"
    if CONFIG.search(tb):
        return "configuration"
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
    require_clean(spec)
    with Lock(d / model / "bfcl.lock"):
        return _bfcl(d, spec, name, model, threads)


def _bfcl(d, spec, name, model, threads):
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
    # retries are counted across sessions from the quarantine record
    retries = {}
    qfile = proj / "quarantine-infra.jsonl"
    if qfile.exists():
        for line in qfile.read_text().splitlines():
            i = json.loads(line)["entry"]["id"]
            retries[i] = retries.get(i, 0) + 1
    for round_no in range(MAX_INFRA_RETRIES + 1):
        if spec.get("kind") != "dryrun":
            run_preflight(d, model)  # the server answering now is the declared one
        t0 = time.time()
        g = sh([str(VENV_BFCL), "benchmarks/bfcl/kab_bfcl.py", "generate", "--model", registry, "--run-ids", "--num-threads", str(threads)], env=env, timeout=24 * 3600)
        (proj / f"generate-{round_no}.log").write_text(g.stdout + g.stderr)
        log.append({"round": round_no, "seconds": round(time.time() - t0, 1), "exit": g.returncode})
        if g.returncode != 0:
            sys.exit(f"bfcl generate failed; see {proj}/generate-{round_no}.log")
        infra = {i: f for i, (f, c) in bfcl_errors(proj, registry).items()
                 if c == "infrastructure" and retries.get(i, 0) < MAX_INFRA_RETRIES}
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
    errs = bfcl_errors(proj, registry)
    config_errs = sorted(i for i, (_, c) in errs.items() if c == "configuration")
    if config_errs:
        sys.exit(f"configuration errors (server rejected requests) for {len(config_errs)} entries, e.g. {config_errs[:3]}; not scored — fix serving and re-run")
    present = set()
    for f in bfcl_result_files(proj, registry):
        present |= {json.loads(l)["id"] for l in f.read_text().splitlines() if l.strip()}
    wanted = {i for ids in spec["bfcl"]["ids"].values() for i in ids}
    if wanted - present or present - wanted:
        sys.exit(f"result coverage mismatch: missing {sorted(wanted - present)[:5]} (+{max(0, len(wanted - present) - 5)}), unexpected {sorted(present - wanted)[:5]}")
    cats = sorted(spec["bfcl"]["ids"].keys())
    t0 = time.time()
    e = sh([str(VENV_BFCL), "benchmarks/bfcl/kab_bfcl.py", "evaluate", "--model", registry, "--test-category", ",".join(cats), "--partial-eval"], env=env, timeout=12 * 3600)
    (proj / "evaluate.log").write_text(e.stdout + e.stderr)
    if e.returncode != 0:
        sys.exit(f"bfcl evaluate failed; see {proj}/evaluate.log")
    errs = bfcl_errors(proj, registry)
    prev = json.loads((proj / "run.json").read_text()) if (proj / "run.json").exists() else {}
    history = prev.get("sessions", []) + ([{k: v for k, v in prev.items() if k != "sessions"}] if prev and "sessions" not in prev else [])
    current = {"model": model, "registry": registry, "configHash": h, "finishedAt": now(),
                                     "generateRounds": log, "evaluateSeconds": round(time.time() - t0, 1),
                                     "infraRetries": retries, "errorsByClass": {c: sorted(i for i, (_, k) in errs.items() if k == c) for c in ("infrastructure", "configuration", "context", "model")},
                                     "git": git_state()}
    # append-only: every invocation is kept; top-level fields describe the latest
    atomic_write(proj / "run.json", {**current, "sessions": history + [current],
                                     "generateSecondsAllSessions": round(sum(r["seconds"] for s in history + [current] for r in s.get("generateRounds", [])), 1)})
    print(f"{model}: BFCL done; errors {{{', '.join(f'{c}: {sum(1 for _, k in errs.values() if k == c)}' for c in ('infrastructure', 'context', 'model'))}}}")


# ── SWE-bench ───────────────────────────────────────────────────────────────

INFRA_REASONS = {"infrastructure_error", "agent_adapter_error", "check_infrastructure_error"}


def budget_kind(msg):
    m = str(msg or "")
    if "wall-time" in m or "[deadline]" in m:
        return "wall_clock"
    if "step budget" in m:
        return "steps"
    if "tool" in m and "budget" in m:
        return "tool_calls"
    return "other"


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
    if runs_dir.exists():
        # interrupted before its attempt record was written: keep, never reuse
        runs_dir.rename(base / f"runs-{n}.stale-{int(time.time())}")
    image = instance_rows()[iid]["image"]
    if sh(["docker", "image", "inspect", image]).returncode != 0:
        raise SystemExit(f"official image {image} not present; run pull-images first (no implicit pulls during a campaign)")
    t0 = time.time()
    started = now()
    # Per-run preflight is mandatory; only a "dryrun" campaign (fake model, never
    # analyzed) may skip it.
    pre = [] if spec.get("kind") == "dryrun" else ["--preflight"]
    try:
        r = sh(["node", str(NODE_CLI), "swebench", "run", "--instance", iid, "--agent", model, *pre, "--runs-dir", str(runs_dir)],
               timeout=SWE_AGENT_TIMEOUT_S + 900)
    except subprocess.TimeoutExpired:
        r = subprocess.CompletedProcess([], 124, "", "harness run exceeded its outer timeout")
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
               "budgetKind": budget_kind(trace.get("agentError")) if trace.get("stopReason") == "budget_exhausted" else None,
               "agentDiagnostics": ((run.get("provenance") or {}).get("model") or {}).get("agentDiagnostics"),
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


_ROWS = {}


def instance_rows():
    if not _ROWS:
        path = next((ROOT / ".cache/swebench").glob("*/instances.jsonl"))
        for line in path.read_text().splitlines():
            r = json.loads(line)
            _ROWS[r["instance_id"]] = r
    return _ROWS


# Must match ENVELOPE.timeoutSec (harness/src/benchmarks/swebench.mjs); the outer
# subprocess timeout adds 15 minutes so the agent's own wall clock always binds first.
SWE_AGENT_TIMEOUT_S = 2700


def prepare(name):
    """Serial: clone each repository once and build every single-commit
    workspace snapshot before any run (no cloning during a campaign)."""
    d, spec = campaign(name)
    ids_file = d / "swebench-ids.json"
    ids_file.write_text(json.dumps(spec["swebench"]["ids"]))
    r = sh(["node", str(NODE_CLI), "swebench", "prepare", "--ids-file", str(ids_file)], timeout=6 * 3600)
    (d / "prepare.log").write_text(r.stdout + r.stderr)
    if r.returncode != 0:
        sys.exit(f"prepare failed; see {d / 'prepare.log'}")
    print(r.stdout.strip().splitlines()[-1] if r.stdout.strip() else "prepared")


def stage_ids(spec, stage):
    """Nested stages (ADR 0011): stage N = the first N frozen stages. Without a
    stage, all ids."""
    stages = spec["swebench"].get("stages")
    if stage is None:
        return spec["swebench"]["ids"]
    if not stages or not 1 <= stage <= len(stages):
        sys.exit(f"campaign has no stage {stage}")
    return [i for s in stages[:stage] for i in s]


def swebench(name, model, concurrency, stage=None):
    d, spec = campaign(name)
    require_session(d, model)
    require_clean(spec)
    with Lock(d / model / "swebench.lock"):
        return _swebench(d, spec, model, concurrency, stage_ids(spec, stage))


def _swebench(d, spec, model, concurrency, ids):
    env_t = sh(["node", "-e", "import('./harness/src/benchmarks/swebench.mjs').then(m => console.log(m.ENVELOPE.timeoutSec))"]).stdout.strip()
    if env_t != str(SWE_AGENT_TIMEOUT_S):
        sys.exit(f"SWE_AGENT_TIMEOUT_S {SWE_AGENT_TIMEOUT_S} != ENVELOPE.timeoutSec {env_t}")
    # the configuration hash covers the whole frozen spec (all stages), so
    # running stage 2 later resumes the same configuration
    h = config_hash(spec, model, "swebench")

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


def swebench_eval(name, model, workers, stage=None):
    d, spec = campaign(name)
    require_clean(spec)
    out = d / model / "swebench" / "eval"
    preds = d / model / "swebench" / "predictions.jsonl"
    rows, runs, accounting = [], [], {}
    for iid in stage_ids(spec, stage):
        a = final_attempt(d, model, iid)
        if not a or not a.get("final"):
            sys.exit(f"{iid}: no final attempt yet; finish the swebench step first")
        accounting[iid] = {"classification": a["classification"], "hasRun": bool(a.get("run"))}
        if a.get("run"):
            runs.append(str(d / a["run"]))
    # Every campaign id is accounted for; ids without a run record are not sent
    # to the evaluator (they are not empty patches) and stay in the denominator.
    atomic_write(d / model / "swebench" / "accounting.json", accounting)
    r = sh(["node", str(NODE_CLI), "swebench", "predictions", "--model-name", f"kab-{model}", "--out", str(preds), *runs])
    if r.returncode != 0:
        sys.exit(r.stdout + r.stderr)
    e = sh([str(VENV_SWE), "benchmarks/swebench/evaluate.py", "--predictions", str(preds), "--run-id", f"{name}-{model}",
            "--out", str(out), "--max-workers", str(workers), "--allow-pull"], timeout=6 * 3600)
    (d / model / "swebench" / "evaluate.log").write_text(e.stdout + e.stderr)
    if e.returncode != 0:
        sys.exit(f"official evaluation failed; see {d / model / 'swebench' / 'evaluate.log'}")
    atomic_write(d / model / "swebench" / "eval-provenance.json", {"at": now(), "git": git_state(), "toolVersions": tool_versions()})
    print(e.stdout[-1500:])


def docker_images_bytes():
    """Actual (layer-deduplicated) bytes used by all images, from docker system df."""
    out = sh(["docker", "system", "df", "--format", "{{.Type}}\t{{.Size}}"]).stdout
    for line in out.splitlines():
        t, size = line.split("\t")
        if t == "Images":
            m = re.match(r"([\d.]+)\s*([kMGT]?B)", size)
            mult = {"B": 1, "kB": 1e3, "MB": 1e6, "GB": 1e9, "TB": 1e12}[m.group(2)]
            return int(float(m.group(1)) * mult)
    raise SystemExit("cannot read docker system df")


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
    base_file = d / "images-baseline-bytes.txt"
    if not base_file.exists():
        base_file.write_text(str(docker_images_bytes()))
    base_bytes = int(base_file.read_text())
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
        used_now = docker_images_bytes()
        if (used_now - base_bytes) / 1e9 > budget_gb:
            sys.exit(f"Docker image budget exceeded: +{(used_now - base_bytes) / 1e9:.1f} GB > {budget_gb} GB; stopping pulls")
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
    ap.add_argument("--stage", type=int)
    a = ap.parse_args()
    if a.cmd == "pull-images":
        return pull_images(a.campaign)
    if a.cmd == "prepare":
        return prepare(a.campaign)
    if a.model not in SERVE:
        sys.exit(f"model must be one of {list(SERVE)}")
    {"inspect": lambda: print(json.dumps(inspect(a.campaign, a.model), indent=1)),
     "serve": lambda: serve(a.campaign, a.model),
     "stop": lambda: stop(a.campaign, a.model),
     "bfcl": lambda: bfcl(a.campaign, a.model, a.threads),
     "swebench": lambda: swebench(a.campaign, a.model, a.concurrency, a.stage),
     "swebench-eval": lambda: swebench_eval(a.campaign, a.model, a.workers, a.stage)}[a.cmd]()


if __name__ == "__main__":
    main()
