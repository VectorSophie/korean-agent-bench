# ADR 0011 — Main comparison protocol v1 (frozen)

## Status

**Accepted and frozen** (2026-10-30, before any main-comparison inference).
Machine-readable protocol: `protocol/main-v1.json` (sha256 in
`protocol/main-v1.json.sha256`), generated from the repository's own sources by
`benchmarks/campaign/freeze_protocol.py` — nothing in it is transcribed by hand.
Reviews: Gate A (`docs/audits/2026-10-29-gate-a-pre-inference.md`), Gate B
(`docs/audits/2026-10-29-gate-b-pre-freeze.md`).

## Context

ADR 0003 admits nothing to the main comparison until a protocol is frozen.
ADR 0009 integrated BFCL and SWE-bench Verified with their upstream
evaluators; ADR 0010 fixed the agent loop's context handling. Four pilot rounds
on ids disjoint from the main subsets (27 BFCL entries, 2 SWE-bench
instances) exercised the full path on all four models; pilot outcomes are not
scores and influenced only defects in the measurement path (Gate B), never
model-specific settings.

## Decision

1. **Admitted datasets** (`datasets/registry.json` `mainComparison:
   admitted`): BFCL subset-v1 (1,106 entries, 14 categories,
   `bfcl-eval==2026.3.23`) and SWE-bench Verified subset-v1 (100 instances,
   dataset revision `78f471bf`, `swebench==5.0.2`). Subsets were drawn by seeded
   hash before any model ran; they do not change after this ADR.
2. **Models.** Primary: Kanana 2 30B-A3B Thinking (BF16, TP1), EXAONE 4.5 33B
   (FP8, thinking on, TP1), A.X 4.0 (BF16, TP2), Solar Open 2 250B (unofficial
   Nota NVFP4, TP2, 8,192-token context) — each exactly as in
   `harness/src/agent/local-models.mjs` and started by the maintained
   launchers, with a REPORTABLE serving preflight before every BFCL round and
   every SWE-bench attempt. EXAONE thinking-off is not run. **Solar Open 2 is
   a separately constrained arm** (half the context of the others, an
   unofficial quantization, a different serving runtime); it is in the same
   tables but every comparison involving it is labelled so.
3. **BFCL** (official track, no upstage-cli): BFCL's own FC handler through
   `benchmarks/bfcl/kab_bfcl.py`, temperature 0.001, **no `max_tokens`**
   (upstream semantics), 8 threads, scored by `bfcl evaluate --partial-eval`.
4. **SWE-bench Verified** (agent track): the model drives upstage-cli at the
   pinned commit through `LocalModelAgent`, in the official instance image
   (network none, 4 GB, 2 CPUs, testbed interpreter on PATH), from a
   single-commit snapshot of `base_commit`. Envelope, uniform for all models:
   30 turns, 60 tool calls, 2,700 s wall clock, English system prompt, the
   7 file/shell tools, prompt template `kab-swebench-prompt-v1` without hints.
   Context: exact server-side token counting (`/tokenize`); output
   reservation 8,192 for the 16K models, 4,096 for Solar. Concurrency 4.
   Scored only by `swebench.harness.run_evaluation`.
5. **Nested stages.** SWE-bench stage 1 (50 instances, repository-stratified,
   `datasets/swe-bench-verified/stages-v1.json`) runs for all four models;
   stage 2 (the other 50) runs only if every model completed stage 1 and the
   projected cost fits the remaining ceilings. That decision uses resource
   figures only, never results. Reports state which stage(s) were completed.
6. **Attempts.** One attempt per task. Infrastructure failures (transport,
   5xx, timeouts; for BFCL by exception type) are retried at most twice; model
   outputs, tool errors, context or budget exhaustion, truncation and protocol
   errors are never retried.
7. **No exclusions.** Every scheduled task stays in the denominator.
   Context-infeasible, truncated, budget-exhausted and infrastructure-failed
   tasks are scored as not correct / not resolved and also reported in their
   own columns.
8. **Analysis** (`benchmarks/campaign/analyze.py`, independently recomputed
   by `verify.py`):
   - BFCL, **confirmatory**: pooled accuracy over the 1,106 scheduled entries
     (unweighted; not BFCL's overall score), Wilson 95% CI; six pairwise exact
     McNemar tests, Holm-adjusted at α = 0.05; paired bootstrap CIs.
     Per-category accuracy is exploratory (n < 30 descriptive only).
     Sensitivity: inference errors and truncations counted as wrong.
   - SWE-bench, **exploratory**: resolve rate with Wilson and
     repository-cluster bootstrap CIs; pairwise paired bootstrap and McNemar,
     descriptive.
   - Behaviour and efficiency: descriptive, never combined into a score.
   - BFCL and SWE-bench are never merged into one number.
9. **Resources.** One model server at a time; at most 36 h of model-server
   wall clock for the campaign; at most 100 GB of additional Docker image
   storage (enforced by `campaign.py pull-images`); GPU safety gates
   unchanged. Order: BFCL for all four models, then SWE-bench stage 1, then
   stage 2 if allowed.
10. **Frozen.** After this ADR no model setting, budget, timeout, prompt,
    subset or scoring rule changes for this campaign. A defect found during
    the run is fixed only if it is in the measurement path and affects all
    models alike; the affected cells are then re-run for every model and the
    change is recorded as a protocol amendment. Otherwise the defect is
    reported as a limitation.

## Interpretation limits

Results describe the measured benchmarks and this frozen workload only — no
"best overall model". Both benchmarks are English; nothing follows about
Korean. The BFCL subset is not comparable to the public leaderboard.
SWE-bench measures each model as the engine of upstage-cli at the pinned
commit, not the model in isolation. Public data: contamination is possible
for every model.

## Consequences

Main results are reported under `results/<campaign>/` with the protocol
sha256; `verify.py` checks that every run used the frozen configuration.
