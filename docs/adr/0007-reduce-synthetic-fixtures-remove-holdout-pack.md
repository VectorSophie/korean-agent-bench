# ADR 0007 — Synthetic fixtures are kept minimal; the held-out pack loader is removed

## Status

**Accepted** (2026-10-29). Implemented in korean-agent-bench#1.

## Context

upstage-cli PR #12 (`f4c574f`) grew benchmark-v1 from 14 to 28 rows and
added `src/benchmark/pack.mjs`, a loader for a private held-out pack kept
outside the repository. korean-agent-bench#1 first imported all of it, minus
the held-out material (ADR 0004).

Two later facts change the value of that work:

1. ADR 0003 excludes every AI-authored task from the main comparison. More
   synthetic rows do not add research evidence; they add maintenance and the
   risk of being mistaken for a benchmark.
2. The held-out candidates the loader was built for were disclosed on a
   public branch and are retired (ADR 0004, upstage-cli#12 closing comment).

## Decision

- **Fixtures are infrastructure.** A synthetic task is kept only if it
  exercises a harness mechanism no other fixture does. From the 14 new rows,
  only `bv1-tr1-json-field` qualifies: it is the end-to-end Docker test of the
  `tool-result-selection` evaluator. The other 13 are dropped (11 duplicate
  the `trustedPaths` mechanism; `tr2`/`ms1` only vary the selector, which
  `tests/h22` covers).
- **Engineering improvements are kept**: the evaluator and its adversarial
  tests, digest pinning of every task image, tranche/family accounting and
  `benchmark.mjs report`.
- **The held-out pack loader is removed**, with its tests and CLI. It had no
  remaining use, and it was a trust boundary (loading task YAML with
  `_import` resolution, fixtures and reference solutions from an external
  path). Removing it is safer than hardening it for no purpose.
- **No sample-size target is attached to synthetic fixtures.** PR #12's
  "~70–80 independent families" target is dropped.

## Consequences

- benchmark-v1 is 15 rows / 12 families, all `synthetic-dev`. Details and
  per-component disposition: `harness/docs/BENCHMARK_V1_DATASET.md`.
- If a private held-out set is wanted later (for example, human-authored
  Korean tasks), a loader must be designed for that purpose, with negative
  tests for `_import` escape, symlinks, and unhashed files, before any
  content exists. The removed code is at `f4c574f` for reference.
- The harness's own task loader still resolves `_import` relative to the
  task file. That is safe only because every task file is repository-owned
  and reviewed; it is not a boundary for untrusted input.
