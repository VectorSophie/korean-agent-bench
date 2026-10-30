# Four-model comparison: BFCL and SWE-bench Verified (stage 1)

Campaign `main-2026-10-30-v1`, 2026-10-29 → 2026-10-30.
- **Protocol:** `protocol/main-v1.json` (sha256 `898410be…3c16`, ADR 0011), with Amendment 1 (`protocol/main-v1-amendment-1.json`, sha256 `ea0a7590…bfd39`).
- **Machine-readable results:** `results/main-2026-10-30-v1/` (summary, per-task CSV, verification, provenance, manifest).
- **Final audit:** `docs/audits/2026-10-30-gate-c-final.md`.

**Scope.** BFCL and SWE-bench are reported separately and never combined; no overall ranking is given.
- **Language:** both benchmarks are English, so nothing here measures Korean-language ability.
- **SWE-bench:** limited to stage 1, 50 instances per model (200 model–instance cells). Stage 2 was not run (§5).
- **Models**, as served (one server at a time, 2× RTX PRO 6000 Blackwell, shared machine):

| Model | Checkpoint (revision) | Size | Precision | Runtime | Context |
|---|---|---|---|---|---|
| Kanana 2 30B-A3B Thinking | `kakaocorp/kanana-2-30b-a3b-thinking-2601` (`cdcbf8b8`) | 30B total / 3B active (MoE) | bf16, TP1 | vLLM 0.32.0 | 16K |
| EXAONE 4.5 33B, thinking on | `LGAI-EXAONE/EXAONE-4.5-33B-FP8` (`69570ad5`) | 33B | fp8, TP1 | vLLM 0.32.0 | 16K |
| A.X 4.0 | `skt/A.X-4.0` (`a3393fd6`) | about 72B dense (143.8 GB bf16) | bf16, TP2 | vLLM 0.32.0 | 16K |
| Solar Open 2 | `nota-ai/Solar-Open2-250B-Nota-NVFP4` (`3cc67333`) | 250B | **unofficial** NVFP4, TP2 | Upstage vLLM fork 0.22.0 | **8K** |

Solar Open 2 is a separately constrained arm: half the context of the others, a much larger model, an unofficial quantization and a different runtime. None of its comparisons is like-for-like.

## 1. Verified measurements

### BFCL subset-v1
Official `bfcl evaluate --partial-eval`, `bfcl-eval` 2026.3.23, 1,106 entries over 14 categories, temperature 0.001, no `max_tokens`.

| Model | Correct / 1106 | Pooled accuracy | Wilson 95% CI | Context errors | Other errors | Truncated outputs |
|---|---|---|---|---|---|---|
| Kanana 2 | 888 | 80.3% | [77.8, 82.5] | 0 | 0 | 10 |
| EXAONE 4.5 | 881 | 79.7% | [77.2, 81.9] | 0 | 0 | 0 |
| A.X 4.0 | 681 | 61.6% | [58.7, 64.4] | 0 | 0 | 0 |
| Solar Open 2 (NVFP4, 8K) | 898 | 81.2% | [78.8, 83.4] | 20 (all `multi_turn_base`) | 0 | 33 |

Notes on the BFCL table:
- **Pooled accuracy** is unweighted over the scheduled entries. It is **not** BFCL's overall score and is not comparable to the public leaderboard.
- **Errors and retries:** the official checker counts context errors as incorrect. There were no infrastructure or configuration errors and no retries.
- **Sensitivity check:** counting caught errors and truncated outputs as wrong changes only Solar, from 81.2% to 80.7%. Five of its truncated entries were scored correct by the official checker.

Per category (official correct / n):

| Category | n | Kanana | EXAONE | A.X | Solar |
|---|---|---|---|---|---|
| simple_python | 100 | 94 | 92 | 96 | 93 |
| simple_java | 100 | 66 | 64 | 66 | 63 |
| simple_javascript | 50 | 26 | 32 | 28 | 31 |
| multiple | 100 | 96 | 96 | 96 | 99 |
| parallel | 100 | 92 | 94 | **0** | 92 |
| parallel_multiple | 100 | 90 | 82 | **1** | 86 |
| irrelevance | 100 | 85 | 70 | 89 | 87 |
| live_simple | 100 | 88 | 93 | 85 | 93 |
| live_multiple | 100 | 81 | 79 | 73 | 80 |
| live_parallel | 16 | 10 | 12 | **0** | 14 |
| live_parallel_multiple | 24 | 18 | 17 | **0** | 17 |
| live_irrelevance | 100 | 85 | 77 | 88 | 81 |
| live_relevance | 16 | 10 | 14 | 9 | 12 |
| multi_turn_base | 100 | 47 | 59 | 50 | 50 |

Exploratory split, not part of the frozen analysis:

| Model | Four parallel categories (240) | All other categories (866) |
|---|---|---|
| Kanana | 210 (87.5%) | 678 (78.3%) |
| EXAONE | 205 (85.4%) | 676 (78.1%) |
| A.X | 1 (0.4%) | 680 (78.5%) |
| Solar | 209 (87.1%) | 689 (79.6%) |

