# Isolated CUDA-compatible vLLM serving — plan, compatibility report, commands

_Prepared 2026-10-22 (inspection phase; nothing pulled yet). Machine: 2× RTX PRO 6000 Blackwell Max-Q, 96 GB each, **sm_120 / compute 12.0**, driver **610.57.04 → CUDA UMD 13.3**. HF cache `/data/jackb/krasis/huggingface/hub`._

## Why a new image (the blocker, restated)
The in-house `ghcr.io/local-inference-lab/vllm:karmic-kraken-beta` image is built against **CUDA 13.4** (`torch.version.cuda==13.4`), but the host driver only exposes **CUDA 13.3**. Every *prebuilt* kernel targeting 13.4 fails on the 13.3 driver with `cudaErrorUnsupportedPtxVersion`. Only the hand-routed GLM/MiMo presets dodge it. Stock HF models crash on the first inference kernel. **Fix = an official vLLM image built with CUDA ≤13.3 that also ships sm_120 kernels.** No driver change. GLM/MiMo/karmic image left exactly as-is.

## Image selection (official `vllm/vllm-openai`, inspected via registry metadata only — no layers pulled)

| Tag | CUDA | `TORCH_CUDA_ARCH_LIST` | Python | transformers pin | amd64 size | Runs on 13.3 driver? | sm_120? |
|---|---|---|---|---|---|---|---|
| **`v0.32.0` (default)** ⭐ | **13.0.2** | `7.5 8.0 8.6 8.9 9.0 10.0 **12.0**` | 3.12 | `>=5.16.1,<5.20.0` | **9.21 GB** | ✅ 13.0 ≤ 13.3 | ✅ 12.0 |
| `v0.32.0-cu129` (fallback) | 12.9.1 | `7.5 8.0 8.6 8.9 9.0 10.0 **12.0**` | 3.12 | `>=5.16.1,<5.20.0` | 11.18 GB | ✅ 12.9 ≤ 13.3 | ✅ 12.0 |
| `karmic-kraken-beta` (current, broken for stock models) | 13.4 | — | 3.12 | — | 44.1 GB (local) | ❌ 13.4 > 13.3 | n/a |

