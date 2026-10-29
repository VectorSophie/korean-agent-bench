// SWE-bench Verified — agent-mediated prediction generation (ADR 0009).
//
// This module only PRODUCES predictions: it runs an agent on an official
// instance (repository at base_commit, issue text) through the normal
// TaskRunner and turns the captured diff into a prediction row
// {instance_id, model_name_or_path, model_patch}. Resolution is decided only by
// the official evaluator (benchmarks/swebench/evaluate.py →
// swebench.harness.run_evaluation). Nothing here scores anything: the task has
// no local checks, so a run record's own status is always "incomplete".
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CodingAgent } from "../agent/interface.mjs";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
export const DATASET = "SWE-bench/SWE-bench_Verified";
export const REVISION = "78f471bf655a3137b2e8a75af1501690ec009ec3";
export const INSTANCES_PATH = join(REPO_ROOT, ".cache/swebench", REVISION, "instances.jsonl");
export const REPO_CACHE = join(REPO_ROOT, ".cache/swebench/repos");
export const SNAPSHOT_CACHE = join(REPO_ROOT, ".cache/swebench/snapshots");

// The only transformation of the official data: the issue text is wrapped in
// this template. hints_text is NOT included (the standard no-hints setting).
export const PROMPT_TEMPLATE_ID = "kab-swebench-prompt-v1";
export const PROMPT_TEMPLATE = `You are working in a checkout of the {repo} repository at commit {base_commit}.
Resolve the issue below by changing the repository's code. Your change will be
evaluated by the project's own tests; the tests that check this issue are not
shown to you.

<issue>
{problem_statement}
</issue>`;
export const PROMPT_TEMPLATE_SHA256 = createHash("sha256").update(PROMPT_TEMPLATE).digest("hex");

// Provisional agent envelope; frozen by a future ADR before any reportable run.
export const ENVELOPE = Object.freeze({
  maxTurns: 30,
  // Turns, not tool calls, are the binding budget (several calls per turn are allowed).
  maxToolCalls: 60,
  timeoutSec: 2700,
  // The benchmark is English; upstage-cli's default system prompt is Korean-first.
  language: "en",
  tools: ["read_file", "write_file", "edit_file", "list_files", "search_code", "glob", "run_shell"],
  // Official images keep the project's interpreter in the "testbed" conda env;
  // put it first so `python`/`pytest` work for the agent (the workspace copy at
  // /workspace is imported first because it is the working directory).
  path: "/opt/miniconda3/envs/testbed/bin:/opt/miniconda3/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  memory: "4g",
  cpus: 2
});

export function buildPrompt(instance) {
  return PROMPT_TEMPLATE.replace("{repo}", instance.repo)
    .replace("{base_commit}", instance.base_commit)
    .replace("{problem_statement}", instance.problem_statement);
}

export function loadInstances(path = INSTANCES_PATH) {
  if (!existsSync(path)) {
    throw new Error(`${path} missing — run: .cache/venv-swebench/bin/python benchmarks/swebench/acquire.py --export`);
  }
  const map = new Map();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    map.set(row.instance_id, row);
  }
  return map;
}

/** Full (non-shallow) clone in the local cache, so any base_commit is available. */
export function ensureRepo(repo, { cacheDir = REPO_CACHE, git = (args, cwd) => execFileSync("git", args, { cwd, stdio: "pipe" }) } = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`invalid repo '${repo}'`);
  const dir = join(cacheDir, repo.replace("/", "__"));
  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(cacheDir, { recursive: true });
    git(["clone", "--quiet", `https://github.com/${repo}.git`, dir], cacheDir);
  }
  return dir;
}

const GIT_ID = ["-c", "user.name=kab-snapshot", "-c", "user.email=kab-snapshot@invalid", "-c", "commit.gpgsign=false"];

/**
 * The agent's workspace: a NEW repository whose only commit is base_commit's
 * tree. A clone of the upstream repository would let the agent reach the
 * future commits that contain the gold fix (`git log --all`), so it is never
 * used as the workspace. Materialized through a temporary index, so the cache
 * clone is not modified. Fails closed if the cache clone is missing (clones
 * happen in the serial `prepare` step, never during a run).
 */
