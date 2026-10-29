// SWE-bench Verified prediction pipeline (src/benchmarks/swebench.mjs) without
// Docker, network or the dataset: task construction, run → prediction, and
// byte-exact patch capture. Official resolution is tested separately by
// benchmarks/swebench/validate_offline.py against the real evaluator.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTask, buildPrompt, toPrediction, ReplayPatchAgent, PROMPT_TEMPLATE_SHA256, ENVELOPE } from "../src/benchmarks/swebench.mjs";
import { TaskRunner } from "../src/task/runner.mjs";
import { validate } from "../src/task/schema.mjs";

const git = (args, cwd) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" }).toString();

let dir, repo, base;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "h29-"));
  repo = join(dir, "repo");
  execFileSync("mkdir", ["-p", repo]);
  git(["init", "-q"], repo);
  // Ends with a blank line, so a diff of an edit near the end has a final
  // context line that is a single space — the case trimming corrupts.
  writeFileSync(join(repo, "mod.py"), "def f():\n    return 1\n\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "base"], repo);
  base = git(["rev-parse", "HEAD"], repo).trim();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const instance = () => ({
  instance_id: "org__proj-1", repo: "org/proj", base_commit: base, image: "example/image:latest",
  problem_statement: "f() should return 2.\nSee the attached traceback.", hints_text: "SECRET HINT TEXT"
});

describe("SWE-bench task construction", () => {
  it("is a valid task with the issue verbatim, no hints, no local checks, and the official image", () => {
    const t = buildTask(instance(), { repoDir: repo });
    assert.equal(validate(t).valid, true, JSON.stringify(validate(t).errors));
    assert.ok(t.prompt.includes("f() should return 2.\nSee the attached traceback."));
    assert.ok(!t.prompt.includes("SECRET HINT TEXT"));
    assert.equal(t.prompt, buildPrompt(instance()));
    assert.deepEqual(t.checks, { fail_to_pass: [], pass_to_pass: [], custom: [] });
    assert.equal(t.commit, base);
    assert.equal(t.sandbox.image, "example/image:latest");
    assert.equal(t.sandbox.network, "none");
    assert.equal(t._meta.promptTemplateSha256, PROMPT_TEMPLATE_SHA256);
    assert.equal(t.agent.maxTurns, ENVELOPE.maxTurns);
  });
});

describe("run → prediction", () => {
  const PATCH = "diff --git a/mod.py b/mod.py\n--- a/mod.py\n+++ b/mod.py\n@@ -1,3 +1,3 @@\n def f():\n-    return 1\n+    return 2\n \n";

  async function replay(patch) {
    const t = { ...buildTask(instance(), { repoDir: repo }), sandbox: { type: "native", timeout: 60 } };
    return new TaskRunner().run(t, new ReplayPatchAgent(patch));
  }

  it("captures the agent's change byte-exact (trailing blank context line kept) and it re-applies", async () => {
    const run = await replay(PATCH);
    assert.equal(run.status, "incomplete", "no local checks: the record never claims a pass");
    const pred = toPrediction(run, "kab-test");
    assert.deepEqual(Object.keys(pred).sort(), ["instance_id", "model_name_or_path", "model_patch"]);
    assert.equal(pred.instance_id, "org__proj-1");
    assert.ok(pred.model_patch.endsWith(" \n"), JSON.stringify(pred.model_patch.slice(-12)));
    const fresh = join(dir, "fresh");
    cpSync(repo, fresh, { recursive: true });
    execFileSync("git", ["apply", "--check", "-"], { cwd: fresh, input: pred.model_patch });
    execFileSync("git", ["apply", "-"], { cwd: fresh, input: pred.model_patch });
    assert.equal(readFileSync(join(fresh, "mod.py"), "utf8"), "def f():\n    return 2\n\n");
  });

  it("no change → empty model_patch (the official evaluator classifies it)", async () => {
    const pred = toPrediction(await replay(""), "kab-test");
    assert.equal(pred.model_patch, "");
  });

  it("rejects records that are not SWE-bench runs", () => {
    assert.throws(() => toPrediction({ id: "x", provenance: { task: {} } }, "m"));
  });
});
