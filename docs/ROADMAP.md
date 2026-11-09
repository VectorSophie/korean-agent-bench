# Roadmap: Harness v2

Ordered milestones, each the smallest useful step. No dates or performance
targets. Nothing here is scheduled. Design: `docs/research/HARNESS_V2.md`.

| # | Milestone | Depends on | Done when | State (2026-11-09) |
|---|---|---|---|---|
| 1 | Onboarding and audit | — | `CLAUDE.md`, HARNESS_V2, ops guide; doc drift corrected; v1 concerns A–D characterized | **done** |
| 2 | Shared harness interface | 1 | `kab.agent-harness/v1` descriptor recorded per run; adapters for upstage-cli emit it; runner validates (h32) | **done (foundation)**. Open: the task spec still carries upstage-cli tool names (move them to the descriptor); the descriptor is optional (`null`), and a v2 campaign driver must refuse runs without a pinned one |
| 3 | First external harness: mini-SWE-agent | 2 | pinned install; Python bridge env → the task's Docker sandbox; litellm → local server; descriptor; offline replay validation (HARNESS_V2 §7) | **done**: mini-swe-agent 2.4.6; h33 (unit, CI), h34 (real Docker, official image); official evaluator on replayed mini predictions (`validate_mini_offline.py`); one supervised live smoke (EXAONE, synthetic task, 2026-11-09). Open: a real model on a real instance (ADR 0012) |
| 4 | Trace and resource accounting | 2 | per-request fixed-overhead / injected-context / conversation tokens; retrieval keywords; time to first edit; repeated reads; same fields for every harness | **partly**: per-call records for both harnesses (`kab.model-call/v1`: logical calls, transport attempts, provider usage or null, tool-call slices; h33, h36). Open: per-request token decomposition, retrieval keywords, time to first edit, repeated reads |
| 5 | Controlled layer ablations | 2, 4 | switches for F1 (KAB shell wrapper) and F2/F3/F4 (reviewed upstage-cli changes behind flags); each level a distinct `harnessId`; budget levels a distinct `budgetId` | not started |
| 6 | Offline validation | 3, 5 | every arm runs end to end with replayed models; official evaluator gold/empty/wrong checks per arm; no GPU | **Track A arms only**: the pilot driver ran A, B, B30 end to end with a scripted model, real Docker and the official evaluator (`benchmarks/pilot/validate_pilot_offline.py`). Ablation arms: not started |
| 7 | Preregistered pilot | 6, owner approval of the queue-held serving session (ops guide; tested with fakes, h35) | protocol file frozen (like `protocol/main-v1.json`); small n; power analysis for the main run | **Track A feasibility pilot proposed** (ADR 0012, spec hash-frozen, driver built); not run; awaits the owner decisions below |
| 8 | Main experiment and official scoring | 7, Docker storage decision | official scorer only; full denominators; verification script; adversarial gate | not started |

## Owner decisions needed before milestone 7

- ~~Approve the queue-held serving session and its first live use~~ (done 2026-11-09, one supervised session).
- ADR 0012: accept the pilot; pull the `psf__requests-1142` image (~3.6 GB); keep or replace `psf__requests-1724` (gold patch unresolved here: a network-dependent test).
- The Docker image budget, which determines the SWE-bench sample size.
- Whether a 32K serving configuration is validated for any model.
