# Roadmap: Harness v2

Ordered milestones, each the smallest useful step. No dates or performance
targets. Nothing here is scheduled. Design: `docs/research/HARNESS_V2.md`.

| # | Milestone | Depends on | Done when | State (2026-11-08) |
|---|---|---|---|---|
| 1 | Onboarding and audit | — | `CLAUDE.md`, HARNESS_V2, ops guide; doc drift corrected; v1 concerns A–D characterized | **done** |
| 2 | Shared harness interface | 1 | `kab.agent-harness/v1` descriptor recorded per run; adapters for upstage-cli emit it; runner validates (h32) | **done (foundation)**. Open: the task spec still carries upstage-cli tool names (move them to the descriptor); the descriptor is optional (`null`), and a v2 campaign driver must refuse runs without a pinned one |
| 3 | First external harness: mini-SWE-agent | 2 | pinned install; Python bridge env → the task's Docker sandbox; litellm → local server; descriptor; offline replay validation (HARNESS_V2 §7) | **done (offline)**: mini-swe-agent 2.4.6; h33 (unit, CI), h34 (real Docker, official image). Open: official-evaluator check of a mini prediction (replayed), first live run (needs milestone 7) |
| 4 | Trace and resource accounting | 2 | per-request fixed-overhead / injected-context / conversation tokens; retrieval keywords; time to first edit; repeated reads; same fields for every harness | not started |
| 5 | Controlled layer ablations | 2, 4 | switches for F1 (KAB shell wrapper) and F2/F3/F4 (reviewed upstage-cli changes behind flags); each level a distinct `harnessId`; budget levels a distinct `budgetId` | not started |
| 6 | Offline validation | 3, 5 | every arm runs end to end with replayed models; official evaluator gold/empty/wrong checks per arm; no GPU | not started |
| 7 | Preregistered pilot | 6, owner approval of the queue-held serving session (ops guide; tested with fakes, h35) | protocol file frozen (like `protocol/main-v1.json`); small n; power analysis for the main run | not started |
| 8 | Main experiment and official scoring | 7, Docker storage decision | official scorer only; full denominators; verification script; adversarial gate | not started |

## Owner decisions needed before milestone 7

- Approve (or change) the queue-held serving session `models/serving/kserve-session.sh`, and its first live use.
- The Docker image budget, which determines the SWE-bench sample size.
- Whether a 32K serving configuration is validated for any model.
