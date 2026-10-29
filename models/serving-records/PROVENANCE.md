# Provenance — model serving records

These files are a verbatim copy of `/home/jackb/workspace/model-prep` taken on
**2026-10-29** during the migration (ADR 0005). That directory is **not under
version control**, so this copy is the first versioned record of it. Nothing
here was edited; `__pycache__/` was the only thing left out.

- Integrity: `sha256sum -c SHA256SUMS` (run in this directory). At copy time the
  same manifest also verified against the source directory.
- Git does not keep file timestamps. The source mtimes below are the only
  evidence of *when* each record was last written; they are recorded here, not
  inferred.
- These records describe one machine (2x RTX PRO 6000 Blackwell Max-Q, 96 GB
  each). Absolute paths inside them (`/data/jackb/...`) are that machine's
  layout, not a requirement.

## Superseded statements

The records were written over a week and some early statements were later
resolved. When two records disagree, the later one wins:

| Statement | Where | Superseded by |
|---|---|---|
| Solar Open 2: "sm_120 NVFP4-MoE kernel confirmation pending", "TP2 unverified" (`blocking_issues`) | `models-manifest.json` (2026-10-26 15:50) | `serving-readiness.json` (2026-10-28): NVFP4-MoE runs via FLASHINFER_CUTLASS, TP2 shards clean, `serving_ready` 2026-10-26 |
| "harness integration NOT yet validated" (all four models) | `models-manifest.json`, `serving-readiness.json` notes | `harness/docs/PILOT_REPORT.md` (live 4x4 pilot through the harness); `benchmark_ready` is still **not** claimed |

## Source file mtimes (local time, +0900)

| File | Last modified | Size (bytes) |
|---|---|---|
| `download_queue.sh` | 2026-10-21 20:34 | 3888 |
| `download-report.md` | 2026-10-21 20:59 | 8061 |
| `download_solar.sh` | 2026-10-23 16:54 | 4097 |
| `download-status.json` | 2026-10-24 17:23 | 1117 |
| `generate_manifest.py` | 2026-10-21 20:57 | 14537 |
| `isolated-serving.md` | 2026-10-23 16:58 | 10373 |
| `kserve.sh` | 2026-10-23 14:19 | 5736 |
| `kserve-solar.sh` | 2026-10-26 15:36 | 5437 |
| `models-manifest.json` | 2026-10-26 15:50 | 22621 |
| `parser_regression_test.py` | 2026-10-23 16:27 | 4460 |
| `probe_models.py` | 2026-10-21 20:29 | 3724 |
| `probe_raw.json` | 2026-10-21 20:29 | 2499134 |
| `results/ax.json` | 2026-10-23 14:44 | 2173 |
| `results/exaone.json` | 2026-10-23 14:34 | 1411 |
| `results/exaone_reasoning.json` | 2026-10-23 16:41 | 5739 |
| `results/kanana.json` | 2026-10-23 14:22 | 1727 |
| `results/kanana_reasoning_FINAL.json` | 2026-10-23 16:36 | 3454 |
| `results/kanana_reasoning.json` | 2026-10-23 16:36 | 3454 |
| `serving-notes.md` | 2026-10-26 15:52 | 12250 |
| `serving-readiness.json` | 2026-10-28 17:30 | 17368 |
| `smoke_test.py` | 2026-10-23 16:55 | 16446 |
| `smoke-test-results.md` | 2026-10-26 15:51 | 18680 |
| `solar-open2-assessment.md` | 2026-10-26 15:49 | 14346 |
