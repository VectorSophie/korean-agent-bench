# Research history

The dated record of how the harness and the model integration were built and
verified. These documents were written in upstage-cli and moved here with
their git history (`git log --follow harness/docs/<file>`); they are kept as
written, so read each as of its date. Where a later decision changes how one
should be read, that is noted below.

| Date (first → last change) | Document | What it records |
|---|---|---|
| 2026-04-27 → 2026-10-21 | [`HARNESS.md`](../../harness/docs/HARNESS.md) | Harness design and usage (Phases A–C onward); formerly upstage-cli's root `HARNESS.md` |
| 2026-10-26 → 2026-10-29 | [`LOCAL_MODELS.md`](../../harness/docs/LOCAL_MODELS.md) | Four-model integration, fairness envelope, readiness taxonomy, GPU safety |
| 2026-10-28 | [`T3_TRACE_EVALUATION.md`](../../harness/docs/T3_TRACE_EVALUATION.md) | Trusted trace evaluator for tool-result continuation |
| 2026-10-28 | [`PILOT_REPORT.md`](../../harness/docs/PILOT_REPORT.md) | Live 4x4 pilot, three runs. Raw records: [`results/pilot-2026-10/`](../../results/pilot-2026-10/) |
| 2026-10-29 | [`BENCHMARK_V1_PROTOCOL.md`](../../harness/docs/BENCHMARK_V1_PROTOCOL.md) | Benchmark-v1 protocol (draft) |
| 2026-10-29 | [`BENCHMARK_V1_SEMANTIC_AUDIT.md`](../../harness/docs/BENCHMARK_V1_SEMANTIC_AUDIT.md) | Semantic audit and evaluator-integrity fix |
| 2026-10-29 | [`BENCHMARK_V1_STATISTICS.md`](../../harness/docs/BENCHMARK_V1_STATISTICS.md) | Metrics and statistical protocol (draft) |
| 2026-10-29 | [`BENCHMARK_V1_TASK_QA.md`](../../harness/docs/BENCHMARK_V1_TASK_QA.md) | Task QA and dataset quality |

## Reading notes (2026-10-29)

- **Benchmark v1 is a development-fixture set.** The BENCHMARK_V1_* documents
  speak of "candidate tasks" and a future "frozen" set. Under ADR 0003, all
  benchmark-v1 rows are AI-authored and excluded from the main model
  comparison, whatever their review state; "candidate" there means fixture
  readiness.
- **Serving evidence** cited as `model-prep/...` is now versioned at
  `models/serving-records/` (ADR 0005).
- **Held-out material** described in upstage-cli PR #12 is treated as
  disclosed (ADR 0004).
