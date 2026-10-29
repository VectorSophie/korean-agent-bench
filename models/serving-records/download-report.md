# Korean frontier-model acquisition report

_Generated 2026-10-21 · machine: 2× NVIDIA RTX PRO 6000 Blackwell Max-Q (96 GB each, 192 GB aggregate, SM120, driver 610.57.04, PCIe/no NVLink) · HF account: VectorSophie · cache: `/data/jackb/krasis/huggingface/hub`_

This is **acquisition/storage preparation only** — no benchmarks run, no servers launched, no weights loaded into GPU memory. Metadata (sizes, SHAs, gating) is from **live HF queries on 2026-10-21**, not assumed.

## 1. GLM-5.3 status
**Complete** — `local-inference-lab/GLM-5.3-Flash-NVFP4-Spark` is fully on disk at 175 GB (finished 2026-10-15, verified then). It was **not** touched by this task. MiMo-V2.6-Flash (166 GB) is also complete. **No downloads were active** when this task started, so there was nothing to preserve mid-flight and no bandwidth competition. GLM/MiMo are not part of this Korean benchmark set.

## 2. Disk capacity
| | /data free | /data used |
|---|---|---|
| Before this task | **1.5 TB** (1514 GB) | 2.0 TB (57%) |
| After planned active downloads (~230 GB: Kanana+EXAONE+A.X) | **~1.28 TB** | ~2.23 TB |
| If Motif-3 were also pulled (+174 GB) | ~1.11 TB | — |

Inodes 1% used. The 150 GB free-space floor is never threatened (the queue self-aborts a model if free space would drop below 160 GB). Disk is **not** the limiting factor — the ~0.8–2 MiB/s upstream throttle is (≈2–4 days for the three active models).

## 3–6. Per-model status, paths, revisions, sizes, quant

| Model | Repo | Pinned SHA | Size | Quant | Status |
|---|---|---|---|---|---|
| Kanana 2 30B-A3B Thinking | `kakaocorp/kanana-2-30b-a3b-thinking-2601` | `cdcbf8b8…433c0844` | 57.14 GB | BF16 | **downloading** (1st) |
| EXAONE 4.5 33B FP8 | `LGAI-EXAONE/EXAONE-4.5-33B-FP8` | `69570ad5…6447f1be` | 38.48 GB | FP8 (compressed-tensors) | **queued** (2nd) |
| A.X 4.0 (72B) | `skt/A.X-4.0` | `a3393fd6…c4497b67` | 133.92 GB | BF16 | **queued** (3rd) |
| Raon-1 mini preview | `KRAFTON/Raon-1-mini-preview` | `8d2ced8f…bbfb33b4` | 30.47 GB (API-visible) | MXFP8 | **access_blocked** |
| Motif 3 NVFP4 | `Motif-Technologies/Motif-3-NVFP4` | `79f2fad1…d6fb0bff` | 174.07 GB | NVFP4 | **deferred_compatibility** |
| Solar Pro 4 | OpenRouter (no weights) | — | 0 | N/A | **api_only** |

Local checkpoint paths (HF snapshot layout): `/data/jackb/krasis/huggingface/hub/models--<org>--<name>/snapshots/<sha>/`. Live status is tracked in `download-status.json`; full metadata in `models-manifest.json`.

## 7. GPU fit (2× RTX PRO 6000, 96 GB each)
- **Kanana 2 (57 GB BF16)** — fits a **single** GPU; TP2 optional for long-context headroom.
- **EXAONE 4.5 FP8 (38.5 GB)** — weights fit one GPU; **TP2** recommended to hold the full 256K-token KV cache.
- **A.X 4.0 (134 GB BF16)** — **TP2 required** (exceeds one 96 GB GPU; fits across 192 GB with KV room).
- **Motif-3 NVFP4 (174 GB)** — ⚠️ validated on **2× B200 (360 GB)**. On our 192 GB, weights alone leave ~18 GB for KV + activations + expert-routing buffers on a **314B/256K** MoE → **likely unservable at useful context**. See §8/§9.
- **Solar Pro 4** — no local GPU (remote API).

## 8. Models needing special serving software
- **Motif-3** — requires the **Motif vLLM fork** `ghcr.io/motiftechnologies/vllm:v0.26.0-motif3` (github.com/MotifTechnologies/vllm, based on vLLM v0.26.0). Stock vLLM cannot load `MotifForCausalLM`. Parsers: `--tool-call-parser motif --reasoning-parser motif`, `--quantization modelopt_nvfp4`.
- **EXAONE 4.5** — stock vLLM works (`>=0.5.8` per card); SGLang needs the EXAONE **fork** (`git+https://github.com/lkm2835/sglang.git@add-exaone4_5`). TensorRT-LLM also officially documented.
- **Kanana 2 / A.X 4.0** — **stock** vLLM (`deepseek_v3` and `qwen2` archs). No fork.

