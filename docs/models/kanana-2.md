# Kanana 2 30B-A3B Thinking

Snapshot as of 2026-10-29. Harness agent id: **`kanana`**.

## Identity

| | |
|---|---|
| Developer | Kakao |
| Checkpoint | [`kakaocorp/kanana-2-30b-a3b-thinking-2601`](https://huggingface.co/kakaocorp/kanana-2-30b-a3b-thinking-2601) |
| Revision | `cdcbf8b811c21366f20f8a10a1f83183433c0844` |
| License | Kanana License (custom; HF tag `other`) |
| Architecture | `DeepseekV3ForCausalLM` — MoE, 128 routed experts, 6 active; 30B total, ~3B active |
| Weights | BF16, 13 safetensors shards, 61,355,871,777 bytes (57.14 GB) |
| Native context | 32,768 (extendable to 131,072 with YaRN; **not used**) |

## Serving configuration

| | |
|---|---|
| Runtime | vLLM v0.32.0, CUDA 13.0.2 |
| Image | `vllm/vllm-openai@sha256:6ee133356d49ed24cee03dd0cda3d3980279a11c107ce3e752c89e76540f41c9` |
| Launcher | `models/serving/kserve.sh start kanana` (port 8101); container `kserve-kanana` |
| Tensor parallel | 1 (GPU 0 by default; `KSERVE_DEV` overrides) |
| `--max-model-len` | 16384 (launcher default) |
| Reasoning parser | `deepseek_r1` |
| Tool-call parser | `hermes` (`--enable-auto-tool-choice`) |
| Chat template | bundled `chat_template.jinja`; template always pre-fills `<think>` |

## Harness configuration (`local-models.mjs`)

| | |
|---|---|
| Served model name | `Kanana-2` |
| Endpoint | `KANANA_BASE_URL`, else `KSERVE_BASE_URL`, else `http://127.0.0.1:8101/v1` |
| Sampling | temperature 0.6, top_p 0.95, top_k 20 (vendor-recommended) |
| `chat_template_kwargs` | none — reasoning is always on |
| Max output tokens | 8192 |
| Context limit | 16384 |

## Hardware

Fits one 96 GB GPU. Serving smoke test (2026-10-23, util 0.75, 16K context):
peak **75,739 MiB** on one GPU, ~21.5 GiB left free, load ~110 s, **~140 tok/s**
generation (contended). Source: `models/serving-records/smoke-test-results.md`.

## Observed behavior

- **Pilot** (one attempt per task; not a benchmark). Run 1: T1, T2, T4 pass;
  T3 v1 fail (wrote `T` instead of the generated token,
  `serving-readiness.json`); 4/4 clean completions. T3-v2 and T3-v3 pass
  with clean completion (`stopReason: done`). `harness/docs/PILOT_REPORT.md`,
  records in `results/pilot-2026-10/`.
- Chain-of-thought is typically in English, answer in Korean
  (`serving-readiness.json`).

## Known limitations

- **Provider reasoning-token count is wrong.** `deepseek_r1` reports
  `reasoning_tokens: 0` because the opening `<think>` is in the prompt, not
  the completion. The harness records `providerReasoningTokens: null` and
  `reasoningChars` (characters, not tokens). A tokenizer-derived count is not
  computed.
- Needs an output budget of at least ~4096 tokens; small budgets end inside
  the reasoning (`finish_reason: length`) with empty content.
- Evaluated at 16K context; the 131K YaRN configuration has not been run.
