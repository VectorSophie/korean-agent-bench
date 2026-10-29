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
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CodingAgent } from "../agent/interface.mjs";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
export const DATASET = "SWE-bench/SWE-bench_Verified";
export const REVISION = "78f471bf655a3137b2e8a75af1501690ec009ec3";
export const INSTANCES_PATH = join(REPO_ROOT, ".cache/swebench", REVISION, "instances.jsonl");
export const REPO_CACHE = join(REPO_ROOT, ".cache/swebench/repos");

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
  timeoutSec: 1800,
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

export function buildTask(instance, { repoDir, image = instance.image, envelope = ENVELOPE } = {}) {
  return {
    id: `swebench-${instance.instance_id}`,
    version: 1,
    description: `SWE-bench Verified ${instance.instance_id} (prediction generation only)`,
    repo: repoDir,
    commit: instance.base_commit,
    prompt: buildPrompt(instance),
    context: { strategy: "default", maxFiles: 40, includeTests: true },
    sandbox: {
      type: "docker", image, network: "none", timeout: envelope.timeoutSec, dependencies: "image",
      memory: envelope.memory, cpus: envelope.cpus, env: { PATH: envelope.path }
    },
    agent: { permissions: "bypassPermissions", maxTurns: envelope.maxTurns, tools: { allow: [...envelope.tools], deny: [] } },
    // No local checks: resolution is decided only by the official evaluator.
    checks: { fail_to_pass: [], pass_to_pass: [], custom: [] },
    tags: ["swebench-verified", "prediction-only"],
    _meta: {
      source: "swebench-verified",
      dataset: DATASET,
      version: REVISION,
      instance_id: instance.instance_id,
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
