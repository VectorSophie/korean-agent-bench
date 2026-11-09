// mini-swe-agent as a KAB agent harness (Harness v2; docs/research/HARNESS_V2.md §7).
//
// mini-swe-agent's own loop, model client (litellm), SWE-bench config and
// submission check run unchanged in a Python subprocess (mini/kab_bridge.py).
// That process executes nothing: each bash action comes back here over a pipe
// and runs in the task's KAB DockerSandbox (hardened, network none, only the
// workspace mounted). Host shell execution is refused.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { CodingAgent } from "../interface.mjs";
import { getLocalModelConfig, LOCAL_MODEL_IDS } from "../local-models.mjs";
import { AGENT_HARNESS_SCHEMA, sourceSha256 } from "../harness-config.mjs";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../../..");
const BRIDGE = resolve(fileURLToPath(import.meta.url), "../../mini/kab_bridge.py");
const VENV = join(REPO_ROOT, ".cache/venv-mini");
// .cache/venv-mini/lib/python3.X/site-packages/... (whatever Python built the venv)
function installedConfigPath() {
  let py = null;
  try { py = readdirSync(join(VENV, "lib")).find((d) => /^python3\.\d+$/.test(d)); } catch { /* not installed */ }
  return join(VENV, "lib", py ?? "python3", "site-packages/minisweagent/config/benchmarks/swebench.yaml");
}

// The pinned upstream release (benchmarks/setup.sh mini verifies the wheel).
export const MINI = Object.freeze({
  version: "2.4.6",
  commit: "a83fcae82d2a08f0ee0c688f9d137b3566c097f8",
  source: "https://github.com/SWE-agent/mini-swe-agent",
  license: "MIT",
  configName: "swebench.yaml",
  configSha256: "9a9c86ac10428b86b932c972b15fefc2f7b6e92230bac5ebdc47e83232a8315e",
  python: join(VENV, "bin/python"),
  configPath: installedConfigPath()
});
// KAB code + the dependency lock: litellm/openai versions change requests.
export const MINI_LOCK = join(REPO_ROOT, "benchmarks/mini-swe-agent/requirements.lock");
// Also the sandbox code that shapes what an action sees (output, isolation).
export const MINI_ADAPTER_SOURCES = Object.freeze([
  "src/agent/adapters/mini-swe-agent.mjs", "src/agent/mini/kab_bridge.py", "../benchmarks/mini-swe-agent/requirements.lock",
  "src/sandbox/docker.mjs", "src/sandbox/native.mjs", "../vendor/upstage-cli/src/sandbox/docker-flags.mjs"
]);

/**
 * Symlinks in the workspace whose target, as the CONTAINER resolves it
 * (workspace mounted at WORKDIR), lies outside the workspace. Lexical on
 * purpose: `ln -s /workspace/a b` is inside even though the host path
 * /workspace/a does not exist. `.git` is skipped (never tracked by the
 * harness, see PatchTracker).
 */
export function escapingLinks(root) {
  const out = [];
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === ".git") continue;
      const p = join(dir, ent.name);
      if (ent.isSymbolicLink()) {
        const rel = relative(root, p);
        const inContainer = posix.join(WORKDIR, rel.split("\\").join("/"));
        const t = readlinkSync(p);
        const target = posix.resolve(posix.dirname(inContainer), t);
        if (target !== WORKDIR && !target.startsWith(WORKDIR + "/")) out.push(rel);
      } else if (ent.isDirectory()) {
        walk(p);
      }
    }
  };
  walk(root);
  return out;
}

