import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync, execFileSync } from "node:child_process";

import { PatchTracker as RealPatchTracker } from "../src/tracking/patch-tracker.mjs";
import { CodingAgent } from "../src/agent/interface.mjs";
import { TaskRunner } from "../src/task/runner.mjs";

// Every tracker owns a git dir outside its workspace; release them all.
const trackers = [];
class PatchTracker extends RealPatchTracker {
  constructor(dir) { super(dir); trackers.push(this); }
}
const ROOT = mkdtempSync(join(tmpdir(), "h4-root-"));
after(() => { trackers.forEach((t) => t.dispose()); rmSync(ROOT, { recursive: true, force: true }); });

function initRepo(dir) {
  execSync("git init -q", { cwd: dir });
  execSync('git config user.email "test@harness"', { cwd: dir });
  execSync('git config user.name "Harness Test"', { cwd: dir });
}

function commit(dir, msg = "initial") {
  execSync("git add -A", { cwd: dir });
  execSync(`git commit -q -m "${msg}"`, { cwd: dir });
  return execSync("git rev-parse HEAD", { cwd: dir }).toString().trim();
}

// ── captureInitial ────────────────────────────────────────────────────────────

describe("PatchTracker — captureInitial", () => {
  it("returns a 40-char SHA for an existing git repo", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "h4-init-"));
    try {
      initRepo(tmp);
      writeFileSync(join(tmp, "file.txt"), "hello");
      commit(tmp);
      const tracker = new PatchTracker(tmp);
      const sha = await tracker.captureInitial();
      assert.match(sha, /^[0-9a-f]{40}$/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("initialises repo and commits when directory is not a git repo", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "h4-nongit-"));
    try {
      writeFileSync(join(tmp, "file.txt"), "content");
      const tracker = new PatchTracker(tmp);
      const sha = await tracker.captureInitial();
      assert.match(sha, /^[0-9a-f]{40}$/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── captureDiff ───────────────────────────────────────────────────────────────

describe("PatchTracker — captureDiff", () => {
  it("detects no change when nothing modified", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "h4-nochange-"));
    try {
      writeFileSync(join(tmp, "app.py"), "x = 1\n");
      const tracker = new PatchTracker(tmp);
      const initial = await tracker.captureInitial();
      const diff = await tracker.captureDiff(initial);
      assert.equal(diff.filesChanged.length, 0);
      assert.equal(diff.linesAdded, 0);
      assert.equal(diff.linesRemoved, 0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("detects single-file single-line addition", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "h4-add-"));
    try {
      writeFileSync(join(tmp, "app.py"), "x = 1\n");
      const tracker = new PatchTracker(tmp);
      const initial = await tracker.captureInitial();
      // Agent "fixes" the file
      writeFileSync(join(tmp, "app.py"), "x = 1\ny = 2\n");
      const diff = await tracker.captureDiff(initial);
      assert.equal(diff.filesChanged.length, 1);
      assert.equal(diff.linesAdded, 1);
      assert.equal(diff.linesRemoved, 0);
      assert.ok(diff.unifiedDiff.includes("+y = 2"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("detects multi-file changes", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "h4-multi-"));
    try {
      writeFileSync(join(tmp, "a.py"), "a = 1\n");
      writeFileSync(join(tmp, "b.py"), "b = 1\n");
      const tracker = new PatchTracker(tmp);
      const initial = await tracker.captureInitial();
      writeFileSync(join(tmp, "a.py"), "a = 2\n");
      writeFileSync(join(tmp, "b.py"), "b = 2\n");
      const diff = await tracker.captureDiff(initial);
      assert.equal(diff.filesChanged.length, 2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("includes unified diff text", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "h4-unified-"));
    try {
      writeFileSync(join(tmp, "x.py"), "old line\n");
      const tracker = new PatchTracker(tmp);
      const initial = await tracker.captureInitial();
      writeFileSync(join(tmp, "x.py"), "new line\n");
      const diff = await tracker.captureDiff(initial);
      assert.ok(diff.unifiedDiff.includes("---") || diff.unifiedDiff.includes("+++"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("counts line removals", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "h4-remove-"));
    try {
      writeFileSync(join(tmp, "app.py"), "line1\nline2\nline3\n");
      const tracker = new PatchTracker(tmp);
      const initial = await tracker.captureInitial();
      writeFileSync(join(tmp, "app.py"), "line1\n");
      const diff = await tracker.captureDiff(initial);
      assert.equal(diff.linesRemoved, 2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── integration: captureInitial then captureDiff ──────────────────────────────

describe("PatchTracker — integration round-trip", () => {
  it("initial SHA is preserved in diff output", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "h4-round-"));
    try {
      writeFileSync(join(tmp, "main.py"), "def main(): pass\n");
      const tracker = new PatchTracker(tmp);
      const initial = await tracker.captureInitial();
      writeFileSync(join(tmp, "main.py"), "def main():\n    return 42\n");
      const diff = await tracker.captureDiff(initial);
      assert.equal(diff.initialCommit, initial);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("new files appear in filesChanged", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "h4-newfile-"));
    try {
      writeFileSync(join(tmp, "existing.py"), "x = 1\n");
      const tracker = new PatchTracker(tmp);
      const initial = await tracker.captureInitial();
      writeFileSync(join(tmp, "new_module.py"), "y = 2\n");
      const diff = await tracker.captureDiff(initial);
      assert.ok(diff.filesChanged.includes("new_module.py"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// Security (independent review of PR #15): the workspace's own .git is agent-
// writable. Host git used for patch capture must not run anything planted there.
describe("PatchTracker ignores an agent-controlled workspace .git", () => {
  const plant = (dir, marker) => {
    const sh = `#!/bin/sh\ntouch ${marker}\n`;
    writeFileSync(join(dir, ".git", "hooks", "post-index-change"), sh, { mode: 0o755 });
    writeFileSync(join(dir, "fsmon.sh"), sh, { mode: 0o755 });
    execFileSync("git", ["config", "core.fsmonitor", join(dir, "fsmon.sh")], { cwd: dir });
    execFileSync("git", ["config", "filter.evil.clean", `touch ${marker}; cat`], { cwd: dir });
    execFileSync("git", ["config", "diff.external", join(dir, "fsmon.sh")], { cwd: dir });
    writeFileSync(join(dir, ".gitattributes"), "* filter=evil diff=evil\n");
  };

  it("captures the diff without running planted hooks, fsmonitor, filters or external diff", async () => {
    const dir = mkdtempSync(join(ROOT, "h4-sec-"));
    const marker = join(mkdtempSync(join(ROOT, "h4-marker-")), "PWNED");
    writeFileSync(join(dir, "a.txt"), "one\n");
    const t = new PatchTracker(dir);
    const base = await t.captureInitial();
    writeFileSync(join(dir, "a.txt"), "two\n");
    plant(dir, marker);
    const d = await t.captureDiff(base);
    await t.reset(base);
    t.dispose();
    assert.equal(existsSync(marker), false, "host git ran agent-planted code");
    assert.match(d.unifiedDiff, /-one\n\+two/);
    assert.ok(!d.filesChanged.some((f) => f.startsWith(".git/")), "the workspace .git is never part of the patch");
    assert.ok(existsSync(join(dir, ".git", "HEAD")), "reset keeps the workspace's own repository");
  });

  it("still captures the diff when the agent replaces .git with a gitfile", async () => {
    const dir = mkdtempSync(join(ROOT, "h4-sec-"));
    writeFileSync(join(dir, "a.txt"), "one\n");
    const t = new PatchTracker(dir);
    const base = await t.captureInitial();
    rmSync(join(dir, ".git"), { recursive: true, force: true });
    writeFileSync(join(dir, ".git"), "gitdir: /nonexistent\n");
    writeFileSync(join(dir, "a.txt"), "two\n");
    const d = await t.captureDiff(base);
    t.dispose();
    assert.deepEqual(d.filesChanged, ["a.txt"]);
  });
});

// Fidelity, symlinks, cleanup and the full runner path, with the harness-owned
// git dir (security PR). The workspace repo the agent sees is unchanged.
describe("PatchTracker with a harness-owned git dir: fidelity and lifecycle", () => {
  const ws = () => {
    const dir = mkdtempSync(join(ROOT, "h4-fid-"));
    writeFileSync(join(dir, "a.txt"), "one\n\ntwo\n");
    writeFileSync(join(dir, "noeol.txt"), "x");
    return dir;
  };

  it("the patch is byte-identical to a diff made in the workspace repo itself (v1 behaviour)", async () => {
    const dir = ws();
    const t = new PatchTracker(dir);
    const base = await t.captureInitial();
    writeFileSync(join(dir, "a.txt"), "one\n\nTWO\n"); // blank context line
    writeFileSync(join(dir, "noeol.txt"), "y"); // "\ No newline at end of file"
    writeFileSync(join(dir, "bin.dat"), Buffer.from([0, 1, 2, 255]));
    writeFileSync(join(dir, "new.txt"), "n\n");
    rmSync(join(dir, "a.txt")); writeFileSync(join(dir, "a.txt"), "one\n\nTWO\n");
    const d = await t.captureDiff(base);
    const g = (...a) => execFileSync("git", a, { cwd: dir }).toString("utf8");
    g("add", "-A");
    assert.equal(d.unifiedDiff, g("diff", "--cached", "--no-ext-diff", "--no-textconv", base));
    assert.match(d.unifiedDiff, /\\ No newline at end of file/);
    assert.match(d.unifiedDiff, /Binary files/);
    assert.equal(base, g("rev-parse", "HEAD").trim(), "the agent's HEAD is the snapshot commit");
  });

  it("symlinks are recorded as links (never followed), including ones pointing outside", async () => {
    const dir = ws();
    const outside = join(mkdtempSync(join(ROOT, "h4-out-")), "secret");
    writeFileSync(outside, "host secret\n");
    const t = new PatchTracker(dir);
    const base = await t.captureInitial();
    symlinkSync(outside, join(dir, "leak"));
    symlinkSync("a.txt", join(dir, "inner"));
    const d = await t.captureDiff(base);
    assert.match(d.unifiedDiff, /new file mode 120000/);
    assert.ok(!d.unifiedDiff.includes("host secret"), "link target content never enters the patch");
    await t.reset(base);
    assert.equal(existsSync(join(dir, "leak")), false);
    assert.equal(readFileSync(outside, "utf8"), "host secret\n");
  });

  it("applyPatch never writes through a planted .harness-test.patch symlink", async () => {
    const dir = ws();
    const victim = join(mkdtempSync(join(ROOT, "h4-out-")), "victim");
    writeFileSync(victim, "untouched\n");
    const t = new PatchTracker(dir);
    await t.captureInitial();
    symlinkSync(victim, join(dir, ".harness-test.patch"));
    await t.applyPatch("--- /dev/null\n+++ b/t.txt\n@@ -0,0 +1 @@\n+t\n");
    assert.equal(readFileSync(victim, "utf8"), "untouched\n");
    assert.equal(readFileSync(join(dir, "t.txt"), "utf8"), "t\n");
  });

  it("applyPatch refuses to modify a file the agent replaced with an outside symlink", async () => {
    const dir = ws();
    const victim = join(mkdtempSync(join(ROOT, "h4-out-")), "victim");
    writeFileSync(victim, "one\n\ntwo\n");
    const t = new PatchTracker(dir);
    await t.captureInitial();
    rmSync(join(dir, "a.txt")); symlinkSync(victim, join(dir, "a.txt"));
    await assert.rejects(t.applyPatch("--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n one\n \n-two\n+TWO\n"));
    assert.equal(readFileSync(victim, "utf8"), "one\n\ntwo\n");
  });

  it("an agent-made nested repository with planted fsmonitor/hooks runs nothing", async () => {
    const dir = ws();
    const marker = join(mkdtempSync(join(ROOT, "h4-marker-")), "PWNED");
    const t = new PatchTracker(dir);
    const base = await t.captureInitial();
    const sub = join(dir, "sub");
    mkdirSync(sub);
    execFileSync("git", ["init", "-q"], { cwd: sub });
    writeFileSync(join(sub, "f"), "f\n");
    writeFileSync(join(dir, "mon.sh"), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    execFileSync("git", ["config", "core.fsmonitor", join(dir, "mon.sh")], { cwd: sub });
    writeFileSync(join(sub, ".git", "hooks", "post-index-change"), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    await t.captureDiff(base);
    await t.reset(base);
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(sub), false, "reset removes the nested repository");
  });

  it("dispose removes the harness git dir; the workspace repository stays", async () => {
    const dir = ws();
    const t = new PatchTracker(dir);
    await t.captureInitial();
    const gitDir = t.gitDir;
    assert.ok(!gitDir.startsWith(dir), "outside the workspace");
    t.dispose();
    assert.equal(existsSync(join(gitDir, "..")), false);
    assert.ok(existsSync(join(dir, ".git", "HEAD")));
    t.dispose(); // idempotent
  });
});

describe("TaskRunner end to end: a hostile agent cannot make host git run code", () => {
  class PlantingAgent extends CodingAgent {
    constructor(marker, victim) { super(); this.marker = marker; this.victim = victim; }
    get id() { return "planting-agent"; }
    isAvailable() { return true; }
    async run(_task, { workdir }) {
      const sh = `#!/bin/sh\ntouch ${this.marker}\n`;
      writeFileSync(join(workdir, "evil.sh"), sh, { mode: 0o755 });
      for (const h of ["pre-commit", "post-index-change", "post-checkout"]) writeFileSync(join(workdir, ".git", "hooks", h), sh, { mode: 0o755 });
      const cfg = (k, v) => execFileSync("git", ["config", k, v], { cwd: workdir });
      cfg("core.fsmonitor", join(workdir, "evil.sh"));
      cfg("filter.evil.clean", `touch ${this.marker}; cat`);
      cfg("filter.evil.smudge", `touch ${this.marker}; cat`);
      cfg("diff.external", join(workdir, "evil.sh"));
      cfg("include.path", join(workdir, "evil.cfg"));
      writeFileSync(join(workdir, ".gitattributes"), "* filter=evil diff=evil\n");
      symlinkSync(this.victim, join(workdir, ".harness-test.patch"));
      writeFileSync(join(workdir, "fix.txt"), "fixed\n");
      return { ok: true, turns: 1, toolCalls: 0, usage: null, events: [], stopReason: "done" };
    }
  }

  it("captures the agent's edit, applies the test patch, runs nothing planted and leaves no harness git dir", async () => {
    const scratch = mkdtempSync(join(ROOT, "h4-runner-"));
    const repo = mkdtempSync(join(ROOT, "h4-repo-"));
    writeFileSync(join(repo, "a.txt"), "a\n");
    const marker = join(scratch, "PWNED");
    const victim = join(scratch, "victim");
    writeFileSync(victim, "untouched\n");
    const task = {
      id: "h4-hostile", version: 1, repo, prompt: "noop", sandbox: { type: "native", timeout: 60 }, agent: { maxTurns: 1 },
      checks: {}, testPatch: "--- /dev/null\n+++ b/test_new.txt\n@@ -0,0 +1 @@\n+t\n"
    };
    const prev = process.env.TMPDIR;
    const tmp = mkdtempSync(join(ROOT, "h4-tmpdir-"));
    process.env.TMPDIR = tmp; // the runner's workspace and the tracker's git dir land here
    let run;
    try {
      run = await new TaskRunner().run(task, new PlantingAgent(marker, victim));
    } finally {
      if (prev === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prev;
    }
    assert.equal(existsSync(marker), false, "host git ran agent-planted code");
    assert.equal(readFileSync(victim, "utf8"), "untouched\n");
    assert.equal(run.result?.infraError ?? null, null, JSON.stringify(run.result));
    assert.ok(run.patch.filesChanged.includes("fix.txt"));
    assert.ok(!run.patch.filesChanged.some((f) => f.startsWith(".git/")));
    assert.deepEqual(readdirSync(tmp), [], "workspace and harness git dir removed");
  });
});
