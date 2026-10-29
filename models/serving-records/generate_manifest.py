#!/usr/bin/env python3
"""Build models-manifest.json from probe_raw.json + serving analysis. No fabrication: unknown -> null."""
import json
PROBE = json.load(open("/home/jackb/workspace/model-prep/probe_raw.json"))
HUB = "/data/jackb/krasis/huggingface/hub"

def snap(repo, sha):
    return f"{HUB}/models--{repo.replace('/','--')}/snapshots/{sha}"

def sz(key):
    r = PROBE.get(key, {})
    return r.get("total_bytes"), r.get("total_human"), r.get("sha"), r.get("n_safetensors")

# Serving analysis is sourced from each repo's README (fetched live), not invented.
MODELS = []

b,h,sha,n = sz("kanana-2")
MODELS.append({
  "name":"Kanana 2 30B-A3B Thinking","org":"Kakao","repo":"kakaocorp/kanana-2-30b-a3b-thinking-2601",
  "revision":sha,"local_snapshot_path":snap("kakaocorp/kanana-2-30b-a3b-thinking-2601",sha),
  "weight_dtype_or_quant":"BF16","params_total":"30B","params_activated":"~3B (a3b)","arch":"DeepseekV3ForCausalLM / deepseek_v3 (MoE, 128 routed experts, 6 active)",
  "context_length":32768,"context_extendable_to":131072,
  "checkpoint_size_bytes":b,"checkpoint_size":h,"n_safetensors":n,
  "gpu_requirements":"Fits a single RTX PRO 6000 (57GB < 96GB) in BF16; TP2 optional for headroom/long ctx.",
  "recommended_engine":"vLLM (stock, deepseek_v3 supported) or SGLang","recommended_tensor_parallelism":1,
  "chat_template":"Bundled chat_template.jinja (tool_call + <think> reasoning).",
  "reasoning_parser":"deepseek_r1 (vLLM) / deepseek-r1 (SGLang)","tool_call_parser":"hermes (vLLM) / qwen (SGLang)",
  "tool_calling":"yes (official --enable-auto-tool-choice)","license":"Kanana License (custom, 'other')",
  "download_status":"queued","compatibility_notes":"Native 32K ctx; use --hf-overrides rope_scaling deepseek_yarn factor=4 for 131K. Standard arch; no fork needed.",
  "blocking_issues":None})

b,h,sha,n = sz("exaone-4.5-fp8")
MODELS.append({
  "name":"EXAONE 4.5 33B FP8","org":"LG AI Research","repo":"LGAI-EXAONE/EXAONE-4.5-33B-FP8",
  "revision":sha,"local_snapshot_path":snap("LGAI-EXAONE/EXAONE-4.5-33B-FP8",sha),
  "weight_dtype_or_quant":"FP8 (compressed-tensors float-quantized, dynamic per-token)","params_total":"33B","params_activated":"33B (dense)","arch":"Exaone4_5_ForConditionalGeneration / exaone4_5 (text; has processor_config.json but no vision weights)",
  "context_length":262144,"context_extendable_to":None,
  "checkpoint_size_bytes":b,"checkpoint_size":h,"n_safetensors":n,
  "gpu_requirements":"TP2 recommended (card: 256K ctx on 1xH200 or 4xA100-40GB). 38.5GB FP8 fits one GPU for weights; TP2 for full 256K KV.",
  "recommended_engine":"vLLM (>=0.5.8 per card), TensorRT-LLM, or SGLang (EXAONE fork)","recommended_tensor_parallelism":2,
  "chat_template":"Bundled chat_template.jinja (tool_call + <think> reasoning).",
  "reasoning_parser":"qwen3","tool_call_parser":"hermes",
  "tool_calling":"yes (official --enable-auto-tool-choice)","license":"EXAONE AI Model License (custom, 'other')",
  "download_status":"queued","compatibility_notes":"FP8 is native on Blackwell (SM120). transformers>=5.8.0 per card. processor_config.json present; no image inputs observed.",
  "blocking_issues":None})

