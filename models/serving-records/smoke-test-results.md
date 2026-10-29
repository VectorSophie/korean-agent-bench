# Korean-model serving smoke-test results

_Status: **COMPLETE (2026-10-23; Solar Open 2 added 2026-10-26)** — the three Korean models smoke-tested on the official `vllm/vllm-openai:v0.32.0` image (CUDA 13.0, sm_120); **Solar Open 2 250B (Nota NVFP4)** smoke-tested separately on the Upstage fork image `upstage/vllm-solar-open2:1.0.0` (vLLM v0.22.0-cu129) — all four now `serving_ready`. Run under authorized GPU co-occupancy beside idle Sinsan bots; ragas/Sinsan/GLM/MiMo untouched; each server stopped cleanly between models. **Result: all 3 serve and generate on sm_120 (CUDA blocker cleared); all 3 are `serving_ready`** (all serving smoke gates pass). Reasoning extraction RESOLVED 2026-10-23 for Kanana + EXAONE (see "Reasoning-parser investigation" below). See per-model sections + measurements summary._

> **`serving_ready` ≠ `benchmark_ready`.** These three passed their *serving* smoke tests. Full integration into the actual benchmark harness (client adapter normalizing content / tool_calls / reasoning / usage / finish_reason, end-to-end) is a separate step and is **not yet validated**. `benchmark_ready` is reserved for that.
>
> **Reasoning counts are CHARACTERS, not tokens.** Where this doc says e.g. "954 ch" / "3000 ch", that is `len(reasoning)` in characters. Provider `usage.reasoning_tokens`: **reliable for EXAONE** (837–2054 tokens observed); **null for Kanana** (deepseek_r1 reports 0 even with thousands of reasoning chars — reported as `null`, never the wrong 0). A tokenizer-derived reasoning token count can be computed offline from the saved reasoning text if a true token count is needed.

## Reasoning-parser investigation (RESOLVED 2026-10-23)
The earlier "reasoning extraction unreliable" flag for Kanana (`deepseek_r1`) and EXAONE (`qwen3`) was **NOT a parser incompatibility**. Two separate, mundane causes, both now fixed in `smoke_test.py`:

1. **Wrong response field.** vLLM v0.32.0 returns the extracted reasoning in the message field **`reasoning`**, not `reasoning_content` (confirmed by raw dump: message keys `[role, content, refusal, annotations, audio, function_call, reasoning]`). The prior harness read `reasoning_content` → always empty. Fix: read `reasoning` (fallback `reasoning_content`).
2. **Inadequate token budget.** Both are heavy thinking models. At `max_tokens` 256/512 (and even 6000 for hard problems) generation is truncated *before* the closing `</think>`, so the parser (correctly) returns the whole stream as reasoning with `content=None` (`finish_reason: length`). That is an *unfinished reasoning sequence*, not a broken parser. Fix: budget ≥ 4096 (8192 used here); hard math/logic reasoning alone can exceed 6000 tokens.

**Both vendor-recommended parsers are correct and need no change.** Proven two ways:
- **Offline, deterministic** (`parser_regression_test.py`, CPU-only, no GPU/weights): runs the real `DeepSeekR1ReasoningParser` and `Qwen3Parser` on canned outputs. Both correctly (a) split `reasoning</think>answer`, (b) return all-reasoning+`content=None` when `</think>` is absent (the truncation case), (c) strip an optional leading `<think>`, and (d) for EXAONE `enable_thinking=False` return all-content/no-reasoning. All assertions PASS.
- **Live** (8192 budget, vendor sampling): both populate `reasoning` separate from `content`, `finish_reason: stop`, no `<think>`/`</think>` leak into content, and reasoning is correctly present-but-not-leaked during tool calling.

