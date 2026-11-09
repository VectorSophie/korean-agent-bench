// mini-swe-agent integration, unit tier (no Docker, no GPU, no network).
// REAL: mini-swe-agent 2.4.6 DefaultAgent + LitellmModel + swebench.yaml, the
// KAB bridge (Python, subprocess), the Node adapter, TaskRunner, provenance.
// FAKE: the model (a scripted OpenAI-compatible HTTP server, like h30) and the
// container (an in-process executor that simulates each command's effect on
// the workspace; nothing is executed on the host). The real-Docker end to end
// is h34. Skipped, loudly, when benchmarks/setup.sh mini has not been run.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MiniSweAgent, MINI, WORKDIR, loadUpstreamConfig, readLock } from "../src/agent/adapters/mini-swe-agent.mjs";
import { TaskRunner } from "../src/task/runner.mjs";
import { MockAgent } from "../src/agent/adapters/mock.mjs";
import { CodingAgent } from "../src/agent/interface.mjs";
import { NativeSandbox } from "../src/sandbox/native.mjs";
import { getLocalModelConfig } from "../src/agent/local-models.mjs";
import { buildTaskV2, toPrediction } from "../src/benchmarks/swebench.mjs";

const BRIDGE = resolve(fileURLToPath(import.meta.url), "../../src/agent/mini/kab_bridge.py");
const skip = existsSync(MINI.python) ? false : "mini-swe-agent venv missing (benchmarks/setup.sh mini) — NOT EXECUTED";
const SUBMIT = "COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT";

// ── fake model server: each request pops the next scripted reply ──────────
let srv, baseUrl, script, requests;
const toolCall = (command, i) => ({ id: `call_${i}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } });
const reply = (body) => ({ id: "x", object: "chat.completion", created: 0, model: "m", usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 }, ...body });
const bash = (...commands) => reply({ choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: "THOUGHT: next.", tool_calls: commands.map(toolCall) } }] });
const noTool = () => reply({ choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "I think it is fixed." } }] });

// ── fake container: deterministic effects of the scripted commands ────────
class FakeDocker {
  constructor() { this.calls = []; this.workdir = null; this.timeoutMs = 2700_000; }
  get type() { return "docker"; }
  async setup(workdir) { this.workdir = workdir; }
  async teardown() {}
  describe() { return { type: "docker", image: "fake" }; }
  async exec(bin, args, opts) {
    this.calls.push({ bin, args, opts });
    const cmd = args[args.length - 1].replace(/^exec 2>&1; /, "");
    const w = this.workdir;
    const ok = (stdout) => ({ ok: true, exitCode: 0, stdout, stderr: "", timedOut: false });
    if (cmd === "cat calc.py") return ok(readFileSync(join(w, "calc.py"), "utf8"));
    if (cmd === "sed -i 's/a - b/a + b/' calc.py") {
      writeFileSync(join(w, "calc.py"), readFileSync(join(w, "calc.py"), "utf8").replace("a - b", "a + b"));
      return ok("");
    }
    if (cmd === "git diff -- calc.py > patch.txt") {
      // what git in the container would write (the test's own git, on a copy it owns)
      writeFileSync(join(w, "patch.txt"), execFileSync("git", ["diff", "--", "calc.py"], { cwd: w, encoding: "utf8" }));
      return ok("");
    }
    if (cmd === `echo ${SUBMIT}`) return ok(`${SUBMIT}\n`);
    if (cmd === `echo ${SUBMIT} && cat patch.txt`) return ok(`${SUBMIT}\n${readFileSync(join(w, "patch.txt"), "utf8")}`);
    if (cmd === "ln -s /etc/passwd leak") { symlinkSync("/etc/passwd", join(w, "leak")); return ok(""); }
    if (cmd === "ln -s /workspace/calc.py alias") { symlinkSync("/workspace/calc.py", join(w, "alias")); return ok(""); }
    if (cmd === "big") return { ok: true, exitCode: 0, stdout: `${SUBMIT}\ndiff --git a/x b/x\n`, stderr: "", timedOut: false, truncated: true };
    if (cmd === "sleep 999") return { ok: false, exitCode: null, stdout: "partial", stderr: "", timedOut: true };
    return { ok: false, exitCode: 127, stdout: "", stderr: `fake: ${cmd}: not scripted\n`, timedOut: false };
  }
}

function synthRepo() {
  const repo = mkdtempSync(join(tmpdir(), "h33-repo-"));
  writeFileSync(join(repo, "calc.py"), "def add(a, b):\n    return a - b\n");
  const g = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo });
  g("init", "-q"); g("add", "."); g("commit", "-qm", "base");
  return repo;
}
const instance = () => ({ instance_id: "synthetic__calc-1", repo: "synthetic/calc", base_commit: "0".repeat(40), problem_statement: "add(2, 3) returns -1 instead of 5.", image: "fake" });
const v2task = (repo, timeoutSec = 600) => buildTaskV2(instance(repo), { repoDir: repo, sandbox: { timeoutSec, memory: "1g", cpus: 1, path: "/usr/bin:/bin" } });
const runMini = async (repo, agentOpts = {}, task = v2task(repo)) => {
  const fake = new FakeDocker();
  const run = await new TaskRunner({ selectSandbox: () => fake }).run(task, new MiniSweAgent({ model: "kanana", baseUrl, ...agentOpts }));
  return { run, fake };
};

before(async () => {
  srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ url: req.url, body: JSON.parse(body || "{}") });
      const next = script.shift() ?? noTool();
      if (next.httpStatus) return res.writeHead(next.httpStatus, { "content-type": "application/json" }).end(JSON.stringify(next.body));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(next));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${srv.address().port}/v1`;
});
after(() => srv.close());

