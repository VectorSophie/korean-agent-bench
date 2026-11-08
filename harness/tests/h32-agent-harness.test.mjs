// Harness v2 foundation (docs/research/HARNESS_V2.md):
//  1. the agent-harness identity contract (harness-config.mjs);
//  2. the runner records it for any adapter, including a non-upstage-cli one;
//  3. characterization of two v1 behaviours that v2 treats as experimental
//     factors (retrieval query, Docker shell interface). These pin the CURRENT
//     behaviour of the pinned upstage-cli + KAB wrapper; if a pin move changes
//     them, the test fails so the change is noticed and documented, not silent.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_HARNESS_SCHEMA, POLICY_DIMENSIONS, validateAgentHarness, finalizeAgentHarness, describeUpstageCliHarness
} from "../src/agent/harness-config.mjs";
import { CodingAgent } from "../src/agent/interface.mjs";
import { TaskRunner } from "../src/task/runner.mjs";
import { MockAgent } from "../src/agent/adapters/mock.mjs";
import { buildAgentRegistry } from "../src/agent/adapters/upstage.mjs";
import { buildPrompt, ENVELOPE } from "../src/benchmarks/swebench.mjs";
import { importFromCli } from "../src/upstream.mjs";

const HARNESS_DIR = resolve(fileURLToPath(import.meta.url), "../..");
const SHA = "a".repeat(40);

function descriptor(over = {}) {
  return {
    schema: AGENT_HARNESS_SCHEMA,
    implementation: { name: "mini-swe-agent", kind: "subprocess", version: "2.0.0", revision: SHA, dirty: false },
    policies: Object.fromEntries(POLICY_DIMENSIONS.map((k) => [k, { id: `test.${k.toLowerCase()}` }])),
    budget: { maxTurns: 30, maxToolCalls: null, timeoutSec: 2700, maxOutputTokens: 8192, contextLimit: 16384, outputReservation: 8192, safetyMarginRatio: 0.05 },
    ...over
  };
}

describe("agent-harness descriptor contract", () => {
  it("accepts a complete descriptor", () => {
    assert.deepEqual(validateAgentHarness(descriptor()), []);
  });

  it("rejects model identity, missing policies, unpinned-looking revisions and unknown budget fields", () => {
    assert.match(validateAgentHarness(descriptor({ model: { id: "x" } })).join(), /provenance\.model/);
    const d = descriptor();
    delete d.policies.retrieval;
    assert.match(validateAgentHarness(d).join(), /policies missing: retrieval/);
    assert.match(validateAgentHarness(descriptor({ implementation: { name: "x", kind: "subprocess", revision: "main" } })).join(), /40-hex/);
    assert.match(validateAgentHarness(descriptor({ budget: { ...descriptor().budget, maxTokens: 1 } })).join(), /unknown budget fields: maxTokens/);
    assert.match(validateAgentHarness(descriptor({ budget: { ...descriptor().budget, maxTurns: "30" } })).join(), /budget\.maxTurns/);
    assert.match(validateAgentHarness(descriptor({ implementation: { name: "x", kind: "docker", revision: null } })).join(), /kind/);
  });

  it("harnessId depends on implementation and policies, not on key order, budget or dirtiness", () => {
    const a = finalizeAgentHarness(descriptor());
    const reordered = descriptor();
    reordered.policies = Object.fromEntries(Object.entries(reordered.policies).reverse());
    assert.equal(finalizeAgentHarness(reordered).harnessId, a.harnessId);

    const bigger = finalizeAgentHarness(descriptor({ budget: { ...descriptor().budget, contextLimit: 32768 } }));
    assert.equal(bigger.harnessId, a.harnessId, "a budget change is not a different harness");
    assert.notEqual(bigger.budgetId, a.budgetId, "…but it is a different budget");

    const p = descriptor();
    p.policies.retrieval = { id: "test.retrieval", query: "issue-only" };
    assert.notEqual(finalizeAgentHarness(p).harnessId, a.harnessId);

    const dirty = finalizeAgentHarness(descriptor({ implementation: { ...descriptor().implementation, dirty: true } }));
    assert.equal(dirty.harnessId, a.harnessId);
    assert.equal(dirty.pinned, false);
    assert.equal(a.pinned, true);
  });

  it("the upstage-cli description is valid and records what KAB controls", () => {
    const d = describeUpstageCliHarness({
      cli: { commit: SHA, matchesPin: true, dirty: false },
      tools: { advertised: ["run_shell", "read_file"], schemaHash: "h" },
      sandboxed: true,
      language: "en",
      budget: { maxTurns: 30, maxToolCalls: 60, timeoutSec: 2700 }
    });
    assert.deepEqual(validateAgentHarness(d), []);
    assert.deepEqual(d.policies.toolInterface.advertised, ["read_file", "run_shell"]);
    assert.equal(d.policies.toolInterface.shell, "kab.docker-argv");
    assert.equal(d.budget.contextLimit, null, "unknown is null, never a default");
    assert.match(d.implementation.adapterSha256, /^[0-9a-f]{64}$/, "KAB-side wrapper code is part of the identity");
    const otherWrapper = { ...d, implementation: { ...d.implementation, adapterSha256: "b".repeat(64) } };
    assert.notEqual(finalizeAgentHarness(otherWrapper).harnessId, finalizeAgentHarness(d).harnessId);
    const off = describeUpstageCliHarness({ cli: { commit: SHA, matchesPin: false, dirty: false }, tools: {}, sandboxed: false, budget: {} });
    assert.equal(finalizeAgentHarness(off).pinned, false, "a checkout off the pin is not pinned");
  });
});

