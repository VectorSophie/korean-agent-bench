// upstage-cli per-call records (trace.modelCalls, kab.model-call/v1), observed
// by KAB around the adapter it constructs (no submodule change).
// REAL: upstage-cli's agent loop, LocalOpenAIAdapter (its retries and response
// validation), tool registry; KAB's LocalModelAgent and TaskRunner.
// FAKE: the model (a scripted OpenAI-compatible server that also counts every
// HTTP request it receives). No GPU, no network beyond 127.0.0.1.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalModelAgent } from "../src/agent/adapters/local.mjs";
import { TaskRunner } from "../src/task/runner.mjs";
import { importFromCli } from "../src/upstream.mjs";
import { observeOpenAIAdapter, aggregateUsage, assignToolCalls, newCallRecord } from "../src/agent/model-calls.mjs";

let srv, baseUrl, script, requests, home, savedHome;
const usage = (p, c, extra = {}) => ({ prompt_tokens: p, completion_tokens: c, total_tokens: p + c, ...extra });
const reply = (message, u, finish = "stop") => ({ id: "x", object: "chat.completion", created: 0, model: "m", choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finish }], ...(u ? { usage: u } : {}) });
const tools = (...calls) => ({ content: "", tool_calls: calls.map(([name, args], i) => ({ id: `c${i}`, type: "function", function: { name, arguments: JSON.stringify(args) } })) });

