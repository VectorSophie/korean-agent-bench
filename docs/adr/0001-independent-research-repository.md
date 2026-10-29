# ADR 0001 — Benchmark research lives in its own repository

## Status

**Accepted** (2026-10-29). Owner review pending.

## Context

The evaluation harness grew inside `VectorSophie/upstage-cli` (a published
npm package, `@jackochesstern/upstage-cli`) from 2026-04-27 onward: 38
commits under `harness/` plus `HARNESS.md`. By October 2026 it had become a
research project in its own right — four locally served Korean models, a
benchmark-v1 protocol, trusted evaluators, Docker isolation, a live pilot,
and an unmerged dataset PR (#12).

Keeping it there mixed two release cadences and two kinds of claim. A CLI
release says "this works"; a benchmark says "this is what we measured, under
these conditions". The research needs dated evidence, pinned model and data
revisions, and a record of what is *not* yet known — none of which belongs in
a product changelog. It also made the CLI's CI pay for Docker-tier research
tests on every push.

## Decision

`VectorSophie/korean-agent-bench` is the home of the harness, the model
records, the dataset registry, results, and the research documentation.
`upstage-cli` remains the agent under test and is consumed as a pinned
submodule (ADR 0002).

History is carried over, not re-authored: `harness/` and `HARNESS.md` were
extracted from upstage-cli master `6d1e932` with `git filter-repo`
(`HARNESS.md` renamed to `harness/docs/HARNESS.md`). Every rewritten commit
keeps its author and date and gains an `Upstream-Commit:` trailer naming the
original SHA. See [`docs/MIGRATION.md`](../MIGRATION.md).

## Consequences

- `git log` / `git blame` in this repository reach back to the harness's
  first commit (2026-04-27).
- upstage-cli can drop `harness/` and `HARNESS.md` — but only after this
  repository's verification is recorded, in a separate PR there (see
  `docs/MIGRATION.md`, "upstage-cli cleanup").
- Two repositories must be kept in step. The submodule pin is the contract;
  moving it is a deliberate, reviewed change.
