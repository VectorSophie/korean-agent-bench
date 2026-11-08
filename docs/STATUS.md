# Status

Snapshot as of **2026-11-08** (v1 main comparison complete and frozen; Harness v2 in
design, `docs/research/HARNESS_V2.md`). Update with
a new date whenever a claim below changes. Legend: **implemented** (code
exists) · **tested** (automated tests) · **verified** (exercised against the
real upstream tool or data) · **not executed** · **planned** · **unsupported**.

## Repository state

| Area | State | Evidence |
|---|---|---|
| Harness extracted from upstage-cli with history (41 commits) | verified | `docs/MIGRATION.md` |
| upstage-cli as pinned submodule `802cddd` (upstage-cli#18, exact token counts; earlier pins `6d1e932` → `7380ef6`) | verified | ADR 0002 pin history; `h24` (incl. every imported name exported at the pin) |
| upstage-cli#12 closed unmerged; held-out candidates retired as disclosed | done | `docs/MIGRATION.md` "PR #12" |
| upstage-cli#13 (cleanup) and #14 (session-index fix) merged | done | upstage-cli `7380ef6`, `160292b` |
| Synthetic fixtures reduced to 15 rows / 12 families, all excluded from comparison | tested | ADR 0007; `h20`, `h25` |
| Run provenance: harness + upstage-cli commit/pin/dirty | tested | `h24` |
| Serving preflight (declared vs observed, fail closed) | tested against fakes (`h26`, `h27`); verified live in the main campaign (row below) | ADR 0008 |
| Solar launcher by digest at 8192 | tested (`print-config`, fake docker); executed by the main campaign driver | `models/serving/kserve-solar.sh`; `h27`; `benchmarks/campaign/campaign.py` |
| Evidence disclosure audit; CI guard | done | `docs/audits/2026-10-29-evidence-disclosure-audit.md`; `scripts/check-evidence.sh` |
| BFCL official pipeline | verified offline (official generate + evaluate, mock model) | ADR 0009; `results/bfcl-offline-validation-2026-10-29/` |
| SWE-bench Verified official scoring | verified offline on 1 instance (official evaluator, official image) | `results/swebench-offline-validation-2026-10-29/` |
| SWE-bench agent prediction pipeline | verified with a replay agent; tested (`h29`) | same |
| Context feasibility for the SWE-bench subset | computed (preregistered) | `datasets/swe-bench-verified/context-feasibility-v1.json` |
| Main comparison `main-2026-10-30-v1`: BFCL 1,106 × 4 models; SWE-bench Verified stage 1, 50 × 4 | **verified** (official scorers; `verify.py` 105/105; independent BFCL recomputation; Gate C) | `results/main-2026-10-30-v1/`, `docs/research/FOUR_MODEL_COMPARISON.md` |
| Protocol frozen (`main-v1`) and Amendment 1 (workspace symlinks, 104 cells re-run) | done | ADR 0011; `protocol/` |
| SWE-bench stage 2 (50 more instances) | **not executed** (resource decision: Docker storage) | `results/main-2026-10-30-v1/records/stage2-decision.json` |
| Live serving preflight | verified (REPORTABLE before every BFCL round and SWE-bench attempt) | campaign runtime records |
| Harness v2: agent-harness identity contract (`provenance.agentHarness`, `kab.agent-harness/v1`) | tested (`h32`, `h30`); no model run | `harness/src/agent/harness-config.mjs`; HARNESS_V2 §6 |
| mini-swe-agent 2.4.6 as agent harness (`--agent mini-swe-agent --model <key>`, `kab.task/v2`, bridge into the KAB Docker sandbox) | tested offline: h33 (fake model + fake container), h34 (fake model, **real** DockerSandbox, official image); **no model run** | HARNESS_V2 §7 |
| Host-side patch capture uses a harness-owned git dir (agent-planted git config/hooks can no longer run on the host; pre-existing hole, found by review) | tested (`h4` fails on the old tracker); v1 records audited: no tool call touched git config/hooks | HARNESS_V2 §7 "Security fix" |
| Queue-held serving session (`models/serving/kserve-session.sh`) | tested with fake docker/nvidia-smi/curl (h35); **not run under the real queue** | `docs/ops/MODEL_OPERATIONS.md` |
| v1 retrieval query uses only SWE-bench wrapper words; Docker `run_shell` splits argv without quotes | characterized offline (`h32`); effect on v1 outcomes **unknown** | HARNESS_V2 §3A–B |

## Verified on 2026-11-08 (mini-swe-agent branch)

See the PR #15 description for the counts after the review fixes. One
unit-suite run earlier that day had a single failure that did not reproduce in
three later full runs (not identified).

## Verified on 2026-11-08 (foundation)

Local (Node v24.21.0, Bun 1.4.2, Python 3.12.3, Docker 29.1.3), branch
`feat/harness-v2-foundation`: harness unit **425/425**, lint, check, smoke;
Docker tier **partially** (h12 + h31, 13/13, real Docker and the official
SWE-bench image); the rest of the Docker tier was not run (it would pull
`python:3.12-slim`). Full-tier and CI results are per PR.

**Security fix (2026-11-08, `fix/patch-tracker-host-git`).** Patch capture ran
host `git` against the agent-writable workspace `.git`, so planted config,
hooks, fsmonitor, filters or an external diff could run host code, and the
test patch was written to a workspace path a planted symlink could redirect.
The tracker now uses a harness-owned git dir outside the workspace, hardened
git options, and stdin for `git apply` (tests h4, h13). Patches are
byte-identical to the previous capture. v1 records were audited read-only:
none of the 3,716 tool calls in the 200 main-campaign SWE-bench records
touched git config, hooks or `.git`; v1 results are unchanged. Local: unit
434/434, Docker tier 37/37 (no pulls), fixture QA 15/15.

## Verified on 2026-10-29

Local (Node v24.21.0, Python 3.12.3, Docker): harness unit **405/405**,
Docker tier **35/35**, lint, check, smoke, `benchmark:validate` (15, 0
warnings), `benchmark:qa` 15/15, evidence checksums (4 directories), evidence
guard. BFCL offline validation: official scorer gold **22/22**, invalid
**0/22** across 12 categories. SWE-bench offline validation: official
evaluator gold-via-agent-pipeline **resolved**, empty **empty_patch**, wrong
**unresolved**, malformed **error**. GitHub CI results per PR are listed in
`docs/MIGRATION.md`.

## Main comparison (2026-10-30)

| Model | BFCL correct / 1106 (95% CI) | SWE-bench stage 1 resolved / 50 (95% CI) |
|---|---|---|
| Kanana 2 30B-A3B Thinking | 888 = 80.3% [77.8, 82.5] | 0 = 0.0% [0.0, 7.1] |
| EXAONE 4.5 33B (thinking) | 881 = 79.7% [77.2, 81.9] | 1 = 2.0% [0.4, 10.5] |
| A.X 4.0 | 681 = 61.6% [58.7, 64.4] | 1 = 2.0% [0.4, 10.5] |
| Solar Open 2 (unofficial NVFP4, 8K) | 898 = 81.2% [78.8, 83.4] | 4 = 8.0% [3.1, 18.8] |

BFCL: A.X lower than each other model (Holm p < 0.0001), entirely from parallel-call
categories; the other three are not distinguishable. SWE-bench: no difference
is statistically supported. English benchmarks only. Full report and
limitations: `docs/research/FOUR_MODEL_COMPARISON.md`.

## Open items

1. **Korean condition undefined.** BFCL and SWE-bench are English; how a
   Korean variant is produced and reviewed is open (ADR 0003).
2. SWE-bench stage 2 not run (resources); a larger sample needs more image
   storage or rotation.
3. The escaping-symlink guard skips nested `.git` directories (Gate C minor;
   pre-existing, not shown exploitable).
4. **Serving under the shared GPU queue.** Proposed: `models/serving/kserve-session.sh`
   (foreground queue job; tested with fakes). Needs owner approval and a first
   supervised live use (`docs/ops/MODEL_OPERATIONS.md`).
5. The launchers' hub path is overridable (`KSERVE_HUB`, default unchanged);
   their cache paths and the hub path in `benchmarks/campaign/campaign.py` are
   still constants.
6. Harness v2 milestones 3–8 (`docs/ROADMAP.md`).

## Known limits

- Serving: one machine, shared; contended timings; models served one at a
  time. Quantization and sampling are `declared_only` in preflight; the
  checkpoint check is by snapshot directory name.
- Solar Open 2 is an unofficial NVFP4 quantization and is validated to 8K
  context; 1 of 100 SWE-bench subset instances is certainly infeasible for it,
  99 depend on the retrieved repository context.
- BFCL: subset scored with `--partial-eval` (not comparable to the public
  leaderboard); `memory`, `web_search`, `format_sensitivity`,
  `multi_turn_long_context`, `multi_turn_miss_*` not covered.
- SWE-bench: official images are `:latest` tags (digest recorded per run);
  results hold for upstage-cli `802cddd` under the frozen envelope (16K
  context, 30 turns), not for the models in isolation.
- An agent-mediated BFCL track is not built.
- SWE-bench Verified declares no dataset license, so its content is not
  committed.
- Synthetic fixtures remain AI-authored; they validate the harness only.
