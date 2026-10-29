# Models

Four Korean models, served locally on one machine and driven through the same
harness agent loop (`harness/src/agent/adapters/local.mjs`). Snapshot as of
**2026-10-29**.

| Card | Harness agent id | Checkpoint (HF) | Revision | Precision | TP | Official weights? |
|---|---|---|---|---|---|---|
| [Kanana 2](kanana-2.md) | `kanana` | `kakaocorp/kanana-2-30b-a3b-thinking-2601` | `cdcbf8b8…0844` | BF16 | 1 | yes |
| [EXAONE 4.5](exaone-4.5.md) | `exaone`, `exaone-nothink` | `LGAI-EXAONE/EXAONE-4.5-33B-FP8` | `69570ad5…47be` | FP8 (vendor release) | 1 | yes |
| [A.X 4.0](ax-4.0.md) | `ax` | `skt/A.X-4.0` | `a3393fd6…7b67` | BF16 | 2 | yes |
| [Solar Open 2](solar-open2.md) | `solar-open2` | `nota-ai/Solar-Open2-250B-Nota-NVFP4` | `3cc67333…6a64` | NVFP4 W4A4 | 2 | **no — third-party quantization** |

Full revisions are in each card and in `harness/src/agent/local-models.mjs`.

## Sources

Every value in these cards comes from one of:

- `harness/src/agent/local-models.mjs` — the configuration the harness sends
  and records in each run's `provenance.model`;
- `models/serving-records/` — the serving validation records (launchers,
  manifest, smoke tests), copied with checksums from the unversioned
  `model-prep` directory (ADR 0005; see its `PROVENANCE.md`);
- `results/pilot-2026-10/` and `harness/docs/PILOT_REPORT.md` — the live pilot.

Where a value is an observation rather than configuration, the card says
when and how it was observed.

## Reference machine

2x NVIDIA RTX PRO 6000 Blackwell Max-Q (96 GB each, SM120), PCIe without
NVLink, driver 610.57.04 (`models/serving-records/models-manifest.json`).
The machine is shared with other long-running work; every measurement in
these cards was taken under that condition and is tagged `contended`.

## Readiness vocabulary

Defined in `harness/docs/LOCAL_MODELS.md`: `serving_ready` (serves and passes
serving smoke tests), `harness_integrated` (runs end-to-end through the
harness), `benchmark_ready` (executes and is evaluated on real tasks at the
intended scale, reproducibly). As of 2026-10-29 all four are
`serving_ready` and `harness_integrated` (live pilot); **none is
`benchmark_ready`**.

## Limitations shared by all four

- **Serving provenance is now checked, but not yet against a live server.**
  Run records copy model configuration from `local-models.mjs`. Since
  2026-10-29 `harness preflight` / `harness run --preflight` compare it with
  the live server and container and block a run on any mismatch (ADR 0008).
  The pilot records predate this; one of them claims `contextLimit: 8192`
  for a server launched at 4096. Quantization and sampling remain
  `declared_only`, and the checkpoint check covers the snapshot directory
  name, not file contents.
- **One server at a time.** Kanana, EXAONE and A.X share port 8101 and are
  served one at a time; A.X and Solar each need both GPUs. Comparisons are
  sequential, not simultaneous.
- **Timings are contended** and indicative only.
- **Sampling differs per model** (vendor-recommended settings, recorded per
  run). Samples are not seeded (`seed: null`).
- **GPU memory utilization is an operator setting** (`KSERVE_GPU_UTIL`),
  not part of the declared configuration. With `--preflight` the observed
  value is recorded in `provenance.preflight.observations`; smoke tests used
  different values per model (table in each card).
