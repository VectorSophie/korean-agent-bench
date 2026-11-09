// Harness v2 pilot driver (Track A: upstage-cli vs mini-swe-agent on the same
// served model and instances). Feasibility only: no ranking, no significance.
// ADR 0012 and benchmarks/pilot/harness-pilot-v1.json are the frozen design.
//
// State machine per attempt (manifest.json, rewritten atomically on every change):
//   pending → started → done | infra_error | provenance_error
//   started (process gone) → interrupted on the next invocation; never re-run
// Every scheduled attempt stays in the denominator; one that never ran is
// reported as not_executed. Stops:
//   resumable  nothing was touched: the queue lease would end before the next
//              attempt could finish (attemptReserveSec, checked BEFORE it
//              starts), or a check before the first attempt of this invocation
//              failed (preflight, an image not inspectable); a new queue
//              session continues the same schedule after a fresh preflight
//   terminal   infrastructure error, provenance failure, an interrupted attempt,
//              an instance snapshot or image that differs from the one recorded,
//              the session ceiling: never resumed (a new output directory is a
//              new pilot)
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { TaskRunner } from "../task/runner.mjs";
import { verifyRunAgainstTask, verifyTaskIdentity, toPrediction } from "../benchmarks/swebench.mjs";

export const PILOT_SPEC_SCHEMA = "kab.harness-pilot/v1";
export const PILOT_MANIFEST_SCHEMA = "kab.harness-pilot-manifest/v1";
export const HARNESSES = Object.freeze(["upstage-cli", "mini-swe-agent"]);
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const FAILED = new Set(["infra_error", "provenance_error", "interrupted"]);

export function validatePilotSpec(spec) {
  const errors = [];
  if (spec?.schema !== PILOT_SPEC_SCHEMA) errors.push(`schema must be ${PILOT_SPEC_SCHEMA}`);
  if (typeof spec?.model !== "string") errors.push("model");
  const inst = spec?.instances;
  if (!Array.isArray(inst) || inst.length === 0 || new Set(inst).size !== inst.length) errors.push("instances: non-empty, unique");
  const arms = Object.entries(spec?.arms ?? {});
  if (arms.length === 0) errors.push("arms");
  for (const [id, a] of arms) {
    if (!/^[A-Za-z0-9]+$/.test(id)) errors.push(`arm id ${id}`);
    if (!HARNESSES.includes(a?.harness)) errors.push(`arm ${id}: harness`);
    if (a?.maxTurns != null && !(Number.isInteger(a.maxTurns) && a.maxTurns > 0)) errors.push(`arm ${id}: maxTurns`);
  }
  if (!(Number.isInteger(spec?.repeats) && spec.repeats > 0)) errors.push("repeats");
  if (typeof spec?.orderSeed !== "string") errors.push("orderSeed");
  const r = spec?.resources ?? {};
  for (const k of ["leaseSec", "attemptTimeoutSec", "attemptReserveSec", "maxAttempts", "maxSessions"]) if (!(Number.isInteger(r[k]) && r[k] > 0)) errors.push(`resources.${k}`);
  if (r.attemptReserveSec < r.attemptTimeoutSec) errors.push("resources.attemptReserveSec must cover attemptTimeoutSec plus setup, teardown and the harness's hard-deadline slack");
  if (!errors.length && inst.length * arms.length * spec.repeats > r.maxAttempts) errors.push("resources.maxAttempts is below the schedule size");
  if (errors.length) throw new Error(`invalid pilot spec: ${errors.join("; ")}`);
  return spec;
}

export function loadPilotSpec(path) {
  const raw = readFileSync(path);
  return { spec: validatePilotSpec(JSON.parse(raw.toString("utf8"))), specSha256: sha256(raw) };
}

/** Fixed order: repeat blocks; within a block every (instance, arm) once, in
 *  an order fixed by the seed, so arms are interleaved in time. */
export function schedule(spec) {
  const out = [];
  for (let r = 1; r <= spec.repeats; r++) {
    const block = [];
    for (const instance of spec.instances) for (const arm of Object.keys(spec.arms)) block.push({ id: `r${r}-${arm}-${instance}`, repeat: r, arm, instance });
    block.sort((a, b) => sha256(`${spec.orderSeed}:${a.id}`).localeCompare(sha256(`${spec.orderSeed}:${b.id}`)));
    out.push(...block);
  }
  return out;
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 1) + "\n");
  renameSync(tmp, path);
}
const fileSha = (p) => sha256(readFileSync(p));

