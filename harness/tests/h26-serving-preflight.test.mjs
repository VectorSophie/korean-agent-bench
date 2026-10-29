// Serving preflight (src/preflight/serving.mjs): declared vs observed serving
// configuration. Every observer is faked — no model server, no GPU, no Docker
// daemon. Two tests use a real local HTTP server / a closed port to exercise
// the actual fetch path.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runServingPreflight, parseServeArgs, formatPreflight, STATUS } from "../src/preflight/serving.mjs";
import { getLocalModelConfig } from "../src/agent/local-models.mjs";
import { TaskRunner } from "../src/task/runner.mjs";
import { MockAgent } from "../src/agent/adapters/mock.mjs";

const HARNESS_DIR = join(fileURLToPath(import.meta.url), "../..");
const SOLAR = getLocalModelConfig("solar-open2");
const KANANA = getLocalModelConfig("kanana");
const SNAP = (cfg) => `/hf/models--x--y/snapshots/${cfg.provenance.revision}`;
const IMAGE_ID = "sha256:" + "1".repeat(64);
const CLEAN_GIT = { commit: "a".repeat(40), dirty: false, upstageCli: { commit: "b".repeat(40), pinnedCommit: "b".repeat(40), matchesPin: true, dirty: false } };

function solarArgs(over = {}) {
  const a = {
    "--served-model-name": "solar-open2-250b", "--tensor-parallel-size": "2", "--max-model-len": "8192",
    "--max-num-seqs": "256", "--gpu-memory-utilization": "0.92", "--reasoning-parser": "solar_open2",
    "--tool-call-parser": "solar_open2",
    "--logits-processors": "vllm.v1.sample.logits_processor.solar_open2:SolarOpen2TemplateLogitsProcessor", "--port": "8102",
    ...over
  };
  const out = [SNAP(SOLAR), "--trust-remote-code", "--enable-auto-tool-choice"];
  for (const [k, v] of Object.entries(a)) if (v !== null) out.push(k, v);
  return out;
}

// A complete, consistent world for solar-open2; each test breaks one thing.
function world({ models, container, image, git, args } = {}) {
  return {
    models: models ?? (async () => ({ data: [{ id: "solar-open2-250b", root: SNAP(SOLAR), max_model_len: 8192 }] })),
    container: container ?? (async () => ({
      Name: "/kserve-solar", State: { Running: true }, Image: IMAGE_ID,
      Config: { Image: "upstage/vllm-solar-open2:1.0.0", Env: ["NVIDIA_VISIBLE_DEVICES=0,1"] },
      Args: args ?? solarArgs()
    })),
    image: image ?? (async () => ({ RepoDigests: [SOLAR.provenance.servingImage] })),
    git: git ?? (async () => CLEAN_GIT)
  };
}
const run = (observers, key = "solar-open2") => runServingPreflight(key, { observers });
const statusOf = (r, name) => r.fields.find((f) => f.field === name)?.status;

describe("serving preflight — exact match", () => {
  it("is reportable and verifies every observable critical field", async () => {
    const r = await run(world());
    assert.equal(r.reportable, true, formatPreflight(r));
    assert.deepEqual(r.blocking, []);
    for (const f of ["endpoint", "servedModelId", "maxModelLen", "container", "servingImage", "checkpointRevision",
      "tensorParallel", "maxModelLenArg", "reasoningParser", "toolCallParser", "maxNumSeqs", "logitsProcessor",
      "gpuDevices", "harnessClean", "upstageCliPin", "upstageCliClean"]) {
      assert.equal(statusOf(r, f), STATUS.VERIFIED, f);
    }
    assert.match(r.fields.find((f) => f.field === "servingImage").note, /launched by tag/);
  });

  it("parses --model (standard launcher) as well as a positional model path (Solar launcher)", async () => {
    const args = ["--model", SNAP(KANANA), "--served-model-name", "Kanana-2", "--tensor-parallel-size", "1", "--max-model-len", "16384",
      "--gpu-memory-utilization", "0.9", "--enable-auto-tool-choice", "--tool-call-parser", "hermes", "--port", "8101", "--reasoning-parser", "deepseek_r1"];
    assert.equal(parseServeArgs(args).model, SNAP(KANANA));
    const r = await run(world({
      models: async () => ({ data: [{ id: "Kanana-2", root: SNAP(KANANA), max_model_len: 16384 }] }),
      container: async () => ({ Name: "/kserve-kanana", State: { Running: true }, Image: IMAGE_ID, Config: { Image: KANANA.provenance.servingImage, Env: ["NVIDIA_VISIBLE_DEVICES=1"] }, Args: args }),
      image: async () => ({ RepoDigests: [KANANA.provenance.servingImage] })
    }), "kanana");
    assert.equal(r.reportable, true, formatPreflight(r));
  });
});

