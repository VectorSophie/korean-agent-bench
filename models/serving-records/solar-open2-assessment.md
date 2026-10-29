# Solar Open 2 — local serving viability assessment (NVFP4 on 2×96 GB Blackwell)

_Prepared 2026-10-23; updated 2026-10-26. **Download COMPLETE + integrity-verified** 2026-10-24 (pinned sha below;
host unchanged, no GPU used yet). Vendor image pull **in progress** 2026-10-26. Supersedes the earlier (incorrect)
"no vLLM serving path / 5–9 day download" assessment.
Verdict remains **interim**: the two empirical unknowns (sm_120 NVFP4-MoE kernels engage on RTX PRO 6000; TP2 shards)
are only settleable once weights are on disk and are tested on the isolated Upstage-fork stack (NOT the working v0.32.0 stack)._

## Corrections to the earlier assessment
1. **A serving path exists.** Upstream vLLM registry absence ≠ no implementation. Upstage ships
   **`UpstageAI/vllm@v0.22.0-solar-open2`** (model impl + `solar_open2` reasoning parser + `solar_open2`
   tool-call parser + `SolarOpen2TemplateLogitsProcessor`). Also a prebuilt image **`upstage/vllm-solar-open2`**.
2. **Download time was wrong.** At ~2 MiB/s, 153.3 GB ≈ **20.3 h** (126 GB ≈ 16.7 h), not 5–9 days.