describe("mini-swe-agent through the KAB bridge (fake model, fake container)", { skip }, () => {
  it("edits the repository, submits with upstream's marker, and the submission is the prediction", async () => {
    const repo = synthRepo();
    requests = [];
    script = [bash("cat calc.py"), bash("sed -i 's/a - b/a + b/' calc.py"), bash("git diff -- calc.py > patch.txt"), bash(`echo ${SUBMIT} && cat patch.txt`)];
    const { run, fake } = await runMini(repo, { budget: { maxTurns: 10 } });

    assert.equal(run.trace.stopReason, "done", run.trace.agentError ?? "");
    assert.equal(run.patch.prediction_source, "agent_submission");
    const srcDiff = execFileSync("git", ["diff", "--", "calc.py"], { cwd: repo, encoding: "utf8" }); // empty: repo untouched
    assert.equal(srcDiff, "", "the agent edited a copy, never the fixture");
    assert.match(run.patch.agent_submission, /^diff --git a\/calc\.py b\/calc\.py[\s\S]*- {4}return a - b\n\+ {4}return a \+ b\n$/);
    assert.deepEqual([...run.patch.filesChanged].sort(), ["calc.py", "patch.txt"], "workspace diff kept alongside (includes the agent's patch.txt)");
    assert.equal(toPrediction(run, "kab-mini-kanana").model_patch, run.patch.agent_submission);

    // every action went to the (fake) Docker executor, with upstream's interpreter and env
    const upstream = loadUpstreamConfig();
    assert.equal(fake.calls.length, 4);
    for (const c of fake.calls) {
      assert.deepEqual([c.bin, ...c.args.slice(0, -1)], upstream.environment.interpreter);
      assert.equal(c.opts.env.PAGER, "cat");
      assert.equal(c.opts.env.PATH, undefined, "PATH stays the task's");
      assert.equal(c.opts.env.BASH_ENV, undefined, "dropped (unreadable for the unprivileged user)");
      assert.ok(c.args.at(-1).startsWith("exec 2>&1; "), "stderr merged in order inside the container");
    }
    assert.equal(run.trace.toolCalls.length, 4);

    // the request mini sent: upstream prompt with the one /testbed→/workspace substitution
    const cfg = getLocalModelConfig("kanana");
    const first = requests[0].body;
    assert.equal(requests[0].url, "/v1/chat/completions");
    assert.equal(first.model, cfg.servedModelName);
    assert.deepEqual(first.tools.map((t) => t.function.name), ["bash"]);
    assert.equal(first.max_tokens, cfg.maxOutputTokens);
    assert.equal(first.temperature, cfg.sampling.temperature);
    assert.equal(first.messages[0].content.trim(), upstream.agent.system_template.trim());
    assert.ok(first.messages[1].content.includes("add(2, 3) returns -1 instead of 5."));
    assert.ok(first.messages[1].content.includes(`files in ${WORKDIR} (this is the working directory`));
    assert.ok(!first.messages[1].content.includes("/testbed"));

    // identities: model, agent harness, budget — separate
    const h = run.provenance.agentHarness;
    assert.equal(h.pinned, true);
    assert.deepEqual({ n: h.implementation.name, k: h.implementation.kind, v: h.implementation.version, r: h.implementation.revision },
      { n: "mini-swe-agent", k: "subprocess", v: MINI.version, r: MINI.commit });
    assert.equal(h.implementation.config.sha256, MINI.configSha256);
    assert.equal(h.implementation.config.promptSubstitutions, 1);
    assert.equal(h.implementation.installVerifiedFiles > 0, true, "every installed mini file matched the wheel RECORD");
    assert.equal(h.policies.termination.prediction, "agent_submission");
    assert.equal(h.budget.maxTurns, 10);
    assert.equal(run.provenance.model.revision, cfg.provenance.revision);
    assert.equal(run.provenance.task.schema, "kab.task/v2");
    assert.equal(run.metrics.turns, 4);
    assert.equal(run.metrics.promptTokens, 400);
  });

  it("sampling the model card declares reaches the server (top_k and chat_template_kwargs too)", async () => {
    const repo = synthRepo();
    requests = [];
    script = [bash(`echo ${SUBMIT}`)];
    await runMini(repo, { model: "exaone" });
    const body = requests[0].body;
    const cfg = getLocalModelConfig("exaone");
    assert.equal(body.top_p, cfg.sampling.topP);
    assert.equal(body.top_k, cfg.sampling.topK);
    assert.deepEqual(body.chat_template_kwargs, cfg.chatTemplateKwargs);
  });

  it("upstream's step limit ends the run as budget_exhausted with an empty prediction", async () => {
    const repo = synthRepo();
    script = [bash("cat calc.py"), bash("cat calc.py"), bash("cat calc.py")];
    const { run } = await runMini(repo, { budget: { maxTurns: 2 } });
    assert.equal(run.trace.stopReason, "budget_exhausted");
    assert.equal(run.patch.agent_submission, "");
    assert.equal(toPrediction(run, "m").model_patch, "");
  });

  it("three replies without a tool call end as model_protocol_error (upstream RepeatedFormatError), not infrastructure", async () => {
    const repo = synthRepo();
    script = [noTool(), noTool(), noTool()];
    const { run, fake } = await runMini(repo);
    assert.equal(run.trace.stopReason, "model_protocol_error");
    assert.notEqual(run.status, "error");
    assert.equal(fake.calls.length, 0);
  });

  it("vLLM's context-length rejection ends as context_exhausted (litellm ContextWindowExceededError), without retries", async () => {
    const repo = synthRepo();
    requests = [];
    script = [{ httpStatus: 400, body: { object: "error", type: "BadRequestError", code: 400, message: "This model's maximum context length is 16384 tokens. However, your request has 20000 input tokens. Please reduce the length of the input messages." } }];
    const { run } = await runMini(repo);
    assert.equal(run.trace.stopReason, "context_exhausted", run.trace.agentError ?? "");
    assert.equal(requests.length, 1, "not retried");
    assert.equal(toPrediction(run, "m").model_patch, "");
  });

  it("keeps mini's own trajectory in the run record", async () => {
    const repo = synthRepo();
    script = [bash(`echo ${SUBMIT}`)];
    const { run } = await runMini(repo);
    assert.equal(run.trace.agentTrajectory.trajectory_format, "mini-swe-agent-1.1");
    assert.equal(run.trace.agentTrajectory.info.exit_status, "Submitted");
  });

  it("a command timeout comes back as upstream's returncode -1 with exception text", async () => {
    const a = new MiniSweAgent({ model: "kanana" });
    const fake = new FakeDocker();
    const r = await a._exec({ id: 1, command: "sleep 999", cwd: WORKDIR, timeout: 5 }, { executor: fake, workdir: mkdtempSync(join(tmpdir(), "h33-")), timeoutSec: 60, interpreter: ["bash", "-c"], execEnv: {}, events: [] });
    assert.equal(r.returncode, -1);
    assert.match(r.exception_info, /timed out after 5 seconds/);
    assert.equal(fake.calls[0].opts.timeoutMs, 5000);
  });
});