/** The common accounting for one attempt (HARNESS_V2 §8), from its run record. */
export function accounting(run) {
  const mc = Array.isArray(run.trace?.modelCalls) ? run.trace.modelCalls : null;
  const answered = mc?.filter((c) => c.outcome !== "error") ?? [];
  const m = run.metrics ?? {};
  return {
    logicalCalls: mc ? mc.length : null,
    failedCalls: m.failedModelCalls ?? null,
    transportAttempts: m.transportAttempts ?? null,
    promptTokens: m.promptTokens ?? null, completionTokens: m.completionTokens ?? null, reasoningTokens: m.reasoningTokens ?? null,
    peakPromptTokens: mc && answered.length && answered.every((c) => Number.isInteger(c.promptTokens)) ? Math.max(...answered.map((c) => c.promptTokens)) : null,
    toolActions: run.trace?.toolCalls?.length ?? null,
    failedToolActions: run.trace?.toolCalls?.filter((c) => c.ok === false || (c.resultData && c.resultData.ok === false)).length ?? null,
    agentWallClockMs: m.agentDurationMs ?? null,
    loopSteps: m.turns ?? null,
    stopReason: run.trace?.stopReason ?? null,
    predictionSource: run.patch?.prediction_source ?? null
  };
}

/**
 * Runs (or resumes) the pilot in `out`. Everything machine-specific is
 * injected through `env` (tests use fakes; the CLI wires the real ones):
 *   kab: { commit, dirty }                      code identity of this checkout
 *   instance(id) → { instance, spec }          verified instance specification
 *   imageId(image) → string|null               local image id (never pulls)
 *   makeAdapter(arm, armSpec) → CodingAgent
 *   makeTask(armSpec, instance, spec) → task
 *   expectedModel: { hfRepo, revision }
 *   preflight() → { reportable, ... }           live mode only
 *   runnerOptions                               e.g. selectSandbox in tests
 */