**Primary choice: `vllm/vllm-openai:v0.32.0` (cu130 default).** Smallest suitable (9.21 GB), CUDA 13.0.2 is comfortably ≤ the 13.3 driver, ships native sm_120. `-cu129` (CUDA 12.9.1 = vLLM's default-compiled target) is the fallback if the cu130 build shows any sm_120 kernel hiccup; +2 GB download.

**Pinned digests (linux/amd64):**
- `v0.32.0` index `sha256:befccf0e7e4089aa23926bb6f887a85c0d46c2a99e6de5c5ffdf5cb7957c5b34`; amd64 `sha256:6ee133356d49ed24cee03dd0cda3d3980279a11c107ce3e752c89e76540f41c9`
- `v0.32.0-cu129` index `sha256:bc0445dac61accbf1c3b17fbb524a71eee0b1b32f55ba45952095e3be8991c3f`; amd64 `sha256:be7326dd2f0731b3c49bd7c09975b46323733dcac74757aa5d5ada60acdee217`

Built 2026-10-18; NCCL 2.30.7; `NVIDIA_REQUIRE_CUDA` floor satisfied by driver 610.

**Expected bundled package versions (from vLLM v0.32.0 `requirements/cuda.txt`; confirm resolved values via `pip freeze` inside the container at smoke-test):** `torch==2.13.0`, `torchvision==0.28.0`, `torchaudio==2.11.0`, `flashinfer-python==0.7.0.post1`, `nvidia-cutlass-dsl[cu13]==4.8.0`, `transformers>=5.16.1,<5.20.0`. Triton ships with torch (pytorch-triton); `vllm-flash-attn` is vendored into the wheel.

## Compatibility report (arch + CUDA both verified — not assumed)
CUDA-kernel availability and model-arch support are **separate** checks; both pass for all three. Arch strings read from the **actual downloaded** `config.json`, registry confirmed in vLLM `v0.32.0`.

| Model | arch (local config) | vLLM v0.32.0 registry | quant | MoE | TP | CUDA path |
|---|---|---|---|---|---|---|
| Kanana 2 30B-A3B | `DeepseekV3ForCausalLM` (deepseek_v3, 128 experts) | ✅ `_TEXT_GENERATION_MODELS` → `deepseek_v2/DeepseekV3ForCausalLM` | BF16 (none) | yes | 1 | sm_120 native |
| EXAONE 4.5 33B FP8 | `Exaone4_5_ForConditionalGeneration` (exaone4_5) | ✅ `_MULTIMODAL_MODELS` → `exaone4_5/...` | compressed-tensors FP8 | no | 1–2 | sm_120 native, FP8 native on Blackwell |
| A.X 4.0 72B | `Qwen2ForCausalLM` (qwen2) | ✅ `_TEXT_GENERATION_MODELS` → `qwen2/Qwen2ForCausalLM` | BF16 | no | **2 req.** | sm_120 native |

Notes:
- **EXAONE 4.5** is registered as a *multimodal* class, but the `-FP8` checkpoint is **text-only** (processor_config present, no vision weights) → serves as text; no image inputs exercised.
- **Kanana** is MoE — on this official image the FlashInfer/Triton MoE kernels are the sm_120/CUDA-12.9/13.0 builds (not the karmic image's broken `triton_kernels`), so the MoE path that failed before should work. **Verify at smoke-test.**
- transformers `>=5.16.1` ≫ EXAONE 4.5's `>=5.8` requirement (submodule present from 5.12). ✅

## Isolation strategy (no shared-state writes)
- **Separate container name** (`kserve-*`), **separate port** (8101) — distinct from llama-swap (8013) and the model port (8000). Never reuse `llm-glm`/`llm-mimo` names.
- **HF snapshot cache mounted READ-ONLY** and under a non-default path so vLLM can't write/lock it: `-e HF_HOME=/hf -v /data/jackb/krasis/huggingface:/hf:ro -e HF_HUB_OFFLINE=1`. Reuses existing weights; cannot modify/delete shared cache.
- **Separate compile caches** (writable, dedicated dir, NOT the glm/mimo caches): `-e VLLM_CACHE_ROOT=/cache -e TORCHINDUCTOR_CACHE_DIR=/cache/inductor -e TRITON_CACHE_DIR=/cache/triton -v /data/jackb/lil-cache-korean:/cache`.
- GPU selection via the nvidia runtime (the `--gpus "device="` bug — see serving-stack memory): `--runtime nvidia -e NVIDIA_VISIBLE_DEVICES=<ids> -e NVIDIA_DRIVER_CAPABILITIES=all`.
- **Before launch:** confirm both GPUs idle (`nvidia-smi`) — do not start if GLM/MiMo or anything else holds VRAM. Run models **one at a time**; A.X needs both GPUs.

## Serving commands (run AFTER the image is pulled; 16K ctx)
Reproducible launcher: **`kserve.sh`** (`./kserve.sh start|stop|wait|logs <kanana|exaone|ax> [maxlen]`).
It does the GPU-idle pre-check, enforces one-kserve-at-a-time, and uses the isolation flags below.

Key robustness detail for the **read-only** HF mount: load by the **local snapshot directory path** (not the repo id), so vLLM never tries to write locks into the read-only tree. Snapshot files are relative symlinks into `../../blobs`, both under the single `/hf` mount, so they resolve read-only. Writable dirs (`HF_HOME=/cache/hf`, `VLLM_CACHE_ROOT=/cache`, inductor/triton caches, `XDG_CACHE_HOME`) all live under the separate `/cache` volume.

Canonical `docker run` (what `kserve.sh` emits; `$IMG` = `vllm/vllm-openai@sha256:6ee133356d49ed24cee03dd0cda3d3980279a11c107ce3e752c89e76540f41c9`):
```
docker run -d --rm --name kserve-<key> \
  --runtime nvidia -e NVIDIA_VISIBLE_DEVICES=<devs> -e NVIDIA_DRIVER_CAPABILITIES=all \
  --network host --ipc host --shm-size 16g \
  --ulimit memlock=-1 --ulimit stack=67108864:67108864 \
  -e HF_HUB_OFFLINE=1 -e HF_HOME=/cache/hf -e XDG_CACHE_HOME=/cache/xdg \
  -e VLLM_CACHE_ROOT=/cache -e TORCHINDUCTOR_CACHE_DIR=/cache/inductor -e TRITON_CACHE_DIR=/cache/triton \
  -v /data/jackb/krasis/huggingface/hub:/hf:ro -v /data/jackb/lil-cache-korean:/cache \
  $IMG \
  --model /hf/models--<repo>--<name>/snapshots/<sha> --served-model-name <Name> \
  --tensor-parallel-size <TP> --max-model-len 16384 --gpu-memory-utilization 0.90 \
  [--reasoning-parser <deepseek_r1|qwen3>] --enable-auto-tool-choice --tool-call-parser hermes \
  --port 8101 --disable-log-requests
```
Per-model substitutions (devices / TP / reasoning parser):
- **Kanana 2** — `kserve-kanana`, devs `0`, TP `1`, reasoning `deepseek_r1`. Snapshot `models--kakaocorp--kanana-2-30b-a3b-thinking-2601/snapshots/cdcbf8b811c21366f20f8a10a1f83183433c0844`.
- **EXAONE 4.5** — `kserve-exaone`, devs `0`, TP `1` (weights 39 GB fit one GPU; TP2 later for long KV), reasoning `qwen3`. Snapshot `models--LGAI-EXAONE--EXAONE-4.5-33B-FP8/snapshots/69570ad5d9a5159816ef267f2f4d37e36447f1be`.
- **A.X 4.0** — `kserve-ax`, devs `0,1`, TP `2` (required), **no** reasoning parser (non-thinking). Snapshot `models--skt--A.X-4.0/snapshots/a3393fd67bf09a34a85e66dfd2c2da61c4497b67`. Only after download verifies.

## Serving-ready gate (ALL must pass per model before marking ready)
1. Weights load, no CUDA/PTX error.
2. Plain `/v1/chat/completions` text generation completes.
3. A structured tool call is emitted and parses (tool-call parser).
4. A tool *result* returned in a 2nd turn is consumed correctly.
5. Reasoning extraction works (Kanana `deepseek_r1`, EXAONE `qwen3`; A.X has none — assert `reasoning_content` is null, not an error).
6. OpenAI-compatible endpoint (`/v1/models`, `/v1/chat/completions`) responds correctly.
7. Record: VRAM used, context length, throughput (tok/s), and the exact serving config.

## Status
- **Inspection + preparation phase: COMPLETE.** Image chosen + digests pinned, CUDA/driver/arch/transformers/torch all verified compatible, isolation designed, writable caches created (`/data/jackb/lil-cache-korean/{inductor,triton,hf,xdg}`), reproducible scripts written and syntax-validated:
  - `kserve.sh` — launcher (GPU-idle pre-check, one-at-a-time guard, read-only mount, port 8101).
  - `smoke_test.py` — stdlib harness for checks B/C/D/E (basic gen ×2, tool-call + synthetic-result multi-turn, reasoning extraction, resource/latency). Writes `results/<key>.json`.
  - `serving-readiness.json` — per-model state machine. `smoke-test-results.md` — results doc (PENDING).
- **Pull + smoke tests: COMPLETE (2026-10-23).** Image pulled + verified (torch 2.13.0+cu130 / transformers 5.19.0 / flashinfer 0.7.0.post1). All 3 checkpoints integrity-verified. Smoke-tested one-at-a-time under authorized GPU co-occupancy beside idle Sinsan (conservative util, clean stop between models, ragas/Sinsan/GLM/MiMo untouched).
- **Result: sm_120 CUDA blocker CLEARED** — Kanana (MoE), EXAONE (FP8), A.X (BF16 TP2) all load+generate on v0.32.0; **cu129 fallback NOT needed.** Also fixed: v0.32.0 removed `--disable-log-requests` (dropped from `kserve.sh`), and `--rm` removed so failed containers keep logs.
- **Reasoning extraction RESOLVED 2026-10-23 → all 3 models `serving_ready`** (serving smoke gates pass; **not** `benchmark_ready` — harness integration still to be validated). The Kanana/EXAONE reasoning flag was (1) the response field is `reasoning` in v0.32.0, not `reasoning_content`, and (2) `max_tokens` 256/512 truncated before `</think>`. Both vendor parsers (`deepseek_r1`/`qwen3`) are correct, no change; verified offline (`parser_regression_test.py`) + live (8192 budget). Benchmark client must read `reasoning` and budget ≥4096 for thinking models; reasoning is measured in CHARACTERS (provider `reasoning_tokens` is reliable for EXAONE, null/unreliable for Kanana). Full detail in **`smoke-test-results.md`** ("Reasoning-parser investigation") + **`serving-readiness.json`**.