describe("serving preflight — mismatches block", () => {
  it("context mismatch: server launched at 4096 while 8192 is declared (the pilot incident)", async () => {
    const r = await run(world({
      models: async () => ({ data: [{ id: "solar-open2-250b", root: SNAP(SOLAR), max_model_len: 4096 }] }),
      args: solarArgs({ "--max-model-len": "4096" })
    }));
    assert.equal(r.reportable, false);
    assert.equal(statusOf(r, "maxModelLen"), STATUS.MISMATCH);
    assert.equal(statusOf(r, "maxModelLenArg"), STATUS.MISMATCH);
  });

  it("image mismatch: container image lacks the declared digest", async () => {
    const r = await run(world({ image: async () => ({ RepoDigests: ["upstage/vllm-solar-open2@sha256:" + "f".repeat(64)] }) }));
    assert.equal(statusOf(r, "servingImage"), STATUS.MISMATCH);
    assert.ok(r.blocking.includes("servingImage"));
  });

  it("wrong served model id", async () => {
    const r = await run(world({ models: async () => ({ data: [{ id: "some-other-model", root: SNAP(SOLAR), max_model_len: 8192 }] }) }));
    assert.equal(statusOf(r, "servedModelId"), STATUS.MISMATCH);
    assert.equal(r.reportable, false);
  });

  it("wrong checkpoint snapshot", async () => {
    const other = "/hf/models--x--y/snapshots/" + "c".repeat(40);
    const r = await run(world({ models: async () => ({ data: [{ id: "solar-open2-250b", root: other, max_model_len: 8192 }] }) }));
    assert.equal(statusOf(r, "checkpointRevision"), STATUS.MISMATCH);
  });

  it("missing tool parser / auto tool choice", async () => {
    const r1 = await run(world({ args: solarArgs({ "--tool-call-parser": null }) }));
    assert.equal(statusOf(r1, "toolCallParser"), STATUS.MISMATCH);
    const r2 = await run(world({ args: solarArgs().filter((a) => a !== "--enable-auto-tool-choice") }));
    assert.equal(statusOf(r2, "toolCallParser"), STATUS.MISMATCH);
    assert.match(r2.fields.find((f) => f.field === "toolCallParser").note, /auto-tool-choice/);
  });

  it("incompatible serving configuration: Solar without --max-num-seqs 256, wrong TP", async () => {
    const r = await run(world({ args: solarArgs({ "--max-num-seqs": "1024", "--tensor-parallel-size": "1" }) }));
    assert.equal(statusOf(r, "maxNumSeqs"), STATUS.MISMATCH);
    assert.equal(statusOf(r, "tensorParallel"), STATUS.MISMATCH);
  });

  it("submodule off its pin", async () => {
    const r = await run(world({ git: async () => ({ ...CLEAN_GIT, upstageCli: { ...CLEAN_GIT.upstageCli, commit: "d".repeat(40), matchesPin: false } }) }));
    assert.equal(statusOf(r, "upstageCliPin"), STATUS.MISMATCH);
    assert.equal(r.reportable, false);
  });

  it("dirty harness or submodule worktree", async () => {
    const r1 = await run(world({ git: async () => ({ ...CLEAN_GIT, dirty: true }) }));
    assert.equal(statusOf(r1, "harnessClean"), STATUS.MISMATCH);
    const r2 = await run(world({ git: async () => ({ ...CLEAN_GIT, upstageCli: { ...CLEAN_GIT.upstageCli, dirty: true } }) }));
    assert.equal(statusOf(r2, "upstageCliClean"), STATUS.MISMATCH);
    assert.equal(r1.reportable || r2.reportable, false);
  });
});

