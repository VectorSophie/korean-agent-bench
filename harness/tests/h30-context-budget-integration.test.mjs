// The harness hands each local model's validated limits to upstage-cli's real
// agent loop (runAgentLoop contextBudget) — not the 65,536 fallback. A fake
// OpenAI-compatible server records every request; no model, no GPU.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalModelAgent, CONTEXT_SAFETY_MARGIN_RATIO } from "../src/agent/adapters/local.mjs";
import { LOCAL_MODELS } from "../src/agent/local-models.mjs";
import { TaskRunner } from "../src/task/runner.mjs";
import { importFromCli } from "../src/upstream.mjs";

let srv, baseUrl, requests, home, savedHome;
before(async () => {
  home = mkdtempSync(join(tmpdir(), "h30-home-"));
  savedHome = process.env.HOME;
  process.env.HOME = home;
  srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push(JSON.parse(body || "{}"));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "x", object: "chat.completion", created: 0, model: "m",
        choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
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

function task(prompt) {
  const repo = mkdtempSync(join(tmpdir(), "h30-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  // enough files that an uncapped repository context would be large
  for (let i = 0; i < 40; i++) writeFileSync(join(repo, `module_${i}.py`), `def f${i}():\n    return ${i}  # ${"pad ".repeat(200)}\n`);
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  return {
    id: "h30", version: 1, repo, prompt,
    sandbox: { type: "native", timeout: 60 },
    agent: { maxTurns: 2, tools: { allow: ["read_file", "write_file", "run_shell"], deny: [] } },
    checks: { fail_to_pass: [], pass_to_pass: [], custom: [] }
  };
}

describe("context budget reaches the real upstage-cli loop", () => {
  for (const key of ["kanana", "solar-open2"]) {
    it(`${key}: budget event, max_tokens, capped repository context, whole request within budget`, async () => {
      requests = [];
      const cfg = LOCAL_MODELS[key];
      const run = await new TaskRunner().run(task("Fix f3 to return 33."), new LocalModelAgent({ model: key, baseUrl }));
      const recorded = run.provenance.model.contextBudget;
      assert.deepEqual(
        { contextLimit: recorded.contextLimit, maxOutputTokens: recorded.maxOutputTokens, charsPerToken: recorded.charsPerToken },
        { contextLimit: cfg.contextLimit, maxOutputTokens: cfg.maxOutputTokens, charsPerToken: cfg.contextCharsPerToken }
      );
      assert.equal(requests.length, 1);
      const body = requests[0];
      assert.equal(body.max_tokens, cfg.maxOutputTokens);
      const { validateContextBudget, estimateMessages, estimateWith } = await importFromCli("agent/effective-context.mjs");
      const eff = validateContextBudget({ ...recorded, safetyMarginRatio: CONTEXT_SAFETY_MARGIN_RATIO });
      const contextBlock = body.messages[1].content;
      assert.ok(contextBlock.length <= eff.repoContextMaxChars + 40, `context block ${contextBlock.length} > ${eff.repoContextMaxChars}`);
      const est = estimateMessages(eff, body.messages) + estimateWith(eff, JSON.stringify(body.tools));
      assert.ok(est <= eff.inputBudget, `request ~${est} > input budget ${eff.inputBudget}`);
      const fallbackCap = Math.floor(65536 * 4 * 0.09);
      assert.ok(eff.repoContextMaxChars < fallbackCap / 4, "cap is far below the 64K fallback's 23,592 chars");
    });
  }

  it("a task that cannot fit Solar's 8K window ends as context_exhausted without any request — not an infrastructure error", async () => {
    requests = [];
    const run = await new TaskRunner().run(task("Describe this: " + "lorem ipsum ".repeat(4000)), new LocalModelAgent({ model: "solar-open2", baseUrl }));
    assert.equal(requests.length, 0);
    assert.equal(run.trace.stopReason, "context_exhausted");
    assert.notEqual(run.outcome.reason, "agent_adapter_error");
  });
});

describe("model vs infrastructure classification of adapter errors", () => {
  async function runWith(respond) {
    const s = createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => respond(res));
    });
    await new Promise((r) => s.listen(0, "127.0.0.1", r));
    try {
      return await new TaskRunner().run(task("Fix f3."), new LocalModelAgent({ model: "kanana", baseUrl: `http://127.0.0.1:${s.address().port}/v1` }));
    } finally {
      s.close();
    }
  }
  const json = (res, code, body) => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };

  it("an empty model turn is a model outcome (model_protocol_error), not infrastructure", async () => {
    const run = await runWith((res) => json(res, 200, { choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }], usage: {} }));
    assert.equal(run.trace.stopReason, "model_protocol_error");
    assert.notEqual(run.outcome.reason, "agent_adapter_error");
  });

  it("a 5xx from the server is infrastructure", async () => {
    const run = await runWith((res) => json(res, 503, { error: { message: "unavailable" } }));
    assert.equal(run.status, "error");
    assert.equal(run.outcome.reason, "agent_adapter_error");
  });
});