describe("mini-swe-agent: refusals (negative tests)", { skip }, () => {
  const ctx = (fake, workdir) => ({ executor: fake, workdir, timeoutSec: 60, interpreter: ["bash", "-c"], execEnv: {}, events: [] });

  it("refuses host execution: a native (non-Docker) sandbox is an error before any model call", async () => {
    const repo = synthRepo();
    requests = [];
    script = [bash("cat calc.py")];
    const run = await new TaskRunner({ selectSandbox: (t) => new NativeSandbox(t) }).run(
      { ...v2task(repo), sandbox: { type: "native", timeout: 60 } }, new MiniSweAgent({ model: "kanana", baseUrl }));
    assert.equal(run.status, "error");
    assert.match(run.trace.agentError, /refusing host execution/);
    assert.equal(requests.length, 0);
  });

  it("refuses a cwd outside the workspace mount and malformed commands without touching the executor", async () => {
    const a = new MiniSweAgent({ model: "kanana" });
    const fake = new FakeDocker();
    const wd = mkdtempSync(join(tmpdir(), "h33-"));
    for (const msg of [{ cwd: "/" }, { cwd: "/workspace/../etc" }, { cwd: "/testbed" }]) {
      const r = await a._exec({ id: 1, command: "ls", timeout: 5, ...msg }, ctx(fake, wd));
      assert.equal(r.returncode, -1);
      assert.match(r.exception_info, /cwd .* refused/);
    }
    for (const command of [42, null, "echo a\0b", "x".repeat(100_001)]) {
      const r = await a._exec({ id: 2, command, cwd: WORKDIR, timeout: 5 }, ctx(fake, wd));
      assert.equal(r.returncode, -1);
      assert.match(r.exception_info, /malformed command refused/);
    }
    assert.equal(fake.calls.length, 0);
  });

  it("removes a symlink escaping the workspace right after the command that made it", async () => {
    const a = new MiniSweAgent({ model: "kanana" });
    const fake = new FakeDocker();
    const wd = mkdtempSync(join(tmpdir(), "h33-"));
    fake.workdir = wd;
    const r = await a._exec({ id: 1, command: "ln -s /etc/passwd leak", cwd: WORKDIR, timeout: 5 }, ctx(fake, wd));
    assert.match(r.exception_info, /removed symlinks escaping the workspace: leak/);
    assert.equal(r.output, "", "the note never enters the output (which may be a submission)");
    assert.equal(existsSync(join(wd, "leak")), false);
  });

  it("keeps links that stay inside the workspace as the container sees it, and the repository's own links", async () => {
    const a = new MiniSweAgent({ model: "kanana" });
    const fake = new FakeDocker();
    const wd = mkdtempSync(join(tmpdir(), "h33-"));
    fake.workdir = wd;
    symlinkSync("/usr/share/doc", join(wd, "repo-link")); // committed by the repository: task content
    const r = await a._exec({ id: 1, command: "ln -s /workspace/calc.py alias", cwd: WORKDIR, timeout: 5 }, { ...ctx(fake, wd), preexistingLinks: new Set(["repo-link"]) });
    assert.equal(r.exception_info, "");
    assert.ok(lstatSync(join(wd, "alias")).isSymbolicLink(), "/workspace/... resolves inside the container");
    assert.ok(lstatSync(join(wd, "repo-link")).isSymbolicLink());
  });

  it("output past the cap fails closed: a cut-off submission is never accepted", async () => {
    const a = new MiniSweAgent({ model: "kanana" });
    const r = await a._exec({ id: 1, command: "big", cwd: WORKDIR, timeout: 5 }, ctx(new FakeDocker(), mkdtempSync(join(tmpdir(), "h33-"))));
    assert.equal(r.returncode, -1, "upstream submits only on returncode 0");
    assert.match(r.exception_info, /output exceeded/);
  });

  it("the bridge refuses any other mini environment class (e.g. local host execution)", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "h33-br-"));
    const child = spawn(MINI.python, ["-I", BRIDGE], { cwd: scratch, env: { PATH: "/usr/bin:/bin", HOME: scratch, MSWEA_GLOBAL_CONFIG_DIR: scratch, MSWEA_SILENT_STARTUP: "1" }, stdio: ["pipe", "pipe", "pipe", "pipe"] });
    let proto = "";
    child.stdio[3].on("data", (c) => (proto += c));
    child.stdin.end(JSON.stringify({ task: "t", workdir: WORKDIR, overrides: { environment: { environment_class: "local" } }, expectedVersion: MINI.version, configName: MINI.configName, expectedConfigSha256: MINI.configSha256 }) + "\n");
    const code = await new Promise((r) => child.on("close", r));
    assert.equal(code, 2);
    assert.match(JSON.parse(proto.trim()).error, /environment_class 'local' refused/);
  });

  it("the bridge refuses an install that differs from the lock", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "h33-lk-"));
    const child = spawn(MINI.python, ["-I", BRIDGE], { cwd: scratch, env: { PATH: "/usr/bin:/bin", HOME: scratch, MSWEA_GLOBAL_CONFIG_DIR: scratch, MSWEA_SILENT_STARTUP: "1" }, stdio: ["pipe", "pipe", "pipe", "pipe"] });
    let proto = "";
    child.stdio[3].on("data", (c) => (proto += c));
    child.stdin.end(JSON.stringify({ task: "t", workdir: WORKDIR, overrides: {}, lock: { ...readLock(), litellm: "0.0.1" }, expectedVersion: MINI.version, configName: MINI.configName, expectedConfigSha256: MINI.configSha256 }) + "\n");
    assert.equal(await new Promise((r) => child.on("close", r)), 2);
    assert.match(JSON.parse(proto.trim()).error, /dependency litellm is .*, lock says 0\.0\.1/);
  });

  it("a modified upstream config is refused (sha256 pin)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "h33-cfg-"));
    const copy = join(dir, "swebench.yaml");
    cpSync(MINI.configPath, copy);
    writeFileSync(copy, readFileSync(copy, "utf8").replace("step_limit: 250", "step_limit: 251"));
    const repo = synthRepo();
    const run = await new TaskRunner({ selectSandbox: () => new FakeDocker() }).run(v2task(repo), new MiniSweAgent({ model: "kanana", baseUrl, configPath: copy }));
    assert.equal(run.status, "error");
    assert.match(run.trace.agentError, /sha256 .* != pinned/);
    assert.equal(run.patch.prediction_source, "agent_submission", "declared by the adapter, not by the (failed) result");
    assert.equal(toPrediction(run, "m").model_patch, "", "a failed run never predicts its partial workspace diff");
  });

  it("missing harness provenance: a kab.task/v2 run without a pinned descriptor is an error", async () => {
    class V2NoDescriptor extends CodingAgent {
      get id() { return "v2-anon"; }
      get taskSchema() { return "kab.task/v2"; }
      get supportsSandbox() { return true; }
      async run() { return { ok: true, turns: 0, toolCalls: 0, usage: null, events: [] }; }
    }
    const repo = synthRepo();
    const run = await new TaskRunner({ selectSandbox: () => new FakeDocker() }).run(v2task(repo), new V2NoDescriptor());
    assert.equal(run.status, "error");
    assert.match(run.trace.agentError, /requires a pinned agent-harness descriptor/);
  });

  it("a v1 adapter is refused on a kab.task/v2 task before anything runs", async () => {
    const repo = synthRepo();
    await assert.rejects(new TaskRunner({ selectSandbox: () => new FakeDocker() }).run(v2task(repo), new MockAgent()), /does not support task schema kab\.task\/v2/);
  });
});

