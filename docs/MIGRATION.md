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
| upstage-cli `src/**` | `vendor/upstage-cli` (submodule, pinned `6d1e932`) | not copied (ADR 0002) |
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

Not merged upstream and not merged here. Its content is on branch
`import/upstage-cli-pr-12` for review as its own pull request. Excluded,
per ADR 0004:

- `harness/benchmarks/v1/holdout-pack.public.json`;
- `harness/docs/BENCHMARK_V1_DATASET.md` §4.2 (replaced by a redaction note).

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

Mutation checks: `h24` fails when the old `../../../src/` import is restored;
`h25` fails when a synthetic set is marked `candidate` and when an
unclassified fixture is added; `upstageCli.matchesPin` reads `false` when the
submodule is moved off its pin. All restored afterwards.

Not run: any GPU workload, model server, or live model inference; `pack
verify`/`pack qa` against the private held-out pack.

## upstage-cli cleanup

A separate upstage-cli PR removes what moved — **only after this
repository's verification above is recorded and its CI is green**:

- delete `harness/` and `HARNESS.md`;
- delete the `harness` job from `.github/workflows/ci.yml` and the harness
  lines in `.gitignore` / `.npmignore`;
- update README / package description and comments that point at
  `harness/` to point here.

Kept in upstage-cli: everything under `src/`, including
`model/local-openai-adapter.mjs` (ADR 0006) and
`sandbox/docker-flags.mjs`, which this repository depends on.

That PR must not be merged while PR #12 is open there, or PR #12's branch
will conflict; the owner decides PR #12's fate first (close it in favor of
`import/upstage-cli-pr-12` here, recommended). After the cleanup merges, this
repository's submodule pin can move to the cleanup commit; the harness only
depends on `src/`, so that move should be a no-op — verify with the full
suite before committing it.
