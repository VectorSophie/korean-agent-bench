# Live integration smoke and request-history audit (2026-11-09)

**Not a benchmark result.** One supervised EXAONE 4.5 FP8 session under the
shared GPU queue, one synthetic two-function task (no SWE-bench content)
through mini-swe-agent 2.4.6 and the KAB Docker sandbox. Context and
interpretation: [`docs/research/HARNESS_V2.md`](../../docs/research/HARNESS_V2.md) §7.

| File | What |
|---|---|
| `smoke-summary.json` | serving, identities, outcome, totals, and one row per model call (provider usage, finish reason, reasoning size). The run predates `trace.modelCalls`; rows are derived from mini's native trajectory. |
| `request-history-audit.json` | the 15 recorded calls replayed through mini's `LitellmModel` (no inference) and re-rendered with the checkpoint's chat template and tokenizer, with and without earlier reasoning, against the server's `prompt_tokens`. |

Counts only: no transcript, commands, reasoning text or patch. The raw run
record (sha256 in both files) stays under `.cache/`. Verify with
`sha256sum -c SHA256SUMS` from this directory.
