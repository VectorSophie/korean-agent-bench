#!/usr/bin/env node
// Capture the exact first chat-completions request each local agent sends for
// a SWE-bench task (system prompt, tools, user prompt), using a fake loopback
// server — no model. The issue/repo/commit are placeholders that
// context_feasibility.py substitutes per instance.
//   node benchmarks/swebench/capture_initial_request.mjs [outDir]
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LOCAL_MODEL_IDS } from "../../harness/src/agent/local-models.mjs";
import { LocalModelAgent } from "../../harness/src/agent/adapters/local.mjs";
import { TaskRunner } from "../../harness/src/task/runner.mjs";
import { buildTask, PROMPT_TEMPLATE_SHA256 } from "../../harness/src/benchmarks/swebench.mjs";

const ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const OUT = resolve(process.argv[2] || join(ROOT, ".cache/swebench/initial-requests"));
export const PLACEHOLDERS = { repo: "<<<KAB_REPO>>>", base_commit: "<<<KAB_BASE_COMMIT>>>", problem_statement: "<<<KAB_ISSUE>>>" };

const captured = [];
const srv = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url.endsWith("/chat/completions")) captured.push(JSON.parse(body));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: "x", object: "chat.completion", created: 0, model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const baseUrl = `http://127.0.0.1:${srv.address().port}/v1`;
mkdirSync(OUT, { recursive: true });
const summary = {};
try {
  for (const key of LOCAL_MODEL_IDS) {
    const repo = mkdtempSync(join(tmpdir(), "kab-capture-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    writeFileSync(join(repo, "README"), "placeholder\n");
    execFileSync("git", ["-c", "user.name=k", "-c", "user.email=k@k", "add", "."], { cwd: repo });
    execFileSync("git", ["-c", "user.name=k", "-c", "user.email=k@k", "commit", "-qm", "init"], { cwd: repo });
    const task = { ...buildTask({ instance_id: "capture", image: "unused", ...PLACEHOLDERS }, { repoDir: repo }), commit: undefined, sandbox: { type: "native", timeout: 60 } };
    captured.length = 0;
    await new TaskRunner().run(task, new LocalModelAgent({ model: key, baseUrl }));
    rmSync(repo, { recursive: true, force: true });
    if (captured.length === 0) throw new Error(`${key}: no request captured`);
    const first = captured[0];
    writeFileSync(join(OUT, `${key}.json`), JSON.stringify(first, null, 1));
    summary[key] = { messages: first.messages.length, tools: (first.tools || []).length, roles: first.messages.map((m) => m.role) };
  }
} finally {
  srv.close();
}
writeFileSync(join(OUT, "summary.json"), JSON.stringify({ promptTemplateSha256: PROMPT_TEMPLATE_SHA256, placeholders: PLACEHOLDERS, agents: summary }, null, 1));
console.log(JSON.stringify(summary));