## 9. Gated-access / license blockers
- **Raon-1 mini — GATED, BLOCKED.** `GatedRepoError 403`: account **VectorSophie is not in the authorized list**. `model_info` returns metadata (sizes/files) but file access is denied. **Not retried** (per instructions). To unblock: request access at https://huggingface.co/KRAFTON/Raon-1-mini-preview (and the `-nvfp4` variant separately). No gated access was circumvented.
- **Licenses:** Kanana = custom **Kanana License**; EXAONE = custom **EXAONE AI Model License**; A.X 4.0 = **Qwen License**; Motif-3 = **MIT**; Raon = unknown (gated); Solar = API terms. The three custom licenses are "other" — review their terms before any redistribution/commercial use; all permit local research use.

## 10. Still waiting
- **EXAONE 4.5 FP8**, **A.X 4.0** — queued behind Kanana (one at a time, to not split the throttled link).
- **Motif-3** — weights **deferred** (compatibility, see §7); revision pinned so it can be fetched later on one command if you decide to attempt reduced-context serving or move it to B200-class hardware.
- **Raon** — waiting on access approval.

## 11. Recommended next steps (smoke tests, later — not done here)
1. After each model reaches `ready_downloaded`, smoke-test via its serving engine with `--max-model-len 32768` first (keeps KV small, fast sanity check), then a 1-token-ish `/v1/chat/completions`.
2. Bring them up **one at a time** through llama-swap (each uses both GPUs); see `serving-notes.md` for exact flags/parsers per model.
3. A.X 4.0 and EXAONE need **TP2**; Kanana can run TP1.
4. For Motif-3, if you still want it: pull weights (`hf download Motif-Technologies/Motif-3-NVFP4 --revision 79f2fad1f8229f5db8a7ad08bbd24a20d6fb0bff`) **and** stand up the Motif vLLM fork image in an **isolated** environment — do not modify the shared vLLM/CUDA stack.
5. Request Raon access, then re-run the probe to fill its manifest row.
6. Register Solar Pro 4 as an OpenRouter endpoint in the agent harness (no local work).

## Download mechanics / resilience
- Tool: `hf download` (huggingface_hub 1.31.0), **`HF_HUB_DISABLE_XET=1`** — xet's chunked downloader crash-loops on this throttled/lossy link; plain HTTP range-resume is reliable and resumes from partial shards. (This intentionally departs from the generic "use xet" suggestion, for a documented environment-specific failure.)

### Is disabling xet actually helping throughput? (investigated 2026-10-21, no disruptive A/B)
Finding: **disabling xet is a reliability fix, not a throughput trade-off — there is no throughput downside here.** Evidence, gathered without interrupting the active queue (per instruction):
- Every transfer on this box runs at the same **~0.8–2.0 MiB/s** ceiling (GLM, MiMo, and Kanana now). A live sample while writing this: Kanana at **2.00 MiB/s**, and total host RX **1.8 MiB/s** — i.e. the download is essentially the machine's *entire* inbound traffic. The bottleneck is the **upstream bandwidth cap**, which is a hard ceiling independent of transfer protocol.
- Xet (content-addressed chunk dedup) only saves bytes when chunks are already cached locally or dedupe across files — it **cannot exceed a fixed bandwidth ceiling** for the net-new shard bytes a fresh model download consists of. So even working, xet could not beat ~2 MiB/s here.
- Xet previously **crash-looped** on this link (`CAS Client Error ... error decoding response body`, writing nothing) — a correctness failure on the lossy connection, not a slow-but-working path.
- Conclusion: keep `HF_HUB_DISABLE_XET=1`. A definitive xet-vs-HTTP A/B was **not** run (would compete with the active queue); it can be done in an idle window if a hard number is wanted, but the ceiling is upstream and unlikely to differ.
- Queue: `download_queue.sh` (pid in `download_queue.pid`, structured log `/data/jackb/logs/korean-dl.log`). Sequential, one model at a time. Bounded retries (6) with exponential backoff (30→600 s). Self-aborts a model if free space would fall below 160 GB. Each model is verified on completion (shard count vs index `weight_map`, zero `.incomplete` blobs, snapshot size) before being marked `ready_downloaded`; anything short is marked `partially_downloaded`.
- A partial download is **never** reported as complete.
