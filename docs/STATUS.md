# Status

Snapshot as of **2026-10-30** (main comparison complete, SWE-bench stage 1). Update with
a new date whenever a claim below changes. Legend: **implemented** (code
exists) · **tested** (automated tests) · **verified** (exercised against the
real upstream tool or data) · **not executed** · **planned** · **unsupported**.

## Repository state

| Area | State | Evidence |
|---|---|---|
| Harness extracted from upstage-cli with history (41 commits) | verified | `docs/MIGRATION.md` |
| upstage-cli as pinned submodule `7380ef6` (harness removed upstream) | verified | ADR 0002 pin history; `h24` (incl. every imported name exported at the pin) |
| upstage-cli#12 closed unmerged; held-out candidates retired as disclosed | done | `docs/MIGRATION.md` "PR #12" |
| upstage-cli#13 (cleanup) and #14 (session-index fix) merged | done | upstage-cli `7380ef6`, `160292b` |
| Synthetic fixtures reduced to 15 rows / 12 families, all excluded from comparison | tested | ADR 0007; `h20`, `h25` |
| Run provenance: harness + upstage-cli commit/pin/dirty | tested | `h24` |
| Serving preflight (declared vs observed, fail closed) | tested against fakes; **not executed against a live server** | ADR 0008; `h26`, `h27` |
| Solar launcher by digest at 8192 | tested (`print-config`, fake docker); **not executed** | `models/serving/kserve-solar.sh`; `h27` |
| Evidence disclosure audit; CI guard | done | `docs/audits/2026-10-29-evidence-disclosure-audit.md`; `scripts/check-evidence.sh` |
| BFCL official pipeline | verified offline (official generate + evaluate, mock model) | ADR 0009; `results/bfcl-offline-validation-2026-10-29/` |
| SWE-bench Verified official scoring | verified offline on 1 instance (official evaluator, official image) | `results/swebench-offline-validation-2026-10-29/` |
| SWE-bench agent prediction pipeline | verified with a replay agent; tested (`h29`) | same |
| Context feasibility for the SWE-bench subset | computed (preregistered) | `datasets/swe-bench-verified/context-feasibility-v1.json` |
| Main comparison `main-2026-10-30-v1`: BFCL 1,106 × 4 models; SWE-bench Verified stage 1, 50 × 4 | **verified** (official scorers; `verify.py` 105/105; independent BFCL recomputation; Gate C) | `results/main-2026-10-30-v1/`, `docs/research/FOUR_MODEL_COMPARISON.md` |
| Protocol frozen (`main-v1`) and Amendment 1 (workspace symlinks, 104 cells re-run) | done | ADR 0011; `protocol/` |
| SWE-bench stage 2 (50 more instances) | **not executed** (resource decision: Docker storage) | `results/main-2026-10-30-v1/records/stage2-decision.json` |
| Live serving preflight | verified (REPORTABLE before every BFCL round and SWE-bench attempt) | campaign runtime records |

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
