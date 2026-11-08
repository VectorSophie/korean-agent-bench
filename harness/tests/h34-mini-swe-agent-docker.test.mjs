// mini-swe-agent end to end on a REAL DockerSandbox (Docker tier).
// REAL: mini-swe-agent 2.4.6 loop/model client/config, KAB bridge, adapter,
// TaskRunner, DockerSandbox (hardened, --network none, workspace-only mount),
// an official SWE-bench instance image (bash, git, testbed python).
// FAKE: only the model (scripted OpenAI-compatible server). The repository is
// synthetic, so no SWE-bench content is used. Skipped when the image is not
// present locally (no pulls) or the mini venv is missing.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MiniSweAgent, MINI } from "../src/agent/adapters/mini-swe-agent.mjs";
import { TaskRunner } from "../src/task/runner.mjs";
import { buildTaskV2, toPrediction, ENVELOPE } from "../src/benchmarks/swebench.mjs";

const IMAGE = "swebench/sweb.eval.x86_64.psf_1776_requests-6028:latest";
const haveImage = process.env.SKIP_DOCKER !== "1" && spawnSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" }).status === 0;
const skip = !existsSync(MINI.python) ? "mini venv missing (benchmarks/setup.sh mini) — NOT EXECUTED"
  : !haveImage ? `${IMAGE} not present locally — NOT EXECUTED (no pulls in tests)` : false;
const SUBMIT = "COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT";

let srv, baseUrl, script;
const bash = (command, i) => ({ id: "x", object: "chat.completion", created: 0, model: "m", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: "THOUGHT", tool_calls: [{ id: `c${i}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } }] } }] });

before(async () => {
  srv = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const cmd = script.shift();
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(bash(cmd ?? `echo ${SUBMIT}`, script.length)));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${srv.address().port}/v1`;
});
after(() => srv?.close());

function synthRepo() {
  const repo = mkdtempSync(join(tmpdir(), "h34-repo-"));
  writeFileSync(join(repo, "calc.py"), "def add(a, b):\n    return a - b\n");
  const g = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo });
  g("init", "-q"); g("add", "."); g("commit", "-qm", "base");
  return repo;
}
const task = (repo) => buildTaskV2(
  { instance_id: "synthetic__calc-1", repo: "synthetic/calc", base_commit: "0".repeat(40), problem_statement: "add(2, 3) returns -1 instead of 5." },
  { repoDir: repo, image: IMAGE, sandbox: { timeoutSec: 300, memory: "1g", cpus: 1, path: ENVELOPE.path } }
);

describe("mini-swe-agent on a real DockerSandbox (official SWE-bench image)", { skip }, () => {
  it("fixes a synthetic repository through the real bridge and submits a patch that applies to the base", async () => {
    const repo = synthRepo();
    script = [
      "cat calc.py",
      "sed -i 's/a - b/a + b/' calc.py",
      `python -c 'import calc; assert calc.add(2, 3) == 5; print("fixed")'`,
      "git diff -- calc.py > patch.txt",
      `echo ${SUBMIT} && cat patch.txt`
    ];
    const run = await new TaskRunner().run(task(repo), new MiniSweAgent({ model: "kanana", baseUrl, budget: { maxTurns: 10 } }));
    assert.equal(run.trace.stopReason, "done", run.trace.agentError ?? "");
    assert.equal(run.sandbox.type, "docker");
    const out = run.trace.toolCalls.map((c) => c.resultData?.stdout ?? "");
    assert.match(out[0], /return a - b/);
    assert.match(out[2], /fixed/, "the edited code ran inside the container");

    const sub = run.patch.agent_submission;
    // byte-exact: what `git diff` wrote, nothing else (no stderr noise appended)
    const expected = run.patch.model_patch.split(/(?=^diff --git )/m).find((h) => h.startsWith("diff --git a/calc.py"));
    assert.equal(sub, expected);
    assert.ok(!out.some((o) => /bashrc|Permission denied/.test(o)), "no BASH_ENV noise in observations");
    // the prediction applies cleanly to the untouched base commit
    const check = spawnSync("git", ["apply", "--check", "-"], { cwd: repo, input: sub });
    assert.equal(check.status, 0, check.stderr?.toString());
    assert.equal(toPrediction(run, "kab-mini-kanana").model_patch, sub);
    // the workspace diff (kept alongside) also has the agent's patch.txt
    assert.deepEqual([...run.patch.filesChanged].sort(), ["calc.py", "patch.txt"]);
    assert.equal(run.provenance.agentHarness.implementation.revision, MINI.commit);
  });

  it("commands are confined: no network, the host is not visible, escaping links are removed", async () => {
    const repo = synthRepo();
    script = [
      `python -c 'import socket; socket.create_connection(("1.1.1.1", 53), 2)'`,
      "ln -s / hostroot && ls hostroot/ | head -3",
      "touch /etc/kab-probe",
      "echo to-stdout; echo to-stderr >&2; echo again",
      `echo ${SUBMIT}`
    ];
    const run = await new TaskRunner().run(task(repo), new MiniSweAgent({ model: "kanana", baseUrl, budget: { maxTurns: 10 } }));
    assert.equal(run.trace.stopReason, "done", run.trace.agentError ?? "");
    const [net, link, ro, order] = run.trace.toolCalls.map((c) => c.resultData);
    assert.equal(order.stdout, "to-stdout\nto-stderr\nagain\n", "stderr interleaved in order, as upstream");
    assert.notEqual(net.code, 0);
    assert.match(net.stdout, /Network is unreachable|OSError|timed out/);
    assert.match(link.stderr, /removed symlinks escaping the workspace: hostroot/); // exception_info
    assert.notEqual(ro.code, 0, "read-only root");
    assert.match(ro.stdout, /Read-only file system|Permission denied/);
    assert.ok(!run.patch.filesChanged.includes("hostroot"));
  });
});
