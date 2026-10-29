// BFCL registrations (benchmarks/bfcl/models.json) must describe the same
// served models and endpoints as the harness (src/agent/local-models.mjs), so
// the BFCL track and agent runs talk to the same servers (ADR 0009).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LOCAL_MODELS, LOCAL_MODEL_IDS } from "../src/agent/local-models.mjs";

const ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const { models } = JSON.parse(readFileSync(resolve(ROOT, "benchmarks/bfcl/models.json"), "utf8"));

describe("BFCL model registrations", () => {
  it("cover every local model exactly once", () => {
    assert.deepEqual(Object.values(models).map((m) => m.agent).sort(), [...LOCAL_MODEL_IDS].sort());
  });

  for (const [name, m] of Object.entries(models)) {
    it(`${name} matches local-models.mjs`, () => {
      const cfg = LOCAL_MODELS[m.agent];
      assert.match(name, /^kab-[a-z0-9-]+-FC$/);
      assert.equal(m.servedModelName, cfg.servedModelName);
      assert.equal(m.baseUrlEnv[0], cfg.baseUrlEnv);
      assert.deepEqual(m.chatTemplateKwargs, cfg.chatTemplateKwargs);
      assert.equal(m.maxOutputTokens, cfg.maxOutputTokens);
      const standard = cfg.provenance.port === 8101;
      assert.equal(m.defaultBaseUrl, standard ? "http://127.0.0.1:8101/v1" : "http://127.0.0.1:8102/v1");
    });
  }
});
