# Status

Snapshot as of **2026-10-29**, immediately after the migration from
upstage-cli. Update this file with a new date whenever a claim below
changes; do not edit history in place.

## What exists

- **A working evaluation harness** that drives upstage-cli's own agent loop
  and tools (pinned submodule, ADR 0002) against the Upstage API or four
  locally served Korean models, in native or Docker sandboxes, with trusted
  evaluators, fail-closed isolation and per-run provenance.
- **Four models integrated** — Kanana 2, EXAONE 4.5 (thinking on/off),
  A.X 4.0, Solar Open 2 (unofficial Nota NVFP4) — documented in
  [`models/`](models/README.md). All `serving_ready` and
  `harness_integrated`; **none `benchmark_ready`**.
- **Synthetic development fixtures**: benchmark-v1 tranche v1-initial (14
  rows) on `main`; tranche v1-dataset (14 more) and the private held-out pack
  loader on branch `import/upstage-cli-pr-12`, pending review.
- **A dataset registry** that excludes every synthetic set from the main
  comparison and lists BFCL and SWE-bench Verified as pinned, planned
  candidates (ADR 0003).
- **Evidence under version control**: model-serving records and the raw
  records of the 2026-10 pilot, with checksums (ADR 0005).

## Verified (2026-10-29)

Commands in [`VERIFY.md`](VERIFY.md); full table and baseline comparison in
[`MIGRATION.md`](MIGRATION.md#verification). On `main`: check, lint, unit
361/361, Docker tier 35/35, smoke, `benchmark:validate`, evidence checksums.
On `import/upstage-cli-pr-12`: unit 379/379, Docker 35/35, `benchmark:qa`
28/28. Not run: any GPU workload, model server or live inference.

GitHub CI (Node 22) is green on `main` (unit 361/361, Docker 35/35, evidence
checksums; run 40829975387) and on the PR #12 import
([#1](https://github.com/VectorSophie/korean-agent-bench/pull/1)).

## Not yet established (blocking a main comparison)

1. **External benchmarks are not integrated.** BFCL and SWE-bench Verified
   are pinned in `datasets/registry.json` but nothing downloads, runs or
   scores them. Needed: drive the four models through the upstream
   evaluators (`bfcl_eval`; SWE-bench predictions + `run_evaluation`) without
   altering evaluation semantics. `harness import swebench` is not this — its
   checks are pytest approximations (`officialEvalCompatible: false`).
2. **No benchmark, subset or budget is chosen.** Requires an ADR (ADR 0003,
   point 5).
3. **Korean condition undefined.** Both candidates are English. Whether and
   how to build Korean variants (and who translates/reviews) is open.
4. **Serving provenance is declared, not observed.** Run records copy model
   configuration from `local-models.mjs`; the harness does not query the
   server (`/v1/models`) or the container image digest. The pilot already
   produced one record whose `contextLimit` (8192) did not match the server
   (4096). Manual pre-run checks are in the protocol until this is automated.
5. **Repetitions, seeds and statistics.** Samples are unseeded; the pilot was
   one attempt per cell. `harness/docs/BENCHMARK_V1_STATISTICS.md` is a draft
   for the fixture set, not for external benchmarks.
6. **Context feasibility.** Solar Open 2 is validated only to 8K on this
   hardware (others 16K). SWE-bench prompts may not fit; how infeasible items
   are reported must be decided before running.

## Known limits

- **One machine, shared.** Measurements are tagged `contended`; models are
  served one at a time; A.X and Solar need both GPUs.
- **Solar Open 2 is an unofficial quantization**; quality relative to the
  official weights is unmeasured. Its launcher runs by image tag (verified on
  2026-10-29 to resolve to the recorded digest) and defaults to the wrong
  context length (4096; must be 8192).
- **Benchmark-v1 tranche v1-initial uses unpinned `node:22-alpine` tags**
  (14 validate warnings). Tranche v1-dataset pins by digest.
- **`vendor/upstage-cli` still contains a stale copy of the harness** until
  the upstage-cli cleanup lands and the pin moves. Nothing imports it (h24).
- **upstage-cli dependencies are installed with Bun** inside the submodule;
  that `node_modules` is not pinned by this repository beyond upstage-cli's
  own `bun.lock`.
- **The live pilot is not reproducible bit-for-bit**: unseeded sampling,
  contended GPUs, and the run records predate the `upstageCli` provenance
  field (their `provenance.harness.commit` is an upstage-cli commit).

## Open owner decisions

- **Held-out candidates are disclosed.** Upstage-cli PR #12's public branch
  describes three built and five designed held-out tasks (ADR 0004). Decide
  whether to delete that branch / close PR #12, and retire those candidates.
- **PR #12 here.** Review and merge (or not)
  [korean-agent-bench#1](https://github.com/VectorSophie/korean-agent-bench/pull/1)
  (draft).
- **upstage-cli cleanup PR.**
  [upstage-cli#13](https://github.com/VectorSophie/upstage-cli/pull/13)
  (draft). This repository's CI is green; merge after PR #12's fate is
  decided (`MIGRATION.md`, "upstage-cli cleanup").
