# Experiment protocol

Status: **operational procedure** (2026-10-30). It covers how a run is
prepared, executed and recorded. *What* is run for the main comparison
(benchmarks, subsets, models, budgets, analysis) is frozen by ADR 0011 in
`protocol/main-v1.json`; where this document and the frozen protocol differ,
the frozen protocol governs.

Related: `harness/docs/BENCHMARK_V1_PROTOCOL.md` and
`BENCHMARK_V1_STATISTICS.md` define the protocol for the synthetic
benchmark-v1 *fixtures*; `harness/docs/LOCAL_MODELS.md` covers serving and
fairness in detail.

## 1. Kinds of run

| Kind | Data | Purpose | May be reported as a model comparison? |
|---|---|---|---|
| Unit / Docker tests | none (mock agent) | harness correctness | no |
| Fixture QA | synthetic-dev, reference solutions | evaluator and fixture validity | no |
| Pilot | synthetic-dev | model integration, feasibility | no — "pilot, not a benchmark" |
| Official-tool offline validation | external data, mock model / replayed patches | pipeline correctness | no — never a score |
| Main comparison | external, `mainComparison: admitted` | model comparison | yes, under the admitting ADR |

## 2. Before serving a model

1. **Machine is shared.** Check GPU memory over several samples
   (`nvidia-smi`). Do not start if foreign compute exceeds the launcher's
   allowance; the launchers refuse in that case — do not bypass the guard.
2. **One evaluation model at a time.** Stop and remove the previous
   `kserve-*` container (only containers this workstream created).
3. Start with the maintained launcher (`models/serving/`, ADR 0008), whose
   defaults match the harness config:
   - `models/serving/kserve.sh start <kanana|exaone|ax>` (16K)
   - `models/serving/kserve-solar.sh start` (8192, pinned digest). Never use
     the recorded original in `models/serving-records/` (defaults to 4096,
     starts by tag).
4. Wait for readiness (`kserve*.sh wait`).

## 3. Serving preflight (required)

`harness preflight --agent <model> --json` compares the declared
configuration with the live server, container and git state (ADR 0008).
Every field is `verified`, `declared_only`, `mismatch` or `unavailable`; a
mismatch or an unavailable critical field blocks the run. Reportable runs
use `harness run ... --preflight`, which refuses to start when blocked and
stores the result in `provenance.preflight` of each run record.

Still manual: set `GPU_CONTENDED=true|false` so the run records it, and keep
the preflight output with the run's records. Not covered by preflight:
sampling and quantization (`declared_only`), file-level checkpoint
integrity, free GPU memory at run time.

## 4. Running

- Identical envelope across models for a task: prompt, tool allowlist,
  `maxTurns`, wall-clock, context strategy, checks. Per-model differences
  allowed and recorded: output-token ceiling, sampling, chat-template
  kwargs (`LOCAL_MODELS.md`, "Common evaluation envelope and fairness").
- `exaone` and `exaone-nothink` are separate rows.
- Run records go directly to `results/<campaign>/` (`--runs-dir`), never only
  to a temp directory (ADR 0005).

## 5. Recording and reporting

- Keep the four dimensions separate: task-solving, agent/tool compatibility,
  inference performance, infrastructure reliability. Never collapse into one
  score.
- `status=error` (adapter/infra) is never counted as a task pass or fail.
- Task pass and clean completion (`stopReason: done`) are reported
  separately.
- Timings recorded under `gpuContended: true` are indicative only.
- Solar Open 2 is always labeled as the unofficial Nota NVFP4 quantization.
- A summary is written after its records are committed with `SHA256SUMS`,
  and it cites them.

## 6. External benchmarks

Run and score only as in `benchmarks/README.md` (ADR 0009): BFCL through
bfcl-eval's own generator and checker; SWE-bench predictions from the harness,
scored only by `swebench.harness.run_evaluation`. Use the frozen subset files;
never re-select after seeing results. Report BFCL per category and SWE-bench
resolve rate in separate tables, each with infeasible (context) and
infrastructure errors as their own columns; never drop infeasible instances
from the denominator.

## 7. Open items before a main comparison

Tracked in `docs/STATUS.md` ("Blockers"): upstage-cli context limits for the
local models, a live preflight, frozen envelopes and admission by ADR, the
statistical analysis, and the Korean condition.
