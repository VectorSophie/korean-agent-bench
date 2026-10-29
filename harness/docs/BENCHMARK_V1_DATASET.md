# Benchmark v1 — `v1-dataset` tranche: disposition

Status as of **2026-10-29** (korean-agent-bench#1). This document replaces
the version written for upstage-cli PR #12 (`f4c574f`), which described
14 new task rows and a private held-out pack workflow. That PR was closed
unmerged; its text remains readable at
`https://github.com/VectorSophie/upstage-cli/pull/12` and its commit at
`refs/pull/12/head`. Decision record: `docs/adr/0007-reduce-synthetic-fixtures-remove-holdout-pack.md`.

## Why the tranche was reduced

All benchmark-v1 tasks are AI-authored. Under ADR 0003 they cannot produce
the main model comparison, whatever their quality, so adding rows does not
add research evidence. What remains useful is **infrastructure**: evaluators
and fixtures that prove the harness scores correctly. A fixture earns its
place only if it exercises a mechanism nothing else does.

## Retained

| Component | Why | Evidence |
|---|---|---|
| `tool-result-selection` trusted evaluator (`src/evaluation/evaluators.mjs`) | Proves the agent ran the exact trusted command **and interpreted** its structured output: the evaluator recomputes the correct value from the run's own stdout with a declarative selector (`find-field`, `max-by`, `indirect`; no eval, no agent-supplied code). | `tests/h22` (adversarial: wrong field, whole-stdout copy, hardcoded value, stderr-only, no execution) |
| `bv1-tr1-json-field` task + `fixtures/benchmark-v1/tr1-json` + mount `bench-tr1-json` | The only row that runs `tool-result-selection` end to end in Docker. | `benchmark:qa`: baseline fails, solution passes, no-op fails |
| `_base-benchmark-v1-dataset.yaml` | Envelope used by tr1, image pinned by digest. | `benchmark:validate` |
| Digest pinning of `_base-benchmark-v1.yaml` | Reproducibility: `node:22-alpine@sha256:fe4f6d74…` for every row; 0 unpinned warnings (was 14). | `tests/h20` asserts every image is pinned |
| Manifest `tranche`, `byTranche`, `byDifficulty`; language pairs counted only when both members exist | Honest independence accounting. | `tests/h20`; `node bin/benchmark.mjs report` |
| `benchmark.mjs report` | Prints rows vs **independent families** (15 rows → 12 families). | — |
| QA support for selection tasks (`src/benchmark/qa.mjs`) | Lets fixture QA drive tr1. | `benchmark:qa` 15/15 |

## Dropped

| Component | Reason |
|---|---|
| 13 task rows: `cr1`, `dx1` (+`-ko`), `dx2`, `dx3`, `fr1` (+`-ko`), `fr2`, `ms1`, `ms2`, `sr1`, `tr2`, `ts1` — with their fixtures, reference solutions and the `bench-tr2-json` / `bench-ms1-indirect` mounts | Eleven use `trustedPaths` restore, the mechanism the 14 `v1-initial` rows already cover. `tr2` and `ms1` use `tool-result-selection` with the `max-by` and `indirect` selectors, which `tests/h22` already unit-tests; tr1 covers the end-to-end path. |
| `src/benchmark/pack.mjs`, `tests/h23`, `benchmark.mjs pack {verify,summary,qa}`, `qaPack` | Its only purpose was a private held-out pool of AI-authored tasks. Those cannot enter the main comparison (ADR 0003), and the candidates built for it were disclosed on a public branch and are retired (ADR 0004). The main comparison uses public external benchmarks. A security-sensitive loader without a use is removed rather than hardened. |
| `harness/benchmarks/v1/holdout-pack.public.json`, held-out construct descriptions | Never imported (ADR 0004). |
| "~70–80 independent families" target added to PROTOCOL/STATISTICS | No defensible basis; sample size for the main comparison follows the external benchmarks' structure and a precision analysis (ADR 0003). |

## Current set

15 rows (14 `v1-initial` + `bv1-tr1-json-field`), 12 independent families,
2 language pairs, categories A3 B2 C3 D3 E2 F2, all `split: dev`,
`independentHumanReviewed` 0/15, all synthetic-dev in
`datasets/registry.json`.

To recover a dropped task: `git show f4c574fef12512686577a029c6b657ea45a63275:<path>`
in an upstage-cli clone (fetch `refs/pull/12/head`), or the pre-reduction
commit `33c84e4` of this repository's PR #1 branch.