export async function runPilot({ spec, specSha256, out, mode, env, leaseEndsAt = null, now = Date.now, log = () => {} }) {
  if (!["live", "validation"].includes(mode)) throw new Error("mode must be live or validation");
  if (mode === "live" && env.kab.dirty) throw new Error("live pilot refuses a dirty KAB checkout");
  const path = join(out, "manifest.json");
  let manifest;
  if (existsSync(path)) {
    manifest = JSON.parse(readFileSync(path, "utf8"));
    if (manifest.schema !== PILOT_MANIFEST_SCHEMA || manifest.specSha256 !== specSha256) throw new Error("manifest belongs to another pilot spec; refusing to resume");
    if (manifest.mode !== mode) throw new Error(`manifest is a ${manifest.mode} pilot`);
    if (manifest.kab.commit !== env.kab.commit) throw new Error(`KAB commit changed (${manifest.kab.commit} → ${env.kab.commit}); refusing to resume`);
    if (manifest.stopped && !manifest.stopped.resumable) throw new Error(`pilot stopped (${manifest.stopped.reason}); a terminal stop is not resumed`);
    if (manifest.completedAt) return manifest;
    manifest.stopped = null;
    for (const a of Object.values(manifest.attempts)) {
      if (a.state === "started") Object.assign(a, { state: "interrupted", endedAt: now(), note: "the driver ended during this attempt; not re-run" });
      if (a.state === "done" && fileSha(join(out, a.runFile)) !== a.runSha256) throw new Error(`run record ${a.runFile} changed since it was written`);
    }
    if (Object.values(manifest.attempts).some((a) => a.state === "interrupted")) {
      manifest.stopped = { reason: "interrupted attempt found on resume", at: now(), resumable: false };
      writeJsonAtomic(path, manifest);
      return manifest;
    }
  } else {
    const order = schedule(spec);
    manifest = {
      schema: PILOT_MANIFEST_SCHEMA, specSha256, spec, mode, createdAt: now(), kab: env.kab,
      note: mode === "validation" ? "VALIDATION RUN (fake model): not a pilot result" : "feasibility pilot: no ranking or significance claims",
      instances: {}, arms: {}, preflights: [], invocations: [], stopped: null,
      schedule: order.map((s) => s.id),
      attempts: Object.fromEntries(order.map((s) => [s.id, { ...s, state: "pending" }]))
    };
  }
  manifest.invocations.push({ at: now(), kabCommit: env.kab.commit, kabDirty: env.kab.dirty, leaseEndsAt, mode });
  const save = () => writeJsonAtomic(path, manifest);
  const stop = (reason, resumable = false) => { manifest.stopped = { reason, at: now(), resumable }; save(); log(`[pilot] STOP: ${reason}`); return manifest; };
  if (mode === "live" && manifest.invocations.length > spec.resources.maxSessions) return stop(`session ceiling (${spec.resources.maxSessions}) reached; remaining attempts not executed`);

  // Instance identity, checked again on every invocation (resume included).
  // Returns a stop reason, or null; `terminal` marks a mismatch with what was recorded.
  const resolved = {};
  const checkInstance = (id) => {
    let r;
    try { r = env.instance(id); } catch (e) { return { reason: `instance ${id}: ${e.message}`, terminal: !!manifest.instances[id] }; }
    const imageId = env.imageId(r.spec.image);
    if (!imageId) return { reason: `image ${r.spec.image} is not present locally (no pulls)`, terminal: false };
    const rec = { specSha256: r.spec.specSha256, imageId, image: r.spec.image, base_commit: r.spec.base_commit, snapshotTree: r.spec.snapshotTree };
    const prev = manifest.instances[id];
    if (prev && (prev.specSha256 !== rec.specSha256 || prev.imageId !== rec.imageId)) return { reason: `instance ${id} changed since the pilot started (spec or image)`, terminal: true };
    manifest.instances[id] = rec;
    resolved[id] = r;
    return null;
  };
  for (const id of spec.instances) {
    const bad = checkInstance(id);
    if (bad) return stop(bad.reason, !bad.terminal);
  }
  if (mode === "live") {
    const pf = await env.preflight();
    manifest.preflights.push({ at: now(), reportable: !!pf?.reportable, blocking: pf?.blocking ?? null });
    if (!pf?.reportable) return stop("serving preflight not REPORTABLE (no attempt started)", true);
  }
  save();

  for (const id of manifest.schedule) {
    const a = manifest.attempts[id];
    if (a.state !== "pending") continue;
    if (leaseEndsAt != null && now() + spec.resources.attemptReserveSec * 1000 > leaseEndsAt) return stop("queue lease would end during the next attempt", true);
    // the snapshot and image again, right before use (a session lasts hours)
    const bad = checkInstance(a.instance);
    if (bad) return stop(`before ${id}: ${bad.reason}`, false);
    const armSpec = spec.arms[a.arm];
    const { instance, spec: ispec } = resolved[a.instance];
    const task = env.makeTask(armSpec, instance, ispec);
    let differences;
    try { differences = verifyTaskIdentity(ispec, task, instance); } catch (e) { Object.assign(a, { state: "provenance_error", error: e.message }); return stop(`task identity: ${e.message}`); }
    Object.assign(a, { state: "started", startedAt: now() });
    save();
    log(`[pilot] ${id} …`);
    const run = await new TaskRunner(env.runnerOptions ?? {}).run(task, env.makeAdapter(a.arm, armSpec));
    const runFile = join("runs", `${id}.json`);
    writeJsonAtomic(join(out, runFile), run);
    Object.assign(a, { endedAt: now(), runFile, runSha256: fileSha(join(out, runFile)), status: run.status, taskSchema: differences.schema, promptSha256: differences.promptSha256 });

    const problems = verifyRunAgainstTask(run, task, ispec);
    const h = run.provenance?.agentHarness;
    if (!h?.pinned) problems.push("agent harness not pinned");
    // Config vs config (provenance.model comes from local-models.mjs): catches a
    // wrong --model wiring; the serving preflight is the real identity check.
    const model = run.provenance?.model;
    if (model?.hfRepo !== env.expectedModel.hfRepo || model?.revision !== env.expectedModel.revision) problems.push(`model ${model?.hfRepo}@${model?.revision}`);
    if (!Array.isArray(run.trace?.modelCalls) && run.status !== "error") problems.push("no per-call records (trace.modelCalls)");
    const arm = (manifest.arms[a.arm] ??= { harness: armSpec.harness, harnessId: h?.harnessId ?? null, budgetId: h?.budgetId ?? null });
    if (h && (h.harnessId !== arm.harnessId || h.budgetId !== arm.budgetId)) problems.push(`arm ${a.arm}: harnessId/budgetId changed within the arm`);
    if (run.status === "error") {
      Object.assign(a, { state: "infra_error", error: run.trace?.agentError ?? run.failure?.reason ?? "error", accounting: accounting(run) });
      return stop(`infrastructure error in ${id}`);
    }
    if (problems.length) {
      Object.assign(a, { state: "provenance_error", error: problems.join("; ") });
      return stop(`provenance check failed in ${id}: ${problems.join("; ")}`);
    }
    Object.assign(a, { state: "done", harnessId: h.harnessId, budgetId: h.budgetId, accounting: accounting(run) });
    save();
  }
  manifest.completedAt = now();
  save();
  return manifest;
}

