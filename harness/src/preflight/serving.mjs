// Serving preflight: compare a local model's DECLARED configuration
// (local-models.mjs) with what the running server and its container actually
// expose. Read-only — it issues one GET /v1/models and `docker inspect` calls;
// it never starts, stops or reconfigures anything.
//
// Every field gets one status:
//   verified       observed and equal to the declaration
//   declared_only  not observable through this method (recorded, not checked)
//   mismatch       observed and different from the declaration
//   unavailable    should be observable but the observation failed or is missing
//
// A run is reportable only if no field is `mismatch` and no critical field is
// `unavailable` (fail closed). See docs/adr/0008-serving-preflight.md.
import { execFileSync } from "node:child_process";
import { getLocalModelConfig } from "../agent/local-models.mjs";

export const STATUS = Object.freeze({
  VERIFIED: "verified",
  DECLARED_ONLY: "declared_only",
  MISMATCH: "mismatch",
  UNAVAILABLE: "unavailable"
});

const SNAPSHOT_RE = /\/snapshots\/([0-9a-f]{40})(?:\/|$)/;

// ── default observers (real system); tests inject fakes ──────────────────────

async function httpModels(baseUrl, { timeoutMs = 5000, apiKey = process.env.LOCAL_MODEL_API_KEY } = {}) {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error(`GET /models returned HTTP ${res.status}`);
  return res.json();
}

function dockerInspect(kind, ref) {
  const args = kind === "image" ? ["image", "inspect", ref] : ["inspect", "--type", "container", ref];
  let out;
  try {
    out = execFileSync("docker", args, { stdio: ["ignore", "pipe", "pipe"], timeout: 10000 }).toString("utf8");
  } catch (err) {
    const stderr = String(err.stderr || "");
    if (/No such (object|container|image)/i.test(stderr)) return null;
    throw new Error(`docker ${args.join(" ")} failed: ${stderr.trim() || err.message}`, { cause: err });
  }
  return JSON.parse(out)[0] ?? null;
}

async function defaultGitInfo() {
  const { getHarnessInfo } = await import("../task/runner.mjs");
  return getHarnessInfo();
}

export const defaultObservers = {
  models: httpModels,
  container: (name) => dockerInspect("container", name),
  image: (ref) => dockerInspect("image", ref),
  git: defaultGitInfo
};

// ── helpers ──────────────────────────────────────────────────────────────────

/** Parse vLLM CLI args (from `docker inspect` .Args) into a map. Handles both
 *  `--model PATH` and the positional model path used by the Solar launcher. */
export function parseServeArgs(argv) {
  const flags = {};
  const positional = [];
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i++) {
    const a = String(list[i]);
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const next = list[i + 1];
      if (next !== undefined && !String(next).startsWith("--")) { flags[a.slice(2)] = String(next); i++; }
      else flags[a.slice(2)] = true;
    } else if (a !== "serve") {
      positional.push(a);
    }
  }
  return { flags, model: flags.model ?? positional[0] ?? null };
}

function field(name, { critical, declared, observed = null, status, source = null, note = null }) {
  return { field: name, critical, declared, observed, status, source, note };
}

function compare(name, critical, declared, observed, source, note = null) {
  if (observed === undefined || observed === null) {
    return field(name, { critical, declared, observed: null, status: STATUS.UNAVAILABLE, source, note });
  }
  const ok = String(observed) === String(declared);
  return field(name, { critical, declared, observed, status: ok ? STATUS.VERIFIED : STATUS.MISMATCH, source, note });
}

// ── main entry ───────────────────────────────────────────────────────────────

