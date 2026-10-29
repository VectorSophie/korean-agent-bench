# Raw records — four-model live pilot (2026-10-26 to 2026-10-28)

The harness run records behind [`harness/docs/PILOT_REPORT.md`](../../harness/docs/PILOT_REPORT.md).
They were never committed upstream; they survived only in a temporary
scratchpad of the session that ran the pilot and were copied here unmodified
on 2026-10-29 (`sha256sum -c SHA256SUMS` from this directory; verified against
the source at copy time). Scanned for credentials and held-out references
before copying: none.

**This is not a benchmark result.** One attempt per model and task, on
AI-authored pilot fixtures (`harness-pilot-tasks` in
[`datasets/registry.json`](../../datasets/registry.json), main comparison
excluded), with GPU timings recorded as contended.

| Directory | Report section | Records | Notes |
|---|---|---|---|
| `run1-pilot/` | Run 1 — original pilot | 18 | 4 models x T1-T4 (16), plus the 2026-10-26 Kanana and EXAONE T1 integration runs. T3 here is the leaky v1 fixture; Kanana T3 `fail`. |
| `run2-t3v2/` | Run 2 — revised T3 | 5 | One per model, plus Solar's first attempt: `error` / `agent_adapter_error` (served at 4096 context; see "Solar context-budget finding"), then the passing re-run at 8192. |
| `run3-t3v3/` | Run 3 — T3-v3 under Docker | 4 | EXAONE `fail` (`required_check_failed`, read `out.txt` before writing it). |

Each record carries `provenance.model` (checkpoint revision, image digest,
parsers, sampling, `gpuContended`) as written by the harness at the time.