b,h,sha,n = sz("ax-4.0")
MODELS.append({
  "name":"A.X 4.0 (72B)","org":"SK Telecom","repo":"skt/A.X-4.0",
  "revision":sha,"local_snapshot_path":snap("skt/A.X-4.0",sha),
  "weight_dtype_or_quant":"BF16","params_total":"72B","params_activated":"72B (dense)","arch":"Qwen2ForCausalLM / qwen2 (dense, hidden 8192 x 80 layers)",
  "context_length":131072,"context_extendable_to":None,
  "checkpoint_size_bytes":b,"checkpoint_size":h,"n_safetensors":n,
  "gpu_requirements":"TP2 REQUIRED: 134GB BF16 weights exceed one 96GB GPU; fits across 2x96GB (192GB) with room for KV.",
  "recommended_engine":"vLLM (>=0.6.4.post1 for tool-use; stock Qwen2 support)","recommended_tensor_parallelism":2,
  "chat_template":"Bundled tokenizer chat_template (tool_call). Non-thinking: reasoning_content is null in examples.",
  "reasoning_parser":None,"tool_call_parser":"hermes",
  "tool_calling":"yes (official --enable-auto-tool-choice --tool-call-parser hermes)","license":"Qwen License (custom, 'other')",
  "download_status":"queued","compatibility_notes":"No official lower-precision variant found on the skt repo; using original BF16. Standard Qwen2 arch; no fork. No reasoning/thinking mode.",
  "blocking_issues":None})

# Raon — gated, blocked
rr = PROBE.get("raon-1-mini", {}); rn = PROBE.get("raon-1-mini-nvfp4", {})
MODELS.append({
  "name":"Raon-1 mini preview","org":"KRAFTON","repo":"KRAFTON/Raon-1-mini-preview",
  "revision":rr.get("sha"),"local_snapshot_path":None,
  "weight_dtype_or_quant":"MXFP8 (primary) — not inspected (gated)","params_total":"unknown (mini)","params_activated":None,"arch":None,
  "context_length":None,"context_extendable_to":None,
  "checkpoint_size_bytes":rr.get("total_bytes"),"checkpoint_size":rr.get("total_human"),"n_safetensors":rr.get("n_safetensors"),
  "gpu_requirements":"unknown (config gated)","recommended_engine":"unknown (gated; card not readable)","recommended_tensor_parallelism":None,
  "chat_template":"unknown (gated)","reasoning_parser":None,"tool_call_parser":None,"tool_calling":"unknown",
  "license":"unknown (gated)","download_status":"access_blocked",
  "compatibility_notes":f"Metadata visible via API (primary {rr.get('total_human')}/{rr.get('n_safetensors')} shards; nvfp4 alt {rn.get('total_human')}/{rn.get('n_safetensors')} shards), but file access is 403. NVFP4 alt revision {rn.get('sha')}.",
  "blocking_issues":"GatedRepoError 403: account 'VectorSophie' is NOT in the authorized list. Request access at https://huggingface.co/KRAFTON/Raon-1-mini-preview . Not retried (per instructions)."})

# Motif-3 — deferred on compatibility
b,h,sha,n = sz("motif-3-nvfp4")
MODELS.append({
  "name":"Motif 3 NVFP4","org":"Motif Technologies","repo":"Motif-Technologies/Motif-3-NVFP4",
  "revision":sha,"local_snapshot_path":snap("Motif-Technologies/Motif-3-NVFP4",sha)+"  (NOT YET DOWNLOADED)",
  "weight_dtype_or_quant":"NVFP4 (modelopt_nvfp4, group_size 16)","params_total":"314B (per model card)","params_activated":None,"arch":"MotifForCausalLM / Motif (MoE, 384 experts, 53 layers)",
  "context_length":262144,"context_extendable_to":None,
  "checkpoint_size_bytes":b,"checkpoint_size":h,"n_safetensors":n,
  "gpu_requirements":"VALIDATED on 2xB200 (360GB aggregate). On our 2x96GB (192GB), 174GB weights leave ~18GB for KV/activations/expert buffers for a 314B/256K MoE — very likely insufficient at meaningful context.",
  "recommended_engine":"Motif vLLM FORK: ghcr.io/motiftechnologies/vllm:v0.26.0-motif3 (github.com/MotifTechnologies/vllm, based on vLLM v0.26.0). Stock vLLM will NOT load MotifForCausalLM.",
  "recommended_tensor_parallelism":"card command shows --tensor-parallel-size 1 on 2xB200 (likely expert/other parallelism); unclear for 2x96GB",
  "chat_template":"Bundled chat_template.jinja (tool_call + <think>).","reasoning_parser":"motif","tool_call_parser":"motif",
  "tool_calling":"yes (--enable-auto-tool-choice --tool-call-parser motif)","license":"MIT",
  "download_status":"deferred_compatibility",
  "compatibility_notes":"NVFP4 needs Blackwell (we qualify, SM120). BUT aggregate VRAM (192GB) vs weights (174GB) leaves no realistic room for KV+overhead on a 314B model; validated hardware is 2xB200. Also needs a non-standard vLLM fork. 174GB over a ~2MiB/s link is a multi-day transfer.",
  "blocking_issues":"Serving likely infeasible on 2x96GB at useful context (validated config = 2xB200/360GB). Weight download DEFERRED. Revision pinned. For an experimental Motif-3 row, prefer the Baekpica mixed-quant GGUF below instead of this official NVFP4."})

