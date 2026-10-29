// Guards the korean-agent-bench ↔ upstage-cli dependency boundary (ADR 0002).
// The CLI is reached ONLY through the pinned submodule at vendor/upstage-cli,
// and only its src/ — never its own copy of the harness, and never the
// pre-migration "../src" layout that assumed the harness lived inside the CLI.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CLI_ROOT, CLI_SRC, importFromCli } from "../src/upstream.mjs";

const HARNESS_DIR = resolve(fileURLToPath(import.meta.url), "../..");
const REPO_ROOT = resolve(HARNESS_DIR, "..");

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".mjs")) out.push(p);
  }
  return out;
}

const SOURCES = [...walk(join(HARNESS_DIR, "src")), ...walk(join(HARNESS_DIR, "tests")), ...walk(join(HARNESS_DIR, "bin"))];
const SPECIFIER = /(?:from\s+|import\(\s*)["']([^"']+)["']/g;

describe("upstream boundary", () => {
  it("resolves upstage-cli to the vendor/upstage-cli submodule", () => {
    assert.equal(relative(REPO_ROOT, CLI_ROOT), join("vendor", "upstage-cli"));
    assert.equal(CLI_SRC, join(CLI_ROOT, "src"));
    assert.ok(existsSync(join(CLI_SRC, "agent/loop.mjs")), "submodule not initialized");
  });

  it("importFromCli loads a real CLI module", async () => {
    const { DEFAULT_LOOP_BUDGET } = await importFromCli("config/defaults.mjs");
    assert.ok(DEFAULT_LOOP_BUDGET);
  });

  it("every relative import stays inside the harness or vendor/upstage-cli/src", () => {
    const vendorSrc = join(REPO_ROOT, "vendor", "upstage-cli", "src");
    const offenders = [];
    for (const file of SOURCES) {
      for (const [, spec] of readFileSync(file, "utf8").matchAll(SPECIFIER)) {
        if (!spec.startsWith(".")) continue;
        const target = resolve(file, "..", spec);
        const inHarness = !relative(HARNESS_DIR, target).startsWith("..");
        const inCliSrc = !relative(vendorSrc, target).startsWith("..");
        if (!inHarness && !inCliSrc) offenders.push(`${relative(REPO_ROOT, file)} -> ${spec}`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  it("run provenance records the checked-out and pinned upstage-cli commits", async () => {
    const { TaskRunner } = await import("../src/task/runner.mjs");
    const { MockAgent } = await import("../src/agent/adapters/mock.mjs");
    const run = await new TaskRunner().run(
      {
        id: "h24-provenance",
        version: 1,
        repo: join(HARNESS_DIR, "fixtures", "flaky-test"),
        prompt: "noop",
        sandbox: { type: "native", timeout: 60 },
        agent: { maxTurns: 1 },
        checks: { fail_to_pass: [], pass_to_pass: [{ id: "true", command: "node -e 0", timeout: 30 }], custom: [] }
      },
      new MockAgent()
    );
    const cli = run.provenance.harness.upstageCli;
    assert.match(cli.commit, /^[0-9a-f]{40}$/);
    assert.match(cli.pinnedCommit, /^[0-9a-f]{40}$/);
    assert.equal(cli.matchesPin, cli.commit === cli.pinnedCommit);
    assert.equal(typeof cli.dirty, "boolean");
  });

  it("no source reaches the CLI except through upstream.mjs or a vendor/upstage-cli/src path", () => {
    const offenders = SOURCES.filter((f) => /\bCLI_ROOT\s*=/.test(readFileSync(f, "utf8")))
      .map((f) => relative(HARNESS_DIR, f))
      .filter((f) => f !== join("src", "upstream.mjs"));
    assert.deepEqual(offenders, []);
  });
});