before(async () => {
  home = mkdtempSync(join(tmpdir(), "h36-home-"));
  savedHome = process.env.HOME;
  process.env.HOME = home;
  srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url === "/tokenize") { // stand-in for vLLM /tokenize
        const b = JSON.parse(body || "{}");
        return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ count: Math.ceil(JSON.stringify([b.messages, b.tools]).length / 4) }));
      }
      requests.push(JSON.parse(body || "{}"));
      const next = script.shift() ?? reply({ content: "done" }, usage(1, 1));
      if (next.sse) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const chunk of next.sse) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        return res.end("data: [DONE]\n\n");
      }
      if (next.httpStatus) return res.writeHead(next.httpStatus, { "content-type": "application/json" }).end(JSON.stringify(next.body ?? {}));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(next));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${srv.address().port}/v1`;
});
after(() => {
  srv.close();
  process.env.HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

function task(maxTurns = 4) {
  const repo = mkdtempSync(join(tmpdir(), "h36-repo-"));
  writeFileSync(join(repo, "calc.py"), "def add(a, b):\n    return a - b\n");
  writeFileSync(join(repo, "README.md"), "calc\n");
  const g = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo });
  g("init", "-q"); g("add", "."); g("commit", "-qm", "base");
  return {
    id: "h36", version: 1, repo, prompt: "add(2, 3) returns -1 instead of 5. Fix calc.py.",
    sandbox: { type: "native", timeout: 60 },
    agent: { maxTurns, tools: { allow: ["read_file", "write_file", "list_files"], deny: [] } },
    checks: { fail_to_pass: [], pass_to_pass: [], custom: [] }
  };
}
const run = (opts = {}, t = task()) => new TaskRunner().run(t, new LocalModelAgent({ model: "exaone", baseUrl, ...opts }));
const pick = (calls, keys) => calls.map((c) => keys.map((k) => c[k]));

describe("upstage-cli per-call records (KAB-side observation of LocalOpenAIAdapter)", () => {
  it("one record per logical call with the provider's usage; tool calls mapped to the call that asked for them; exact sums", async () => {
    requests = [];
    script = [
      reply({ ...tools(["read_file", { path: "calc.py" }]), reasoning_content: "Look first." }, usage(1000, 50, { completion_tokens_details: { reasoning_tokens: 12 } }), "tool_calls"),
      reply(tools(["read_file", { path: "README.md" }], ["list_files", { path: "." }]), usage(1200, 70, { completion_tokens_details: { reasoning_tokens: 30 } }), "tool_calls"),
      reply({ content: "Done." }, usage(1500, 40, { completion_tokens_details: { reasoning_tokens: 0 } }))
    ];
    const r = await run();
    const mc = r.trace.modelCalls;
    assert.equal(mc.length, requests.length, "every HTTP chat request is one recorded call (no retries here)");
    assert.deepEqual(pick(mc, ["index", "outcome", "transportAttempts", "promptTokens", "completionTokens", "totalTokens", "reasoningTokens", "reasoningChars", "finishReason", "toolCallsRequested", "firstToolCall", "toolCallsExecuted"]), [
      [0, "response", 1, 1000, 50, 1050, 12, 11, "tool_calls", 1, 0, 1],
      [1, "response", 1, 1200, 70, 1270, 30, null, "tool_calls", 2, 1, 2],
      [2, "response", 1, 1500, 40, 1540, 0, null, "stop", 0, null, 0]
    ]);
    assert.equal(r.trace.toolCalls.length, 3);
    assert.equal(r.trace.toolCalls[mc[1].firstToolCall + 1].tool, "list_files");
    const m = r.metrics;
    assert.deepEqual([m.modelCalls, m.failedModelCalls, m.transportAttempts, m.promptTokens, m.completionTokens, m.totalTokens, m.reasoningTokens], [3, 0, 3, 3700, 160, 3860, 42]);
    // with complete usage, v1's event-based sum agrees
    assert.deepEqual(r.provenance.model.usageFromEvents, { promptTokens: 3700, completionTokens: 160, totalTokens: 3860, modelCalls: 3 });
    for (const c of mc) assert.ok(Number.isInteger(c.durationMs) && Number.isInteger(c.startedAt));
  });

  it("missing usage is null (upstage-cli's own sum would count it as 0)", async () => {
    requests = [];
    script = [reply(tools(["read_file", { path: "calc.py" }]), null, "tool_calls"), reply({ content: "Done." }, usage(800, 5))];
    const r = await run();
    assert.deepEqual(pick(r.trace.modelCalls, ["promptTokens", "completionTokens", "totalTokens"]), [[null, null, null], [800, 5, 805]]);
    assert.deepEqual([r.metrics.promptTokens, r.metrics.totalTokens, r.metrics.modelCalls], [null, null, 2]);
    assert.equal(r.provenance.model.usageFromEvents.modelCalls, 1, "v1 accounting silently drops the call without usage");
  });

  it("an unusable reply is a format_error record with its usage; the run ends model_protocol_error, not infrastructure", async () => {
    requests = [];
    script = [reply({ content: "" }, usage(900, 3))];
    const r = await run();
    assert.equal(r.trace.stopReason, "model_protocol_error");
    assert.notEqual(r.status, "error");
    assert.deepEqual(pick(r.trace.modelCalls, ["outcome", "transportAttempts", "promptTokens", "finishReason", "toolCallsRequested"]), [["format_error", 1, 900, "stop", 0]]);
    assert.match(r.trace.modelCalls[0].error, /\[protocol\]/);
  });

  it("the client's retry is one logical call with two transport attempts", async () => {
    requests = [];
    script = [{ httpStatus: 503, body: { error: "busy" } }, reply({ content: "Done." }, usage(600, 10))];
    const r = await run();
    assert.equal(requests.length, 2);
    assert.deepEqual(pick(r.trace.modelCalls, ["outcome", "transportAttempts", "promptTokens"]), [["response", 2, 600]]);
    assert.deepEqual([r.metrics.modelCalls, r.metrics.transportAttempts], [1, 2]);
  });

  it("a server that keeps failing: infrastructure error, and the failed call (3 attempts) stays in the run record", async () => {
    requests = [];
    script = [{ httpStatus: 500 }, { httpStatus: 500 }, { httpStatus: 500 }];
    const r = await run();
    assert.equal(r.status, "error");
    assert.equal(requests.length, 3, "upstage-cli's maxRetries 2");
    assert.deepEqual(pick(r.trace.modelCalls, ["outcome", "transportAttempts", "promptTokens"]), [["error", 3, null]]);
    assert.match(r.trace.modelCalls[0].error, /server_error/);
  });

  it("observation changes nothing: same requests, same tool calls, same patch, same stop reason", async () => {
    const sequence = () => [
      reply(tools(["read_file", { path: "calc.py" }]), usage(10, 1), "tool_calls"),
      reply(tools(["write_file", { path: "calc.py", content: "def add(a, b):\n    return a + b\n" }]), usage(20, 2), "tool_calls"),
      reply({ content: "Fixed." }, usage(30, 3))
    ];
    const outcome = async (observeCalls) => {
      requests = [];
      script = sequence();
      const r = await run({ observeCalls });
      // the workspace path differs per run; everything else must be identical
      const bodies = JSON.parse(JSON.stringify(requests).replaceAll(r.provenance.repo.workdir ?? "\0", "<ws>").replace(/\/tmp\/[\w.-]+/g, "<tmp>"));
      return { bodies, stop: r.trace.stopReason, tools: r.trace.toolCalls.map((c) => [c.tool, c.args]), patch: r.patch.model_patch, modelCalls: r.trace.modelCalls };
    };
    const off = await outcome(false);
    const on = await outcome(true);
    assert.equal(off.modelCalls, null);
    assert.equal(on.modelCalls.length, 3);
    assert.deepEqual(on.bodies, off.bodies);
    assert.deepEqual([on.stop, on.tools, on.patch], [off.stop, off.tools, off.patch]);
    assert.match(on.patch, /\+ {4}return a \+ b/);
  });

  it("streaming through an observed adapter: same tokens, same result; usage stays null (event streams are not parsed)", async () => {
    const { LocalOpenAIAdapter } = await importFromCli("model/local-openai-adapter.mjs");
    const sse = () => ({ sse: [
      { id: "s", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] },
      { id: "s", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "lo" }, finish_reason: "stop" }] }
    ] });
    const go = async (observe) => {
      const adapter = new LocalOpenAIAdapter({ model: "m", baseUrl });
      const obs = observe ? observeOpenAIAdapter(adapter) : null;
      const tokens = [];
      script = [sse()];
      const result = await adapter.complete({ messages: [{ role: "user", content: "hi" }], stream: true, onToken: (t) => tokens.push(t) });
      return { tokens, content: result.content, calls: obs?.calls };
    };
    const off = await go(false);
    const on = await go(true);
    assert.deepEqual([on.tokens, on.content], [off.tokens, off.content]);
    assert.equal(on.content, "Hello");
    assert.deepEqual(pick(on.calls, ["outcome", "transportAttempts", "promptTokens"]), [["response", 1, null]]);
  });

  it("attempts are attributed per call even when two observed adapters run concurrently", async () => {
    const { LocalOpenAIAdapter } = await importFromCli("model/local-openai-adapter.mjs");
    requests = [];
    script = [reply({ content: "a" }, usage(5, 1)), reply({ content: "b" }, usage(6, 1))];
    const a = new LocalOpenAIAdapter({ model: "m", baseUrl });
    const b = new LocalOpenAIAdapter({ model: "m", baseUrl });
    const oa = observeOpenAIAdapter(a);
    const ob = observeOpenAIAdapter(b);
    await Promise.all([a.complete({ messages: [{ role: "user", content: "x" }] }), b.complete({ messages: [{ role: "user", content: "y" }] })]);
    assert.deepEqual([oa.calls.length, ob.calls.length, oa.calls[0].transportAttempts, ob.calls[0].transportAttempts], [1, 1, 1, 1]);
    assert.equal(requests.length, 2);
  });
});

describe("aggregation and tool-call slices (pure)", () => {
  it("totals over answered calls; a failed call counts as a call and as attempts, not as tokens", () => {
    const rec = (o) => Object.assign(newCallRecord(0), o);
    const u = aggregateUsage([
      rec({ outcome: "response", promptTokens: 10, completionTokens: 1, totalTokens: 11, reasoningTokens: 0, transportAttempts: 1 }),
      rec({ outcome: "format_error", promptTokens: 20, completionTokens: 2, totalTokens: 22, reasoningTokens: 1, transportAttempts: 2 }),
      rec({ outcome: "error", transportAttempts: 3 })
    ]);
    assert.deepEqual(u, { promptTokens: 30, completionTokens: 3, totalTokens: 33, reasoningTokens: 1, modelCalls: 3, failedCalls: 1, transportAttempts: 6 });
    assert.equal(aggregateUsage([rec({ outcome: "response", transportAttempts: null })]).transportAttempts, null);
    assert.deepEqual(aggregateUsage([]), { promptTokens: 0, completionTokens: 0, totalTokens: 0, reasoningTokens: 0, modelCalls: 0, failedCalls: 0, transportAttempts: 0 });
  });

  it("a tool_start belongs to the latest call that began before it", () => {
    const calls = [newCallRecord(0), newCallRecord(1)];
    const events = [{ type: "plan" }, { type: "tool_start" }, { type: "tool_result" }, { type: "tool_start" }, { type: "thinking" }, { type: "tool_start" }];
    assignToolCalls(calls, [0, 4], events);
    assert.deepEqual(pick(calls, ["firstToolCall", "toolCallsExecuted"]), [[0, 2], [2, 1]]);
  });
});
