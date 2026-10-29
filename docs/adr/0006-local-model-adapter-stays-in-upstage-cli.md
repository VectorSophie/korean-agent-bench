# ADR 0006 — The local OpenAI-compatible model adapter stays in upstage-cli

## Status

**Accepted** (2026-10-29). Revisit if upstage-cli decides not to ship it.

## Context

`src/model/local-openai-adapter.mjs` (upstage-cli, 4 commits, 2026-10-26 to
2026-10-28) is the client the harness uses to talk to the four locally
served models. Nothing else in upstage-cli imports it today, so it is a
candidate to move here with the rest of the research infrastructure.

But it is an implementation of upstage-cli's *internal* model-adapter
contract: it imports `src/model/fetch-utils.mjs` and `src/core/streaming.mjs`
and is consumed by the CLI's `runAgentLoop`. Moved here, it would depend on
more CLI internals through the submodule and would break silently whenever
that contract changes — without any upstage-cli test to catch it.

## Decision

The adapter stays in upstage-cli and is loaded through `importFromCli`
(ADR 0002). The **model registry** — which models, revisions, sampling and
endpoints — is research configuration and lives here
(`harness/src/agent/local-models.mjs`). Its tests
(`harness/tests/h14-local-adapter.test.mjs`) run here against the pinned
adapter.

## Consequences

- The upstage-cli cleanup PR does **not** remove the adapter.
- upstage-cli keeps a component it does not yet use itself. If it never wires
  local models into the product, moving the adapter (with its history, via
  the same filter-repo procedure) becomes the better trade, and this ADR is
  superseded.