describe("kab.task/v2 carries no agent-specific settings", () => {
  it("has no agent block, no upstage-cli tool names and the raw problem statement as prompt", () => {
    const repo = mkdtempSync(join(tmpdir(), "h33-t-"));
    mkdirSync(join(repo, ".git"));
    const t = v2task(repo);
    assert.equal(t.schema, "kab.task/v2");
    assert.equal(t.agent, undefined);
    assert.equal(t.prompt, instance(repo).problem_statement);
    assert.ok(!JSON.stringify(t).match(/run_shell|read_file|search_code/));
    assert.equal(t._meta.base_commit, "0".repeat(40));
    rmSync(repo, { recursive: true, force: true });
  });
});

// ── per-call trace and the 16K limit (Observability and Context Audit) ─────
// Usage values are chosen so every total is checkable by hand.
const withUsage = (r, prompt, completion, extra = {}) => ({ ...r, usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, ...extra } });
const withReasoning = (r, text) => ({ ...r, choices: [{ ...r.choices[0], message: { ...r.choices[0].message, reasoning_content: text } }] });
const noUsage = (r) => { const { usage: _u, ...rest } = r; return rest; };
// vLLM 0.32.0 renderers/params.py _token_len_check, as served (HTTP 400).
const VLLM_CTX_400 = { httpStatus: 400, body: { error: { message: "This model's maximum context length is 16384 tokens. However, your prompt contains 16391 input tokens, which exceeds this limit even without any output tokens. Please reduce the length of the input prompt. (parameter=input_tokens, value=16391)", type: "BadRequestError", param: "input_tokens", code: 400 } } };
const lengthCut = () => reply({ choices: [{ index: 0, finish_reason: "length", message: { role: "assistant", content: "THOUGHT: I will now" } }] });

