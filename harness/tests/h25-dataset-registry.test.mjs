// Enforces datasets/registry.json (ADR 0003): synthetic task sets can never be
// marked for the main comparison, external benchmarks must be pinned and scored
// by their upstream evaluator, and no task or fixture in the harness exists
// without a classification.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const registry = JSON.parse(readFileSync(join(REPO_ROOT, "datasets/registry.json"), "utf8"));
const MAIN_COMPARISON = ["excluded", "candidate", "admitted"];

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe("dataset registry", () => {
  it("has unique ids and a known mainComparison value", () => {
    const ids = registry.datasets.map((d) => d.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const d of registry.datasets) assert.ok(MAIN_COMPARISON.includes(d.mainComparison), d.id);
  });

  it("never admits a synthetic set to the main comparison", () => {
    for (const d of registry.datasets.filter((x) => x.kind === "synthetic-dev")) {
      assert.equal(d.mainComparison, "excluded", `${d.id} is synthetic`);
    }
    for (const d of registry.datasets.filter((x) => x.origin === "ai-authored")) {
      assert.equal(d.kind, "synthetic-dev", `${d.id} is AI-authored`);
    }
  });

  it("pins every external benchmark and scores it with the upstream evaluator", () => {
    for (const d of registry.datasets.filter((x) => x.kind === "external")) {
      assert.match(d.source.repository, /^https:\/\//, d.id);
      assert.match(d.source.revision, /^[0-9a-f]{40}$/, `${d.id}: revision must be a full commit sha`);
      assert.ok(d.source.license, `${d.id}: license`);
      assert.ok(d.evaluation.upstreamEvaluator, `${d.id}: upstreamEvaluator`);
      assert.equal(d.evaluation.reimplemented, false, `${d.id}: evaluator must not be reimplemented`);
    }
  });

  it("admits nothing without an ADR", () => {
    for (const d of registry.datasets.filter((x) => x.mainComparison === "admitted")) {
      assert.ok(d.admittedBy && existsSync(join(REPO_ROOT, d.admittedBy)), `${d.id}: admittedBy must name an ADR file`);
    }
  });

  it("lists only locations that exist", () => {
    for (const d of registry.datasets) {
      for (const loc of d.locations || []) assert.ok(existsSync(join(REPO_ROOT, loc)), `${d.id}: ${loc}`);
    }
  });

  it("classifies every task and fixture in the harness", () => {
    const covered = registry.datasets.flatMap((d) => d.locations || []);
    const isCovered = (rel) => covered.some((loc) => rel === loc || rel.startsWith(loc + "/"));
    const files = [...walk(join(REPO_ROOT, "harness/tasks")), ...walk(join(REPO_ROOT, "harness/fixtures"))]
      .map((p) => relative(REPO_ROOT, p).split(sep).join("/"));
    assert.deepEqual(files.filter((f) => !isCovered(f)), []);
  });
});
