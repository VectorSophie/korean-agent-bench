# A.X 4.0 (72B)

Snapshot as of 2026-10-29. Harness agent id: **`ax`**.

## Identity

| | |
|---|---|
| Developer | SK Telecom |
| Checkpoint | [`skt/A.X-4.0`](https://huggingface.co/skt/A.X-4.0) |
| Revision | `a3393fd67bf09a34a85e66dfd2c2da61c4497b67` |
| License | Qwen License (custom; HF tag `other`) |
| Architecture | `Qwen2ForCausalLM` — dense, 72B (hidden 8192 x 80 layers) |
| Weights | BF16, 30 shards, 143,798,193,521 bytes (133.92 GB). No official lower-precision variant exists in the vendor repo. |
| Native context | 131,072 |
| Reasoning | none — non-thinking model |

## Serving configuration

| | |
|---|---|
| Runtime | vLLM v0.32.0, CUDA 13.0.2 |
| Image | `vllm/vllm-openai@sha256:6ee133356d49ed24cee03dd0cda3d3980279a11c107ce3e752c89e76540f41c9` |
| Launcher | `models/serving-records/kserve.sh start ax` (port 8101) |
| Tensor parallel | **2 (required)** — GPUs 0,1, over PCIe |
| `--max-model-len` | 16384 |
| Reasoning parser | none |
| Tool-call parser | `hermes` (`--enable-auto-tool-choice`) |

## Harness configuration (`local-models.mjs`)

| | |
|---|---|
| Served model name | `A.X-4.0` |
| Endpoint | `AX_BASE_URL` → `KSERVE_BASE_URL` → `http://127.0.0.1:8101/v1` |
| Sampling | temperature 0.6, top_p 0.95 |
| `chat_template_kwargs` | none |
| Max output tokens | 4096 |
| Context limit | 16384 |

## Hardware

BF16 weights (134 GB) exceed one 96 GB GPU, so both GPUs are required.
Serving smoke test (2026-10-23, util 0.82, 16K context): **81,171 + 80,771 MiB**
across GPU 0/1, ~16 GiB free per GPU, load ~220 s, **~17 tok/s**, TTFT 0.094 s
(contended). Source: `models/serving-records/smoke-test-results.md`.

## Observed behavior

**Pilot** (one attempt per task; not a benchmark): T1–T4, T3-v2 and T3-v3
pass, all with clean completion (`stopReason: done`). `harness/docs/PILOT_REPORT.md`.

## Known limitations

- Slowest of the four per token (dense 72B over PCIe TP2).
- Occupies both GPUs: nothing else can be served while it runs.
- As a non-thinking model it has no reasoning channel; reasoning metrics are
  `null`, not zero.
