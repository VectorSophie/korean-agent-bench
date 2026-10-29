# Migration from upstage-cli

Performed 2026-10-29. Record of exactly what moved, how, what was left
behind, and how it was verified. Rationale: ADR 0001.

## Sources

| Source | Ref | Commit |
|---|---|---|
| `VectorSophie/upstage-cli` | `master` (merge of PR #11) | `6d1e9329381b45e32b736bde1cdbd6ac2a41b7da` |
| `VectorSophie/upstage-cli` | `feat/harness-benchmark-v1-dataset` (PR #12, **unmerged**) | `f4c574fef12512686577a029c6b657ea45a63275` |
| `~/workspace/model-prep` | no version control | file list + SHA-256 in `models/serving-records/` |
| live pilot run records | previous session scratchpad (`/tmp`) | file list + SHA-256 in `results/pilot-2026-10/` |
| `VectorSophie/hgit` | — | reference for documentation conventions only; nothing copied |

All work was done from fresh clones. The existing local checkout
`~/workspace/upstage-cli` (on the PR #12 branch) was not modified.

## Map

| From | To | Method |
|---|---|---|
| upstage-cli `harness/**` (master) | `harness/**` | `git filter-repo --path harness/ --path HARNESS.md`; 41 commits (38 touching harness, plus merges), authors and dates kept, each with an `Upstream-Commit:` trailer |
| upstage-cli `HARNESS.md` | `harness/docs/HARNESS.md` | same history (`--path-rename`) |
| upstage-cli `src/**` | `vendor/upstage-cli` (submodule; pinned `6d1e932` at extraction, now `7380ef6`, the cleanup merge) | not copied (ADR 0002; pin history there) |
| upstage-cli `eslint.config.mjs` (re-exported by the harness) | inlined into `harness/eslint.config.mjs` | same rules |
| upstage-cli `src/model/local-openai-adapter.mjs` | stays upstream, loaded via the submodule | ADR 0006 |
| PR #12 content | branch `import/upstage-cli-pr-12` (not merged into `main`) | patch re-applied minus held-out material; see below |
| `model-prep/*` (except `__pycache__/`) | `models/serving-records/` | verbatim copy + `SHA256SUMS` + `PROVENANCE.md` |
| pilot run records (27) | `results/pilot-2026-10/` | verbatim copy + `SHA256SUMS` + `README.md` |
| upstage-cli CI job `harness` | `.github/workflows/ci.yml` | rewritten for the submodule layout |

## Changes made after extraction

All on `main`, each its own commit:

1. **Boundary.** Three private `CLI_ROOT` resolvers, one static import and
   five test files re-pointed to `vendor/upstage-cli/src` via
   `harness/src/upstream.mjs`; guard test `h24`.
2. **Provenance.** `provenance.harness.upstageCli` added to every run record
   (the move made `provenance.harness.commit` stop identifying the agent).
3. **Registry.** `datasets/registry.json` + guard test `h25`.
4. References to `~/workspace/model-prep` re-pointed to
   `models/serving-records/`.

No harness behavior, task, fixture, evaluator or scoring logic was changed.

## PR #12

**Final disposition (2026-10-29):**

- **upstage-cli#12** (`feat/harness-benchmark-v1-dataset`, head
  `f4c574fef12512686577a029c6b657ea45a63275`) was **closed without merging**
  with a comment linking here. Before closing, all 86 files it changed were
  compared with the import: 83 byte-identical, `package.json` merged,
  `holdout-pack.public.json` excluded and `BENCHMARK_V1_DATASET.md` §4.2
  redacted (ADR 0004). The branch had no commits beyond `f4c574f` and was
  then deleted; the commit stays reachable at `refs/pull/12/head`.
- The held-out candidates that PR published (3 built, 5 designed) are
  **disclosed and retired** from any official held-out pool. Deleting the
  branch does not undo the disclosure.
- **korean-agent-bench#1** imported the PR (commit `33c84e4`), then reduced
  it (ADR 0007): kept the `tool-result-selection` evaluator, its adversarial
  tests, digest pinning, family/tranche accounting and one end-to-end
  fixture (`bv1-tr1-json-field`); dropped 13 synthetic rows and the
  held-out pack loader. Per-component table:
  [`harness/docs/BENCHMARK_V1_DATASET.md`](../harness/docs/BENCHMARK_V1_DATASET.md).

Upstream history for PR #12 was **not** carried over (its commit contains
the excluded files). The import commit names the original SHA in its
`Upstream-Commit:` trailer.

## Verification

Baseline first: the same commands on a fresh upstage-cli clone at
`6d1e932`, in its original layout, then in this repository. Run
2026-10-29, Node v24.21.0, Bun 1.4.2, Docker on the reference machine.

| Check | upstage-cli `6d1e932` | korean-agent-bench `main` | `import/upstage-cli-pr-12` |
|---|---|---|---|
| Extracted `harness/` tree vs upstream | — | identical except the added `harness/docs/HARNESS.md` (same blob as upstream `HARNESS.md`) | — |
| `npm run check` | pass | pass | pass |
| `npm run lint` | pass | pass | pass |
| `npm test` (unit tier) | 350/350 | 361/361 (same 350 test names + 11 new) | 379/379 |
| `npm run test:docker` | 35/35 | 35/35 | 35/35 |
| `npm run smoke` (mock agent) | pass | pass | pass |
| `benchmark:validate` | — | OK, 14 tasks (14 unpinned-image warnings, as upstream) | OK, 28 tasks, 0 warnings |
| `benchmark:qa` (Docker, reference solutions) | — | — | 28/28 |
| GitHub CI, Node 22 | — | green: unit 361/361, Docker 35/35 (run 40829975387) | green |

Mutation checks: `h24` fails when the old `../../../src/` import is restored;
`h25` fails when a synthetic set is marked `candidate` and when an
unclassified fixture is added; `upstageCli.matchesPin` reads `false` when the
submodule is moved off its pin. All restored afterwards.

Not run: any GPU workload, model server, or live model inference; `pack
verify`/`pack qa` against the private held-out pack.

## upstage-cli cleanup

**Done 2026-10-29.** [upstage-cli#13](https://github.com/VectorSophie/upstage-cli/pull/13)
was merged at `7380ef6e32fa091c24e6c4cbf03be66452c10b25` after upstage-cli#12
was closed. Reviewed boundary: 179/179 files under `harness/` plus
`HARNESS.md` deleted, the `harness` CI job and harness-only ignore lines
removed, **no file under `src/` deleted** (`src/` changes are comments
naming korean-agent-bench as the consumer of `sandbox/docker-flags.mjs`).
Kept upstream: all of `src/`, including `model/local-openai-adapter.mjs`
(ADR 0006) and `sandbox/docker-flags.mjs`.

A fresh clone of upstage-cli at `7380ef6` passes check, lint, `npm test`
(940: 932 pass, 0 fail, 8 skipped), `bun test tests/opentui/` (4/4), and
smoke (3/3); `upstage --version` and `--help` work.

**The intermittent `m9-improvements` failure** was investigated rather than
waived: it is a cross-process lost update on the shared
`~/.upstage-cli/sessions/index.json` (m9 alone 0/15 failures; serialized full
suite 0/10; default concurrency ~2/4 on unmodified master, so not introduced by
the cleanup). The same race left a stale index entry that made `upstage ask`
fail with ENOENT during verification. Fixed separately in
[upstage-cli#14](https://github.com/VectorSophie/upstage-cli/pull/14).

This repository's submodule pin was then moved to `7380ef6` (pin history in
ADR 0002); the full suite passes at the new pin.

## Final record (2026-10-29)

| Repository | PR | Disposition | Merge commit | CI on merge commit |
|---|---|---|---|---|
| upstage-cli | #12 v1-dataset + held-out pack | **closed unmerged**; branch deleted (commit kept at `refs/pull/12/head`) | — | — |
| korean-agent-bench | #1 PR #12 import, reduced (ADR 0007) | merged | `c254617` | run 40832314580 ✅ |
| upstage-cli | #13 remove harness | merged | `7380ef6` | run 40832861012 ✅ |
| upstage-cli | #14 session-index robustness, m9 isolation | merged | `160292b` | run 40833579697 ✅ |
| korean-agent-bench | #2 submodule pin → `7380ef6` | merged | `966d879` | run 40833667340 ✅ |
| korean-agent-bench | #3 serving preflight, Solar launcher, evidence audit | merged | `7a93212` | run 40834824264 ✅ |
| korean-agent-bench | #4 BFCL + SWE-bench Verified (official tooling) | merged | `c81edd5` | run 40839812410 ✅ (incl. external-benchmarks job) |

Earlier upstage-cli master CI on `6d1e932` (the extraction commit, before this
work) had failed one test, `screenshot() returns non-empty PNG bytes`
(run 40816432490); it passed on the later master runs above. Not investigated
further here.

**Final verification from a fresh recursive clone of `main` at `c81edd5`:**
submodule at `7380ef6` with a clean tree and no `harness/` upstream; every
relative import in `harness/` and `benchmarks/` resolves inside the harness
(184) or into `vendor/upstage-cli/src` (11), none elsewhere; check, lint, unit
405/405, Docker 35/35, smoke, `benchmark:validate` 15/0, `benchmark:qa` 15/15;
BFCL subset reproduced and BFCL offline validation PASS; SWE-bench parquet
sha256, index and subset reproduced and SWE-bench offline validation PASS
(official evaluator); all four evidence checksum sets and the disclosure
guard pass.

Not done: deleting the merged branches `import/upstage-cli-pr-12`,
`chore/pin-upstage-cli-cleanup`, `feat/evidence-audit-and-preflight`,
`feat/external-benchmarks` here, and upstage-cli's
`chore/move-harness-to-korean-agent-bench`, `fix/session-index-robustness`
(deleting `import/upstage-cli-pr-12` was denied by the session's permission
policy, so the others were not attempted; all are fully merged and safe to
delete).
