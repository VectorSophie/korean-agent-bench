# EXAONE 4.5 33B (FP8)

Snapshot as of 2026-10-29. Harness agent ids: **`exaone`** (thinking on) and
**`exaone-nothink`** (thinking off) — same checkpoint and server.

## Identity

| | |
|---|---|
| Developer | LG AI Research |
| Checkpoint | [`LGAI-EXAONE/EXAONE-4.5-33B-FP8`](https://huggingface.co/LGAI-EXAONE/EXAONE-4.5-33B-FP8) |
| Revision | `69570ad5d9a5159816ef267f2f4d37e36447f1be` |
| License | EXAONE AI Model License (custom; HF tag `other`) |
| Architecture | `Exaone4_5_ForConditionalGeneration` — dense, 33B. Ships a `processor_config.json` but no vision weights were observed; used text-only. |
| Weights | FP8 (compressed-tensors, float-quantized, dynamic per-token) — the **vendor's own** FP8 release. 9 shards, 41,322,391,860 bytes (38.48 GB) |
| Native context | 262,144 |

## Serving configuration

| | |
|---|---|
| Runtime | vLLM v0.32.0, CUDA 13.0.2 |
| Image | `vllm/vllm-openai@sha256:6ee133356d49ed24cee03dd0cda3d3980279a11c107ce3e752c89e76540f41c9` |
| Launcher | `models/serving-records/kserve.sh start exaone` (port 8101) |
| Tensor parallel | 1 (vendor card recommends TP2 for the full 256K KV cache; not needed at 16K) |
| `--max-model-len` | 16384 |
| Reasoning parser | `qwen3` |
| Tool-call parser | `hermes` (`--enable-auto-tool-choice`) |

## Harness configuration (`local-models.mjs`)

| | `exaone` | `exaone-nothink` |
|---|---|---|
| Served model name | `EXAONE-4.5` | `EXAONE-4.5` |
| Endpoint | `EXAONE_BASE_URL` → `KSERVE_BASE_URL` → `http://127.0.0.1:8101/v1` | same |
| Sampling | temperature 0.6, top_p 0.95, top_k 20, presence_penalty 1.5 | same |
| `chat_template_kwargs` | `{ enable_thinking: true }` | `{ enable_thinking: false }` |
| Max output tokens | 8192 | 4096 |
| Context limit | 16384 | 16384 |

`exaone-nothink` is a different *configuration* of the same model and must be
reported as its own row, never pooled with `exaone`.

## Hardware

Serving smoke test (2026-10-23, util 0.55, 16K context): peak **51,593 MiB**
on one GPU, ~45.7 GiB free, load ~220 s, **~34 tok/s** (contended).
Source: `models/serving-records/smoke-test-results.md`.

## Observed behavior

- **Pilot** (one attempt per task; not a benchmark). Run 1: T1–T4 all pass,
  but **0/4 clean completions** (two `budget_exhausted`, two `tool_error`).
  Run 2 (T3-v2): pass, `budget_exhausted`. Run 3 (T3-v3): **fail** — read
  `out.txt` before writing it, and the resulting tool error ended the loop.
  `harness/docs/PILOT_REPORT.md` ("EXAONE termination analysis").
- Provider reasoning-token counts are reliable (`qwen3`; 837–2,054 observed).

## Known limitations

- `presence_penalty` 1.5 is part of the vendor preset used throughout
  (`serving-records/serving-notes.md`); behavior without it has not been
  tested here.
- Needs an output budget of at least ~4096 tokens with thinking on.
- The `exaone-nothink` configuration has not been run in the live pilot.
