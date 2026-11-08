import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Interpreter/test caches created by baseline or check runs must never show up
// in the agent's patch.
const EXCLUDES = [
  "__pycache__/", "*.pyc", ".pytest_cache/", ".mypy_cache/", ".ruff_cache/", ".harness-*",
  // The CLI's own per-workspace cache (retrieval index under .upstage-cli/index/)
  // written by context-building is an infra artifact, not an agent edit — same
  // rationale as the interpreter/test caches above. Excluding it keeps model_patch
  // (and the patch-minimality metric) fair across agents that run through the CLI
  // loop. Scoped to .upstage-cli/ only (the CLI's private session/index store,
  // never a task target); project config under .upstage/ is left visible in case
  // a task legitimately edits it.
  ".upstage-cli/"
];
const IDENT = ["-c", "user.email=harness@upstage", "-c", "user.name=Harness", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false"];
// Host git must never run code the agent planted: no hooks, no fsmonitor, no
// external diff/textconv, and no system/global config (filters, includes).
const HARDEN = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "protocol.allow=never"];
const GIT_ENV = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };

/**
 * Tracks the agent's changes with a git directory the HARNESS owns, outside
 * the agent-writable workspace (security: the workspace's own .git is fully
 * agent-controlled — its config, hooks, or a gitfile could make host git run
 * code). The workspace repo is only touched before the agent starts (pinning
 * and the snapshot commit the agent sees as HEAD); every diff, reset and patch
 * application after that goes through the harness git dir, which never tracks
 * any `.git` path.
 */
export class PatchTracker {
  constructor(workdir) {
    this.workdir = workdir;
    this.gitDir = null; // harness-owned, created by captureInitial()
  }

  /** Remove the harness git dir (the workspace itself is the runner's). */
  dispose() {
    if (this.gitDir) rmSync(join(this.gitDir, ".."), { recursive: true, force: true });
    this.gitDir = null;
  }

  // raw: keep stdout byte-exact (a unified diff's trailing newline and a final
  // blank context line " " are part of the patch; trimming corrupts the hunk).
  // workspaceRepo: run against the workspace's own repository (pre-agent only).
  _git(args, { allowFail = false, raw = false, workspaceRepo = false, input } = {}) {
    const out = (buf) => (raw ? buf.toString("utf8") : buf.toString("utf8").trim());
    const where = workspaceRepo || !this.gitDir ? [] : ["--git-dir", this.gitDir, "--work-tree", this.workdir];
    try {
      return out(execFileSync("git", [...HARDEN, ...IDENT, ...where, ...args], { cwd: this.workdir, input, stdio: "pipe", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...GIT_ENV } }));
    } catch (err) {
      if (allowFail) return err.stdout ? out(err.stdout) : "";
      throw new Error(`git ${args.join(" ")} failed: ${err.stderr?.toString("utf8") || err.message}`, { cause: err });
    }
  }

  /** True when workdir is itself the root of a git repo (not nested in an outer one). */
  _isOwnRepo() {
    const top = this._git(["rev-parse", "--show-toplevel"], { allowFail: true, workspaceRepo: true });
    if (!top) return false;
    try {
      return realpathSync(top) === realpathSync(this.workdir);
    } catch {
      return false;
    }
  }

  /**
   * Prepare the workspace and return the commit every diff is taken against.
   * `commit` (optional) pins an existing repo to a specific revision first.
   * Whatever the starting state (clean, dirty, or not a repo), the returned
   * commit is a snapshot of exactly what the agent will see.
   */
  async captureInitial({ commit = null } = {}) {
    // 1. The workspace repo the agent sees (trusted fixture state, pre-agent):
    //    pinned and committed, so the agent's own `git diff` is against HEAD.
    const ws = { workspaceRepo: true };
    if (!this._isOwnRepo()) {
      if (commit) throw new Error(`Task pins commit ${commit} but its repo is not a git repository`);
      this._git(["init", "-q"], ws);
    } else if (commit) {
      this._git(["checkout", "-q", "--force", commit], ws);
      this._git(["clean", "-fdxq"], ws);
    }
    const infoDir = join(this.workdir, ".git", "info");
    mkdirSync(infoDir, { recursive: true });
    appendFileSync(join(infoDir, "exclude"), `\n${EXCLUDES.join("\n")}\n`);
    // -f: ignored files present at the start (fixture caches, build outputs)
    // are part of the snapshot too, so reset() can restore them exactly and
    // still remove everything else with clean -x
    this._git(["add", "-A", "-f"], ws);
    this._git(["commit", "-q", "--allow-empty", "--no-verify", "-m", "harness: initial state"], ws);

    // 2. The harness's own snapshot of the same tree, outside the workspace.
    this.gitDir = join(mkdtempSync(join(tmpdir(), "kab-track-")), "git");
    this._git(["init", "-q", "--bare", this.gitDir], ws);
    mkdirSync(join(this.gitDir, "info"), { recursive: true });
    writeFileSync(join(this.gitDir, "info", "exclude"), `${EXCLUDES.join("\n")}\n`);
    this._git(["config", "core.bare", "false"]);
    this._git(["add", "-A", "-f"]);
    this._git(["commit", "-q", "--allow-empty", "--no-verify", "-m", "harness: initial state"]);
    return this._git(["rev-parse", "HEAD"]);
  }

  /**
   * Restore the workspace to exactly the captureInitial() snapshot, discarding
   * baseline side effects — including ignored ones (__pycache__, .pytest_cache,
   * build output). Only paths inside this repo's work tree are touched.
   */
  async reset(commit) {
    this._git(["reset", "-q", "--hard", commit]);
    this._git(["clean", "-ffdxq"]);
  }

  /** Apply a unified diff (e.g. a SWE-bench test_patch). Throws on failure. */
  async applyPatch(patchText) {
    // stdin, never a file in the agent-writable workspace (a planted symlink
    // there would make the harness write outside it)
    this._git(["apply", "--whitespace=nowarn", "-"], { input: patchText.endsWith("\n") ? patchText : `${patchText}\n` });
  }

  async captureDiff(initialCommit) {
    // Stage all changes so diff is accurate even without agent committing
    this._git(["add", "-A"], { allowFail: true });

    const D = ["diff", "--cached", "--no-ext-diff", "--no-textconv"];
    const unifiedDiff = this._git([...D, initialCommit], { allowFail: true, raw: true });
    const numstat = this._git([...D, "--numstat", initialCommit], { allowFail: true });
    const filesChanged = this._git([...D, "--name-only", initialCommit], { allowFail: true }).split("\n").filter(Boolean);

    let linesAdded = 0;
    let linesRemoved = 0;
    for (const line of numstat.split("\n").filter(Boolean)) {
      const [a, d] = line.split("\t");
      // binary files report "-"
      linesAdded += Number.parseInt(a, 10) || 0;
      linesRemoved += Number.parseInt(d, 10) || 0;
    }

    // Unstage so later git operations (test patch, reset) see a normal tree
    this._git(["reset", "-q"], { allowFail: true });

    return {
      initialCommit,
      unifiedDiff: unifiedDiff || "",
      filesChanged,
      linesAdded,
      linesRemoved,
      stat: numstat || ""
    };
  }
}
