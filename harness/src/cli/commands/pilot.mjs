import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getHarnessInfo } from "../../task/runner.mjs";
import { getLocalModelConfig } from "../../agent/local-models.mjs";
import { LocalModelAgent } from "../../agent/adapters/local.mjs";
import { MiniSweAgent } from "../../agent/adapters/mini-swe-agent.mjs";
import { runServingPreflight } from "../../preflight/serving.mjs";
import { loadInstances, instanceSpec, TASK_FOR_HARNESS } from "../../benchmarks/swebench.mjs";
import { loadPilotSpec, schedule, runPilot, evaluatePilot } from "../../pilot/pilot.mjs";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../../..");
const USAGE = `Usage:
  harness pilot plan --spec <pilot.json>
  harness pilot run --spec <pilot.json> --out <dir> (--live | --validation [--lease-sec N])
  harness pilot evaluate --out <dir>
--live needs a running queue session (models/serving/kserve-session.sh): the lease end is read from its state file,
and the serving preflight must be REPORTABLE. --validation is for fake model servers only; its results are not a pilot.
<dir> must be outside the repository or under .cache/ (run records contain SWE-bench content).`;

export function checkOut(out) {
  const rel = relative(REPO_ROOT, out);
  const outside = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (!outside && !rel.startsWith(`.cache${sep}`)) throw new Error(`--out ${out} is inside the repository but not under .cache/ (run records contain SWE-bench content)`);
  return out;
}

function liveLeaseEnd(model) {
  const state = join(process.env.KSERVE_SESSION_DIR || join(REPO_ROOT, ".cache/kserve-session"), `${model}.json`);
  if (!existsSync(state)) throw new Error(`no queue session for ${model} (${state}); start it with gpuq + models/serving/kserve-session.sh`);
  const s = JSON.parse(readFileSync(state, "utf8"));
  return (s.startedAt + s.leaseSec) * 1000;
}

function realEnv(spec) {
  const instances = loadInstances();
  const cfg = getLocalModelConfig(spec.model);
  const info = getHarnessInfo();
  return {
    kab: { commit: info.commit, dirty: info.dirty, upstageCli: info.upstageCli },
    instance(id) {
      const instance = instances.get(id);
      if (!instance) throw new Error(`unknown instance ${id}`);
      return { instance, spec: instanceSpec(instance) };
    },
    imageId(image) {
      try { return execFileSync("docker", ["image", "inspect", "--format", "{{.Id}}", image], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; }
    },
    makeTask: (armSpec, instance, ispec) => TASK_FOR_HARNESS[armSpec.harness](instance, ispec),
    makeAdapter: (_arm, armSpec) => (armSpec.harness === "upstage-cli"
      ? new LocalModelAgent({ model: spec.model })
      : new MiniSweAgent({ model: spec.model, budget: { maxTurns: armSpec.maxTurns } })),
    expectedModel: { hfRepo: cfg.provenance.hfRepo, revision: cfg.provenance.revision },
    preflight: () => runServingPreflight(spec.model)
  };
}

function officialEvaluate({ predictions, runId, outDir }) {
  const py = join(REPO_ROOT, ".cache/venv-swebench/bin/python");
  execFileSync(py, [join(REPO_ROOT, "benchmarks/swebench/evaluate.py"), "--predictions", predictions, "--run-id", runId, "--out", outDir], { cwd: REPO_ROOT, stdio: "inherit" });
  const o = JSON.parse(readFileSync(join(outDir, "outcomes.json"), "utf8")).outcomes;
  return Object.fromEntries(Object.entries(o).map(([id, v]) => [id, v.official]));
}

export async function pilotCommand(argv, options = {}) {
  const sub = argv[0];
  if (sub === "plan" && typeof options.spec === "string") {
    const { spec, specSha256 } = loadPilotSpec(resolve(options.spec));
    console.log(JSON.stringify({ specSha256, attempts: schedule(spec).map((s) => s.id) }, null, 1));
    return;
  }
  if (sub === "run" && typeof options.spec === "string" && typeof options.out === "string" && (options.live === true) !== (options.validation === true)) {
    const { spec, specSha256 } = loadPilotSpec(resolve(options.spec));
    const out = checkOut(resolve(options.out));
    const mode = options.live ? "live" : "validation";
    const leaseEndsAt = mode === "live" ? liveLeaseEnd(spec.model) : (options["lease-sec"] ? Date.now() + Number(options["lease-sec"]) * 1000 : null);
    const m = await runPilot({ spec, specSha256, out, mode, env: realEnv(spec), leaseEndsAt, log: console.log });
    const states = Object.values(m.attempts).reduce((acc, a) => ({ ...acc, [a.state]: (acc[a.state] ?? 0) + 1 }), {});
    console.log(JSON.stringify({ out, states, stopped: m.stopped }, null, 1));
    if (m.stopped && !m.stopped.resumable) process.exitCode = 1;
    return;
  }
  if (sub === "evaluate" && typeof options.out === "string") {
    const r = await evaluatePilot({ out: checkOut(resolve(options.out)), evaluate: officialEvaluate });
    console.log(JSON.stringify({ scheduled: r.scheduled, executed: r.executed, failed: r.failed, notExecuted: r.notExecuted }, null, 1));
    return;
  }
  console.error(USAGE);
  process.exitCode = 2;
}