/** name → version from the exact lock (comments ignored). */
export function readLock(path = MINI_LOCK) {
  return Object.fromEntries(readFileSync(path, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => l.split("==")));
}
export const WORKDIR = "/workspace"; // DockerSandbox mount point (upstage-cli docker-flags)
export const UPSTREAM_STEP_LIMIT = 250; // swebench.yaml agent.step_limit
const MAX_COMMAND_CHARS = 100_000;
// Upstream keeps all output (its observation template elides the middle past
// 10,000 chars). KAB must cap host memory; past this cap the action fails
// closed (returncode -1) so a cut-off submission can never count as Submitted.
export const OUTPUT_LIMIT = 8_000_000;
const MAX_PROTOCOL_LINE = 4_000_000;
const ENV_KEY = /^[A-Z_][A-Z0-9_]*$/;
// BASH_ENV=/root/.bashrc activates the testbed conda env for upstream's root
// user. KAB runs as an unprivileged user, so bash cannot read it and prints
// "Permission denied" into every observation (and into the submission); KAB's
// task PATH already selects the testbed interpreter. Dropped and recorded.
export const DROPPED_ENV = Object.freeze(["BASH_ENV"]);
// Upstream merges stderr into stdout in order (stderr=STDOUT). DockerSandbox
// returns them separately, so the merge happens inside the container instead.
export const MERGE_STDERR = "exec 2>&1; ";

/** The pinned upstream SWE-bench config, verified by sha256 (fails closed). */
export function loadUpstreamConfig(path = MINI.configPath) {
  if (!existsSync(path)) throw new Error(`mini-swe-agent not installed (${path}): run benchmarks/setup.sh mini`);
  const raw = readFileSync(path);
  const sha = createHash("sha256").update(raw).digest("hex");
  if (sha !== MINI.configSha256) throw new Error(`${MINI.configName} sha256 ${sha} != pinned ${MINI.configSha256}`);
  return yaml.load(raw.toString("utf8"));
}

/** Run totals from per-call records (trace.modelCalls). Over the calls that
 *  returned a response (a call that failed without one, e.g. a context-length
 *  rejection, has no usage and is counted in failedCalls), each total is the
 *  exact sum of provider-reported values, or null when any of them lacks
 *  that value: an unknown is never counted as 0. */
export function aggregateUsage(calls) {
  const answered = calls.filter((c) => c.outcome !== "error");
  const sum = (k) => (answered.every((c) => Number.isInteger(c[k])) ? answered.reduce((s, c) => s + c[k], 0) : null);
  return {
    promptTokens: sum("promptTokens"), completionTokens: sum("completionTokens"), totalTokens: sum("totalTokens"),
    reasoningTokens: sum("reasoningTokens"), modelCalls: calls.length, failedCalls: calls.length - answered.length
  };
}

// Upstream's TimeoutExpired path reports returncode -1 and this message shape.
const timeoutInfo = (cmd, s) => `An error occurred while executing the command: Command '${cmd}' timed out after ${s} seconds`;

export class MiniSweAgent extends CodingAgent {
  /**
   * @param {object} o
   * @param {string} o.model    local-models.mjs key (model identity stays there)
   * @param {string} [o.baseUrl] endpoint override (tests: a fake server)
   * @param {object} [o.budget] { maxTurns } — default: upstream step_limit
   */
  constructor({ model, baseUrl, budget = {}, python = MINI.python, configPath = MINI.configPath } = {}) {
    super();
    this._key = (model || "").toLowerCase() || null;
    this._config = this._key ? getLocalModelConfig(this._key) : null;
    this._baseUrl = baseUrl || null;
    this._maxTurns = budget.maxTurns ?? UPSTREAM_STEP_LIMIT;
    this._python = python;
    this._configPath = configPath;
  }

  get id() { return this._key ? `mini-swe-agent-${this._key}` : "mini-swe-agent"; }
  get displayName() { return `mini-swe-agent ${MINI.version} (${this._config?.displayName ?? `--model one of ${LOCAL_MODEL_IDS.join(", ")}`})`; }
  get modelKey() { return this._key; }
  get taskSchema() { return "kab.task/v2"; }
  // Declared, not taken from the result: a failed run must predict "" (as
  // upstream would), never fall back to a partial workspace diff.
  get predictionSource() { return "agent_submission"; }
  // Every action goes through context.executor; run() refuses non-Docker executors.
  get supportsSandbox() { return true; }
  isAvailable() { return !!this._config && existsSync(this._python); }

  async run(task, context) {
    // Per-call records arrive as they happen ({"type":"call"}), so they survive
    // a run that later fails: attached to the error for the runner to keep.
    const calls = [];
    try {
      return await this._run(task, context, calls);
    } catch (e) {
      if (e && typeof e === "object" && calls.length) e.modelCalls = calls;
      throw e;
    }
  }

