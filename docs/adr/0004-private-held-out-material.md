# ADR 0004 — Private held-out material never enters this repository

## Status

**Accepted** (2026-10-29).

## Context

Unmerged upstage-cli PR #12 (`f4c574f`) added a loader for an external,
private held-out pack (`harness/src/benchmark/pack.mjs`), loaded from an
explicit path outside the repository with fail-closed path, hash and version
checks. That design is sound and is kept.

The same PR, however, also committed on a **public** branch:

- `harness/benchmarks/v1/holdout-pack.public.json` — task ids that name each
  held-out task's topic (e.g. a topological-ordering task, an LRU-cache
  task), its category, difficulty, and fixture/task hashes;
- `harness/docs/BENCHMARK_V1_DATASET.md` §4.2 — a table describing each
  held-out task's construct, including what its grader accepts and which
  wrong solution it is designed to reject, plus five more "designed, not yet
  built" held-out specs.

That is enough for a model trained on, or a person who has read, the public
branch to target the held-out tasks. The PR's own text notes that "hashes
alone do NOT guarantee confidentiality".

## Decision

- No held-out content, and no per-task description of held-out content, is
  committed here: no prompts, fixtures, tests, solutions, construct
  descriptions, grader behavior, or topic-revealing ids.
- The loader (`pack.mjs`), its tests (which use a synthetic pack generated in
  a temp directory), and the CLI commands are imported from PR #12.
  `holdout-pack.public.json` and §4.2 of `BENCHMARK_V1_DATASET.md` are not
  (see `docs/MIGRATION.md`).
- A public commitment to a held-out set, if wanted, is a single digest over
  the whole pack published *without* per-task metadata.
- `.gitignore` blocks `holdout/`, `*.holdout/` and `private/` as a guard
  against accidental copies. It is not the confidentiality mechanism; not
  committing the content is.

## Consequences

- **The three built held-out candidates and the five designed specs that
  PR #12 described should be treated as disclosed.** They are already public
  on `VectorSophie/upstage-cli` branch `feat/harness-benchmark-v1-dataset`.
  Removing that is the owner's decision (closing the PR does not remove the
  branch or its commits; deleting the branch does not remove forks or
  caches). Recommended: retire those eight and author fresh held-out tasks
  directly into the private pack.
- In any case, a held-out set made of AI-authored tasks is still
  `synthetic-dev` under ADR 0003.