/**
 * Official evaluation: one predictions file per (arm, repeat), scored by the
 * official evaluator (env.evaluate). Writes results.json (every scheduled
 * attempt, with its state; not-run attempts stay in the denominator) and
 * SHA256SUMS over the output directory.
 */
export async function evaluatePilot({ out, evaluate }) {
  const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
  if (!manifest.completedAt && !manifest.stopped) throw new Error("pilot still in progress (neither completed nor stopped); not evaluated");
  for (const a of Object.values(manifest.attempts)) {
    if (a.state === "started") throw new Error(`${a.id} is still marked started; resume (it becomes interrupted) before evaluating`);
    if (a.runFile && fileSha(join(out, a.runFile)) !== a.runSha256) throw new Error(`run record ${a.runFile} changed since it was written`);
  }
  const groups = {};
  for (const id of manifest.schedule) {
    const a = manifest.attempts[id];
    (groups[`${a.arm}-r${a.repeat}`] ??= []).push(a);
  }
  const rows = [];
  for (const [group, attempts] of Object.entries(groups)) {
    const done = attempts.filter((a) => a.state === "done");
    let outcomes = {};
    if (done.length) {
      const preds = done.map((a) => toPrediction(JSON.parse(readFileSync(join(out, a.runFile), "utf8")), `kab-pilot-${group}`));
      const predFile = join(out, "predictions", `${group}.jsonl`);
      mkdirSync(dirname(predFile), { recursive: true });
      writeFileSync(predFile, preds.map((p) => JSON.stringify(p)).join("\n") + "\n");
      outcomes = await evaluate({ predictions: predFile, runId: `kab-pilot-${group}`, outDir: join(out, "eval", group) });
    }
    for (const a of attempts) {
      const official = a.state === "done" ? (outcomes[a.instance] ?? "missing") : null;
      rows.push({ id: a.id, arm: a.arm, repeat: a.repeat, instance: a.instance, state: a.state === "pending" ? "not_executed" : a.state, official, accounting: a.accounting ?? null });
    }
  }
  const order = new Map(manifest.schedule.map((id, i) => [id, i]));
  rows.sort((x, y) => order.get(x.id) - order.get(y.id));
  const results = {
    schema: "kab.harness-pilot-results/v1", specSha256: manifest.specSha256, mode: manifest.mode, note: manifest.note,
    scheduled: rows.length, executed: rows.filter((r) => r.state === "done").length,
    failed: rows.filter((r) => FAILED.has(r.state)).length, notExecuted: rows.filter((r) => r.state === "not_executed").length,
    stopped: manifest.stopped, rows
  };
  writeJsonAtomic(join(out, "results.json"), results);
  const files = [];
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (f !== "SHA256SUMS") files.push(p); } };
  walk(out);
  writeFileSync(join(out, "SHA256SUMS"), files.sort().map((p) => `${fileSha(p)}  ${relative(out, p)}`).join("\n") + "\n");
  return results;
}
