# main-2026-10-30-v1 — results

Protocol `protocol/main-v1.json` sha256 `898410beb3a59af55ee551d371e7e0ec5087f10b0a2b4e9f0dd78c3030eb3c16` (ADR 0011). Independent recomputation: 105/105 checks passed (`verification.json`).

Protocol amendments applied: `protocol/main-v1-amendment-1.json` (sha256 `ea0a759031a7…`, 104 cells re-run).

BFCL and SWE-bench are reported separately and never combined. Both are English benchmarks; nothing here measures Korean-language ability. Solar Open 2 is a separately constrained arm (8K context, unofficial quantization, different runtime).

## Table A — BFCL subset-v1 (official `bfcl evaluate --partial-eval`)

Pooled accuracy over the scheduled entries (unweighted; not BFCL's overall score), Wilson 95% CI. Sensitivity: caught inference errors and truncated outputs counted wrong.

| Model | Correct | Accuracy | 95% CI | Sensitivity | Errors | Truncated | Median latency s |
|---|---|---|---|---|---|---|---|
| Kanana 2 30B-A3B Thinking | 888/1106 | 80.3% | [77.8, 82.5] | 80.3% | 0 | 10 | 6.48 |
| EXAONE 4.5 33B (thinking) | 881/1106 | 79.7% | [77.2, 81.9] | 79.7% | 0 | 0 | 7.39 |
| A.X 4.0 | 681/1106 | 61.6% | [58.7, 64.4] | 61.6% | 0 | 0 | 3.78 |
| Solar Open 2 (8K arm, unofficial NVFP4) | 898/1106 | 81.2% | [78.8, 83.4] | 80.7% | 20 | 33 | 5.96 |

Per category (exploratory; n < 30 descriptive only):

| Category | n | kanana | exaone | ax | solar-open2 |
|---|---|---|---|---|---|
| simple_python | 100 | 94.0% | 92.0% | 96.0% | 93.0% |
| simple_java | 100 | 66.0% | 64.0% | 66.0% | 63.0% |
| simple_javascript | 50 | 52.0% | 64.0% | 56.0% | 62.0% |
| multiple | 100 | 96.0% | 96.0% | 96.0% | 99.0% |
| parallel | 100 | 92.0% | 94.0% | 0.0% | 92.0% |
| parallel_multiple | 100 | 90.0% | 82.0% | 1.0% | 86.0% |
| irrelevance | 100 | 85.0% | 70.0% | 89.0% | 87.0% |
| live_simple | 100 | 88.0% | 93.0% | 85.0% | 93.0% |
| live_multiple | 100 | 81.0% | 79.0% | 73.0% | 80.0% |
| live_parallel | 16 | 62.5% | 75.0% | 0.0% | 87.5% |
| live_parallel_multiple | 24 | 75.0% | 70.8% | 0.0% | 70.8% |
| live_irrelevance | 100 | 85.0% | 77.0% | 88.0% | 81.0% |
| live_relevance | 16 | 62.5% | 87.5% | 56.2% | 75.0% |
| multi_turn_base | 100 | 47.0% | 59.0% | 50.0% | 50.0% |

## Table B — SWE-bench Verified subset-v1, stage 1 (official `swebench.harness.run_evaluation`)

Resolve rate over the scheduled instances; Wilson and repository-cluster bootstrap 95% CIs. Exploratory (ADR 0011).

| Model | Resolved | Rate | Wilson 95% CI | Repo-cluster 95% CI | Official outcomes | Agent stop reasons |
|---|---|---|---|---|---|---|
| Kanana 2 30B-A3B Thinking | 0/50 | 0.0% | [0.0, 7.1] | [0.0, 0.0] (degenerate: no resolved instance) | empty_patch 33, unresolved 17 | completed 13, output_truncated 37 |
| EXAONE 4.5 33B (thinking) | 1/50 | 2.0% | [0.4, 10.5] | [0.0, 10.0] | empty_patch 49, resolved 1 | budget_exhausted 46, completed 4 |
| A.X 4.0 | 1/50 | 2.0% | [0.4, 10.5] | [0.0, 10.7] | empty_patch 31, resolved 1, unresolved 18 | budget_exhausted 10, completed 33, context_exhausted 1, output_truncated 4, tool_error 2 |
| Solar Open 2 (8K arm, unofficial NVFP4) | 4/50 | 8.0% | [3.1, 18.8] | [0.0, 17.4] | empty_patch 44, resolved 4, unresolved 2 | budget_exhausted 41, context_exhausted 2, output_truncated 7 |

## Table C — behaviour and efficiency (descriptive)

| Model | BFCL generate s | BFCL median output tokens | SWE clean completion | SWE budget exhausted | SWE context exhausted | SWE median tool calls | SWE tool-error rate | SWE median episode s |
|---|---|---|---|---|---|---|---|---|
| Kanana 2 30B-A3B Thinking | 2558 | 364 | 26.0% | 0 | 0 | 5.0 | 22.4% | 190.1 |
| EXAONE 4.5 33B (thinking) | 2426 | 236 | 8.0% | 46 | 0 | 30.0 | 1.6% | 150.4 |
| A.X 4.0 | 1566 | 43 | 66.0% | 10 | 1 | 8.5 | 14.2% | 286.2 |
| Solar Open 2 (8K arm, unofficial NVFP4) | 2160 | 226 | 0.0% | 41 | 2 | 30.0 | 3.9% | 74.3 |

## Table D — pairwise comparisons (same tasks, paired)

BFCL pooled accuracy: **confirmatory** — exact McNemar, Holm-adjusted over the 6 pairs, α = 0.05 (* = significant). Difference CI: paired bootstrap. Discordant = tasks only A / only B got right.

| Pair (A − B) | n | A | B | Diff (pp) | Diff 95% CI | Discordant | McNemar p | Holm p |
|---|---|---|---|---|---|---|---|---|
| kanana − exaone | 1106 | 80.3% | 79.7% | +0.6 | [-1.5, 2.7] | 74/67 | 0.6135 | 0.8306 |
| kanana − ax | 1106 | 80.3% | 61.6% | +18.7 | [15.7, 21.8] | 275/68 | <0.0001 | <0.0001 * |
| kanana − solar-open2 | 1106 | 80.3% | 81.2% | -0.9 | [-2.9, 1.1] | 56/66 | 0.4153 | 0.8306 |
| exaone − ax | 1106 | 79.7% | 61.6% | +18.1 | [15.0, 21.2] | 277/77 | <0.0001 | <0.0001 * |
| exaone − solar-open2 | 1106 | 79.7% | 81.2% | -1.5 | [-3.4, 0.3] | 45/62 | 0.1215 | 0.3645 |
| ax − solar-open2 | 1106 | 61.6% | 81.2% | -19.6 | [-22.6, -16.6] | 62/279 | <0.0001 | <0.0001 * |

SWE-bench resolve rate: **exploratory** (descriptive; p-values not used for claims).

| Pair (A − B) | n | A | B | Diff (pp) | Diff 95% CI | Discordant | McNemar p | Holm p |
|---|---|---|---|---|---|---|---|---|
| kanana − exaone | 50 | 0.0% | 2.0% | -2.0 | [-10.0, 0.0] | 0/1 | 1 | 1 |
| kanana − ax | 50 | 0.0% | 2.0% | -2.0 | [-10.7, 0.0] | 0/1 | 1 | 1 |
| kanana − solar-open2 | 50 | 0.0% | 8.0% | -8.0 | [-17.4, 0.0] | 0/4 | 0.125 | 0.75 |
| exaone − ax | 50 | 2.0% | 2.0% | +0.0 | [-8.3, 7.7] | 1/1 | 1 | 1 |
| exaone − solar-open2 | 50 | 2.0% | 8.0% | -6.0 | [-12.2, 0.0] | 0/3 | 0.25 | 1 |
| ax − solar-open2 | 50 | 2.0% | 8.0% | -6.0 | [-11.1, 0.0] | 0/3 | 0.25 | 1 |
