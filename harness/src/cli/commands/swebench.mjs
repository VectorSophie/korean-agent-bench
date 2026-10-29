import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { TaskRunner } from "../../task/runner.mjs";
import { LOCAL_MODEL_IDS } from "../../agent/local-models.mjs";
import { runServingPreflight, formatPreflight } from "../../preflight/serving.mjs";
import { loadInstances, ensureRepo, buildTask, toPrediction, ReplayPatchAgent } from "../../benchmarks/swebench.mjs";
import { resolveAgent } from "./run.mjs";

const USAGE = `Usage:
  harness swebench run --instance <instance_id> (--agent <id> [--preflight] | --replay-patch <file>) [--runs-dir DIR]
  harness swebench predictions --model-name <name> --out <predictions.jsonl> <run.json> [...]
Resolution is decided only by benchmarks/swebench/evaluate.py (official evaluator).`;

export async function swebenchCommand(argv, options = {}) {
  const sub = argv[0];
  if (sub === "run") return runInstance(options);
  if (sub === "predictions") return writePredictions(argv.slice(1), options);
  console.error(USAGE);
  process.exitCode = 2;
}

async function runInstance(options) {
  const instance = loadInstances().get(options.instance);
  if (!instance) {
    console.error(`unknown instance '${options.instance}'\n${USAGE}`);
    process.exitCode = 2;
    return null;
  }
  let adapter;
  let preflight = null;
  if (typeof options["replay-patch"] === "string") {
    adapter = new ReplayPatchAgent(readFileSync(resolve(options["replay-patch"]), "utf8"));
  } else if (typeof options.agent === "string") {
    adapter = resolveAgent(options.agent, options);
    if (options.preflight) {
      if (!LOCAL_MODEL_IDS.includes(options.agent)) throw new Error("--preflight applies to local models only");
      preflight = await runServingPreflight(options.agent);
      console.log(formatPreflight(preflight));
      if (!preflight.reportable) {
        process.exitCode = 3;
        return null;
      }
    }
  } else {
    console.error(USAGE);
    process.exitCode = 2;
    return null;
  }
  const repoDir = ensureRepo(instance.repo);
  const task = buildTask(instance, { repoDir });
  const runner = new TaskRunner({ runsDir: resolve(options["runs-dir"] || "runs") });
  const run = await runner.run(task, adapter, { preflight });
  console.log(`${instance.instance_id}: run ${run.id} — agent ${run.agentId}, patch ${run.patch?.filesChanged?.length ?? 0} file(s); local status '${run.status}' is not a score`);
  return run;
}

function writePredictions(paths, options) {
  if (!options["model-name"] || !options.out || paths.length === 0) {
    console.error(USAGE);
    process.exitCode = 2;
    return null;
  }
  const rows = paths.map((p) => toPrediction(JSON.parse(readFileSync(resolve(p), "utf8")), options["model-name"]));
  const seen = new Set();
  for (const r of rows) {
    if (seen.has(r.instance_id)) throw new Error(`duplicate prediction for ${r.instance_id}`);
    seen.add(r.instance_id);
  }
  writeFileSync(resolve(options.out), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`wrote ${rows.length} prediction(s) to ${options.out}`);
  return rows;
}