**Template mechanism (both models):** the chat template injects the opening `<think>\n` into the assistant *prompt* prefix (Kanana unconditionally; EXAONE when `enable_thinking` is true/default), so the model generates only the reasoning body + closing `</think>` + answer. Both parsers are built for exactly this (deepseek_r1 strips an optional leading `<think>`; qwen3's ParserEngine *starts* in `ParserState.REASONING`). `<think>`/`</think>` are single vocab tokens in both (Kanana 128032/128033, EXAONE 54/55).

**Metric caveat:** `usage.completion_tokens_details.reasoning_tokens` is **reliable for EXAONE** (qwen3 engine, e.g. 837–2054) but reads **0 for Kanana** (`deepseek_r1` counts tokens strictly *between* a generated `<think>` and `</think>`; since `<think>` is in the prompt, not generated, the count is 0 even with thousands of reasoning chars). For Kanana, use `len(reasoning)` / `completion_tokens`, not `reasoning_tokens`.

**Model behavior note:** both models emit their chain-of-thought **in English** even for Korean prompts (EXAONE README footnote ¶ confirms this), then answer in Korean. Expected; not a defect. Kanana also sometimes closes `<think>` immediately for easy prompts and answers inline (reasoning empty) — also valid.

Image under test: `vllm/vllm-openai:v0.32.0` (CUDA 13.0.2), amd64 digest
`sha256:6ee133356d49ed24cee03dd0cda3d3980279a11c107ce3e752c89e76540f41c9`.
Fallback `-cu129` (CUDA 12.9.1) only if a genuine primary-image kernel issue appears.

Harness: `smoke_test.py` (pure stdlib). Launcher: `kserve.sh`. Port 8101, one model at a time.
Context length starts at **16K**; any reduction is recorded with the reason.

## Procedure (per model, sequential)
1. `./kserve.sh start <key> 16384` → `./kserve.sh wait <key>` (loadable + CUDA init + health).
2. `python3 smoke_test.py --model <served> --reasoning <parser|none> --container kserve-<key> --devices <d> --out results/<key>.json`.
3. Record load time (from container logs: "Application startup complete" / engine init) and TTFT/tok/s (from harness).
4. `./kserve.sh stop <key>` (clean shutdown) before the next model.

## Readiness taxonomy
`downloaded` → `loadable` → `inference_ready` → `tool_ready` → `serving_ready` → `benchmark_ready` → `blocked`.
A model is **not** `serving_ready` on weight-load or a single completion alone — all of B/C/D(where applicable)/E must pass reproducibly. `benchmark_ready` is a further step beyond serving: successful end-to-end integration in the actual benchmark harness (not done yet for any model).

---

## Kanana 2 30B-A3B Thinking — TESTED 2026-10-23 (GPU 1, util 0.75, 16K ctx) — metrics `contended`-policy (GPU was actually quiet beside idle Sinsan)
- Config: `DeepseekV3ForCausalLM`, BF16, **MoE**, TP1, **GPU 1** (not 0; GPU0 also free), reasoning `deepseek_r1`, tool `hermes`, image `vllm/vllm-openai@sha256:6ee1333…` (v0.32.0, CUDA 13.0).
- **A. Loading: PASS** — ready in **~110 s**, no CUDA/PTX error. **This clears the sm_120 MoE blocker** that crashed the karmic (CUDA 13.4) image on the first MoE kernel. KV profiling/graph-capture spike to 100% util completed cleanly.
- **B. Basic generation: PASS** (harness auto-flag was a false negative). Throughput **~140 tok/s**, `finish_reason: stop`, correct Korean output verified across 6 manual probes. The harness `ok=false` was an artifact: this is a thinking model + `max_tokens=256` + the harness reads only `content`; at default temp a stochastic long reasoning run filled the budget before `content`. Replays returned correct, complete `content`.
- **C. Tool call + multi-turn result: PASS** — turn-1 emitted `get_current_weather` with valid-JSON args; turn-2 consumed a synthetic tool result correctly ("서울의 현재 날씨는 섭씨 7도이며, 흐린 상태입니다"). `args_valid_json=true`, `uses_result=true`, no reasoning leak.
- **D. Reasoning extraction: PASS ✅ (RESOLVED 2026-10-23).** With the `reasoning` field + 8192 budget + vendor sampling (`temp 0.6, top_p 0.95, top_k 20`): `finish_reason: stop`, **reasoning extracted = 954 chars**, content separate = 667 chars, no `<think>`/`</think>` leak, and during tool calling reasoning is present but correctly not leaked into `tool_calls`/content. Config = vendor default (`--reasoning-parser deepseek_r1 --enable-auto-tool-choice --tool-call-parser hermes`, README line 621 — exact match). Caveat: `usage.reasoning_tokens` reads **0** (deepseek_r1 counts between a *generated* `<think>`, which is in the prompt here — use `len(reasoning)`). Hard math/logic reasoning can exceed 6000 tokens → budget generously for reasoning-heavy evals.
- **E. Resources:** peak **75,739 MiB** on GPU 1 (container RSS ~59.5 GiB; device incl. allocator ~74.9 GiB), **21.5 GiB free** maintained, Sinsan untouched (772 MiB). ~140 tok/s, 16K ctx, TP1, util 0.75. Clean release to 782 MiB on stop.
- **Readiness:** **`serving_ready`** ✅ — gen + structured tool-call + tool-result + reasoning separation all pass. Good for tool/agentic AND reasoning-trace-dependent evals. (Harness integration not yet validated → not `benchmark_ready`.)

## EXAONE 4.5 33B FP8 — TESTED 2026-10-23 (GPU 1, util 0.55, 16K ctx) — metrics `contended`-policy (GPU quiet beside idle Sinsan)
- Config: `Exaone4_5_ForConditionalGeneration`, **compressed-tensors FP8**, dense, TP1, **GPU 1**, reasoning `qwen3`, tool `hermes`.
- **A. Loading: PASS** — ready ~**220 s**, no CUDA error. **FP8 compressed-tensors kernels initialize and run on sm_120.** Multimodal class loaded the text-only ckpt fine (no vision path exercised).
- **B. Basic generation: PASS** (harness false negative). ~**34 tok/s** (33B dense FP8, one GPU — reasonable). Correct Korean output verified (incl. a 1192-char logic-puzzle CoT, `finish_reason: stop`). Harness `ok=false` = token-budget artifact: EXAONE is a heavy thinking model and at the harness's small `max_tokens` (256/512) the think phase consumed the whole budget before `content`. With `max_tokens≥4000` it completes correctly.
- **C. Tool call + multi-turn result: PASS** (manually; harness `uses_result=false` was the same budget artifact). Turn-1 emitted `get_current_weather` w/ valid-JSON args; with `max_tokens=4000` turn-2 consumed the synthetic result correctly ("서울의 현재 날씨는 7도이며, 흐림입니다").
- **D. Reasoning extraction: PASS ✅ (RESOLVED 2026-10-23), both thinking modes tested.** With the `reasoning` field + 8192 budget + vendor Korean sampling (`temp 0.6, top_p 0.95, top_k 20, presence_penalty 1.5`):
  - `enable_thinking=True` (default): `finish_reason: stop`, **reasoning extracted = 3000 chars** (raw probe 5977), content separate = 777 chars, no tag leak, `reasoning_tokens=837–2054` (**reliable** for the qwen3 engine).
  - `enable_thinking=False`: reasoning correctly empty, content only (1124 chars) — non-reasoning mode works.
  - Tool calling correct in both modes (reasoning present-but-not-leaked when on; absent when off). Config = vendor default (`--reasoning-parser qwen3 --tool-call-parser hermes`, README lines 523/542 — exact match).
- **E. Resources:** peak **51,593 MiB** on GPU 1 (EngineCore 50.8 GB + Sinsan 0.77 GB), **45.7 GiB free** maintained, util 0.55, 16K ctx, TP1. Clean release to 782 MiB on stop; Sinsan untouched.
- **Readiness:** **`serving_ready`** ✅ — gen + tool-call + tool-result + reasoning separation (both thinking modes) all pass. (Harness integration not yet validated → not `benchmark_ready`.)

## A.X 4.0 72B — TESTED 2026-10-23 (GPU 0+1, TP2, util 0.82, 16K ctx) — metrics `contended`-policy (GPUs quiet beside idle Sinsan)
- Config: `Qwen2ForCausalLM`, BF16, dense, **TP2 (both GPUs)**, reasoning N/A (non-thinking), tool `hermes`. Checkpoint pre-verified 30/30 shards.
- **A. Loading: PASS** — ready ~**220 s**, no CUDA error, **TP2 sharded cleanly across both GPUs** (Worker_TP0/TP1 ~79.9 GB each over PCIe, no NVLink).
- **B. Basic generation: PASS** (clean, no artifact — non-thinking). **~17 tok/s** (72B dense, TP2 over PCIe — expected), `ttft 0.094 s`, correct Korean ("대한민국의 수도는 서울입니다 … 경복궁 …").
- **C. Tool call + multi-turn result: PASS** — `get_current_weather`, valid-JSON args, turn-2 used result ("현재 서울의 날씨는 흐리며, 기온은 섭씨 7도입니다"). `uses_result=true`.
- **D. Reasoning: N/A** (non-thinking; `reasoning_content` null by design — correctly treated as N/A, not a failure).
- **E. Resources:** **81,171 / 80,771 MiB** across GPU 0/1 (100% util during gen), container 140.2 GiB, ~16 GiB free/GPU, Sinsan untouched. Clean release on stop.
- **Readiness:** **`serving_ready`** ✅ — full hard serving gate (gen + tool-call + tool-result) passes with no caveats; reasoning N/A. (Harness integration not yet validated → not `benchmark_ready`.)

---

## Solar Open 2 250B (Nota NVFP4) — TESTED 2026-10-26 (GPU 0+1, TP2, util 0.90, 4K→8K ctx) — **separate image**: Upstage fork `upstage/vllm-solar-open2:1.0.0` (vLLM v0.22.0-cu129), NOT the v0.32.0 Korean stack. Metrics `contended` (GPUs quiet beside idle Sinsan).
- Config: `SolarOpen2ForCausalLM` / `solar_open2`, **NVFP4 W4A4 (compressed-tensors, no `--quantization`)**, **hybrid attention+Mamba MoE** (48L, 320 experts, 8 active), TP2 both GPUs, `--reasoning-parser solar_open2 --tool-call-parser solar_open2` + `SolarOpen2TemplateLogitsProcessor`, `think_render_option: preserved`, `trust_remote_code`. Checkpoint verified 29/29 shards @ sha 3cc6733…
- **A. Loading: PASS** — **NVFP4-MoE = `FLASHINFER_CUTLASS`** on sm_120 (no Marlin/Emulation fallback, no PTX error); TP2 shards clean (**71.6 GiB/GPU**, NCCL 2.28.9 + CUSTOM/PYNCCL over PCIe); ready ~190 s @8K (load 31 s, graph capture 12 s, engine init 79 s). **Required flag:** `--max-num-seqs 256` (hybrid Mamba: default 1024 > 401 cache blocks → engine-init crash).
- **B. Basic generation: PASS** — correct Korean.
- **C. Tool call + multi-turn result: PASS** — `get_weather({"city":"부산","unit":"c"})` (typed args, inferred unit from "섭씨"); turn-2 continuation used result → "부산의 현재 날씨는 19°C이며, 맑음" (`finish=stop`). Reasoning separated in both turns, no leak.
- **D. Reasoning: PASS** — delimiters are special tokens **`<|think:start|>`/`<|think:end|>`** (template prefills `<|think:start|>` into the prompt); `solar_open2` parser splits on `<|think:end|>` textually. Finished logic puzzle: `finish=stop`, **reasoning 4626 chars** in `reasoning` field, 636-char Korean answer, **no `<|think` leak**; English CoT → Korean answer. The `reasoning_start_str`/`reasoning_end_str` auto-init warning is **BENIGN** (parser is text-based; verified by reading the parser source). `reasoning_effort` defaults "high" → budget ≥4–7K (trivial prompts over-think and truncate at 4K).
- **E. Resources:** **88.3 GB/GPU** at util 0.90 (7.6–8.0 GB free/GPU); KV @8K 10.89 GiB → 329,914 tokens → 40× (@4K 9.79 GiB → 233,472 → 57×); ~34 tok/s reasoning; Sinsan untouched; clean release on stop (both GPUs → Sinsan-only baseline).
- **Readiness:** **`serving_ready`** ✅ — gen + structured tool-call + multi-turn tool-result + reasoning separation all pass at 8K. 131K ctx won't fit (KV). (Harness integration not yet validated → not `benchmark_ready`.)

---

## Measurements summary
| Model | load_s | tok/s | TTFT_s | peak VRAM | ctx | TP | util | reasoning | readiness |
|---|---|---|---|---|---|---|---|---|---|
| Kanana-2 | ~110 | ~140 | — | 75.7 GB (GPU1) | 16K | 1 | 0.75 | ✅ `reasoning` field, 954 chars (provider rtoks=null/unreliable) | **serving_ready** |
| EXAONE-4.5 | ~220 | ~34 | — | 51.6 GB (GPU1) | 16K | 1 | 0.55 | ✅ `reasoning` field, 3000 chars, provider rtoks 837–2054 (reliable) | **serving_ready** |
| A.X-4.0 | ~220 | ~17 | 0.094 | 81.2+80.8 GB (GPU0+1) | 16K | 2 | 0.82 | N/A (non-thinking) | **serving_ready** |
| Solar-Open2 (NVFP4) | ~190 (@8K) | ~34 | — | 88.3+88.3 GB (GPU0+1) | 8K | 2 | 0.90 | ✅ `reasoning` field, 4626 chars (`<|think:end|>` split; provider rtoks=null) | **serving_ready** |

_All three are serving-ready; none is `benchmark_ready` yet (harness integration pending). Reasoning sizes above are CHARACTERS._

_All throughput/VRAM numbers are policy-tagged `contended` (co-occupancy run), though in practice each GPU was quiet beside an idle ~1 GB Sinsan chess-bot resident, not under active competition — treat as indicative, not clean benchmark figures._

---

## Failure log
_(classified by earliest failing stage: checkpoint load / arch / CUDA-PTX-kernel / attention backend / MoE / FP8 / tokenizer-chat-template / reasoning parser / tool-call parser / API format / GPU OOM)_

1. **CLI/arg (all models, launcher):** v0.32.0 removed `--disable-log-requests` → vLLM exited code 2 at arg-parse before any CUDA init. **Fixed** in `kserve.sh` (flag dropped). Also removed `--rm` so failed containers keep logs. **Not CUDA/arch.**
2. **Reasoning parser (Kanana `deepseek_r1`, EXAONE `qwen3`) — RESOLVED 2026-10-23, no parser change:** earlier "unreliable" was (a) harness read `reasoning_content` but v0.32.0 uses the **`reasoning`** field, and (b) `max_tokens` 256/512 truncated before `</think>` (unfinished sequence, not a broken parser). Fixed in `smoke_test.py` (read `reasoning`, budget ≥4096). Both parsers verified correct offline (`parser_regression_test.py`) and live. See the "Reasoning-parser investigation" section.
3. **Harness ergonomics (not a model failure):** `smoke_test.py` now defaults `--max-tokens 4096` (use 8192 for reasoning-heavy), records `finish_reason`/token counts/`reasoning_finished` so a *length*-truncated run is never mislabeled a parser bug, tests `enable_thinking` on+off (EXAONE), and takes `--sampling` for vendor params. A.X (non-thinking) unaffected.
4. **Solar Open 2 config (hybrid Mamba), RESOLVED 2026-10-26 — not a kernel/NVFP4 failure:** first TP2 launch crashed at engine init (AFTER weights loaded + MoE profiled) with `max_num_seqs (1024) exceeds available Mamba cache blocks (401)`. Solar is a hybrid attention+Mamba MoE; each decode seq needs a Mamba cache block. **Fixed** by `--max-num-seqs 256` (baked into `kserve-solar.sh`). The NVFP4-MoE FlashInfer-CUTLASS path and TP2 sharding were already working at that point. Also fixed a launcher gate-return bug (`gpu_free_check` returned the test's exit code on success).
5. **Solar reasoning "missing" at 4K — RESOLVED, same budget lesson:** a pure-reasoning prompt at `max_tokens` too small for `reasoning_effort=high` never reaches `<|think:end|>`, so the parser correctly returns `(reasoning=None, content=all)` — looks like missing reasoning but is an unfinished think. Budget ≥4–7K at 8K ctx → `finish=stop`, reasoning separated. No parser change.

**No CUDA/PTX, attention-backend, MoE, FP8, or OOM failures occurred.** The sm_120 compatibility that broke the karmic (CUDA 13.4) image is fully resolved on official v0.32.0 (CUDA 13.0): Kanana MoE, EXAONE FP8, and A.X BF16-TP2 all loaded and generated.

## Measurements
See the **Measurements summary** table above (load_s / tok-s / TTFT / peak VRAM / ctx / TP / util / reasoning / readiness).