describe("serving preflight — missing observations fail closed", () => {
  it("missing server: endpoint and everything from the API become unavailable", async () => {
    const r = await run(world({ models: async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:8102"); } }));
    assert.equal(statusOf(r, "endpoint"), STATUS.UNAVAILABLE);
    assert.equal(statusOf(r, "maxModelLen"), STATUS.UNAVAILABLE);
    assert.equal(r.reportable, false);
    assert.ok(r.blocking.includes("endpoint"));
  });

  it("missing metadata: /models without max_model_len or root", async () => {
    const r = await run(world({ models: async () => ({ data: [{ id: "solar-open2-250b" }] }) }));
    assert.equal(statusOf(r, "maxModelLen"), STATUS.UNAVAILABLE);
    // revision still verified from the container's model argument
    assert.equal(statusOf(r, "checkpointRevision"), STATUS.VERIFIED);
    assert.equal(r.reportable, false);
  });

  it("container not found / docker not accessible", async () => {
    for (const container of [async () => null, async () => { throw new Error("permission denied on docker.sock"); }]) {
      const r = await run(world({ container }));
      assert.equal(statusOf(r, "container"), STATUS.UNAVAILABLE);
      assert.equal(statusOf(r, "servingImage"), STATUS.UNAVAILABLE);
      assert.equal(statusOf(r, "tensorParallel"), STATUS.UNAVAILABLE);
      assert.equal(r.reportable, false);
    }
  });

  it("stopped container is a mismatch, not a match", async () => {
    const r = await run(world({ container: async () => ({ Name: "/kserve-solar", State: { Running: false }, Image: IMAGE_ID, Config: { Env: [] }, Args: solarArgs() }) }));
    assert.equal(statusOf(r, "container"), STATUS.MISMATCH);
  });
});

describe("serving preflight — unsupported verification fields", () => {
  it("quantization, sampling and runtime are declared_only and never block", async () => {
    const r = await run(world());
    for (const f of ["quantization", "sampling", "servingRuntime"]) {
      const x = r.fields.find((y) => y.field === f);
      assert.equal(x.status, STATUS.DECLARED_ONLY, f);
      assert.equal(x.critical, false, f);
    }
    assert.equal(r.reportable, true);
  });

  it("an explicit --quantization flag contradicting the checkpoint is a mismatch", async () => {
    const r = await run(world({ args: [...solarArgs(), "--quantization", "fp8"] }));
    assert.equal(statusOf(r, "quantization"), STATUS.MISMATCH);
  });

  it("never claims the API verifies the revision beyond the snapshot path", async () => {
    const r = await run(world());
    assert.match(r.fields.find((f) => f.field === "checkpointRevision").note, /not hashed/);
  });
});

describe("serving preflight — real HTTP path (fake endpoint)", () => {
  it("reads served id and max_model_len from a local fake /v1/models", async () => {
    const srv = createServer((req, res) => {
      if (req.url === "/v1/models") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [{ id: "solar-open2-250b", root: SNAP(SOLAR), max_model_len: 4096 }] })); }
      else { res.statusCode = 404; res.end(); }
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    try {
      const { models: _m, ...rest } = world();
      const r = await runServingPreflight("solar-open2", { baseUrl: `http://127.0.0.1:${srv.address().port}/v1`, observers: rest });
      assert.equal(statusOf(r, "servedModelId"), STATUS.VERIFIED);
      assert.equal(statusOf(r, "maxModelLen"), STATUS.MISMATCH);
    } finally {
      srv.close();
    }
  });

  it("a closed port is reported unavailable, not as a match", async () => {
    const srv = createServer();
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;
    await new Promise((r) => srv.close(r));
    const { models: _m, ...rest } = world();
    const r = await runServingPreflight("solar-open2", { baseUrl: `http://127.0.0.1:${port}/v1`, observers: rest });
    assert.equal(statusOf(r, "endpoint"), STATUS.UNAVAILABLE);
    assert.equal(r.reportable, false);
  });
});

describe("serving preflight — run record", () => {
  it("TaskRunner stores the preflight result in provenance", async () => {
    const pf = await run(world());
    const result = await new TaskRunner().run({
      id: "h26-pf", version: 1, repo: join(HARNESS_DIR, "fixtures", "flaky-test"), prompt: "noop",
      sandbox: { type: "native", timeout: 60 }, agent: { maxTurns: 1 },
      checks: { fail_to_pass: [], pass_to_pass: [{ id: "t", command: "node -e 0", timeout: 30 }], custom: [] }
    }, new MockAgent(), { preflight: pf });
    assert.equal(result.provenance.preflight.kind, "serving-preflight");
    assert.equal(result.provenance.preflight.reportable, true);
  });
});