// A CPU-only stand-in for an external (subprocess) harness: it only proves the
// runner path is agent-agnostic. It is NOT an integration of any real system.
class FakeExternalHarness extends CodingAgent {
  constructor(harness) { super(); this._h = harness; }
  get id() { return "fake-external"; }
  get supportsSandbox() { return true; }
  async run(_task, context) {
    await context.executor.exec("node", ["-e", "require('fs').writeFileSync('touched.txt','x')"], { timeoutMs: 10000 });
    return { ok: true, turns: 1, toolCalls: 1, usage: null, events: [], stopReason: "done", harness: this._h };
  }
}

function nativeTask() {
  return {
    id: "h32", version: 1, repo: join(HARNESS_DIR, "fixtures", "flaky-test"), prompt: "noop",
    sandbox: { type: "native", timeout: 60 }, agent: { maxTurns: 1 },
    checks: { fail_to_pass: [], pass_to_pass: [{ id: "true", command: "node -e 0", timeout: 30 }], custom: [] }
  };
}

describe("runner records the agent harness for any adapter", () => {
  it("an external-kind harness is recorded with its ids; its edit is the patch", async () => {
    const run = await new TaskRunner().run(nativeTask(), new FakeExternalHarness(descriptor()));
    assert.equal(run.provenance.agentHarness.implementation.kind, "subprocess");
    assert.equal(run.provenance.agentHarness.harnessId, finalizeAgentHarness(descriptor()).harnessId);
    assert.deepEqual(run.patch.filesChanged, ["touched.txt"]);
    assert.equal(run.provenance.model, null, "model identity is not invented from the harness");
  });

  it("an adapter that declares nothing records null (v1 mock behaviour unchanged)", async () => {
    const run = await new TaskRunner().run(nativeTask(), new MockAgent());
    assert.equal(run.provenance.agentHarness, null);
  });

  it("an invalid descriptor makes the run an error, never an unlabeled result", async () => {
    const run = await new TaskRunner().run(nativeTask(), new FakeExternalHarness({ schema: "nope" }));
    assert.equal(run.status, "error");
    assert.match(run.trace.agentError, /invalid agent harness descriptor/);
  });
});

describe("characterization: v1 automatic retrieval query (pinned upstage-cli)", () => {
  it("all eight retrieval keywords of a SWE-bench prompt come from the KAB wrapper, none from the issue", async () => {
    const { buildContext } = await importFromCli("agent/context-builder.mjs");
    const dir = mkdtempSync(join(tmpdir(), "h32-kw-"));
    mkdirSync(join(dir, "pkg"));
    for (let i = 0; i < 8; i++) writeFileSync(join(dir, "pkg", `mod${i}.py`), `# the repository commit you are working on\ndef helper_${i}():\n    return ${i}\n`);
    writeFileSync(join(dir, "pkg", "serializers.py"), "def deconstruct_lazy_reference(value):\n    raise TypeError('cannot serialize')\n");
    // Synthetic issue text (no SWE-bench content is used).
    const issue = "deconstruct_lazy_reference raises TypeError when serializing a lazy reference in migrations.";
    // The v1 SWE-bench tool allowlist: repo_map/find_symbol/find_references/
    // list_modules are removed by the task policy, so buildContext's calls to
    // them fail and only search_code/glob select files.
    const { registry } = await buildAgentRegistry({ agent: { tools: { allow: [...ENVELOPE.tools], deny: [] } } }, { workdir: dir, executor: null });
    const ctx = async (input) => buildContext({ input, registry, cwd: dir, runtimeCache: {} });

    const wrapped = await ctx(buildPrompt({ repo: "acme/widgets", base_commit: "0".repeat(40), problem_statement: issue }));
    assert.deepEqual(wrapped.keywords, ["you", "are", "working", "checkout", "the", "acme/widgets", "repository", "commit"]);
    assert.equal(wrapped.repoSummary.totalFiles, 0, "no repo map under the v1 allowlist");
    assert.ok(wrapped.snippets.length > 0 && !wrapped.snippets.some((s) => s.path === "pkg/serializers.py"), "distractors in, the issue's file out");

    const issueOnly = await ctx(issue);
    assert.ok(issueOnly.keywords.includes("deconstruct_lazy_reference"));
    assert.ok(issueOnly.snippets.some((s) => s.path === "pkg/serializers.py"));
  });
});

describe("characterization: v1 Docker run_shell interface (KAB wrapper)", () => {
  it("splits on whitespace without quote handling and refuses pipes/&&", async () => {
    const dir = mkdtempSync(join(tmpdir(), "h32-sh-"));
    const seen = [];
    const executor = { type: "docker", timeoutMs: 1000, async exec(b, a) { seen.push([b, ...a]); return { ok: true, exitCode: 0, stdout: "", stderr: "" }; } };
    const { registry } = await buildAgentRegistry({ agent: { permissions: "bypassPermissions", tools: { allow: ["run_shell"] } } }, { workdir: dir, executor });
    const sh = async (command) => {
      seen.length = 0;
      const r = await registry.execute("run_shell", { command }, { cwd: dir }).catch((e) => ({ ok: false, error: e }));
      return r.ok ? seen[0] : null;
    };
    // quotes reach the program literally: a silently different search
    assert.deepEqual(await sh(`grep -rn "def foo" src`), ["grep", "-rn", "\"def", "foo\"", "src"]);
    // redirection is an ordinary argument, not a redirect
    assert.deepEqual(await sh("python setup.py test > out.txt"), ["python", "setup.py", "test", ">", "out.txt"]);
    assert.equal(await sh("grep -rn foo . | head"), null);
    assert.equal(await sh("cd src && pytest"), null);
    assert.equal(await sh(`python -c "import x; print(x)"`), null);
  });
});
