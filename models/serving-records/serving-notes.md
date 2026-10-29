# Serving notes (prepared, NOT launched)

> **2026-10-22 update:** the model-specific vLLM flags/parsers below still hold, but the
> **runtime** is now the official **`vllm/vllm-openai:v0.32.0`** image in an isolated
> container (the in-house `karmic-kraken-beta` image is CUDA 13.4 vs our 13.3 driver and
> crashes stock models on the first kernel). The authoritative serving plan — image digests,
> read-only-mount isolation, reproducible `kserve.sh` launcher + `smoke_test.py` harness, and
> the 7-point readiness gate — is in **`isolated-serving.md`**. Smoke tests are deferred until
> the A.X download finishes. GLM/MiMo serving is unchanged.

Startup configuration for a later experiment. **No servers were started and no weights were loaded into GPU memory during preparation.** The future benchmark uses a common OpenAI-compatible interface, but model-specific chat templates / parsers below are preserved as-is — do **not** force a single shared template.

Hardware: 2× RTX PRO 6000 Blackwell Max-Q, 96 GB each (192 GB aggregate), SM120, driver 610.57.04, PCIe (no NVLink). Each model uses **both** GPUs or one; only one model fits at a time → bring them up one at a time (e.g. via the existing llama-swap). Suggested initial `--max-model-len 32768` where the model supports more, to keep the first-boot KV footprint small.

**Do not install/upgrade CUDA, PyTorch, vLLM, or SGLang in any shared environment.** Where a model needs a specific/forked engine (Motif, EXAONE-SGLang), use an **isolated** venv or the vendor Docker image (see per-model). Flags below are transcribed from each model's official HF card on 2026-10-21.

---

## Kanana 2 30B-A3B Thinking  —  `ready after download`
- **Engine:** stock **vLLM** (arch `deepseek_v3`) or SGLang. No fork.
- **TP:** 1 (57 GB BF16 fits one 96 GB GPU); TP2 optional.
- **vLLM:**
  ```
  vllm serve kakaocorp/kanana-2-30b-a3b-thinking-2601 \
    --reasoning-parser deepseek_r1 \
    --enable-auto-tool-choice --tool-call-parser hermes \
    --max-model-len 32768
  ```
- **SGLang:** `--reasoning-parser deepseek-r1 --tool-call-parser qwen`
- **Context:** 32,768 native. For up to 131,072, add
  `--hf-overrides '{"max_position_embeddings":131072,"rope_scaling":{"rope_type":"deepseek_yarn","factor":4.0,"beta_fast":32,"beta_slow":1,"mscale":1.0,"mscale_all_dim":1.0,"original_max_position_embeddings":32768}}'`
  (enable YaRN only when you actually need long context).
- **Reasoning:** thinking model; template auto-opens `<think>` in the prompt, model emits body + `</think>` + answer → parser `deepseek_r1` (vendor default, **verified correct 2026-10-23**). Recommended sampling: `temperature=0.6, top_p=0.95, top_k=20` (avoid greedy). Read reasoning from the **`reasoning`** response field (v0.32.0), not `reasoning_content`; budget `max_tokens≥4096` (reasoning alone can exceed 6000 for hard problems) or it truncates before `</think>`. `usage.reasoning_tokens` reads 0 here (metric artifact) — use `len(reasoning)`. CoT is emitted in English, answer in Korean.
- **Custom kernels:** none. **Chat template:** bundled `chat_template.jinja`.

## EXAONE 4.5 33B FP8  —  `ready after download`
- **Engine:** **vLLM** (`>=0.5.8` per card), TensorRT-LLM, or SGLang (**fork**: `git+https://github.com/lkm2835/sglang.git@add-exaone4_5`). Needs `transformers>=5.8.0`.
- **TP:** 2 recommended (to hold full 256K KV; weights 38.5 GB fit one GPU).
- **vLLM:**
  ```
  vllm serve LGAI-EXAONE/EXAONE-4.5-33B-FP8 \
    --served-model-name EXAONE-4.5-33B-FP8 \
    --tensor-parallel-size 2 \
    --reasoning-parser qwen3 \
    --enable-auto-tool-choice --tool-call-parser hermes \
    --max-model-len 32768
  ```
- **SGLang (fork):** `python -m sglang.launch_server --model-path LGAI-EXAONE/EXAONE-4.5-33B-FP8 --tp-size 2`
- **Quant:** FP8 (compressed-tensors, dynamic per-token) — **native on Blackwell**.
- **Context:** 262,144. **Reasoning:** `qwen3` parser (vendor default, **verified correct 2026-10-23**, both `enable_thinking` True/False). `enable_thinking=True` is the default; pass `chat_template_kwargs={"enable_thinking":false}` for non-reasoning mode. Recommended sampling: general `temperature=1.0, top_p=0.95, presence_penalty=1.5`; Korean/OCR `temperature=0.6, top_p=0.95, top_k=20, presence_penalty=1.5`. Read the **`reasoning`** field; budget `max_tokens≥4096`. `usage.reasoning_tokens` is **reliable** here (unlike Kanana). CoT in English, answer in Korean.
- **Processor:** `processor_config.json` present but **no vision weights/image processor** — treat as text. **Chat template:** bundled `chat_template.jinja`.

