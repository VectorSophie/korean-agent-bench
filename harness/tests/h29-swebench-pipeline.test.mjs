// SWE-bench Verified prediction pipeline (src/benchmarks/swebench.mjs) without
// Docker, network or the dataset: task construction, run → prediction, and
// byte-exact patch capture. Official resolution is tested separately by
// benchmarks/swebench/validate_offline.py against the real evaluator.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, cpSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTask, buildPrompt, toPrediction, ReplayPatchAgent, PROMPT_TEMPLATE_SHA256, ENVELOPE, prepareSnapshot } from "../src/benchmarks/swebench.mjs";
import { TaskRunner } from "../src/task/runner.mjs";
import { removeEscapingSymlinks } from "../src/agent/sandboxed-tools.mjs";
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
    assert.equal(t.commit, undefined, "the snapshot's own HEAD is the diff base");
    assert.equal(t._meta.base_commit, base);
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

  it("keeps relative symlinks verbatim: an agent change yields a patch with no symlink entries that applies to the real repository", async () => {
    // django/matplotlib carry relative symlinks; a workspace copy that rewrote
    // them to absolute host paths put spurious symlink hunks into every patch,
    // so the official evaluator could not apply it (main-v1 amendment 1).
    execFileSync("mkdir", ["-p", join(repo, "docs", "a"), join(repo, "docs", "b")]);
    writeFileSync(join(repo, "docs", "a", "icon.png"), "png");
    execFileSync("ln", ["-s", "../a/icon.png", join(repo, "docs", "b", "icon.png")]);
    git(["add", "."], repo);
    git(["commit", "-q", "-m", "links"], repo);
    base = git(["rev-parse", "HEAD"], repo).trim();
    // the agent's workspace must hold the link exactly as committed (not an
    // absolute path to the source checkout, which dangles inside a container);
    // the sandboxed tools' escaping-symlink guard must then have nothing to
    // remove (on Docker tasks it runs before the first turn and removed
    // exactly these links in main-v1 stage 1)
    let seen = null, removed = null;
    const probe = { name: "probe", async run(_task, ctx) {
      seen = readlinkSync(join(ctx.workdir, "docs", "b", "icon.png"));
      removed = removeEscapingSymlinks(ctx.workdir);
      return { ok: true, turns: 0, toolCalls: 0, usage: null, events: [] };
    } };
    await new TaskRunner().run({ ...buildTask(instance(), { repoDir: repo }), sandbox: { type: "native", timeout: 60 } }, probe);
    assert.equal(seen, "../a/icon.png");
    assert.deepEqual(removed, []);
    const run = await replay(PATCH);
    const pred = toPrediction(run, "kab-test");
    assert.ok(!pred.model_patch.includes("icon.png"), pred.model_patch.slice(0, 400));
    const fresh = join(dir, "fresh");
    execFileSync("git", ["clone", "-q", repo, fresh]);
    execFileSync("git", ["apply", "--check", "-"], { cwd: fresh, input: pred.model_patch });
    assert.equal(toPrediction(await replay(""), "kab-test").model_patch, "", "no change → empty patch even with symlinks");
  });

  it("rejects records that are not SWE-bench runs", () => {
    assert.throws(() => toPrediction({ id: "x", provenance: { task: {} } }, "m"));
  });
});

describe("workspace snapshot (no access to future commits)", () => {
  it("has exactly one commit with base_commit's tree; the later fix is unreachable; the cache clone is untouched", () => {
    // cache clone layout: <cacheDir>/<owner>__<name>
    const cacheDir = join(dir, "cache");
    const clone = join(cacheDir, "org__proj");
    cpSync(repo, clone, { recursive: true });
    writeFileSync(join(clone, ".gitignore"), "build/\n");
    execFileSync("mkdir", ["-p", join(clone, "build")]);
    writeFileSync(join(clone, "build", "tracked.txt"), "tracked despite .gitignore\n");
    git(["add", "-f", "."], clone);
    git(["commit", "-q", "-m", "base with ignored-but-tracked file"], clone);
    const baseSha = git(["rev-parse", "HEAD"], clone).trim();
    writeFileSync(join(clone, "mod.py"), "def f():\n    return 2  # GOLD FIX\n\n");
    git(["commit", "-qam", "the future fix"], clone);
    const statusBefore = git(["status", "--porcelain"], clone);

    const snap = prepareSnapshot({ instance_id: "org__proj-1", repo: "org/proj", base_commit: baseSha }, { cacheDir, snapDir: join(dir, "snaps") });
    assert.equal(git(["rev-list", "--all"], snap).trim().split("\n").length, 1);
    assert.equal(git(["rev-parse", "HEAD^{tree}"], snap).trim(), git(["rev-parse", `${baseSha}^{tree}`], clone).trim());
    assert.ok(!git(["log", "--all", "-p"], snap).includes("GOLD FIX"));
    assert.equal(git(["fsck", "--unreachable", "--no-reflogs"], snap).trim(), "");
    assert.ok(readFileSync(join(snap, "build", "tracked.txt"), "utf8").includes("tracked"));
    assert.equal(git(["status", "--porcelain"], clone), statusBefore, "cache clone not modified");
    // idempotent; refuses a different base
    assert.equal(prepareSnapshot({ instance_id: "org__proj-1", repo: "org/proj", base_commit: baseSha }, { cacheDir, snapDir: join(dir, "snaps") }), snap);
    assert.throws(() => prepareSnapshot({ instance_id: "org__proj-1", repo: "org/proj", base_commit: base }, { cacheDir, snapDir: join(dir, "snaps") }));
  });
});
