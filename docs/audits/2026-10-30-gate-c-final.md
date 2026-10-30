# Critique Gate C — final adversarial audit (2026-10-30)

Campaign `main-2026-10-30-v1`: BFCL subset-v1 (1,106 entries) and SWE-bench
Verified stage 1 (50 instances), four models, protocol `main-v1`
(sha256 `898410be…3c16`) with Amendment 1 (sha256 `ea0a7590…bfd39`).

An independent reviewer (a separate read-only agent instructed to find reasons
the conclusions could be wrong) inspected code, raw campaign records, official
evaluator outputs and the analysis. Each finding below was checked here before
acting on it. **Outcome: no blocker; 4 material findings, all about
interpretation and reporting, all adopted in the final report; no result was
changed or excluded.**

## Material (adopted in the report)

| # | Finding | Check here | Resolution |
|---|---|---|---|
| M1 | SWE-bench numbers describe this agent envelope, not coding ability, and all four models are context-constrained, not only Solar. Input budget 7,372 tokens for the 16K models and 3,686 for Solar. Kanana stopped `output_truncated` 37/50 (thinking reaches the 8,192-token output cap). EXAONE stopped `budget_exhausted` 46/50 with 49/50 empty patches. Solar finished cleanly 0/50. | confirmed (`contextFit`, `summary.json`) | The headline states the envelope; all four models are described as constrained |
| M2 | Solar Open 2 is a 250B model, served as an unofficial NVFP4 quantization on a different runtime. The others are Kanana 30B-A3B (MoE), EXAONE 33B (FP8) and A.X 4.0 (about 72B dense, bf16; 143.8 GB of bf16 weights). Rankings without this context mislead. | confirmed (protocol, checkpoint index) | Size and serving stack stated next to every comparison |
| M3 | A.X's entire BFCL deficit comes from the four parallel categories: 1/240 on parallel categories, 680/866 elsewhere (others 676–689/866). A.X emits exactly one tool call on 1,438 turns and more than one on 6. The reviewer wrote 340/766; the categories hold 100 + 100 + 16 + 24 = **240** entries, corrected here. | confirmed (official score files, `kab-diagnostics.jsonl`) | Per-category table and an exploratory non-parallel split published. Wording: "A.X 4.0 did not issue parallel calls under this serving configuration", not "weaker at function calling" |
| M4 | No SWE-bench ordering is supported. Every Holm-adjusted p ≥ 0.75 and every repo-cluster lower bound is 0. Two of Solar's 4 resolves (flask-5014, pytest-5631) were also solved by another model; 23/50 instances are django. | confirmed (`summary.json` pairwise) | Report says all models resolve ≤ 8% with no significant difference |

## Minor

- Kanana's repository-cluster CI is degenerate ([0, 0], no resolved instance). It is flagged in Table B.
- Evaluations of carried instances were reused from the pre-amendment evaluator run (the evaluator skips instances that already have a report). The reviewer confirmed that each reused `patch.diff` equals the prediction. Disclosed.
- "A.X `maxOutputTokens` 4096 vs reservation 8192 is inconsistent": **not a defect**. Since Gate B (ADR 0011), the reservation is 8,192 for every 16K model so their input budgets are equal; A.X's validated output cap stays 4,096.
- Two resolved patches look odd but are valid source edits: A.X flask-5014 repeats a guard three times, and EXAONE pytest-5631 has a stray trailing comma. A.X patches often include scratch files (`*.patch`, `test_*.py`); none of those instances resolved.
- The escaping-symlink guard skips directories named `.git` at any depth. This predates the campaign and was not changed by Amendment 1. In-process file tools still check real paths, and the container sees only its mount. Recorded for follow-up; not exploitable as far as the reviewer could determine.

## Limitations (stated in the report)

- **Stage 2 timing:** stage 2 was not run. The project owner decided this on Docker-storage evidence (`records/stage2-decision.json`), after the original stage-1 results had been seen.
- **Shared GPUs:** latency and wall-clock figures are contended.
- **Solar weights:** unofficial NVFP4 quantization; results may not represent official Solar weights.
- **Contamination:** public data; possible for every model. The instances solved by several models are well-known easy ones.
- **Language:** English-only prompts and benchmarks; no claim about Korean-language ability follows.
- **Solar BFCL errors:** its 20 BFCL context errors (all `multi_turn_base`) count as wrong. Of its 33 truncated entries, 5 were scored correct by the official checker. This explains the sensitivity figure (81.2% → 80.7%). Solar stays first or tied either way.

## Not reproduced (checked and clean)

1. **Symlink scope.** Exactly the 26 invalidated stage-1 instances contain symlinks (django 4 links each, matplotlib 8 each); the 24 carried instances contain none. Before the fix, all 104 invalidated evaluations, and no others, failed with "Patch Apply Failed". No final prediction contains a mode-120000 or symlink-deletion hunk.
2. **Carried-code equivalence.** Commits `a48b0b8` (frozen) and `f212414` (amended) differ only in `runner.mjs` (`verbatimSymlinks`, which affects symlinks only), campaign tooling, verifier, tests and docs. All carried attempts ran on `a48b0b8` and all re-runs on `f212414`, each with a clean tree. `verify.py` confirms this from provenance.
3. **Re-run selection.** The criterion (git mode 120000 in the instance's tree) is structural and identical for every model; it cannot depend on results.
4. **Security boundary.** Links that resolve outside the workspace are still removed. No stage-1 or stage-2 snapshot has an escaping or dangling link. The Amendment 1 validation on real django and matplotlib instances removed 0 links, and the official evaluator applied both patches.
5. **The six resolved results.** All are genuine single-file source edits with no test changes. All FAIL_TO_PASS tests pass and no PASS_TO_PASS test fails. The `resolved_ids` match the summary.
6. **Infrastructure vs model labels.** 0 infrastructure errors, 0 retries, no quarantine file. BFCL `errorsByClass` contains only Solar's 20 context errors. A.X's 2 `tool_error` stops were model tool loops.
7. **Statistics recomputed.** Wilson CIs (4/50, 1/50, 888/1106), exact McNemar p values and Holm-adjusted values all equal `summary.json`.
8. **Arithmetic.** CSV, summary, official score files and official reports agree. BFCL correct counts are 888 / 881 / 681 / 898; SWE-bench resolved counts are 0 / 1 / 1 / 4; empty patches are 33 / 49 / 31 / 44.

## Verification

`verify.py`: **105/105** checks passed. Independently of `analyze.py`, BFCL was recomputed from the official score files (`records/bfcl_independent.py`), with an identical result.
