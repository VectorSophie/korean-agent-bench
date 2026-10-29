# ADR 0003 — Synthetic task sets are development fixtures; the main comparison uses established external benchmarks

## Status

**Accepted** (2026-10-29). The *choice* of external benchmarks and subsets is
**open** and will need its own ADR before any main-comparison run.

## Context

Every task in the harness today was written with an AI coding assistant:
the benchmark-v1 rows (PR #11, and 14 more in unmerged PR #12), the pilot
tasks, and the example tasks. They were audited carefully
(`harness/docs/BENCHMARK_V1_SEMANTIC_AUDIT.md`, `BENCHMARK_V1_TASK_QA.md`) and
they are good at what they were built for: exercising the harness, the
evaluators, and model integration.

They are not suitable for comparing models:

- **Author bias.** Tasks written by one model family, in that family's idiom,
  may systematically favor or penalize particular models.
- **No independent review.** The audit was performed in the same workflow
  that wrote the tasks; PR #12's own description says "No independent human
  review claimed; protocol NOT frozen".
- **Small, correlated samples.** `BENCHMARK_V1_STATISTICS.md` counts
  independence on families, not rows — a handful of families cannot support
  model rankings.
- **No external comparability.** Nobody else can place a number from these
  tasks next to a published result.

## Decision

1. All AI-authored task sets are `kind: synthetic-dev`,
   `mainComparison: "excluded"` in [`datasets/registry.json`](../../datasets/registry.json).
   They remain first-class for harness development, evaluator QA,
   calibration and infrastructure pilots.
2. Main-comparison candidates are **established external benchmarks** —
   initially BFCL (function calling) and SWE-bench Verified (repository
   repair) — recorded by pinned upstream revision (full commit / dataset SHA),
   license, and upstream evaluator.
3. **Provenance and semantics are preserved.** Upstream task identity
   (BFCL category + id, SWE-bench `instance_id`) is kept verbatim. Scores
   come from the **upstream evaluator**, never a re-implementation.
   `harness import swebench` remains a development tool: its pytest
   approximations are marked `officialEvalCompatible: false` and must not
   produce main-comparison numbers.
4. **Korean.** Both candidates are English. A Korean variant (translated
   prompts or issues) is a *derived condition*: it keeps the upstream ids and
   evaluator, is reported separately from the original, and records who or
   what produced the translation. A machine-translated variant is
   AI-generated content and falls under point 1 unless independently
   reviewed.
5. Nothing becomes `mainComparison: "admitted"` without an ADR that fixes the
   subset, budgets and protocol (`admittedBy` must name it).

`harness/tests/h25-dataset-registry.test.mjs` enforces 1, 2, 3 (pinning and
non-reimplementation fields) and 5, and fails if any file under
`harness/tasks/` or `harness/fixtures/` belongs to no registry entry.

## Consequences

- The benchmark-v1 protocol docs remain valid as the *development-fixture*
  protocol; their "candidate" wording refers to fixture readiness, not to
  main-comparison eligibility.
- PR #12's 14 new rows are imported (on a branch, ADR 0004) as
  synthetic-dev, not as an evaluation set.
- Integration work is now required before any main-comparison run: driving
  the four local models through the BFCL and SWE-bench upstream harnesses
  (or exporting harness patches to SWE-bench's predictions format) without
  changing their evaluation semantics. Tracked in `docs/STATUS.md`.
- Hardware limits (Solar Open 2 validated only to 8K context here) may make
  some external tasks infeasible for some models. That is reported as
  infeasibility, never silently filtered.