### SWE-bench Verified, stage 1
- **Data and scorer:** dataset revision `78f471bf`; official `swebench==5.0.2` `run_evaluation`.
- **Agent:** upstage-cli `802cddd` driven by the harness.
- **Envelope:** 30 turns, 60 tool calls, 2,700 s, English prompt. The input budget per request is 7,372 tokens for the 16K models and 3,686 for Solar (exact server-side counting).
- **Denominator:** every rate is over all 50 scheduled instances, with no exclusions.

| Model | Resolved / 50 | Resolve rate | Wilson 95% CI | Repo-cluster 95% CI | Unresolved | Empty patch | Invalid (error) | Context-exhausted | Budget-exhausted | Infra errors | Missing |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Kanana 2 | 0 | 0.0% | [0.0, 7.1] | degenerate | 17 | 33 | 0 | 0 | 0 | 0 | 0 |
| EXAONE 4.5 | 1 | 2.0% | [0.4, 10.5] | [0.0, 10.0] | 0 | 49 | 0 | 0 | 46 | 0 | 0 |
| A.X 4.0 | 1 | 2.0% | [0.4, 10.5] | [0.0, 10.7] | 18 | 31 | 0 | 1 | 10 | 0 | 0 |
| Solar Open 2 (NVFP4, 8K) | 4 | 8.0% | [3.1, 18.8] | [0.0, 17.4] | 2 | 44 | 0 | 2 | 41 | 0 | 0 |

**Coverage.** Each model has 50 valid attempts: 24 carried from the original frozen-code run, plus the 26 Amendment 1 re-runs.

**Resolved instances.** Every resolved patch is a single-file source edit with all FAIL_TO_PASS tests passing and no PASS_TO_PASS failure.
- EXAONE: `pytest-dev__pytest-5631`
- A.X: `pallets__flask-5014`
- Solar: `django__django-16429`, `django__django-16612`, `pallets__flask-5014`, `pytest-dev__pytest-5631`

The flask and pytest instances were also solved by another model.

### Behaviour and cost (descriptive)

| | Kanana | EXAONE | A.X | Solar |
|---|---|---|---|---|
| SWE agent stop: completed / output-truncated / budget / context / tool-error | 13 / 37 / 0 / 0 / 0 | 4 / 0 / 46 / 0 / 0 | 33 / 4 / 10 / 1 / 2 | 0 / 7 / 41 / 2 / 0 |
| SWE median tool calls per episode | 5 | 30 | 8.5 | 30 |
| SWE tool-error rate (recoverable) | 22.4% | 1.6% | 14.2% | 3.9% |
| SWE median episode wall-clock | 190 s | 150 s | 286 s | 74 s |
| SWE prompt / completion tokens (50 episodes) | 1.11M / 0.74M | 5.65M / 0.26M | 2.58M / 0.28M | 3.23M / 0.13M |
| BFCL generate wall-clock | 2,558 s | 2,426 s | 1,566 s | 2,160 s |
| BFCL median output tokens per response | 364 | 236 | 43 | 226 |
| Model-server occupancy: BFCL + SWE stage 1 (incl. re-runs) | 0.74 + 1.22 h | 0.73 + 1.22 h | 0.50 + 2.34 h | 0.66 + 0.60 h |

Total model-server occupancy was **8.0 h** of the 36 h ceiling. That includes the original stage-1 sessions, whose 26 symlink cells per model were invalidated. Wall-clock figures come from a shared machine and are contended.

## 2. Statistical interpretation

**BFCL (confirmatory: pooled accuracy, exact McNemar with Holm over 6 pairs).**
- A.X is lower than each of the other three models, by 18.1–19.6 points (Holm p < 0.0001 for all three).
- Kanana, EXAONE and Solar are not distinguishable:

| Pair | Difference | Paired 95% CI | Holm p |
|---|---|---|---|
| Kanana − EXAONE | +0.6 | [−1.5, 2.7] | 0.83 |
| Kanana − Solar | −0.9 | [−2.9, 1.1] | 0.83 |
| EXAONE − Solar | −1.5 | [−3.4, 0.3] | 0.36 |

- The A.X result is driven by one behaviour: it scored 1/240 on the parallel-call categories and 680/866 elsewhere (the other models: 676–689). It did not issue parallel calls under this serving configuration. It emitted exactly one tool call on 1,438 responses and more than one on 6. In the pilot, a raw completion confirmed the model itself emits a single call; the parser is not dropping calls. Whether a different chat template or system prompt would change this was not tested.

**SWE-bench stage 1 (exploratory).**
- No difference between models is statistically supported. Every Holm-adjusted p ≥ 0.75 and every repository-cluster CI includes 0.
- All four models resolve ≤ 8% of instances under this envelope.
- Solar's 4/50 rests on two instances only it solved. The sample is 46% django (23/50).

