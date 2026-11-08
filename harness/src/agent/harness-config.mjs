// Agent-harness identity contract (Harness v2, docs/research/HARNESS_V2.md).
//
// Vocabulary: "the harness" in provenance.harness is KAB's EVALUATOR (this
// package). An AGENT HARNESS is the scaffold under test that drives the model:
// loop, tools, retrieval, context policy, termination (today: upstage-cli at
// its pin). This module describes the agent harness of one run so that runs
// can be grouped by scaffold independently of the model:
//
//   descriptor = { schema, implementation, policies, budget }
//   harnessId  = sha256(schema, implementation identity, policies)
//   budgetId   = sha256(budget)
//
// Model identity (checkpoint, revision, sampling, serving) stays in
// provenance.model and is rejected here, so the two cannot be mixed up.
import { createHash } from "node:crypto";

export const AGENT_HARNESS_SCHEMA = "kab.agent-harness/v1";
export const POLICY_DIMENSIONS = Object.freeze(["toolInterface", "retrieval", "context", "planning", "termination"]);
export const BUDGET_FIELDS = Object.freeze([
  "maxTurns", "maxToolCalls", "timeoutSec", "maxOutputTokens", "contextLimit", "outputReservation", "safetyMarginRatio"
]);
const KINDS = new Set(["in-process", "subprocess"]);
const POLICY_ID = /^[a-z0-9][a-z0-9._-]*$/;
const SHA = /^[0-9a-f]{40}$/;

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isJsonValue = (v) =>
  v === null || ["string", "boolean"].includes(typeof v) || (typeof v === "number" && Number.isFinite(v)) ||
  (Array.isArray(v) && v.every(isJsonValue)) || (isPlain(v) && Object.values(v).every(isJsonValue));

/** Returns a list of problems; empty means valid. */
export function validateAgentHarness(d) {
  if (!isPlain(d)) return ["descriptor must be an object"];
  const errors = [];
  const extra = Object.keys(d).filter((k) => !["schema", "implementation", "policies", "budget"].includes(k));
  if (extra.length) errors.push(`unknown top-level keys (model identity belongs in provenance.model): ${extra.join(", ")}`);
  if (d.schema !== AGENT_HARNESS_SCHEMA) errors.push(`schema must be "${AGENT_HARNESS_SCHEMA}"`);

  const impl = d.implementation;
  if (!isPlain(impl)) errors.push("implementation must be an object");
  else {
    if (typeof impl.name !== "string" || !POLICY_ID.test(impl.name)) errors.push("implementation.name must be a lowercase id");
    if (!KINDS.has(impl.kind)) errors.push(`implementation.kind must be one of ${[...KINDS].join(", ")}`);
    // A reportable harness is pinned to a source revision; null is allowed only
    // for mock/replay agents and is flagged by `pinned: false` in the record.
    if (impl.revision !== null && !(typeof impl.revision === "string" && SHA.test(impl.revision))) {
      errors.push("implementation.revision must be a 40-hex commit or null");
    }
    if (impl.version !== undefined && impl.version !== null && typeof impl.version !== "string") errors.push("implementation.version must be a string or null");
    if (impl.dirty !== undefined && impl.dirty !== null && typeof impl.dirty !== "boolean") errors.push("implementation.dirty must be a boolean or null");
  }

  if (!isPlain(d.policies)) errors.push("policies must be an object");
  else {
    const keys = Object.keys(d.policies);
    const missing = POLICY_DIMENSIONS.filter((k) => !keys.includes(k));
    const unknown = keys.filter((k) => !POLICY_DIMENSIONS.includes(k));
    if (missing.length) errors.push(`policies missing: ${missing.join(", ")}`);
    if (unknown.length) errors.push(`unknown policies: ${unknown.join(", ")}`);
    for (const k of POLICY_DIMENSIONS) {
      const p = d.policies[k];
      if (p === undefined) continue;
      if (!isPlain(p) || typeof p.id !== "string" || !POLICY_ID.test(p.id)) errors.push(`policies.${k}.id must be a lowercase id`);
      else if (!isJsonValue(p)) errors.push(`policies.${k} must be plain JSON`);
    }
  }

  if (!isPlain(d.budget)) errors.push("budget must be an object");
  else {
    const unknown = Object.keys(d.budget).filter((k) => !BUDGET_FIELDS.includes(k));
    if (unknown.length) errors.push(`unknown budget fields: ${unknown.join(", ")}`);
    for (const k of BUDGET_FIELDS) {
      const v = d.budget[k];
      // null = not enforced / not known for this harness; never a silent default
      if (!(v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0))) errors.push(`budget.${k} must be a non-negative number or null`);
    }
  }
  return errors;
}

// Canonical JSON: sorted keys, so semantically equal descriptors hash equally.
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isPlain(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
const sha256 = (v) => createHash("sha256").update(canonical(v)).digest("hex");

/**
 * Validated record form: the descriptor plus harnessId/budgetId. Throws on an
 * invalid descriptor. `dirty` and `version` are recorded but excluded from
 * harnessId (a dirty tree is a provenance flag, not a different design).
 */
export function finalizeAgentHarness(d) {
  const errors = validateAgentHarness(d);
  if (errors.length) throw new Error(`invalid agent harness descriptor: ${errors.join("; ")}`);
  const { name, kind, revision } = d.implementation;
  return {
    ...d,
    harnessId: sha256({ schema: d.schema, implementation: { name, kind, revision }, policies: d.policies }),
    budgetId: sha256(d.budget),
    pinned: revision !== null && d.implementation.dirty !== true
  };
}

/**
 * The upstage-cli agent harness as KAB drives it (UpstageAgent, LocalModelAgent).
 * upstage-cli has no switches for these dimensions at its pin: each policy id
 * names upstream behaviour *at implementation.revision*, and params are only
 * what KAB itself controls (tool allowlist, shell wrapper, prompt language).
 */
export function describeUpstageCliHarness({ cli, tools, sandboxed, language = null, budget }) {
  return {
    schema: AGENT_HARNESS_SCHEMA,
    implementation: {
      name: "upstage-cli",
      kind: "in-process",
      version: null,
      revision: cli?.commit ?? null,
      dirty: cli ? (cli.dirty === true || cli.matchesPin === false) : null
    },
    policies: {
      toolInterface: {
        id: "upstage-cli.registry",
        advertised: [...(tools?.advertised ?? [])].sort(),
        schemaHash: tools?.schemaHash ?? null,
        // docker: KAB's run_shell wrapper (whitespace argv split, metacharacters
        // refused, one fresh container per call); native: upstage-cli's own tool
        shell: sandboxed ? "kab.docker-argv" : "upstage-cli.native",
        language
      },
      retrieval: { id: "upstage-cli.context-builder" },
      context: { id: "upstage-cli.compaction" },
      planning: { id: "upstage-cli.replan" },
      termination: { id: "upstage-cli.loop" }
    },
    budget: Object.fromEntries(BUDGET_FIELDS.map((k) => [k, budget?.[k] ?? null]))
  };
}
