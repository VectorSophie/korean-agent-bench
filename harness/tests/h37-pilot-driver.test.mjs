// Harness v2 pilot driver (ADR 0012), CPU only.
// REAL: the driver, the task mapping (TASK_FOR_HARNESS, instanceSpec,
// verifyTaskIdentity), TaskRunner, upstage-cli's loop through LocalModelAgent,
// mini-swe-agent 2.4.6 through the KAB bridge.
// FAKE: the model (one scripted server answering each harness in its own
// protocol), the container (FakeDocker), the instances (synthetic snapshots
// in the real snapshot format), the image ids and the official evaluator.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalModelAgent } from "../src/agent/adapters/local.mjs";
import { MiniSweAgent, MINI } from "../src/agent/adapters/mini-swe-agent.mjs";
import { getLocalModelConfig } from "../src/agent/local-models.mjs";
import { instanceSpec, TASK_FOR_HARNESS, verifyTaskIdentity, taskIdentity, buildTask, buildTaskV2 } from "../src/benchmarks/swebench.mjs";
import { schedule, validatePilotSpec, runPilot, evaluatePilot } from "../src/pilot/pilot.mjs";
import { checkOut } from "../src/cli/commands/pilot.mjs";

const SUBMIT = "COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT";
const haveMini = existsSync(MINI.python);
let srv, baseUrl, failUpstage = false, home, savedHome, root;
const chat = (message, finish) => ({ id: "x", object: "chat.completion", created: 0, model: "m", usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
  choices: [{ index: 0, finish_reason: finish, message: { role: "assistant", ...message } }] });