## 3. Plausible but unverified explanations

- **Kanana:** 37/50 episodes ended `output_truncated`; the thinking trace filled the 8,192-token output cap, often within a few turns. Its SWE result most likely reflects the thinking budget against the output cap, not code-editing ability. Not tested with another cap (the protocol is frozen).
- **EXAONE:** 46/50 episodes used all 30 turns, with 49/50 empty patches: it explored, at about 30 tool calls per episode, without editing. A larger step budget might change this. Not tested.
- **A.X:** finished most episodes cleanly (33/50) and often produced patches (18 unresolved, 1 resolved), sometimes with scratch files.
- **Solar:** worked under continual compaction (3,686-token input budget) and still produced small correct patches on 4 instances.

**Why BFCL and SWE-bench disagree.** BFCL measures single function-calling decisions. SWE-bench here measures each model as the engine of one agent harness under a tight context and output envelope. The SWE results are dominated by how each model interacts with the envelope (truncation, step budget, compaction), so they say little about relative coding ability.

## 4. Amendment 1: the symlink incident

**Defect.** In stage 1, the official evaluator classified exactly the 26 instances whose repository contains symlinks as `error` (Patch Apply Failed), identically for all four models.
- **Cause:** the task runner copied workspaces with Node's `cpSync` default. That rewrites relative symlinks to absolute paths, which the escaping-symlink guard (correctly) removed before the agent's first turn.
- **Why the patches failed:** every patch carried spurious symlink deletions.
- **Why validation missed it:** the pilots (psf/requests, no symlinks) and the replay-agent offline validation (no tool registry, so the guard never ran) could not show it.

**Fix and re-run** (PR #12, ADR 0011 Amendment 1):
- The fix is `verbatimSymlinks`, with a regression test.
- All 104 cells (26 instances × 4 models) were invalidated by an instance property (has a symlink), never by results, and each was re-run once on the amended code. Model settings, envelope, prompt, subset and scoring were unchanged.
- The original attempts and evaluator logs are kept, not deleted.

**Validation.**
- **Before the re-runs:** end to end on real django-11119 and matplotlib-25287, links were preserved, the guard removed nothing, and the official evaluator applied both patches (`records/amendment1-validation.json`).
- **After the re-runs:** 0 `error` outcomes, 0 Patch Apply Failed, and no symlink hunks in any of the 200 final predictions.
- **Provenance checks** (`verify.py`):
  - all 24 carried cells per model ran on the frozen code (`a48b0b8`);
  - all 26 re-runs per model ran on the amended code (`f212414`);
  - none of the carried instances contains a symlink.
- **Reused evaluations:** for carried instances, the official evaluator reused the earlier per-instance reports. The Gate C reviewer confirmed that each reused patch equals the final prediction.

## 5. Stage 2 resource decision

Stage 2 (the other 50 instances) was not run.
- **Who and when:** the project owner decided this explicitly, on resource grounds, as ADR 0011 decision 5 permits. It was decided after the original stage-1 results were known (Gate C).
- **Evidence** (`records/stage2-decision.json`): the Docker image budget is +100 GB over the 165.1 GB baseline.
  - The main image pull stopped at +102.2 GB. The guard checks after each pull, which explains the 2.2 GB overshoot.
  - A probe of 8 stage-2 images added 41.5 GB of deduplicated storage.
  - The 26 amendment re-run images were also needed, and both sets could not fit.

## 6. Verification and audits

- **`verify.py`:** 105/105 checks pass. They cover:
  - protocol and amendment hashes;
  - code trees per run and carried vs. re-run cells;
  - per-model coverage and official reports;
  - numerators and denominators;
  - retries and preflights.
- **Independent BFCL recomputation:** done from the official score files, without `analyze.py` (`records/bfcl_independent.py`). It gives identical counts, CIs and McNemar/Holm values.
- **Raw records:** checksummed in `records/raw-records.sha256`. They stay local because they contain SWE-bench issue text and model transcripts.
- **Gate C** (independent adversarial review): no blocker. Its four material findings are all about interpretation and are reflected above.

## 7. Limitations

- **Sample size:** SWE-bench stage 1 has n = 50 and is django-heavy. Resolve rates are near zero, so it cannot rank the models.
- **Envelope:** SWE-bench results hold only for this agent harness (upstage-cli `802cddd`) and envelope: 16K context, 8K/4K output caps, 30 turns. They are not intrinsic coding ability.
- **Solar Open 2:** unofficial NVFP4 weights on a different runtime, 8K context, and a much larger model. It is not representative of official Solar weights.
- **BFCL scope:** partial evaluation of a 1,106-entry subset, not the public leaderboard; temperature 0.001 for all models (not vendor sampling).
- **Determinism:** one attempt per task; no seed control on the served models.
- **Contamination:** both benchmarks are public and could be in any model's training data.
- **Hardware:** shared GPUs, so timing figures are contended.
- **Language:** English only. **No Korean-language claim follows from these results.**
