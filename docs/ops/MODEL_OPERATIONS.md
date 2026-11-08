# Model operations

How the four models are stored, served and checked, and the rules for doing
so on a shared machine. Host-specific inventory (paths, sizes, current
processes) belongs in an untracked file, `private/machine-inventory.md`
(`private/` is git-ignored). This page uses placeholders.

Last verified: **2026-11-08**, read-only, with no server started. The checks
were: checkpoint snapshot directories present at the pinned revisions, pinned
serving images present locally by digest, no `kserve-*` container running,
GPU queue empty.

## Models, checkpoints, serving

The source of truth is `harness/src/agent/local-models.mjs`, which the
launchers and `benchmarks/bfcl/models.json` must match (tests h15, h27, h28).

| Agent id | Checkpoint (HF) @ revision | Precision | Runtime (image digest prefix) | TP | GPUs | Port | Validated context | `max_tokens` / reservation |
|---|---|---|---|---|---|---|---|---|
| `kanana` | `kakaocorp/kanana-2-30b-a3b-thinking-2601` @ `cdcbf8b8` | bf16 | vLLM 0.32.0 cu130 (`6ee13335`) | 1 | 0 | 8101 | 16,384 | 8,192 / 8,192 |
| `exaone` | `LGAI-EXAONE/EXAONE-4.5-33B-FP8` @ `69570ad5` (thinking on) | fp8 | same | 1 | 0 | 8101 | 16,384 | 8,192 / 8,192 |
| `exaone-nothink` | same checkpoint, thinking off (not in v1) | fp8 | same | 1 | 0 | 8101 | 16,384 | 4,096 / 8,192 |
| `ax` | `skt/A.X-4.0` @ `a3393fd6` | bf16 | same | 2 | 0,1 | 8101 | 16,384 | 4,096 / 8,192 |
| `solar-open2` | `nota-ai/Solar-Open2-250B-Nota-NVFP4` @ `3cc67333` (**unofficial** quantization) | NVFP4 W4A4 | Upstage vLLM fork 0.22.0 (`b34b7dd4`) | 2 | 0,1 | 8102 | 8,192 | 4,096 / 4,096 |

Approximate snapshot sizes on disk: Kanana 58 GB, EXAONE 39 GB, A.X 134 GB,
Solar 143 GB. Model cards: `docs/models/`.

A larger context (e.g. 32K) is **not validated** for any model. Solar's 8K is
what its serving record validated, and it must not be assumed to support more.
Changing `--max-model-len` means a new serving validation and a new
`local-models.mjs` entry, so the preflight can tell the configurations apart.

## Launchers

- `models/serving/kserve.sh {start|stop|logs|wait} {kanana|exaone|ax} [maxlen]`:
  port 8101, one model at a time (it refuses if another `kserve-*` is up).
- `models/serving/kserve-solar.sh {start|stop|logs|wait|print-config} [maxlen]`:
  port 8102; refuses an image that does not resolve to the pinned digest.
  `print-config` has no side effects.

Both mount the Hugging Face hub **read-only** and write compile caches to a
dedicated directory per stack. Both run a GPU gate before starting: they
refuse when foreign compute memory exceeds an allowance, and Solar also
requires about 85 GB free per GPU.

Host paths are currently **constants in the scripts** (`HUB=`, `CACHE=`), as
is the hub path in `benchmarks/campaign/campaign.py`. On another machine,
edit them (or, better, make them environment variables in a reviewed change)
and record that in the run. `models/serving-records/` holds the historical
copies used for the original validation; do not run those.

## Before any live run

1. `harness preflight --agent <id>` must report REPORTABLE (served model,
   context, parsers, image and checkpoint against the declaration; ADR 0008).
   `--preflight` on `harness run` / `harness swebench run` makes it blocking.
2. The campaign driver (`benchmarks/campaign/campaign.py`) refuses a dirty
   tree. Do code work in a separate worktree while it runs.

## Shared-machine rules

- The machine is shared (other research jobs run on the same GPUs). Never
  stop, replace or restart a model server or GPU process you did not start.
  Never bypass a launcher's GPU gate.
- **The GPU queue.** This host now requires all GPU work to go through a
  shared task-spooler queue (the operator's `gpuq`, with a GPU count and never
  explicit device ids). The v1 launchers predate this: they start detached
  `docker run -d` containers, which a queue slot cannot hold. **Before the
  next live run**, decide with the owner how a long-lived server holds a queue
  slot (e.g. a foreground launcher variant that blocks for the session). Until
  then, do not start servers.
- Do not upgrade drivers, CUDA, PyTorch/JAX or serving images. Do not
  download checkpoints or pull large images without the owner's approval.
- Docker storage is a hard constraint. v1 used a +100 GB image budget, which
  is why SWE-bench stage 2 was not run (`results/main-2026-10-30-v1/records/stage2-decision.json`).
  Never prune images or caches you did not create.
- Timings on this machine are contended. Report them as such.

## Known limits

- Quantization and sampling are `declared_only` in preflight. The checkpoint
  check is by snapshot directory name, not by file hashes.
- No seed control on the served models.
- The A.X parallel-call behaviour (BFCL) is a model/serving-interface
  property under this chat template and parser. It was not re-tested with
  other templates.