export async function runServingPreflight(agentKey, { baseUrl = null, containerName = null, observers = {} } = {}) {
  const obs = { ...defaultObservers, ...observers };
  const cfg = getLocalModelConfig(agentKey);
  if (!cfg) throw new Error(`unknown local model '${agentKey}'`);
  const p = cfg.provenance;
  const url = baseUrl || cfg.baseUrl;
  const container = containerName || p.containerName || null;
  const fields = [];
  const observations = { baseUrl: url, containerName: container };

  // 1. Serving API ------------------------------------------------------------
  let card = null;
  try {
    const body = await obs.models(url);
    const data = Array.isArray(body?.data) ? body.data : [];
    observations.servedModels = data.map((m) => m.id);
    fields.push(field("endpoint", { critical: true, declared: url, observed: url, status: STATUS.VERIFIED, source: "GET /models" }));
    card = data.find((m) => m.id === cfg.servedModelName) || null;
    fields.push(field("servedModelId", {
      critical: true, declared: cfg.servedModelName, observed: observations.servedModels.join(", ") || null,
      status: card ? STATUS.VERIFIED : (data.length ? STATUS.MISMATCH : STATUS.UNAVAILABLE), source: "GET /models data[].id"
    }));
  } catch (err) {
    fields.push(field("endpoint", { critical: true, declared: url, status: STATUS.UNAVAILABLE, source: "GET /models", note: err.message }));
    fields.push(field("servedModelId", { critical: true, declared: cfg.servedModelName, status: STATUS.UNAVAILABLE, source: "GET /models", note: "endpoint unreachable" }));
  }
  fields.push(compare("maxModelLen", true, cfg.contextLimit, card?.max_model_len, "GET /models data[].max_model_len"));

  // 2. Container --------------------------------------------------------------
  let inspect = null;
  let containerError = null;
  if (!container) containerError = "no container name declared or given";
  else {
    try { inspect = await obs.container(container); if (!inspect) containerError = `container '${container}' not found`; }
    catch (err) { containerError = err.message; }
  }
  fields.push(field("container", {
    critical: true, declared: container, observed: inspect ? inspect.Name?.replace(/^\//, "") || container : null,
    status: inspect ? (inspect.State?.Running === false ? STATUS.MISMATCH : STATUS.VERIFIED) : STATUS.UNAVAILABLE,
    source: "docker inspect", note: inspect?.State?.Running === false ? "container exists but is not running" : containerError
  }));

  const args = parseServeArgs(inspect?.Args);
  const flag = (k) => (inspect ? (args.flags[k] ?? null) : undefined);

  // Image: the declared value is `repo@sha256:<manifest digest>`; the container
  // records an image ID, whose RepoDigests must include the declared digest.
  if (!inspect) {
    fields.push(field("servingImage", { critical: true, declared: p.servingImage, status: STATUS.UNAVAILABLE, source: "docker image inspect", note: containerError }));
  } else {
    let image = null;
    let imageErr = null;
    try { image = await obs.image(inspect.Image); } catch (err) { imageErr = err.message; }
    const digests = image?.RepoDigests || [];
    observations.imageRef = inspect.Config?.Image ?? null;
    observations.imageId = inspect.Image ?? null;
    fields.push(field("servingImage", {
      critical: true, declared: p.servingImage, observed: digests.join(", ") || null,
      status: !image ? STATUS.UNAVAILABLE : digests.includes(p.servingImage) ? STATUS.VERIFIED : STATUS.MISMATCH,
      source: "docker inspect .Image -> docker image inspect .RepoDigests",
      note: imageErr || (observations.imageRef && !observations.imageRef.includes("@sha256:") ? `launched by tag '${observations.imageRef}'` : null)
    }));
  }

  // Checkpoint: the HF cache snapshot directory is named by commit SHA. Both
  // the API's `root` and the container's model argument are checked. This
  // verifies WHICH snapshot directory was served, not that its files match
  // the Hub (no file hashing here).
  const revs = [card?.root, inspect ? args.model : null].map((s) => (typeof s === "string" ? s.match(SNAPSHOT_RE)?.[1] : null)).filter(Boolean);
  const revNote = "snapshot directory name from GET /models root and the container's model argument; file contents are not hashed";
  if (revs.length === 0) fields.push(field("checkpointRevision", { critical: true, declared: p.revision, status: STATUS.UNAVAILABLE, source: "snapshot path", note: revNote }));
  else {
    const allMatch = revs.every((r) => r === p.revision);
    fields.push(field("checkpointRevision", { critical: true, declared: p.revision, observed: [...new Set(revs)].join(", "), status: allMatch ? STATUS.VERIFIED : STATUS.MISMATCH, source: "snapshot path", note: revNote }));
  }

  fields.push(compare("servedModelNameArg", true, cfg.servedModelName, flag("served-model-name"), "container args"));
  fields.push(compare("tensorParallel", true, p.tensorParallel, flag("tensor-parallel-size"), "container args"));
  fields.push(compare("maxModelLenArg", true, cfg.contextLimit, flag("max-model-len"), "container args"));
  if (!inspect) {
    fields.push(field("reasoningParser", { critical: true, declared: p.reasoningParser, status: STATUS.UNAVAILABLE, source: "container args", note: containerError }));
    fields.push(field("toolCallParser", { critical: true, declared: p.toolCallParser, status: STATUS.UNAVAILABLE, source: "container args", note: containerError }));
  } else {
    const rp = args.flags["reasoning-parser"] ?? null;
    fields.push(field("reasoningParser", { critical: true, declared: p.reasoningParser, observed: rp, status: rp === (p.reasoningParser ?? null) ? STATUS.VERIFIED : STATUS.MISMATCH, source: "container args" }));
    const tp = args.flags["tool-call-parser"] ?? null;
    const auto = args.flags["enable-auto-tool-choice"] === true;
    fields.push(field("toolCallParser", {
      critical: true, declared: p.toolCallParser, observed: tp ? `${tp}${auto ? " +auto-tool-choice" : ""}` : null,
      status: tp === p.toolCallParser && auto ? STATUS.VERIFIED : STATUS.MISMATCH, source: "container args",
      note: tp === p.toolCallParser && !auto ? "--enable-auto-tool-choice missing" : null
    }));
  }
  if (p.maxNumSeqs != null) fields.push(compare("maxNumSeqs", true, p.maxNumSeqs, flag("max-num-seqs"), "container args"));
  if (p.logitsProcessor) {
    const lp = flag("logits-processors");
    fields.push(field("logitsProcessor", {
      critical: true, declared: p.logitsProcessor, observed: lp ?? null, source: "container args",
      status: lp === undefined || lp === null ? STATUS.UNAVAILABLE : String(lp).includes(p.logitsProcessor) ? STATUS.VERIFIED : STATUS.MISMATCH
    }));
  }

  // Declared-only: not observable through the serving API or container args.
  const q = inspect ? args.flags.quantization : undefined;
  fields.push(field("quantization", {
    critical: false, declared: p.quantization, observed: q ?? null, status: q ? STATUS.MISMATCH : STATUS.DECLARED_ONLY, source: "checkpoint config (not inspected)",
    note: q ? "an explicit --quantization flag overrides the checkpoint's own quantization config" : "vLLM reads quantization from the checkpoint; not exposed by the API"
  }));
  fields.push(field("sampling", {
    critical: false, declared: cfg.sampling, status: STATUS.DECLARED_ONLY, source: "harness request body",
    note: "sent by the harness on every request; not observable server-side. Parameters the harness leaves unset fall back to the model's generation defaults."
  }));
  fields.push(field("servingRuntime", { critical: false, declared: p.servingRuntime, status: STATUS.DECLARED_ONLY, source: "implied by servingImage", note: "only as good as the image digest check" }));

  // Resource envelope (informational; no declaration to compare with).
  if (inspect) {
    const env = Object.fromEntries((inspect.Config?.Env || []).map((e) => [e.split("=")[0], e.slice(e.indexOf("=") + 1)]));
    observations.visibleDevices = env.NVIDIA_VISIBLE_DEVICES ?? null;
    observations.gpuMemoryUtilization = args.flags["gpu-memory-utilization"] ?? null;
    const n = observations.visibleDevices ? observations.visibleDevices.split(",").filter(Boolean).length : null;
    fields.push(field("gpuDevices", {
      critical: true, declared: `>= ${p.tensorParallel} device(s)`, observed: observations.visibleDevices,
      status: n === null ? STATUS.UNAVAILABLE : n >= p.tensorParallel ? STATUS.VERIFIED : STATUS.MISMATCH, source: "container env NVIDIA_VISIBLE_DEVICES"
    }));
  }

  // 3. Agent revision and harness state ----------------------------------------
  let git = null;
  try { git = await obs.git(); } catch (err) { observations.gitError = err.message; }
  const cli = git?.upstageCli;
  fields.push(field("harnessClean", { critical: true, declared: "clean worktree", observed: git ? (git.dirty ? "dirty" : "clean") : null, status: !git || git.dirty === null ? STATUS.UNAVAILABLE : git.dirty ? STATUS.MISMATCH : STATUS.VERIFIED, source: "git status (harness/)" }));
  fields.push(field("upstageCliPin", { critical: true, declared: cli?.pinnedCommit ?? null, observed: cli?.commit ?? null, status: !cli || cli.matchesPin === null ? STATUS.UNAVAILABLE : cli.matchesPin ? STATUS.VERIFIED : STATUS.MISMATCH, source: "git (vendor/upstage-cli vs gitlink)" }));
  fields.push(field("upstageCliClean", { critical: true, declared: "clean worktree", observed: cli ? (cli.dirty ? "dirty" : "clean") : null, status: !cli || cli.dirty === null ? STATUS.UNAVAILABLE : cli.dirty ? STATUS.MISMATCH : STATUS.VERIFIED, source: "git status (vendor/upstage-cli)" }));
  observations.harnessCommit = git?.commit ?? null;

  const blocking = fields.filter((f) => f.status === STATUS.MISMATCH || (f.critical && f.status === STATUS.UNAVAILABLE));
  const counts = Object.fromEntries(Object.values(STATUS).map((s) => [s, fields.filter((f) => f.status === s).length]));
  return {
    kind: "serving-preflight",
    version: 1,
    agent: agentKey,
    checkedAt: new Date().toISOString(),
    reportable: blocking.length === 0,
    blocking: blocking.map((f) => f.field),
    counts,
    fields,
    observations
  };
}

export function formatPreflight(r) {
  const mark = { verified: "✓", declared_only: "·", mismatch: "✗", unavailable: "?" };
  const lines = [`Serving preflight — ${r.agent} — ${r.reportable ? "REPORTABLE" : "BLOCKED"}`];
  for (const f of r.fields) {
    const obs = f.observed === null || f.observed === undefined ? "" : `  observed=${JSON.stringify(f.observed)}`;
    lines.push(`  ${mark[f.status]} ${f.field.padEnd(20)} ${f.status.padEnd(13)}${f.critical ? " [critical]" : ""}  declared=${JSON.stringify(f.declared)}${obs}${f.note ? `  — ${f.note}` : ""}`);
  }
  lines.push(`  counts: ${JSON.stringify(r.counts)}`);
  if (!r.reportable) lines.push(`  blocking: ${r.blocking.join(", ")}`);
  return lines.join("\n");
}
