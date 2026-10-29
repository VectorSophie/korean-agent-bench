# Solar Open 2 — Nota NVFP4 (unofficial quantization)

Snapshot as of 2026-10-29. Harness agent id: **`solar-open2`**.

> **This is not the official checkpoint.** It is a third-party (Nota AI)
> NVFP4 W4A4 quantization of `upstage/Solar-Open2-250B`. Results from it must
> be labeled as such and never presented as, or compared directly with,
> results for the official BF16 model. Run records carry
> `provenance.model.official: false`.

## Identity

| | |
|---|---|
| Base model | Upstage Solar Open 2 (`upstage/Solar-Open2-250B`, BF16, 500.6 GB) — not used |
| Checkpoint | [`nota-ai/Solar-Open2-250B-Nota-NVFP4`](https://huggingface.co/nota-ai/Solar-Open2-250B-Nota-NVFP4) |
| Revision | `3cc673335f4c2f41181e05a98fc2b8324d586a64` (pinned 2026-10-23) |
| License | Upstage Solar License: derivative names must begin with "Solar", display "Built with Solar", ship a copy of the license |
| Architecture | `SolarOpen2ForCausalLM` — hybrid attention + Mamba MoE, 48 layers, 320 experts, 8 active (~15B active per base card). Parameter count is reported inconsistently (repo name 250B; NVFP4 card ~145B). Requires `trust_remote_code`. |
| Weights | NVFP4 W4A4 (compressed-tensors). 29 shards, 153,347,365,220 bytes (153.3 GB); integrity verified 2026-10-24 (29/29 shards, 185,259 tensors) |

## Serving configuration

| | |
|---|---|
| Runtime | Upstage vLLM fork `v0.22.0-solar-open2`, CUDA 12.9.1. Upstream vLLM cannot load this architecture. |
| Image | `upstage/vllm-solar-open2@sha256:b34b7dd42d986bafb8dcfb285758de2fbfd55e7cf28a1b5ba6b858e6b2b7c8c3` |
| Launcher | `models/serving/kserve-solar.sh start` (port 8102); container `kserve-solar` |
| Tensor parallel | **2 (required)** |
| `--max-model-len` | **8192** (maintained launcher default since 2026-10-29; the recorded original defaulted to 4096) |
| `--max-num-seqs` | **256 (required)**: hybrid Mamba; the default 1024 exceeds the 401 Mamba cache blocks and crashes engine init |
| Logits processor | `SolarOpen2TemplateLogitsProcessor` |
| Chat template kwargs (server default) | `{"think_render_option": "preserved"}` |
| Reasoning / tool parsers | `solar_open2` / `solar_open2` |
| NVFP4 MoE kernel | `FLASHINFER_CUTLASS` on SM120 (no Marlin/emulation fallback) |

## Harness configuration (`local-models.mjs`)

| | |
|---|---|
| Served model name | `solar-open2-250b` |
| Endpoint | `SOLAR_BASE_URL` → `http://127.0.0.1:8102/v1` |
| Sampling | temperature 0.6, top_p 0.95 |
| `chat_template_kwargs` | none (reasoning effort defaults to high server-side) |
| Max output tokens | 4096 |
| Context limit | 8192 |

## Hardware

Requires Blackwell FP4 tensor cores. Weights alone are 71.6 GiB per GPU at
TP2. Serving smoke test (2026-10-26, util 0.90, 8K context): **88.3 GB per
GPU**, 7.6–8.0 GB free per GPU, ready ~190 s, **~34 tok/s** (contended). KV
cache at 8K: 10.89 GiB. **131K context does not fit** on 2x96 GB.
Source: `models/serving-records/smoke-test-results.md`.

## Observed behavior

**Pilot** (one attempt per task; not a benchmark). Run 1: T1–T4 pass, 4/4
clean completions. T3-v2 (after re-serving at 8192) and T3-v3 pass, but both
end by exhausting the turn budget (`budget_exhausted`), not by finishing. `harness/docs/PILOT_REPORT.md`.

## Known limitations

- **Unofficial quantization** (above). No comparison against the official
  weights has been made; the quantization's effect on quality is unmeasured
  here.
- **8K context ceiling** on this hardware, half the other three models'
  16K. External tasks with long prompts (e.g. SWE-bench) may not fit — see
  ADR 0003; this must be reported as infeasibility, not filtered silently.
- **Launcher fixed 2026-10-29, not yet run live.** The original launcher
  (`models/serving-records/kserve-solar.sh`) started by tag and defaulted to
  4096, which caused the pilot's `context_length` error. The maintained
  launcher (`models/serving/kserve-solar.sh`) starts by the pinned digest,
  refuses an image that does not resolve to it, and defaults to 8192
  (ADR 0008; `harness/tests/h27`). The tag resolved to the pinned digest on
  the reference machine on 2026-10-29 (`docker image inspect`).
- Provider reasoning-token counts are unavailable (`null`); `reasoningChars`
  is recorded.