## A.X 4.0 (72B)  —  `ready after download`
- **Engine:** stock **vLLM** (`>=0.6.4.post1` for tool-use; arch `qwen2`). No fork. `transformers>=4.46.0`.
- **TP:** **2 required** (134 GB BF16 > one 96 GB GPU).
- **vLLM:**
  ```
  vllm serve skt/A.X-4.0 \
    --tensor-parallel-size 2 \
    --enable-auto-tool-choice --tool-call-parser hermes \
    --max-model-len 32768
  ```
- **Reasoning:** **none** — A.X 4.0 is non-thinking (`reasoning_content` is null in official examples). Do not set a reasoning parser.
- **Tool parser:** `hermes`. **Custom kernels:** none. **Chat template:** bundled (tokenizer `chat_template`, tool-calling).

## Motif-3  —  three paths, all `deferred` (nothing downloaded yet)

Decision after inspecting the compact GGUF options: **prefer the Baekpica mixed-quant for an experimental, explicitly-UNOFFICIAL Motif-3 row**, contingent on an `sm_120` runtime build succeeding. Keep the official NVFP4 deferred. jhkim55 is a last-resort fallback (documented quality failure). Do not download until the current Kanana→EXAONE→A.X queue finishes or bandwidth frees up.

### Option 1 (PREFERRED, experimental, UNOFFICIAL) — Baekpica Mixed-Quant GGUF
- **Repo:** `Baekpica/Motif-3-Mixed-Quant-GGUF` @ `b1897692…f83837a` — **94.16 GB** (87.70 GiB), 11 GGUF shards.
- **Why preferred:** smart mixed quant (attention/GDLA/output-gate kept at Q8_0/BF16/F32; only experts at IQ2_XXS/Q2_K). Numerically near-lossless: Q2_K down cosine **0.9996**, combined sparse output cosine **0.9998**, logit cosine **0.995**, top-8 overlap **8/8**. Card documents **validated OpenAI tool-call + result-loop** and 32K/256K correctness — so GGUF is *not* categorically unsuitable here.
- **Engine:** **`ds4-dfm`** — `Baekpica/ds4` @ branch `dfm`, tag `v0.6.2-dfm`, commit `a09ff4f`. Custom C/CUDA runtime with a native Motif tensor binder + tokenizer/chat/**reasoning/tool** protocol and an OpenAI Chat/Completions/Responses (+ Anthropic) server. **NOT llama.cpp, NOT vLLM.**
- **Memory / GPUs:** measured resident model+runtime = **91.26 GiB on ONE device** → fits a **single** RTX PRO 6000 (96 GB) at limited (~32K) context. Full 256K needs ~128 GB unified (DGX Spark). Runtime is **single-GPU** (no documented 2-GPU split) → it uses one card; the other stays free.
- **⚠️ PRIMARY BLOCKER — CUDA arch:** ds4-dfm's shipped/validated CUDA objects are **`sm_121a` (DGX Spark GB10)** and **`sm_90` (H200)** only. Our cards are **`sm_120`** — a *different* Blackwell target. The vendor's own cross-build audit says the `sm_121a` objects "cannot be executed" off GB10. **Must rebuild ds4 from the pinned source for `sm_120`** (we have CUDA 13 + driver 610; RTX PRO 6000 supports MXFP4 / `DS4_CUDA_HAVE_MXF4`). This `sm_120` build is **unverified by the vendor** — prove it builds and serves **before** committing the 94 GB download.
- **Order of operations if pursued:** (1) `git clone Baekpica/ds4`, checkout `v0.6.2-dfm`; (2) build `cuda-spark`/server target with `-gencode arch=compute_120,code=sm_120` (isolated env/container — do not touch the shared stack); (3) run its Motif loader/tokenizer/CUDA self-tests; (4) only then `hf download Baekpica/Motif-3-Mixed-Quant-GGUF --revision b1897692691833d2531ed4c770de05b51f83837a` (start shard `00001-of-00011`; split-aware runtimes discover the rest; or `llama-gguf-split --merge`).

### Option 2 (fallback only) — jhkim55 IQ2-XXS GGUF
- **Repo:** `jhkim55/Motif-3-Direct-IQ2-XXS-DGX-Spark` @ `3511f72d…18d54` — **83.56 GiB** single GGUF.
- **Engine:** patched **llama.cpp fork** `hebo1221/llama.cpp @ motif3-dgx-spark-v1` (`cc3f13b`) + `motif3-tokenizer-exact-v1` patch; `llama-server` (OpenAI-compatible). Builds with `-DGGML_NATIVE=ON` → likely compiles on our x86/`sm_120` (more portable than ds4-dfm). Serve e.g. `-ngl 99 -fa on -ctk f16 -ctv f16 -c 32768`.
- **Why fallback:** card explicitly states it **"did not pass the prespecified BF16 quality-preservation gates ... systems/research release, not a drop-in,"** with a documented reasoning error (quotes the right number, reaches the wrong conclusion). Uniform 2-bit → weaker, arguably unfair benchmark row. Use only if the Baekpica `sm_120` build proves infeasible.

### Option 3 (official, deferred) — Motif-3 NVFP4
- **Repo:** `Motif-Technologies/Motif-3-NVFP4` @ `79f2fad1…b0dff` — 174 GB, needs **Motif vLLM fork** `ghcr.io/motiftechnologies/vllm:v0.26.0-motif3` (`--quantization modelopt_nvfp4 --tool-call-parser motif --reasoning-parser motif`). Validated on **2× B200 (360 GB)**; 174 GB in our 192 GB leaves ~18 GB → likely unservable at useful context. Highest quality + official parsers, but biggest download and tightest fit. Kept deferred.

## Solar Open 2 (Nota NVFP4)  —  `serving_ready` (VALIDATED 2026-10-26; replaces the intended local Upstage row)
- **Engine:** prebuilt image **`upstage/vllm-solar-open2:1.0.0`** (digest sha256:b34b7dd4…b2b7c8c3, base vLLM **v0.22.0-cu129**, CUDA 12.9.1). **Separate** container from the `vllm/vllm-openai:v0.32.0` Korean stack — no effect on existing servers. CUDA 12.9 ≤ 13.3 driver → no driver change. Launcher **`kserve-solar.sh`** (port 8102, cache `/data/jackb/lil-cache-solar`).
- **Checkpoint:** `nota-ai/Solar-Open2-250B-Nota-NVFP4` @ sha `3cc6733…`, downloaded+verified (29/29 shards, 153.311 GB, UNOFFICIAL third-party quant). Unpruned = uniform experts → avoids the GlobalPruned load bug.
- **Serve cmd (validated):** TP2, `--gpu-memory-utilization 0.90`, `--max-model-len 8192`, **`--max-num-seqs 256`** (hybrid Mamba cache bound — REQUIRED), `--reasoning-parser solar_open2 --tool-call-parser solar_open2 --enable-auto-tool-choice`, `SolarOpen2TemplateLogitsProcessor`, `--default-chat-template-kwargs '{"think_render_option":"preserved"}'`, `--trust-remote-code`. NVFP4 compressed-tensors → NO `--quantization`.
- **Resolved on RTX PRO 6000:** NVFP4-MoE = **FLASHINFER_CUTLASS** (no Marlin/Emulation fallback); TP2 shards clean (71.6 GiB/GPU). Reasoning (`<|think:start|>`/`<|think:end|>` special tokens; parser splits on `<|think:end|>`), structured tool calling, and multi-turn tool-result continuation all PASS at 8K. reasoning_chars=CHARS; provider reasoning_tokens unavailable→null; `reasoning_effort` default "high" → budget ≥4–7K. 131K won't fit.
- **Status:** `serving_ready` (SERVING gates pass); **`benchmark_ready` pending** (harness integration not yet validated). Full details in **`solar-open2-assessment.md`**, `smoke-test-results.md`.

## Solar Pro 4 (Upstage)  —  `api_only` (OPTIONAL separate baseline, NOT equivalent to Solar Open 2)
- No local serving. Register as an **OpenRouter** OpenAI-compatible endpoint in the agent harness. Credentials intentionally not configured/tested this session. Kept as an optional API baseline only — different generation + hosted vs local open-weights; do **not** present as the same checkpoint as the local Solar Open 2 row.

---

## Isolated-environment spec (for later, if forks are needed)
Rather than modifying the shared vLLM/CUDA/PyTorch install:
- **Motif-3:** run the vendor Docker image `ghcr.io/motiftechnologies/vllm:v0.26.0-motif3` (mirrors the existing llama-swap docker pattern). No host Python changes.
- **EXAONE SGLang:** if SGLang is wanted over vLLM, create a dedicated `uv`/venv and `uv pip install 'git+https://github.com/lkm2835/sglang.git@add-exaone4_5#subdirectory=python&egg=sglang[all]'` + matching `transformers>=5.8.0`. Otherwise use stock vLLM (no isolation needed).
- Kanana / EXAONE-vLLM / A.X run on the **existing** vLLM stack — verify its version meets the per-model minimums above before serving.
