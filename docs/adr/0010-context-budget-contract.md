# ADR 0010 — The harness hands each model's validated context budget to the agent loop

## Status

**Accepted** (2026-10-29). Upstream: upstage-cli#15, merge `b17a1f3`.
Submodule pinned to it.

## Context

upstage-cli had no capability entries for the four served model ids
(`Kanana-2`, `EXAONE-4.5`, `A.X-4.0`, `solar-open2-250b`), so its agent loop
used a 65,536-token fallback for all of them: a 23,592-character repository
context cap and compaction at 80% of 64K, against validated windows of
16,384 (8,192 for Solar). Investigating the path (M1) found five further
defects: compaction counted only the conversation (not the system prompt,
context block, tool schemas or output reservation); full compaction reduced
the task message to a 120-character preview; its summary was unbounded; a
single tool result was unbounded; and the char/4 token heuristic
underestimates these models' real tokenizers.

Tokenizer calibration (`models/tokenizer-calibration/2026-10-29.json`; real
tokenizers at the pinned revisions vs the heuristic, on the 100 SWE-bench
issue texts, the captured system prompt and tools, and real Python source and
JSON tool output): worst real/heuristic ratio Kanana 1.87, EXAONE 1.98,
A.X 2.27, Solar 2.12 (medians 0.97–1.24).

## Decision

1. **Generic upstream contract, no research model names in the product.**
   `runAgentLoop({ contextBudget })` takes `contextLimit`, `maxOutputTokens`,
   `charsPerToken`, `safetyMarginRatio`. Without it, behaviour is unchanged.
   With it: validated up front (contradictions, including an adapter
   `max_tokens` above the reservation, are rejected before any request);
   input budget = limit − output − margin; repository context ≤ 9% of it;
   per-turn conversation budget after system prompt, context block and tool
   schemas; task message pinned verbatim; bounded summary; tool results ≤ 25%
   of the conversation budget; a pre-request fit check with staged
   compaction (4 → 2 → 0 recent messages) and then `context_exhausted`; one
   bounded compaction retry on a server context-length rejection, then
   `context_exhausted`.
2. **The harness supplies the values** (`harness/src/agent/adapters/local.mjs`):
   `contextLimit` from `local-models.mjs`, `maxOutputTokens` = exactly the
   `max_tokens` sent, `charsPerToken` = 4 / (model's worst observed ratio ×
   1.10), margin 5%. Recorded per run in `provenance.model.contextBudget`.
3. **`context_exhausted` is an agent outcome, not infrastructure**: it flows
   through like `budget_exhausted` and is reported in its own column.

## Consequences

- Initial-request feasibility on the SWE-bench subset
  (`datasets/swe-bench-verified/context-feasibility-v1.json`, recomputed with
  real tokenizers): Kanana, EXAONE, A.X 100/100 fit; Solar 96 fit, 1 depends
  on the retrieved context, 3 cannot fit its 3,686-token input budget.
- The loop's fit check uses the calibrated heuristic, which is deliberately
  conservative: it may stop with `context_exhausted` on a request that would
  have fit by the real tokenizer. It never sends one estimated not to fit.
  The same rule applies to every model, with each model's own calibration.
- Tests: upstage-cli `tests/m49` (11, two mutation-checked);
  harness `tests/h30` (the budget reaches the real loop; request within
  budget; unfittable task never sent and not classified as infrastructure).

## Amendment (2026-10-29, M2 pilot)

The first live pilot showed the worst-case calibration was too pessimistic
for typical content: on Kanana 2 (16K), after one file read the loop
estimated the next request at 8,024 tokens against an input budget of 7,372
and stopped with `context_exhausted`, while the server had counted the first
request at ~1.7K tokens. upstage-cli#16 (`23f8136`) therefore calibrates from
the server: after each completion the ratio of `usage.prompt_tokens` to the
base heuristic of exactly what was sent (max over the run, clamped to
[0.25, 4]) replaces the calibrated chars/token, plus 10%. The worst-case
calibration still governs the first request. Shared infrastructure, applied
identically to every model; made before the protocol freeze.