# --- Experimental Motif-3 option A (PREFERRED): Baekpica mixed-quant GGUF ---
MODELS.append({
  "name":"Motif 3 (Baekpica Mixed-Quant GGUF) — UNOFFICIAL, experimental","org":"Baekpica (community; base: Motif Technologies)","repo":"Baekpica/Motif-3-Mixed-Quant-GGUF",
  "revision":"b1897692691833d2531ed4c770de05b51f83837a","local_snapshot_path":snap("Baekpica/Motif-3-Mixed-Quant-GGUF","b1897692691833d2531ed4c770de05b51f83837a")+"  (NOT YET DOWNLOADED)",
  "weight_dtype_or_quant":"Mixed GGUF: attention/GDLA/output-gate Q8_0 + BF16/F32 (1273 F32, 318 BF16, 543 Q8_0), experts IQ2_XXS(102)+Q2_K(51). 2287 tensors.",
  "params_total":"314.7B (per card)","params_activated":"384 experts, top-8 (per card)","arch":"MotifForCausalLM (53 layers: 14 full + 39 SWA; MTP)",
  "context_length":262144,"context_extendable_to":None,
  "checkpoint_size_bytes":94162542816,"checkpoint_size":"94.16 GB (87.70 GiB), 11 GGUF shards","n_safetensors":0,
  "gpu_requirements":"ds4-dfm resident model/runtime measured 91.26 GiB on ONE device -> fits a SINGLE RTX PRO 6000 (96GB) at limited (~32K) context; 256K needs ~128GB unified (DGX Spark). Single-GPU runtime: no documented 2-GPU split, so the 2nd card is unused.",
  "recommended_engine":"ds4-dfm (Baekpica/ds4 @ dfm branch, tag v0.6.2-dfm, commit a09ff4f) — custom C/CUDA runtime with native Motif binder + OpenAI Chat/Completions/Responses + Anthropic server. NOT llama.cpp, NOT vLLM.",
  "recommended_tensor_parallelism":1,
  "chat_template":"Native Motif tokenizer/chat/reasoning/tool protocol implemented in ds4-dfm (validated).","reasoning_parser":"native (ds4-dfm Motif protocol)","tool_call_parser":"native (ds4-dfm Motif protocol)",
  "tool_calling":"yes — card documents validated OpenAI-compatible tool-call + result-loop (MQ87-88-FIT-SAMPLE-VERIFY.json, H200-OPENAI-32K-CORRECTNESS).","license":"MIT (base) — community-repackaged",
  "download_status":"deferred_compatibility",
  "compatibility_notes":"Quant quality strong (Q2_K down cosine 0.9996, combined sparse output cosine 0.9998, logit cosine 0.995, top-8 overlap 8/8) — far better preservation than uniform IQ2. BUT the ds4-dfm CUDA objects are built for sm_121a (DGX Spark GB10) and sm_90 (H200) ONLY; our GPUs are sm_120 (a DIFFERENT Blackwell target). Vendor's own cross-build audit says the sm_121a objects 'cannot be executed' off GB10. Needs a from-source rebuild of ds4 for sm_120 (CUDA 13 present; MXFP4/DS4_CUDA_HAVE_MXF4 supported on RTX PRO 6000) — UNVERIFIED by vendor on sm_120.",
  "blocking_issues":"PRIMARY BLOCKER: ds4-dfm must be rebuilt for sm_120 from pinned source; vendor validated only sm_121a(GB10)/sm_90(H200), single-GPU unified-memory design. Feasibility on 2x discrete 96GB cards unproven. Download NOT started (per instruction). If pursued: build ds4@v0.6.2-dfm for sm_120 FIRST, prove it serves, THEN fetch the 94GB. Explicitly an UNOFFICIAL mixed-quant checkpoint."})