## Candidate (preferred): `nota-ai/Solar-Open2-250B-Nota-NVFP4`
- **Unpruned** NVFP4 (W4A4, compressed-tensors) quant of `upstage/Solar-Open2-250B` BF16. **153.3 GB** (BF16 = 500.6 GB).
- MoE, ~15B active; repo named "250B", NVFP4 card metadata says ~145B params (sources inconsistent — flagged).
- **Why unpruned over GlobalPruned:** the Upstage fork's MoE impl **assumes a uniform expert count across layers**.
  The **GlobalPruned** checkpoint has variable per-layer expert counts → documented load failure
  (HF discussion: Nota's patch also hits `ImportError: SharedFusedMoE`, merged into `FusedMoE` in v0.22.0).
  The **unpruned** checkpoint has uniform experts → sidesteps that bug. GlobalPruned (126 GB) kept only as a
  fallback **and only if** fork support for variable per-layer expert counts lands.

## Runtime / CUDA compatibility vs driver 610.57.04 (CUDA UMD 13.3)
| Item | Value | Verdict |
|---|---|---|
| Base engine | vLLM **v0.22.0**, **cu129 (CUDA 12.9)** precompiled wheel | 12.9 ≤ 13.3 → runs, **no driver change** |
| Fork | `git+https://github.com/UpstageAI/vllm.git@v0.22.0-solar-open2` on top of that wheel | layered install |
| Prebuilt image | `upstage/vllm-solar-open2` (vLLM v0.22.0 + CUDA 12.9) | preferred (matches our Docker isolation) |
| Arch | `SolarOpen2ForCausalLM` / `solar_open2` | resolved by the fork (not upstream) |
| sm_120 NVFP4 **MoE** kernels | v0.22.0 = first release with FlashInfer SM120/121 FP4 GEMM+MoE (PR #40082) | **UNVERIFIED on RTX PRO 6000 for this model** |

**The single residual risk is kernel maturity, not CUDA/driver.** Pre-v0.22.0 reports had the CUTLASS NVFP4-MoE
path on SM120 falling back to slow/incorrect; v0.22.0 adds the SM120 FP4 paths but there is no v0.22.0-specific
RTX PRO 6000 confirmation for Solar Open 2. **Only settleable empirically** (requires weights on disk):
on first serve, check startup logs for **no Marlin/slow fallback** on the NVFP4 MoE path, then a correctness probe.

## Memory & topology (2× RTX PRO 6000, 96 GB each, PCIe, no NVLink)
- Weights **153.3 GB ÷ TP2 = 76.65 GB/GPU**. At `--gpu-memory-utilization 0.92` (~88 GB usable/GPU):
  76.65 weights + CUDA/NCCL context (~2–4 GB) leaves **~7–9 GB/GPU for KV + activations**.
- **KV at reduced context is small** → **4K–8K context is feasible**; **131K context will NOT fit** (start reduced).
- **TP2 is unverified** — all vendor examples use **TP4** ("set TP to your GPU count"). 15B-active MoE over 2 GPUs
  *should* shard cleanly; confirm at first load. Expert-parallel (`--enable-expert-parallel`) **not required** at TP2;
  consider only if TP2 sharding of experts misbehaves.
- No NVLink → TP2 all-reduce over PCIe; acceptable for a benchmark row, throughput lower than an NVLink pair.

## Serving command (for the isolated `kserve-` pattern, once downloaded — NOT run yet)
Base (vendor example, TP4) adapted to **TP2** + reduced context + our isolation (read-only `/hf`, writable `/cache`,
port 8101, `NVIDIA_VISIBLE_DEVICES=0,1`). NVFP4 is compressed-tensors → **no `--quantization` flag**.
```
vllm serve /hf/models--nota-ai--Solar-Open2-250B-Nota-NVFP4/snapshots/<sha> \
  --served-model-name solar-open2-250b \
  --tensor-parallel-size 2 \
  --gpu-memory-utilization 0.92 --max-model-len 8192 \
  --default-chat-template-kwargs '{"think_render_option":"preserved"}' \
  --reasoning-parser solar_open2 --tool-call-parser solar_open2 --enable-auto-tool-choice \
  --logits-processors vllm.v1.sample.logits_processor.solar_open2:SolarOpen2TemplateLogitsProcessor \
  --port 8101
```
Engine is the **Upstage fork**, so this runs in a **separate** container/venv from the `vllm/vllm-openai:v0.32.0`
Korean-model stack — **no effect on existing vLLM servers** (different image, different port, different cache).
Prefer the `upstage/vllm-solar-open2` image; else build the fork into a dedicated uv venv (`VLLM_USE_PRECOMPILED=1`
+ the v0.22.0 cu129 wheel URL + `git+...@v0.22.0-solar-open2`). Do **not** install the fork into any shared env.

## Verdict — VALIDATED / `serving_ready` (2026-10-26)
**Viable and serving.** CUDA-compat ✅, arch-support ✅ (fork), memory at 4–8K ✅, unpruned avoids the pruned load bug ✅.
Both former unknowns **now confirmed empirically on the RTX PRO 6000**: (1) sm_120 NVFP4-MoE kernels engage
(FLASHINFER_CUTLASS, no Marlin/Emulation fallback); (2) TP2 shards cleanly (71.6 GiB/GPU). Reasoning, structured
tool calling, and multi-turn tool-result continuation all pass at 8K. Required non-default flag: `--max-num-seqs 256`
(hybrid Mamba cache bound). Remaining work = **benchmark-harness integration** (not yet validated); do not start the
full benchmark yet.

## Download — COMPLETE + INTEGRITY-VERIFIED (finished 2026-10-24 08:23 UTC)
- **Pinned revision:** `3cc673335f4c2f41181e05a98fc2b8324d586a64` (HEAD; confirmed by HF API **and** `git ls-remote` — not fabricated). **Not gated**, public.
- **Launcher:** `download_solar.sh` — `HF_HUB_DISABLE_XET=1 hf download … --revision 3cc673…` into the existing cache; **resumable**, 160 GB free-space floor, **bounded retries** (6, exp backoff ≤600 s), refuses to run beside another active `hf download`. The throttled link dropped many shard connections mid-stream (`peer closed connection …`); the resumable retries recovered every one. Status → `download-status.json` (`solar-open2-nvfp4` = `ready_downloaded`), log `/data/jackb/logs/solar-dl.log`. Actual wall time ≈ 24.5 h.
- **Independent integrity validation (2026-10-26, offline/CPU, `python3 -I`):**
  - **29/29** `*.safetensors` shards present, **0 `.incomplete`**, all symlinks resolve to full-size blobs.
  - **On-disk total 153,311,254,120 bytes = 153.311 GB (142.78 GiB)**; index `metadata.total_size` = 153,288,243,200 B (difference = safetensors header bytes, expected).
  - **`model.safetensors.index.json` weight_map: 185,259 tensors across 29 shards — 0 missing, 0 extra.**
  - **All 29 safetensors headers parse**; header tensor count (185,259) == index tensor count.
  - `config.json`: `model_type=solar_open2`, `architectures=[SolarOpen2ForCausalLM]`, **48 layers, n_routed_experts=320, num_experts_per_tok=8** (uniform expert count → the unpruned structure that sidesteps the GlobalPruned load bug), hidden_size=4096, vocab_size=196608, max_position_embeddings=1,048,576.
  - `quantization_config.json`: **`nvfp4-pack-quantized`, `compressed-tensors`, W4A4** (weights 4-bit float + input_activations 4-bit), `kv_cache_scheme` present — confirms no `--quantization` flag needed.
- GlobalPruned (126 GB) = fallback only if fork gains variable-per-layer-expert support. **Not** downloaded (no justification to add a second quant).

## Serving environment — vendor image PULLED + VERIFIED (2026-10-26)
- Chosen path: prebuilt vendor image **`upstage/vllm-solar-open2:1.0.0`** over building the fork into a venv — matches the isolated `kserve-*` Docker pattern and is vendor-validated.
- **Image pulled + pinned:** digest `sha256:b34b7dd42d986bafb8dcfb285758de2fbfd55e7cf28a1b5ba6b858e6b2b7c8c3`, 30.26 GB on disk, built 2026-07-21, `VLLM_IMAGE_TAG=vllm/vllm-openai:v0.22.0-cu129` (the exact fork base). Entrypoint `["vllm","serve"]`.
- **CUDA/arch verified by container probe (torch, no weights):** `CUDA_VERSION=12.9.1` (≤ 13.3 driver → **no driver change**); `TORCH_CUDA_ARCH_LIST=7.5 8.0 8.6 8.9 9.0 10.0 **12.0**` (sm_120 included); torch **2.11.0+cu129** sees **2× sm_120** devices and a real matmul executes on Blackwell (no PTX error); vLLM **0.22.0**; **`SolarOpen2ForCausalLM` registered: True**. The nvidia runtime did **not** reject driver 610 despite `NVIDIA_REQUIRE_CUDA` capping at `driver<571`.
- **Launcher staged:** `kserve-solar.sh` (port 8102, cache `/data/jackb/lil-cache-solar`, TP2, strict 2-GPU gate). NVFP4 = compressed-tensors → no `--quantization` flag (engine auto-detects `quantization=compressed-tensors`, confirmed in startup log).

## TP2 serving smoke test — PASSED / `serving_ready` (2026-10-26)
Multi-sample GPU gate passed before each launch (both cards ~96 GB free, 0% util, 5 samples stable); only foreign compute = **Sinsan idle** (~1.2 GB GPU0 / ~0.8 GB GPU1). One-at-a-time. Launched via `kserve-solar.sh` (TP2, util 0.90, `solar_open2` reasoning+tool parsers + `SolarOpen2TemplateLogitsProcessor`, `think_render_option: preserved`, `trust_remote_code`). Tested at **4K then 8K** context. Server stopped after testing; GPU returned to Sinsan-only baseline, **Sinsan untouched throughout** (same pids/memory). **Not starting the full benchmark.**

**Both empirical unknowns RESOLVED:**
1. **sm_120 NVFP4-MoE kernels engage** — startup log `nvfp4.py:326 Using 'FLASHINFER_CUTLASS' NvFp4 MoE backend` (out of [...TRTLLM, CUTEDSL, CUTLASS, VLLM_CUTLASS, **MARLIN**, **EMULATION**]) — the real FlashInfer-CUTLASS FP4 path, **no Marlin/Emulation fallback**. No PTX/illegal-instruction errors.
2. **TP2 shards cleanly** — world_size=2 NCCL (2.28.9), **71.6 GiB/GPU** weights, all-reduce via CUSTOM/PYNCCL over PCIe (`SymmMem` cap-12.0 unsupported = benign fallback).

**Architecture note:** Solar Open 2 is a **hybrid attention + Mamba/SSM MoE** ("attention block size 1072 to ensure page size ≥ mamba page size"). Each decode seq needs one Mamba cache block → **`--max-num-seqs` must be ≤ available Mamba blocks** (default 1024 failed with "exceeds available Mamba cache blocks (401)" at util 0.90; set `--max-num-seqs 256`). This is the one non-obvious required flag; now baked into `kserve-solar.sh`.

**Inference battery (8K, contended):**
- Basic Korean generation ✓.
- **Reasoning separation ✓** — reasoning delimiters are special tokens **`<|think:start|>`/`<|think:end|>`** (NOT `<think>`); the chat template prefills `<|think:start|>` into the generation prompt (effort medium/high), so the model emits `<reasoning><|think:end|><answer>`. The `solar_open2` parser splits on `<|think:end|>` textually. Finished logic puzzle: `finish=stop`, **reasoning 4626 chars** in the `reasoning` field, 636-char Korean answer in `content`, **no `<|think` leak**. CoT in **English**, answer in Korean (same as Kanana/EXAONE).
- **Structured tool calling ✓** — `get_weather({"city":"부산","unit":"c"})`, `finish=tool_calls`, typed args correct, reasoning separated.
- **Multi-turn tool-result continuation ✓** — fed tool result back → `finish=stop`, correct Korean answer using the result; prior-turn reasoning + tool_calls + tool message handled by the template.
- The **`reasoning_start_str`/`reasoning_end_str` auto-init warning is BENIGN** — this parser splits textually on `<|think:end|>`, not via base-class token-id init; confirmed by reading `vllm/reasoning/solar_open2_reasoning_parser.py` in the image (no-`<|think:end|>` → `(reasoning=None, content=all)`, so a too-small budget *looks* like missing reasoning — same budget lesson as the other models).

**Metric caveats:** `reasoning_chars` is CHARACTERS. Provider `usage.completion_tokens_details` comes back **empty → reasoning_tokens unavailable → report `null`** (like Kanana). `reasoning_effort` defaults to **"high"** → verbose CoT; budget ≥4–7K completion (trivial prompts can over-think and truncate at 4K). 131K context will NOT fit (KV-limited); 8K comfortable.

**Resource measurements (contended, Sinsan idle co-resident):** serve footprint **88.3 GB/GPU** at util 0.90 (7.6–8.0 GB free/GPU); model load **71.6 GiB/GPU in ~31 s**; graph capture ~12 s; engine init ~79 s; KV @8K **10.89 GiB → 329,914 tokens → 40× concurrency** (@4K: 9.79 GiB → 233,472 → 57×). Throughput (contended): reasoning ~34 tok/s; tool/continuation turns ~1.4–1.5 s.

**`serving_ready` ≠ `benchmark_ready`:** serving smoke gates pass; full benchmark-harness integration not yet validated (same status as the 3 Korean models).

## License obligations (Upstage Solar License)
- Derivative model names **must begin with "Solar"**.
- Public-facing materials must display **"Built with Solar"**.
- Must include a copy of the Upstage Solar License.
- The **NVFP4 is a third-party (Nota AI) community quant** → report it **separately** as UNOFFICIAL, per standing rule.

## Benchmark placement
- **Replace the intended _local_ Upstage row** with **Solar Open 2 (Nota NVFP4)**.
- **Retain Solar Pro 4** as an **optional, separate API baseline** — **not** presented as an equivalent checkpoint
  (different generation; hosted API vs local open-weights NVFP4). OpenRouter creds still unconfigured.

## Sources
- UpstageAI/vllm fork + GlobalPruned uniform-expert bug: https://huggingface.co/nota-ai/Solar-Open2-250B-Nota-INT4-GlobalPruned/discussions/1
- Nota NVFP4 card (serve cmd, 153.3 GB, Blackwell FP4, license): https://huggingface.co/nota-ai/Solar-Open2-250B-Nota-NVFP4
- Install/serve steps (fork URL, cu129 wheel, docker image): https://interfaze.ai/models/nota-aisolar-open2-250b-nota-nvfp4.md
- vLLM v0.22.0 SM120/121 FP4 GEMM+MoE (PR #40082): https://newreleases.io/project/github/vllm-project/vllm/release/v0.22.0
- SM120 NVFP4-MoE fallback history (RTX PRO 6000): https://discuss.vllm.ai/t/sm120-rtx-pro-6000-nvfp4-moe-performance-report-qwen3-5-397b/2536
- Upstage Solar Open 2 model card: https://huggingface.co/upstage/Solar-Open2-250B