before(async () => {
  root = mkdtempSync(join(tmpdir(), "h37-"));
  home = join(root, "home"); mkdirSync(home);
  savedHome = process.env.HOME;
  process.env.HOME = home;
  srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const b = JSON.parse(body || "{}");
      if (req.url === "/tokenize") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ count: 50 }));
      const isMini = (b.tools ?? []).map((t) => t.function?.name).join() === "bash";
      if (!isMini && failUpstage) return res.writeHead(500).end("{}");
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(isMini
        ? chat({ content: "THOUGHT: submit", tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: `echo ${SUBMIT}` }) } }] }, "tool_calls")
        : chat({ content: "Nothing to change." }, "stop")));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${srv.address().port}/v1`;
});
after(() => {
  srv.close();
  process.env.HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
});

class FakeDocker {
  get type() { return "docker"; }
  async setup() {}
  async teardown() {}
  describe() { return { type: "docker", image: this.image }; }
  async exec(_bin, args) {
    const cmd = args.at(-1).replace(/^exec 2>&1; /, "");
    if (cmd === `echo ${SUBMIT}`) return { ok: true, exitCode: 0, stdout: `${SUBMIT}\n`, stderr: "", timedOut: false };
    return { ok: false, exitCode: 127, stdout: "", stderr: "not scripted\n", timedOut: false };
  }
}

/** A synthetic instance + snapshot in the format prepareSnapshot writes. */
function synthInstance(id) {
  const dir = join(root, "snapshots", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "calc.py"), "def add(a, b):\n    return a - b\n");
  const g = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir, encoding: "utf8" }).trim();
  g("init", "-q"); g("add", "."); g("commit", "-qm", "snapshot");
  const instance = { instance_id: id, repo: "synthetic/calc", base_commit: "b".repeat(40), problem_statement: `add(2, 3) is wrong (${id}).`, image: `fake-image-${id}` };
  writeFileSync(join(dir, ".git", "kab-snapshot.json"), JSON.stringify({ repo: instance.repo, base_commit: instance.base_commit, tree: g("rev-parse", "HEAD^{tree}") }));
  return { instance, spec: instanceSpec(instance, { repoDir: dir }) };
}

const SPEC = () => validatePilotSpec({
  schema: "kab.harness-pilot/v1", model: "exaone", instances: ["synthetic__calc-1", "synthetic__calc-2"],
  arms: { A: { harness: "upstage-cli" }, B: { harness: "mini-swe-agent", maxTurns: 250 }, B30: { harness: "mini-swe-agent", maxTurns: 30 } },
  repeats: 2, orderSeed: "h37", resources: { leaseSec: 3600, attemptTimeoutSec: 600, attemptReserveSec: 600, maxSessions: 6, maxAttempts: 12 }
});

const INSTANCES = {}; // one snapshot per id, shared by every test
function env({ images = {}, commit = "c0ffee", dirty = false } = {}) {
  const inst = INSTANCES;
  const cfg = getLocalModelConfig("exaone");
  return {
    kab: { commit, dirty },
    // like the CLI: the snapshot is verified again on every call
    instance: (id) => { const r = (inst[id] ??= synthInstance(`${id}`)); return { instance: r.instance, spec: instanceSpec(r.instance, { repoDir: r.spec.repoDir }) }; },
    imageId: (image) => images[image] ?? `sha256:${image}`,
    makeTask: (armSpec, instance, ispec) => TASK_FOR_HARNESS[armSpec.harness](instance, ispec),
    makeAdapter: (_arm, armSpec) => (armSpec.harness === "upstage-cli"
      ? new LocalModelAgent({ model: "exaone", baseUrl })
      : new MiniSweAgent({ model: "exaone", baseUrl, budget: { maxTurns: armSpec.maxTurns } })),
    expectedModel: { hfRepo: cfg.provenance.hfRepo, revision: cfg.provenance.revision },
    runnerOptions: { selectSandbox: (task) => Object.assign(new FakeDocker(), { image: task.sandbox.image }) }
  };
}
const outDir = (name) => join(root, "out", name);

describe("pilot schedule and spec", () => {
  it("fixed order: repeat blocks, every (instance, arm) once per block, interleaved by the seed, reproducible", () => {
    const s = schedule(SPEC());
    assert.equal(s.length, 12);
    assert.deepEqual(s, schedule(SPEC()));
    for (const r of [1, 2]) {
      const block = s.filter((x) => x.repeat === r);
      assert.equal(block.length, 6);
      assert.equal(new Set(block.map((x) => `${x.arm}/${x.instance}`)).size, 6);
    }
    assert.ok(s.slice(0, 6).every((x) => x.repeat === 1), "repeat 1 finishes before repeat 2 starts");
    assert.notDeepEqual(s.slice(0, 6).map((x) => x.arm), ["A", "A", "B", "B", "B30", "B30"], "arms interleaved, not blocked");
  });

  it("the frozen pilot spec is valid and schedules 18 attempts", () => {
    const spec = validatePilotSpec(JSON.parse(readFileSync(new URL("../../benchmarks/pilot/harness-pilot-v1.json", import.meta.url), "utf8")));
    assert.equal(schedule(spec).length, 18);
    assert.deepEqual(spec.instances, ["psf__requests-1724", "psf__requests-2931", "psf__requests-1142"]);
  });

  it("rejects malformed specs", () => {
    assert.throws(() => validatePilotSpec({ ...SPEC(), repeats: 0 }), /repeats/);
    assert.throws(() => validatePilotSpec({ ...SPEC(), arms: { A: { harness: "aider" } } }), /harness/);
    assert.throws(() => validatePilotSpec({ ...SPEC(), resources: { leaseSec: 1, attemptTimeoutSec: 1, attemptReserveSec: 1, maxSessions: 1, maxAttempts: 5 } }), /maxAttempts/);
    assert.throws(() => validatePilotSpec({ ...SPEC(), resources: { leaseSec: 1, attemptTimeoutSec: 10, attemptReserveSec: 5, maxSessions: 1, maxAttempts: 12 } }), /attemptReserveSec/);
  });
});

describe("one instance specification, one task per harness", () => {
  it("both representations carry the same instance, base commit, snapshot, image and scoring input; prompts differ as documented", () => {
    const { instance, spec } = synthInstance("synthetic__id-1");
    const v1 = TASK_FOR_HARNESS["upstage-cli"](instance, spec);
    const v2 = TASK_FOR_HARNESS["mini-swe-agent"](instance, spec);
    assert.deepEqual(taskIdentity(v1), taskIdentity(v2));
    const d1 = verifyTaskIdentity(spec, v1, instance);
    const d2 = verifyTaskIdentity(spec, v2, instance);
    assert.deepEqual([d1.schema, d2.schema], ["kab.task/v1", "kab.task/v2"]);
    assert.notEqual(d1.promptSha256, d2.promptSha256);
    assert.deepEqual(d1.agentBudget, { maxTurns: 30, maxToolCalls: 60 });
    assert.equal(d2.agentBudget, null);
    // the v1 task is exactly the frozen builder's output (no new fields)
    assert.deepEqual(v1, buildTask(instance, { repoDir: spec.repoDir }));
    assert.deepEqual(v2, buildTaskV2(instance, { repoDir: spec.repoDir }));
  });

  it("fails closed on a different image, base commit, issue text or a modified snapshot", () => {
    const { instance, spec } = synthInstance("synthetic__id-2");
    const t = TASK_FOR_HARNESS["mini-swe-agent"](instance, spec);
    assert.throws(() => verifyTaskIdentity(spec, { ...t, sandbox: { ...t.sandbox, image: "other" } }, instance), /image/);
    assert.throws(() => verifyTaskIdentity(spec, { ...t, _meta: { ...t._meta, base_commit: "c".repeat(40) } }, instance), /base_commit/);
    assert.throws(() => verifyTaskIdentity(spec, t, { ...instance, problem_statement: "something else" }), /problem statement/);
    writeFileSync(join(spec.repoDir, "calc.py"), "tampered\n");
    assert.throws(() => instanceSpec(instance, { repoDir: spec.repoDir }), /uncommitted changes/);
  });
});

describe("pilot driver (validation mode, fake model)", { skip: haveMini ? false : "mini-swe-agent venv missing — NOT EXECUTED" }, () => {
  it("runs every arm in the fixed order with fail-closed provenance, then official-style evaluation with the full denominator", async () => {
    const out = outDir("full");
    failUpstage = false;
    const m = await runPilot({ spec: SPEC(), specSha256: "spec-1", out, mode: "validation", env: env() });
    assert.equal(m.stopped, null);
    assert.deepEqual(Object.values(m.attempts).map((a) => a.state), Array(12).fill("done"));
    for (const arm of ["A", "B", "B30"]) assert.ok(m.arms[arm].harnessId && m.arms[arm].budgetId, arm);
    assert.notEqual(m.arms.B.budgetId, m.arms.B30.budgetId, "B and B30 differ only by budget");
    assert.equal(m.arms.B.harnessId, m.arms.B30.harnessId);
    const a = m.attempts[m.schedule.find((id) => id.includes("-A-"))].accounting;
    assert.deepEqual([a.logicalCalls, a.transportAttempts, a.promptTokens, a.peakPromptTokens, a.stopReason], [1, 1, 100, 100, "done"]);
    const b = m.attempts[m.schedule.find((id) => id.includes("-B30-"))].accounting;
    assert.deepEqual([b.logicalCalls, b.toolActions, b.stopReason, b.predictionSource], [1, 1, "done", "agent_submission"]);
    for (const at of Object.values(m.attempts)) assert.match(at.runSha256, /^[0-9a-f]{64}$/);

    const seen = [];
    const r = await evaluatePilot({ out, evaluate: async ({ predictions, runId }) => {
      seen.push(runId);
      const rows = readFileSync(predictions, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      return Object.fromEntries(rows.map((p) => [p.instance_id, p.model_patch ? "unresolved" : "empty_patch"]));
    } });
    assert.deepEqual(seen.sort(), ["kab-pilot-A-r1", "kab-pilot-A-r2", "kab-pilot-B-r1", "kab-pilot-B-r2", "kab-pilot-B30-r1", "kab-pilot-B30-r2"]);
    assert.deepEqual([r.scheduled, r.executed, r.failed, r.notExecuted], [12, 12, 0, 0]);
    assert.ok(r.rows.every((row) => row.official === "empty_patch"));
    const sums = readFileSync(join(out, "SHA256SUMS"), "utf8");
    assert.match(sums, /manifest\.json/);
    assert.match(sums, /runs\/r1-A-synthetic__calc-1\.json/);
  });

  it("an infrastructure error stops the pilot; the rest stay in the denominator as not executed; a terminal stop is never resumed", async () => {
    const out = outDir("infra");
    failUpstage = true;
    const m = await runPilot({ spec: SPEC(), specSha256: "spec-1", out, mode: "validation", env: env() });
    failUpstage = false;
    assert.equal(m.stopped.resumable, false);
    const failed = Object.values(m.attempts).filter((x) => x.state === "infra_error");
    assert.equal(failed.length, 1);
    assert.equal(failed[0].arm, "A");
    assert.equal(failed[0].accounting.transportAttempts, 3, "the client's retries are visible");
    await assert.rejects(runPilot({ spec: SPEC(), specSha256: "spec-1", out, mode: "validation", env: env() }), /terminal stop is not resumed/);
    const r = await evaluatePilot({ out, evaluate: async () => ({}) });
    assert.equal(r.scheduled, 12);
    assert.equal(r.failed, 1);
    assert.equal(r.executed + r.failed + r.notExecuted, 12);
  });

  it("the lease is checked before each attempt (resumable stop); a new session continues the same schedule", async () => {
    const out = outDir("lease");
    let t = 1_000_000;
    const now = () => (t += 1000);
    const first = await runPilot({ spec: SPEC(), specSha256: "spec-1", out, mode: "validation", env: env(), leaseEndsAt: 1_000_000 + 600_000 + 20_000, now });
    assert.equal(first.stopped.resumable, true);
    const doneFirst = Object.values(first.attempts).filter((x) => x.state === "done").length;
    assert.ok(doneFirst >= 1 && doneFirst < 12, `${doneFirst}`);
    const second = await runPilot({ spec: SPEC(), specSha256: "spec-1", out, mode: "validation", env: env() });
    assert.equal(second.stopped, null);
    assert.ok(Object.values(second.attempts).every((x) => x.state === "done"));
    assert.equal(second.invocations.length, 2);
  });

  it("resume: an attempt left 'started' becomes interrupted (not re-run) and stops the pilot; changed spec, commit, image or mode refuse", async () => {
    const out = outDir("resume");
    const spec = { ...SPEC(), repeats: 1, resources: { leaseSec: 3600, attemptTimeoutSec: 600, attemptReserveSec: 600, maxSessions: 6, maxAttempts: 6 } };
    let t = 1_000_000;
    const m = await runPilot({ spec, specSha256: "spec-2", out, mode: "validation", env: env(), leaseEndsAt: 1_000_000 + 600_000 + 8_000, now: () => (t += 1000) });
    const pending = m.schedule.find((id) => m.attempts[id].state === "pending");
    assert.ok(pending && m.schedule.some((id) => m.attempts[id].state === "done"), "some done, some pending");
    // simulate the driver dying during an attempt
    const path = join(out, "manifest.json");
    const raw = JSON.parse(readFileSync(path, "utf8"));
    raw.attempts[pending].state = "started";
    writeFileSync(path, JSON.stringify(raw));
    await assert.rejects(runPilot({ spec, specSha256: "other", out, mode: "validation", env: env() }), /another pilot spec/);
    await assert.rejects(runPilot({ spec, specSha256: "spec-2", out, mode: "validation", env: env({ commit: "beef" }) }), /KAB commit changed/);
    await assert.rejects(runPilot({ spec, specSha256: "spec-2", out, mode: "live", env: env() }), /validation pilot/);
    const r = await runPilot({ spec, specSha256: "spec-2", out, mode: "validation", env: env() });
    assert.equal(r.attempts[pending].state, "interrupted");
    assert.equal(r.stopped.resumable, false);
    assert.equal(r.attempts[pending].runFile, undefined, "not re-run");
  });

  it("a changed local image between sessions is a terminal stop; live mode refuses a dirty checkout", async () => {
    const out = outDir("image");
    const spec = { ...SPEC(), repeats: 1, resources: { leaseSec: 3600, attemptTimeoutSec: 600, attemptReserveSec: 600, maxSessions: 6, maxAttempts: 6 } };
    let t = 1_000_000;
    await runPilot({ spec, specSha256: "spec-3", out, mode: "validation", env: env(), leaseEndsAt: 1_000_000 + 600_000 + 8_000, now: () => (t += 1000) });
    const r = await runPilot({ spec, specSha256: "spec-3", out, mode: "validation", env: env({ images: { "fake-image-synthetic__calc-1": "sha256:rebuilt" } }) });
    assert.match(r.stopped.reason, /changed since the pilot started/);
    await assert.rejects(runPilot({ spec, specSha256: "spec-4", out: outDir("dirty"), mode: "live", env: env({ dirty: true }) }), /dirty/);
  });

  it("live: a failed preflight before any attempt is a resumable stop; the session ceiling is terminal", async () => {
    const out = outDir("live");
    const spec = { ...SPEC(), repeats: 1, resources: { leaseSec: 3600, attemptTimeoutSec: 600, attemptReserveSec: 600, maxSessions: 2, maxAttempts: 6 } };
    const live = (reportable) => ({ ...env(), preflight: async () => ({ reportable, blocking: reportable ? [] : ["servedModelId"] }) });
    const m1 = await runPilot({ spec, specSha256: "spec-live", out, mode: "live", env: live(false) });
    assert.deepEqual([m1.stopped.resumable, Object.values(m1.attempts).every((a) => a.state === "pending")], [true, true]);
    let t = 1_000_000;
    const m2 = await runPilot({ spec, specSha256: "spec-live", out, mode: "live", env: live(true), leaseEndsAt: 1_000_000 + 600_000 + 8_000, now: () => (t += 1000) });
    assert.equal(m2.stopped.resumable, true, "lease");
    const m3 = await runPilot({ spec, specSha256: "spec-live", out, mode: "live", env: live(true) });
    assert.match(m3.stopped.reason, /session ceiling/);
    assert.equal(m3.stopped.resumable, false);
  });

  it("a snapshot changed during the pilot is caught before the next attempt (terminal)", async () => {
    const out = outDir("snapshot");
    const spec = { ...SPEC(), instances: ["synthetic__snap-1"], repeats: 2, resources: { leaseSec: 3600, attemptTimeoutSec: 600, attemptReserveSec: 600, maxSessions: 6, maxAttempts: 6 } };
    const e = env();
    let n = 0;
    const makeAdapter = e.makeAdapter;
    e.makeAdapter = (arm, armSpec) => {
      if (++n === 2) writeFileSync(join(INSTANCES["synthetic__snap-1"].spec.repoDir, "calc.py"), "changed\n");
      return makeAdapter(arm, armSpec);
    };
    const m = await runPilot({ spec, specSha256: "spec-snap", out, mode: "validation", env: e });
    assert.equal(m.stopped.resumable, false);
    assert.match(m.stopped.reason, /uncommitted changes/);
    assert.equal(Object.values(m.attempts).filter((a) => a.state === "done").length, 2, "the attempt already running finishes; the next one does not start");
  });

  it("evaluation refuses a pilot in progress or a changed run record; --out must not put SWE-bench content in the repository", async () => {
    const out = outDir("lease");
    const ev = async () => ({});
    const path = join(out, "manifest.json");
    const saved = readFileSync(path, "utf8");
    const raw = JSON.parse(saved);
    delete raw.completedAt;
    raw.stopped = null;
    writeFileSync(path, JSON.stringify(raw));
    await assert.rejects(evaluatePilot({ out, evaluate: ev }), /still in progress/);
    writeFileSync(path, saved);
    const run = join(out, JSON.parse(saved).attempts[JSON.parse(saved).schedule[0]].runFile);
    writeFileSync(run, readFileSync(run, "utf8").replace("{", "{ "));
    await assert.rejects(evaluatePilot({ out, evaluate: ev }), /changed since it was written/);
    const repo = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
    assert.throws(() => checkOut(repo), /not under \.cache/);
    assert.throws(() => checkOut(join(repo, "results", "x")), /not under \.cache/);
    assert.equal(checkOut(join(repo, ".cache", "pilot-x")), join(repo, ".cache", "pilot-x"));
    assert.equal(checkOut(join(tmpdir(), "pilot-x")), join(tmpdir(), "pilot-x"));
  });
});