export function prepareSnapshot(instance, { cacheDir = REPO_CACHE, snapDir = SNAPSHOT_CACHE } = {}) {
  const clone = join(cacheDir, instance.repo.replace("/", "__"));
  if (!existsSync(join(clone, ".git"))) throw new Error(`repository cache missing for ${instance.repo}: run \`harness swebench prepare\` first`);
  const dir = join(snapDir, instance.instance_id);
  const marker = join(dir, ".git", "kab-snapshot.json");
  if (existsSync(marker)) {
    const m = JSON.parse(readFileSync(marker, "utf8"));
    if (m.base_commit !== instance.base_commit) throw new Error(`snapshot ${dir} was built from ${m.base_commit}, not ${instance.base_commit}`);
    return dir;
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const index = join(snapDir, `.${instance.instance_id}.index`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  const g = (args, opts = {}) => execFileSync("git", args, { stdio: "pipe", ...opts });
  g(["--git-dir", join(clone, ".git"), "--work-tree", dir, "read-tree", instance.base_commit], { env });
  g(["--git-dir", join(clone, ".git"), "--work-tree", dir, "checkout-index", "-a", "-f"], { env });
  rmSync(index, { force: true });
  g(["init", "-q"], { cwd: dir });
  g([...GIT_ID, "add", "-A", "-f"], { cwd: dir });
  g([...GIT_ID, "commit", "-q", "--no-verify", "-m", `snapshot of ${instance.repo}@${instance.base_commit}`],
    { cwd: dir, env: { ...process.env, GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" } });
  writeFileSync(marker, JSON.stringify({ repo: instance.repo, base_commit: instance.base_commit, tree: g(["rev-parse", "HEAD^{tree}"], { cwd: dir }).toString().trim() }));
  return dir;
}

export function snapshotDir(instance, { snapDir = SNAPSHOT_CACHE } = {}) {
  const dir = join(snapDir, instance.instance_id);
  if (!existsSync(join(dir, ".git", "kab-snapshot.json"))) throw new Error(`no snapshot for ${instance.instance_id}: run \`harness swebench prepare\` first`);
  return dir;
}

export function buildTask(instance, { repoDir, image = instance.image, envelope = ENVELOPE } = {}) {
  return {
    id: `swebench-${instance.instance_id}`,
    version: 1,
    description: `SWE-bench Verified ${instance.instance_id} (prediction generation only)`,
    repo: repoDir,
    // The workspace is a single-commit snapshot of base_commit (prepareSnapshot);
    // its HEAD is the diff base. base_commit is recorded in _meta.

    prompt: buildPrompt(instance),
    context: { strategy: "default", maxFiles: 40, includeTests: true },
    sandbox: {
      type: "docker", image, network: "none", timeout: envelope.timeoutSec, dependencies: "image",
      memory: envelope.memory, cpus: envelope.cpus, env: { PATH: envelope.path }
    },
    agent: {
      permissions: "bypassPermissions", maxTurns: envelope.maxTurns, maxToolCalls: envelope.maxToolCalls, language: envelope.language,
      tools: { allow: [...envelope.tools], deny: [] }
    },
    // No local checks: resolution is decided only by the official evaluator.
    checks: { fail_to_pass: [], pass_to_pass: [], custom: [] },
    tags: ["swebench-verified", "prediction-only"],
    _meta: {
      source: "swebench-verified",
      dataset: DATASET,
      version: REVISION,
      instance_id: instance.instance_id,
      base_commit: instance.base_commit,
      promptTemplate: PROMPT_TEMPLATE_ID,
      promptTemplateSha256: PROMPT_TEMPLATE_SHA256,
      officialEvaluation: "swebench.harness.run_evaluation"
    }
  };
}

/** A run record → one official prediction row. Missing patch → "" (the
 *  official evaluator classifies it as an empty patch). */
export function toPrediction(run, modelName) {
  const instanceId = run?.provenance?.task?.id?.replace(/^swebench-/, "");
  if (!instanceId || !run.id) throw new Error("not a SWE-bench run record");
  return {
    instance_id: instanceId,
    model_name_or_path: modelName,
    model_patch: typeof run.patch?.model_patch === "string" ? run.patch.model_patch : ""
  };
}

/** Pipeline-validation agent: applies a given unified diff with `git apply`.
 *  Not a model; never registered as a selectable agent. */
export class ReplayPatchAgent extends CodingAgent {
  constructor(patchText) {
    super();
    this._patch = patchText;
  }
  get id() { return "replay-patch"; }
  get displayName() { return "Replay patch (pipeline validation, not a model)"; }
  get supportsSandbox() { return true; }
  isAvailable() { return true; }
  async run(_task, context) {
    if (this._patch) {
      execFileSync("git", ["apply", "--whitespace=nowarn", "-"], { cwd: context.workdir, input: this._patch, stdio: ["pipe", "pipe", "pipe"] });
    }
    return { ok: true, turns: 0, toolCalls: 0, usage: null, events: [], stopReason: "done" };
  }
}