  async _run(task, context, calls) {
    const { workdir, executor, auditLog } = context;
    if (!this._config) throw new Error(`unknown local model '${this._key}' (known: ${LOCAL_MODEL_IDS.join(", ")})`);
    if (executor?.type !== "docker") {
      throw new Error("mini-swe-agent actions run only in a Docker sandbox; refusing host execution (sandbox.type must be docker)");
    }
    const upstream = loadUpstreamConfig(this._configPath);
    const uenv = upstream.environment;
    const interpreter = uenv.interpreter;
    const execEnv = Object.fromEntries(Object.entries(uenv.env || {}).filter(([k]) => ENV_KEY.test(k) && k !== "PATH" && !DROPPED_ENV.includes(k)));
    const cfg = this._config;
    const baseUrl = this._baseUrl || cfg.baseUrl;
    const timeoutSec = task.sandbox?.timeout || 120;
    const maxTokens = cfg.maxOutputTokens;
    const sampling = cfg.sampling;

    // KAB overrides of the upstream config: budget, model endpoint and sampling.
    // Prompts, templates, interpreter and termination stay upstream's.
    const extraBody = {};
    if (sampling.topK != null) extraBody.top_k = sampling.topK;
    if (cfg.chatTemplateKwargs) extraBody.chat_template_kwargs = cfg.chatTemplateKwargs;
    const overrides = {
      agent: { step_limit: this._maxTurns, cost_limit: 0, wall_time_limit_seconds: timeoutSec },
      environment: { cwd: WORKDIR },
      model: {
        model_class: "litellm",
        model_name: `hosted_vllm/${cfg.servedModelName}`,
        cost_tracking: "ignore_errors",
        model_kwargs: {
          api_base: baseUrl,
          api_key: process.env.LOCAL_MODEL_API_KEY || "EMPTY",
          max_tokens: maxTokens,
          temperature: sampling.temperature,
          ...(sampling.topP != null ? { top_p: sampling.topP } : {}),
          ...(sampling.presencePenalty != null ? { presence_penalty: sampling.presencePenalty } : {}),
          ...(Object.keys(extraBody).length ? { extra_body: extraBody } : {})
        }
      }
    };

    // Links the repository itself contains are task content, not the agent's.
    const preexistingLinks = new Set(escapingLinks(workdir));
    const scratch = mkdtempSync(join(tmpdir(), "kab-mini-"));
    const trajectoryPath = join(scratch, "trajectory.json");
    const events = [];
    let result = null;
    let fatal = null;
    let trajectory = null;
    try {
      const child = spawn(this._python, ["-I", BRIDGE], {
        cwd: scratch,
        // Scrubbed: no host credentials, proxies or mini/litellm user config.
        env: {
          PATH: "/usr/bin:/bin", HOME: scratch, MSWEA_GLOBAL_CONFIG_DIR: scratch, MSWEA_SILENT_STARTUP: "1",
          MSWEA_COST_TRACKING: "ignore_errors", LITELLM_LOCAL_MODEL_COST_MAP: "True", NO_PROXY: "*", PYTHONHASHSEED: "0"
        },
        stdio: ["pipe", "pipe", "pipe", "pipe"]
      });
      let log = "";
      const keep = (c) => { log = (log + c).slice(-20000); };
      child.stdout.on("data", keep);
      child.stderr.on("data", keep);
      const exited = new Promise((res) => child.on("close", (code) => res(code)));
      const kill = () => { try { child.kill("SIGKILL"); } catch { /* gone */ } };
      // Hard ceiling: the bridge may not outlive the task's wall clock.
      // Upstream checks its wall clock only before each model call, so one
      // last turn (several actions, a long generation) may overrun it.
      let killedAtDeadline = false;
      const deadline = setTimeout(() => { killedAtDeadline = true; kill(); }, (timeoutSec + 900) * 1000);
      // A bridge that dies mid-run must not crash the harness with EPIPE; its
      // exit is reported below (no result → error).
      child.stdin.on("error", () => {});
      const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");

      send({
        task: task.prompt, workdir: WORKDIR, trajectoryPath, overrides,
        expectedVersion: MINI.version, configName: MINI.configName, expectedConfigSha256: MINI.configSha256,
        lock: readLock()
      });

      const lines = createInterface({ input: child.stdio[3] });
      try {
        for await (const line of lines) {
          let msg;
          try {
            if (line.length > MAX_PROTOCOL_LINE) throw new Error("oversized message");
            msg = JSON.parse(line);
          } catch (e) {
            throw new Error(`mini bridge protocol error: ${e.message}`, { cause: e });
          }
          if (msg?.type === "call") {
            calls.push({ ...msg.record, index: calls.length, firstToolCall: null, toolCallsExecuted: 0 });
          } else if (msg?.type === "exec") {
            // the model call whose response asked for this action (exec ids are 1-based, in trace.toolCalls order)
            const c = calls.at(-1);
            if (c) { c.toolCallsExecuted += 1; c.firstToolCall ??= msg.id - 1; }
            send(await this._exec(msg, { executor, workdir, timeoutSec, interpreter, execEnv, events, preexistingLinks }));
          } else if (msg?.type === "result") {
            result = msg;
          } else if (msg?.type === "fatal") {
            fatal = String(msg.error);
          } else {
            throw new Error(`mini bridge protocol error: unexpected message type ${JSON.stringify(msg?.type)}`);
          }
        }
      } catch (e) {
        kill();
        throw e;
      } finally {
        clearTimeout(deadline);
      }
      const code = await exited;
      if (fatal) throw new Error(`mini bridge refused to run: ${fatal}`);
      if (!result && killedAtDeadline) {
        result = { exitStatus: "TimeExceeded", submission: "", killedAtDeadline: true };
      }
      if (!result) throw new Error(`mini bridge exited (${code}) without a result: ${log.slice(-2000)}`);
      try { trajectory = JSON.parse(readFileSync(trajectoryPath, "utf8")); } catch { /* none written */ }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    if (auditLog) auditLog.recordEvents(events);

    // exit_status → KAB stop reason. Infrastructure (server unreachable, 5xx
    // after upstream's retries) is an error, never a task outcome.
    if (result.killedAtDeadline) {
      return {
        ok: false, error: "TimeExceeded (bridge killed at the hard deadline)", turns: null, toolCalls: events.filter((e) => e.type === "tool_start").length,
        usage: aggregateUsage(calls), modelCalls: calls, events, stopReason: "budget_exhausted", submission: "", trajectory
      };
    }
    const STOP = { Submitted: "done", LimitsExceeded: "budget_exhausted", TimeExceeded: "budget_exhausted", RepeatedFormatError: "model_protocol_error", ContextWindowExceededError: "context_exhausted" };
    const stopReason = STOP[result.exitStatus];
    if (!stopReason) throw new Error(`mini-swe-agent ended with ${result.exitStatus || "no exit status"}: ${result.error ?? ""}`);

    return {
      ok: result.exitStatus === "Submitted",
      error: result.exitStatus === "Submitted" ? undefined : result.exitStatus,
      turns: result.nCalls,
      toolCalls: result.nActions,
      usage: aggregateUsage(calls),
      modelCalls: calls,
      events,
      stopReason,
      // mini's own output is the prediction (as `mini-extra swebench` writes
      // it); the runner keeps the workspace diff alongside it.
      submission: result.submission,
      predictionSource: "agent_submission",
      // mini's own trajectory (all messages); kept in the local run record
      trajectory,
      model: {
        provider: cfg.provenance.provider,
        id: cfg.servedModelName,
        hfRepo: cfg.provenance.hfRepo,
        revision: cfg.provenance.revision,
        quantization: cfg.provenance.quantization,
        official: cfg.provenance.official,
        servingRuntime: cfg.provenance.servingRuntime,
        servingImage: cfg.provenance.servingImage,
        tensorParallel: cfg.provenance.tensorParallel,
        baseUrl,
        client: `litellm (${result.modelClass})`,
        sampling: { temperature: sampling.temperature ?? null, topP: sampling.topP ?? null, topK: sampling.topK ?? null, presencePenalty: sampling.presencePenalty ?? null, seed: null },
        chatTemplateKwargs: cfg.chatTemplateKwargs ?? null,
        maxOutputTokens: maxTokens,
        contextLimit: cfg.contextLimit,
        finishReasons: result.finishReasons
      },
      tools: { advertised: ["bash"], removedByPolicy: [], removedForIsolation: [], schemaHash: null },
      harness: {
        schema: AGENT_HARNESS_SCHEMA,
        implementation: {
          name: "mini-swe-agent", kind: "subprocess", version: result.miniVersion, revision: MINI.commit, dirty: false,
          adapterSha256: sourceSha256(MINI_ADAPTER_SOURCES),
          config: { name: result.configName, sha256: result.configSha256, promptSubstitutions: result.promptSubstitutions },
          python: result.python,
          installVerifiedFiles: result.installVerifiedFiles
        },
        policies: {
          toolInterface: { id: "mini.bash", interpreter, containerPerAction: true, stderr: "merged-in-order", droppedEnv: [...DROPPED_ENV] },
          retrieval: { id: "none" },
          context: { id: "mini.full-history" },
          planning: { id: "none" },
          termination: { id: "mini.submit-marker", prediction: "agent_submission", maxConsecutiveFormatErrors: result.effectiveAgentConfig.max_consecutive_format_errors }
        },
        budget: {
          maxTurns: result.effectiveAgentConfig.step_limit, maxToolCalls: null, timeoutSec: result.effectiveAgentConfig.wall_time_limit_seconds,
          maxOutputTokens: maxTokens, contextLimit: cfg.contextLimit, outputReservation: null, safetyMarginRatio: null
        }
      }
    };
  }

  // One action from the bridge → one command in the task's container.
  async _exec(msg, { executor, workdir, timeoutSec, interpreter, execEnv, events, preexistingLinks = new Set() }) {
    const reply = (output, returncode, exception_info = "") => ({ id: msg.id, output, returncode, exception_info });
    const command = msg.command;
    events.push({ type: "tool_start", tool: "bash", args: { command: typeof command === "string" ? command.slice(0, 2000) : command } });
    const done = (r) => {
      events.push({ type: "tool_result", tool: "bash", ok: r.returncode === 0, result: { ok: r.returncode === 0, code: r.returncode, stdout: r.output, stderr: r.exception_info, timedOut: false } });
      return r;
    };
    if (typeof command !== "string" || command.length > MAX_COMMAND_CHARS || command.includes("\0")) {
      return done(reply("", -1, "KAB sandbox: malformed command refused (must be a string without NUL, at most 100000 characters)"));
    }
    // mini only ever uses its configured cwd; anything else could escape the mount.
    if (msg.cwd !== WORKDIR) return done(reply("", -1, `KAB sandbox: cwd ${JSON.stringify(msg.cwd)} refused (only ${WORKDIR})`));
    const limitSec = Math.min(Number.isInteger(msg.timeout) && msg.timeout > 0 ? msg.timeout : 30, timeoutSec);
    const r = await executor.exec(interpreter[0], [...interpreter.slice(1), MERGE_STDERR + command], { timeoutMs: limitSec * 1000, env: execEnv, outputLimit: OUTPUT_LIMIT });
    if (r.infraError) throw new Error(`sandbox error: ${r.infraError}`);
    // Links the agent made that point out of the workspace (as the container
    // resolves them) are removed; the note goes to exception_info, never into
    // the output (which may be a submission).
    const escaped = escapingLinks(workdir).filter((p) => !preexistingLinks.has(p));
    for (const p of escaped) {
      const abs = join(workdir, p);
      if (lstatSync(abs).isSymbolicLink()) unlinkSync(abs);
    }
    const note = escaped.length ? `KAB sandbox: removed symlinks escaping the workspace: ${escaped.join(", ")}` : "";
    const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    if (r.timedOut) return done(reply(output, -1, [timeoutInfo(command, limitSec), note].filter(Boolean).join("\n")));
    if (r.truncated) return done(reply(output, -1, `KAB sandbox: output exceeded ${OUTPUT_LIMIT} characters and was cut; the command is treated as failed (a submission is not accepted)`));
    return done(reply(output, r.exitCode ?? -1, note));
  }
}