# --- Experimental Motif-3 option B (fallback): jhkim55 uniform IQ2-XXS GGUF ---
MODELS.append({
  "name":"Motif 3 (jhkim55 IQ2-XXS GGUF) — UNOFFICIAL, lower quality","org":"jhkim55 (community; base: Motif Technologies)","repo":"jhkim55/Motif-3-Direct-IQ2-XXS-DGX-Spark",
  "revision":"3511f72d7ceac63e2931b27e1666766f2ad18d54","local_snapshot_path":snap("jhkim55/Motif-3-Direct-IQ2-XXS-DGX-Spark","3511f72d7ceac63e2931b27e1666766f2ad18d54")+"  (NOT YET DOWNLOADED)",
  "weight_dtype_or_quant":"Uniform IQ2_XXS mixed GGUF (single file, 83.56 GiB)","params_total":"314.7B","params_activated":"384 experts","arch":"MotifForCausalLM",
  "context_length":262144,"context_extendable_to":None,
  "checkpoint_size_bytes":89728000000,"checkpoint_size":"83.56 GiB (single GGUF)","n_safetensors":0,
  "gpu_requirements":"Loads all layers on GPU; tested on one 128GB DGX Spark. ~84GiB file -> plausibly a single 96GB card at ~32K ctx.",
  "recommended_engine":"Patched llama.cpp fork (hebo1221/llama.cpp @ motif3-dgx-spark-v1, commit cc3f13b) + motif3-tokenizer-exact-v1 patch; llama-server (OpenAI-compatible). Builds with GGML_NATIVE (likely compiles on our x86/sm_120).",
  "recommended_tensor_parallelism":1,
  "chat_template":"motif3-llama.cpp.jinja + tokenizer patch (fixes Motif prompt token IDs).","reasoning_parser":"llama.cpp generic","tool_call_parser":"llama.cpp generic",
  "tool_calling":"via llama.cpp generic tooling (not Motif-native).","license":"MIT (base) — community-repackaged",
  "download_status":"deferred_compatibility",
  "compatibility_notes":"Runtime more likely to build on our hardware (GGML_NATIVE llama.cpp). BUT card: 'did not pass the prespecified BF16 quality-preservation gates ... systems/research release, not a drop-in'; documented reasoning error (right number, wrong conclusion). Research closed 2026-09-10. perf on Spark: pp512 316 tok/s, tg128 16.5 tok/s.",
  "blocking_issues":"Lower quality than the Baekpica mixed-quant (uniform 2-bit, failed BF16 gates) -> weaker/unfair benchmark row. Kept as a fallback only if the Baekpica ds4-dfm sm_120 build proves infeasible. Download NOT started. Unofficial."})

# Solar Pro 4 — API only
MODELS.append({
  "name":"Solar Pro 4","org":"Upstage","repo":"(API via OpenRouter — no weights)",
  "revision":None,"local_snapshot_path":None,"weight_dtype_or_quant":"N/A (hosted API)","params_total":None,"params_activated":None,"arch":None,
  "context_length":None,"context_extendable_to":None,"checkpoint_size_bytes":0,"checkpoint_size":"0 (API-only)","n_safetensors":0,
  "gpu_requirements":"None (remote API)","recommended_engine":"OpenRouter (OpenAI-compatible)","recommended_tensor_parallelism":None,
  "chat_template":"N/A (provider-side)","reasoning_parser":None,"tool_call_parser":None,"tool_calling":"provider-dependent",
  "license":"N/A (API terms)","download_status":"api_only",
  "compatibility_notes":"Sixth benchmark target. Runs through OpenRouter. No weights to download. OpenRouter credentials NOT configured/tested this session (per instructions).",
  "blocking_issues":None})

manifest = {
  "generated": "2026-10-21",
  "machine": "2x NVIDIA RTX PRO 6000 Blackwell Max-Q, 96GB each (192GB aggregate), SM120, driver 610.57.04, PCIe (no NVLink)",
  "hf_cache": HUB,
  "hf_account": "VectorSophie",
  "download_tool": "hf download (huggingface_hub 1.31.0) with HF_HUB_DISABLE_XET=1 (xet crashes on this throttled link)",
  "notes": "Sizes/SHAs are from live HF metadata on 2026-10-21. GLM-5.3-Flash and MiMo-V2.6-Flash are already fully downloaded (prior work) and are NOT part of this Korean benchmark set.",
  "models": MODELS,
}
with open("/home/jackb/workspace/model-prep/models-manifest.json","w") as f:
    json.dump(manifest, f, indent=2)
print("wrote models-manifest.json with", len(MODELS), "models")
for m in MODELS:
    print(f"  - {m['name']:28s} {str(m['checkpoint_size']):12s} {m['download_status']}")
