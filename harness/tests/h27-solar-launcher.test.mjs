// The maintained Solar launcher (models/serving/kserve-solar.sh) must start the
// configuration the harness declares, by digest, at the validated context.
// No container is started: `print-config` has no side effects, and the
// refusal test puts a fake `docker` first on PATH that only answers
// `image inspect` and records every call.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getLocalModelConfig } from "../src/agent/local-models.mjs";
import { runServingPreflight, formatPreflight } from "../src/preflight/serving.mjs";

const LAUNCHER = resolve(fileURLToPath(import.meta.url), "../../../models/serving/kserve-solar.sh");
const SOLAR = getLocalModelConfig("solar-open2");

function printConfig(extraEnv = {}) {
  const out = execFileSync("bash", [LAUNCHER, "print-config"], { env: { ...process.env, ...extraEnv }, encoding: "utf8" });
  const lines = out.trim().split("\n");
  return {
    image: lines.find((l) => l.startsWith("image=")).slice(6),
    args: lines.filter((l) => l.startsWith("arg=")).map((l) => l.slice(4))
  };
}

describe("Solar launcher", () => {
  it("defaults to the declared digest and the declared 8192 context", () => {
    const { image, args } = printConfig();
    assert.equal(image, SOLAR.provenance.servingImage);
    assert.equal(args[args.indexOf("--max-model-len") + 1], String(SOLAR.contextLimit));
  });

  it("its exact arguments pass the serving preflight (launcher and harness config agree)", async () => {
    const { image, args } = printConfig();
    const r = await runServingPreflight("solar-open2", {
      observers: {
        models: async () => ({ data: [{ id: SOLAR.servedModelName, root: args[0], max_model_len: SOLAR.contextLimit }] }),
        container: async () => ({ Name: "/kserve-solar", State: { Running: true }, Image: "sha256:" + "2".repeat(64), Config: { Image: image, Env: ["NVIDIA_VISIBLE_DEVICES=0,1"] }, Args: args }),
        image: async () => ({ RepoDigests: [image] }),
        git: async () => ({ commit: "a".repeat(40), dirty: false, upstageCli: { commit: "b".repeat(40), pinnedCommit: "b".repeat(40), matchesPin: true, dirty: false } })
      }
    });
    assert.equal(r.reportable, true, formatPreflight(r));
  });

  it("refuses to start an image that does not resolve to the pinned digest, before any other step", () => {
    const dir = mkdtempSync(join(tmpdir(), "h27-"));
    try {
      const log = join(dir, "calls.log");
      writeFileSync(join(dir, "docker"), `#!/usr/bin/env bash\necho "$*" >> "${log}"\nif [ "$1" = image ] && [ "$2" = inspect ]; then echo "upstage/vllm-solar-open2@sha256:${"f".repeat(64)}"; exit 0; fi\nexit 97\n`);
      chmodSync(join(dir, "docker"), 0o755);
      const r = spawnSync("bash", [LAUNCHER, "start"], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, SOLAR_IMG: "upstage/vllm-solar-open2:1.0.0" }, encoding: "utf8" });
      assert.notEqual(r.status, 0);
      assert.match(r.stdout, /does not resolve to the pinned digest/);
      const calls = readFileSync(log, "utf8").trim().split("\n");
      assert.ok(calls.every((c) => c.startsWith("image inspect")), `unexpected docker calls: ${calls}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
