# Experiment protocol

Status: **draft, not frozen** (2026-10-29). It covers how a run is prepared,
executed and recorded. *What* is run for the main comparison (benchmarks,
subsets, budgets) is decided by a future ADR under ADR 0003; until then only
development fixtures and pilots are run.

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
| Main comparison | external, `mainComparison: admitted` | model comparison | yes, under the admitting ADR |

## 2. Before serving a model

1. **Machine is shared.** Check GPU memory over several samples
   (`nvidia-smi`). Do not start if foreign compute exceeds the launcher's
   allowance; the launchers refuse in that case — do not bypass the guard.
2. **One evaluation model at a time.** Stop and remove the previous
   `kserve-*` container (only containers this workstream created).
3. Start with the recorded launcher and **the context the harness config
   pins**:
   - `models/serving-records/kserve.sh start <kanana|exaone|ax>` (16K)
   - `models/serving-records/kserve-solar.sh start 8192` — the default 4096
     is wrong for the harness (pilot "Solar context-budget finding").
4. Wait for readiness (`kserve*.sh wait`).

## 3. Pre-run checks (operator; not yet automated)

The harness records serving configuration *as declared* in
`local-models.mjs`, not as observed (`docs/models/README.md`). Before a run,
confirm and write down:

- `GET /v1/models` → served model name and `max_model_len` match the card.
- `docker inspect <container> --format '{{.Image}}'` → image digest matches
  the card.
- The `vendor/upstage-cli` checkout matches its pin
  (`git submodule status` shows no `+`), and the harness tree is clean. Every
  run records this as `provenance.harness.upstageCli.matchesPin` / `.dirty`
  and `provenance.harness.dirty`; a run with either mismatch is not a
  reportable run.
- `GPU_CONTENDED=true|false` is set so the run records it.

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

## 6. Open items before a main comparison

Tracked in `docs/STATUS.md`. In short: choose external benchmarks and fixed
subsets (ADR), integrate them with their upstream evaluators, automate the
section 3 checks, decide repetitions/seeds and the statistical analysis, and
decide how infeasible items (context limits) are reported.
