# ADR 0002 — upstage-cli is a pinned submodule, reached through one module

## Status

**Accepted** (2026-10-29).

## Context

The harness does not re-implement an agent. `UpstageAgent` and
`LocalModelAgent` drive upstage-cli's own agent loop, tool registry, policy
engine and session (`src/agent/loop.mjs`, `src/tools/create-registry.mjs`,
`src/core/policy/engine.mjs`, `src/runtime/session.mjs`), its model adapters,
its prompt-injection check, and its Docker flag builder
(`src/sandbox/docker-flags.mjs`). That reuse is the point: a model is
measured through the same agent machinery a user runs.

Inside upstage-cli this reuse was expressed as relative paths that assumed
the harness sat next to `src/`: three private `CLI_ROOT` resolvers
(`../../../../../src`, `../../../../src`), one static import
(`../../../src/sandbox/docker-flags.mjs`), five test files importing
`../../src/...`, and an ESLint config that re-exported the CLI's.

Options considered:

1. **Copy `src/` into this repository.** Rejected: the agent under test would
   silently fork from the product, and the copy would have no provenance.
2. **Depend on the npm package.** Rejected for now: the harness uses internal
   modules that are not part of the package's public surface, and npm
   versions are coarser than commits.
3. **Git submodule pinned to a commit.** Exact, reviewable, and the pin is
   recorded with every result.

## Decision

upstage-cli is a git submodule at `vendor/upstage-cli`, pinned to
`6d1e9329381b45e32b736bde1cdbd6ac2a41b7da` (master, merge of PR #11 — the
same commit the harness was extracted from, so code and agent match).

All access goes through `harness/src/upstream.mjs` (`CLI_ROOT`, `CLI_SRC`,
`importFromCli`) or a literal `vendor/upstage-cli/src/...` import path. Only
`src/` is used; the submodule's own `harness/` copy is never imported.

There is **no environment override** for the CLI location. Static imports
cannot follow one, so an override would let dynamic and static imports load
two different CLI revisions in one run. To evaluate another revision, move
the pin.

`harness/tests/h24-upstream-boundary.test.mjs` fails if any relative import
leaves the harness except into `vendor/upstage-cli/src`, or if any file other
than `upstream.mjs` defines its own `CLI_ROOT`.

## Consequences

- Setup needs `git submodule update --init` and `bun install` inside the
  submodule (its dependencies, e.g. tree-sitter, are loaded by the tool
  registry). `importFromCli` fails with those instructions if the submodule
  is missing.
- Results must identify the agent. Upstream, `provenance.harness.commit` was
  the upstage-cli commit and so identified harness *and* agent; here it is
  this repository's commit, which implies the CLI revision only if the
  submodule checkout matches its pin. Every run record therefore also carries
  `provenance.harness.upstageCli = { commit, pinnedCommit, matchesPin, dirty }`
  (tested in h24; drift verified to show `matchesPin: false`).
- While the pin predates the upstage-cli cleanup, `vendor/upstage-cli/harness/`
  still exists. It is dead weight, not a dependency; h24 guarantees nothing
  imports it.