describe("mini-swe-agent per-call trace (trace.modelCalls) and context limit", { skip }, () => {
  it("records each model call with provider usage, maps tool calls to the call that asked for them, and sums exactly", async () => {
    const repo = synthRepo();
    requests = [];
    script = [
      withUsage(withReasoning(bash("cat calc.py"), "Read the file first."), 1000, 50, { completion_tokens_details: { reasoning_tokens: 20 } }),
      withUsage(bash("sed -i 's/a - b/a + b/' calc.py", "git diff -- calc.py > patch.txt"), 1200, 70, { completion_tokens_details: { reasoning_tokens: 30 } }),
      withUsage(bash(`echo ${SUBMIT} && cat patch.txt`), 1500, 40)
    ];
    const { run } = await runMini(repo, { budget: { maxTurns: 10 } });
    assert.equal(run.trace.stopReason, "done", run.trace.agentError ?? "");
    const mc = run.trace.modelCalls;
    assert.equal(mc.length, 3);
    assert.equal(requests.length, 3, "one HTTP request per recorded call");
    assert.deepEqual(mc.map((c) => [c.index, c.outcome, c.promptTokens, c.completionTokens, c.totalTokens, c.reasoningTokens, c.finishReason, c.toolCallsRequested, c.firstToolCall, c.toolCallsExecuted]), [
      [0, "response", 1000, 50, 1050, 20, "tool_calls", 1, 0, 1],
      [1, "response", 1200, 70, 1270, 30, "tool_calls", 2, 1, 2],
      [2, "response", 1500, 40, 1540, null, "tool_calls", 1, 3, 1]
    ]);
    assert.deepEqual(mc.map((c) => c.reasoningChars), [20, null, null], "characters of returned reasoning; null when none");
    // the reasoning of earlier turns is sent back with the history (what the live audit measured)
    assert.equal(requests[1].body.messages.find((m) => m.role === "assistant").reasoning_content, "Read the file first.");
    // the per-call slices cover trace.toolCalls exactly, in order
    assert.equal(run.trace.toolCalls.length, mc.reduce((s, c) => s + c.toolCallsExecuted, 0));
    assert.equal(run.trace.toolCalls[mc[1].firstToolCall + 1].args.command, "git diff -- calc.py > patch.txt");
    for (const c of mc) assert.ok(Number.isInteger(c.durationMs) && c.durationMs >= 0 && Number.isInteger(c.startedAt));
    const m = run.metrics;
    assert.deepEqual([m.modelCalls, m.turns, m.toolCalls, m.promptTokens, m.completionTokens, m.totalTokens, m.reasoningTokens],
      [3, 3, 4, 3700, 160, 3860, null], "reasoning total is null: one call did not report it");
    // mini's native trajectory is kept unchanged alongside
    assert.equal(run.trace.agentTrajectory.info.model_stats.api_calls, 3);
  });

  it("missing usage is null, never 0 (litellm's zero placeholder), and a reported 0 stays 0", async () => {
    const repo = synthRepo();
    script = [noUsage(bash("cat calc.py")), withUsage(bash(`echo ${SUBMIT}`), 800, 5, { completion_tokens_details: { reasoning_tokens: 0 } })];
    const { run } = await runMini(repo);
    const [a, b] = run.trace.modelCalls;
    assert.deepEqual([a.promptTokens, a.completionTokens, a.totalTokens, a.reasoningTokens], [null, null, null, null]);
    assert.deepEqual([b.promptTokens, b.completionTokens, b.totalTokens, b.reasoningTokens], [800, 5, 805, 0]);
    assert.deepEqual([run.metrics.promptTokens, run.metrics.completionTokens, run.metrics.totalTokens, run.metrics.modelCalls], [null, null, null, 2]);
  });

  it("a format error is a model call: recorded with its usage, no tool call executed", async () => {
    const repo = synthRepo();
    script = [withUsage(noTool(), 900, 30), withUsage(bash(`echo ${SUBMIT}`), 1000, 10)];
    const { run } = await runMini(repo);
    assert.equal(run.trace.stopReason, "done");
    assert.deepEqual(run.trace.modelCalls.map((c) => [c.outcome, c.promptTokens, c.finishReason, c.toolCallsExecuted, c.firstToolCall]),
      [["format_error", 900, "stop", 0, null], ["response", 1000, "tool_calls", 1, 0]]);
    assert.deepEqual([run.metrics.modelCalls, run.metrics.promptTokens, run.metrics.toolCalls], [2, 1900, 1]);
  });

  it("approaching then exceeding 16K: a cut-off reply is a format error, vLLM's rejection ends as context_exhausted once, with no submission", async () => {
    const repo = synthRepo();
    requests = [];
    script = [
      withUsage(bash("sed -i 's/a - b/a + b/' calc.py"), 9000, 100),
      withUsage(bash("git diff -- calc.py > patch.txt"), 12000, 100), // a patch exists in the workspace...
      withUsage(lengthCut(), 16000, 384), // vLLM clamps max_tokens to 16384 - prompt; the reply is cut before a tool call
      VLLM_CTX_400 // ...but the next prompt no longer fits
    ];
    const { run } = await runMini(repo, { model: "exaone" });
    assert.equal(run.trace.stopReason, "context_exhausted", run.trace.agentError ?? "");
    assert.equal(requests.length, 4, "the rejection is not retried");
    assert.match(requests[3].body.messages.at(-1).content, /reached the output token limit \(finish_reason=length\)/, "upstream's own truncation feedback");
    const mc = run.trace.modelCalls;
    assert.deepEqual(mc.map((c) => [c.outcome, c.promptTokens, c.finishReason]),
      [["response", 9000, "tool_calls"], ["response", 12000, "tool_calls"], ["format_error", 16000, "length"], ["error", null, null]]);
    assert.match(mc[3].error, /^ContextWindowExceededError: /);
    assert.deepEqual([run.metrics.modelCalls, run.metrics.promptTokens, run.metrics.completionTokens], [4, 37000, 584]);
    // no false submission: patch.txt exists, but nothing was submitted
    assert.equal(run.patch.agent_submission, "");
    assert.equal(toPrediction(run, "m").model_patch, "");
    assert.ok(run.patch.filesChanged.includes("patch.txt"));
    assert.notEqual(run.status, "error", "a model outcome, not infrastructure");
    // valid partial-run provenance
    assert.equal(run.provenance.agentHarness.pinned, true);
    assert.equal(run.provenance.model.hfRepo, getLocalModelConfig("exaone").provenance.hfRepo);
    assert.equal(run.trace.agentTrajectory.info.exit_status, "ContextWindowExceededError");
  });
});
