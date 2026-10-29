# Critique Gate B — pre-freeze review (2026-10-29)

An independent reviewer (a separate read-only agent instructed to find reasons
the main comparison would be invalid or unfair) examined the pilot evidence
(`pilot-2026-10-29-r3`: 4 models × 27 BFCL entries + 2 SWE-bench instances,
disjoint from the main subsets) and the measurement path before the protocol
freeze. Each finding was reproduced here before remediation. Pilot results are
descriptive only and are not reported as scores.

**Outcome: 4 must-fix findings confirmed and fixed (upstage-cli#18 and this
repository's PR #10); 3 further changes adopted; recommendations on the
statistics plan adopted in ADR 0011.** A fourth pilot round
(`pilot-2026-10-29-r4`, same ids) then exercised the fixed path live on all
four models before the freeze.

## Must-fix

| # | Finding | Evidence | Remediation |
|---|---|---|---|
| B1 | Context policy artefact: the worst-case calibrated estimate (chars/token from `models/tokenizer-calibration/2026-10-29.json`) made Solar (8K) end with `context_exhausted` *before its first request* on one pilot instance, and the 16K models had unequal input budgets because the reservation followed each model's own `maxOutputTokens` (Kanana and EXAONE 8192, A.X 4096: A.X had about 4K more input) | pilot r3 agent records (Solar psf__requests-1724 `context_exhausted` after 171 ms, 0 tool calls, no model request; `local-models.mjs` before `1b4bc66`) | Exact server-side counting: upstage-cli#18 (`802cddd`) adds `contextBudget.countTokens`; the harness passes `LocalOpenAIAdapter.countTokens` → vLLM `/tokenize` (same chat template, tools and `chat_template_kwargs` as the request). Estimates remain only for compaction budgeting and as fallback. Output reservation equal across the 16K models (8192); Solar keeps 4096 of its 8192 |
| B2 | The harness system prompt defaults to Korean; A.X wrote a Korean code comment into a Python 2-compatible file, which then failed with `SyntaxError` — a language-condition artefact on an English benchmark | pilot r3 A.X psf__requests-1724: patch adds Korean comments to `requests/sessions.py`; official test log `SyntaxError: Non-ASCII character '\xea' … no encoding declared` | Task-level `agent.language: "en"` (schema enum `en`/`ko`) set by the SWE-bench envelope |
| B3 | Provenance/observability gaps: the context budget actually applied, compactions, recoverable tool errors and re-plans were not in the run record | run JSON | `agentDiagnostics` (context fit per request with exact and estimated counts, observed ratio, compactions, recoverable errors, re-plans) and the full `contextBudget` in provenance |
| B4 | BFCL: the harness-level 4096 `max_tokens` cap (Gate A #2) produced Solar's two pilot errors (`max_tokens` + prompt > 8192 rejected by the server) — a deviation from BFCL's own request semantics that penalises the 8K model | pilot r3 Solar BFCL `kab-diagnostics.jsonl` (2 × HTTP 400 context length) | Reverted to upstream semantics: no `max_tokens` (vLLM allows the remaining context). Truncation and empty outputs stay visible through the diagnostics sidecar and the sensitivity analysis |

## Adopted changes

- SWE-bench wall clock raised from 1800 s to 2700 s for every model. Pilot
  maximum episode was 715 s, so the clock was not binding; the new value is
  set before any main run, uniformly, and not tuned on results.
- Nested SWE-bench stages (`datasets/swe-bench-verified/stages-v1.json`):
  stage 1 (50, repository-stratified) runs for all four models first; stage 2
  (the other 50) runs only on a resource decision. Projected cost (reviewer's
  estimate): BFCL 0.4–1.2 h per model; SWE-bench 100 instances ≈ 17 h at
  concurrency 4; total ≈ 22 h of the 36 h ceiling; Docker images 75–125 GB
  against a 100 GB budget — hence stages and an enforced image budget.
- upstage-cli file checkpointing disabled in harness runs (it wrote
  checkpoint files into the repository root during the pilot); `.upstage/`
  gitignored.

## Statistics plan (adopted)

BFCL pooled-accuracy pairwise McNemar tests (6 pairs, Holm) are the only
confirmatory analysis; per-category results and every SWE-bench pairwise
comparison are exploratory. SWE-bench concurrency 4.

## Not changed

- BFCL temperature 0.001 (BFCL's own, uniform) — documented limitation.
- A.X's 0/6 on BFCL parallel categories in the pilot: verified with a raw
  completion (`tool_choice=none`) that the model itself emits a single
  `<tool_call>`; not a parser defect, so nothing to fix.

## Post-fix pilot (r4, same ids as r3; descriptive only)

`pilot-2026-10-29-r4` re-ran all four models on the r3 pilot ids with the
fixes above (EXAONE's first pass was refused by the clean-tree guard because of
an uncommitted file and re-run on a clean tree; nothing was recorded by the
refused pass).

| Model | BFCL (27) | SWE-bench agent outcomes | Official |
|---|---|---|---|
| Kanana | 25 | output_truncated ×2 (thinking exceeded the 8,192-token output) | empty_patch, unresolved |
| EXAONE | 23 | budget_exhausted ×2 (30 turns) | empty_patch ×2 |
| A.X | 18 (parallel categories 0/6 as in r3) | completed ×2 | empty_patch, unresolved |
| Solar Open 2 | 26 (0 context errors, was 2) | context_exhausted (after 2 tool calls), budget_exhausted (30 turns, patch) | empty_patch, unresolved |

Checks: every SWE-bench request counted exactly by the server (`/tokenize`,
all 157 requests); no Korean text in any run record; `verify.py` 87/87. One
observability defect found and fixed before the freeze: `trace.compactions`
was always empty (event-name mismatch). Solar's 3,686-token SWE-bench input
budget is recorded in ADR 0011 as a known property of the 8K arm.
