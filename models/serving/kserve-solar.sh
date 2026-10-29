#!/usr/bin/env bash
# Isolated vLLM launcher for Solar Open 2 (Nota NVFP4) on the Upstage fork image.
# SEPARATE from kserve.sh / the vllm/vllm-openai:v0.32.0 Korean stack:
#   different image (upstage/vllm-solar-open2), different port (8102), different
#   compile cache (/data/jackb/lil-cache-solar). Never touches GLM/MiMo/Sinsan or
#   the karmic-kraken image. TP2 over PCIe (no NVLink); both GPUs required.
#   ./kserve-solar.sh start [maxlen]   # default 8192 = the harness's validated contextLimit
#   ./kserve-solar.sh stop
#   ./kserve-solar.sh logs [-f]
#   ./kserve-solar.sh wait
#   ./kserve-solar.sh print-config [maxlen]   # no side effects: image + args that start would use
# Env: KSERVE_GPU_UTIL (default 0.92), KSERVE_MIN_FREE_MIB (default 85000 per GPU),
#      KSERVE_ALLOW_FOREIGN_MIB (default 2048 — tolerate Sinsan ~1GB), KSERVE_DEV (default 0,1),
#      SOLAR_IMG (default: the pinned digest below), SOLAR_EXTRA (extra vllm args),
#      SOLAR_ALLOW_UNPINNED=1 to start an image that does not resolve to the pinned digest.
# Changed from models/serving-records/kserve-solar.sh (2026-10-29, ADR 0008):
#   default maxlen 4096 -> 8192 (4096 under-served the harness: pilot context_length error);
#   image by digest, not tag, and an override must resolve to the pinned digest.
set -uo pipefail

PORT=8102
HUB=/data/jackb/krasis/huggingface/hub
CACHE=/data/jackb/lil-cache-solar
SNAP=models--nota-ai--Solar-Open2-250B-Nota-NVFP4/snapshots/3cc673335f4c2f41181e05a98fc2b8324d586a64
# Pinned digest = provenance.servingImage in harness/src/agent/local-models.mjs.
PINNED_IMG="upstage/vllm-solar-open2@sha256:b34b7dd42d986bafb8dcfb285758de2fbfd55e7cf28a1b5ba6b858e6b2b7c8c3"
IMG=${SOLAR_IMG:-$PINNED_IMG}
NAME=kserve-solar
SERVED=solar-open2-250b

DEVS=${KSERVE_DEV:-0,1}
GPU_UTIL=${KSERVE_GPU_UTIL:-0.92}
MIN_FREE=${KSERVE_MIN_FREE_MIB:-85000}       # TP2 needs ~77GB weights + overhead per GPU
ALLOW_FOREIGN=${KSERVE_ALLOW_FOREIGN_MIB:-2048}

usage(){ echo "usage: $0 {start|stop|logs|wait|print-config} [maxlen]"; exit 2; }
[ $# -ge 1 ] || usage
ACTION=$1; MAXLEN=${2:-8192}

serve_args(){
  args=( "/hf/$SNAP" --served-model-name "$SERVED"
         --tensor-parallel-size 2 --max-model-len "$MAXLEN" --max-num-seqs "${SOLAR_MAX_SEQS:-256}"
         --gpu-memory-utilization "$GPU_UTIL" --trust-remote-code
         --default-chat-template-kwargs '{"think_render_option":"preserved"}'
         --reasoning-parser solar_open2 --tool-call-parser solar_open2 --enable-auto-tool-choice
         --logits-processors vllm.v1.sample.logits_processor.solar_open2:SolarOpen2TemplateLogitsProcessor
         --port "$PORT" )
  # SOLAR_EXTRA lets us drop/adjust args (e.g. remove the logits-processor) without editing the script.
  [ -n "${SOLAR_EXTRA:-}" ] && args+=( ${SOLAR_EXTRA} )
  return 0
}

image_digest_check(){ # refuse an image that does not resolve to the pinned digest
  local digests
  digests=$(docker image inspect --format '{{join .RepoDigests " "}}' "$IMG" 2>/dev/null) || { echo "ABORT: image $IMG not present locally (pull not finished?)."; return 1; }
  if [[ " $digests " != *" $PINNED_IMG "* ]]; then
    if [ "${SOLAR_ALLOW_UNPINNED:-0}" = "1" ]; then
      echo "WARNING: $IMG does not resolve to the pinned digest (SOLAR_ALLOW_UNPINNED=1): $digests"
    else
      echo "ABORT: $IMG does not resolve to the pinned digest $PINNED_IMG (got: ${digests:-none}). Set SOLAR_ALLOW_UNPINNED=1 to override; runs will not pass preflight."; return 1
    fi
  fi
  return 0
}

gpu_free_check(){
  local busy=0
  for d in ${DEVS//,/ }; do
    local used free fused
    used=$(nvidia-smi -i "$d" --query-gpu=memory.used --format=csv,noheader,nounits 2>/dev/null | tr -dc '0-9')
    free=$(nvidia-smi -i "$d" --query-gpu=memory.free --format=csv,noheader,nounits 2>/dev/null | tr -dc '0-9')
    fused=$(nvidia-smi -i "$d" --query-compute-apps=used_memory --format=csv,noheader,nounits 2>/dev/null | tr -dc '0-9\n' | awk '{s+=$1} END{print s+0}')
    echo "  GPU $d: ${used:-?} MiB used, ${free:-?} MiB free, foreign-compute ~${fused:-0} MiB (allow<=$ALLOW_FOREIGN, min-free=$MIN_FREE)"
    if [ "${fused:-0}" -gt "$ALLOW_FOREIGN" ]; then echo "    -> foreign compute ${fused} MiB exceeds allowance"; busy=1; fi
    if [ "$MIN_FREE" -gt 0 ] && [ "${free:-0}" -lt "$MIN_FREE" ]; then echo "    -> free ${free} MiB below floor ${MIN_FREE}"; busy=1; fi
  done
  if [ $busy -ne 0 ]; then
    echo "ABORT: target GPU(s) [$DEVS] not sufficiently available. Not launching."; return 1
  fi
  return 0
}

case "$ACTION" in
 start)
  echo "[kserve-solar] image=$IMG tp=2 devices=$DEVS maxlen=$MAXLEN util=$GPU_UTIL port=$PORT"
  image_digest_check || exit 1
  [ -f "$HUB/$SNAP/config.json" ] || { echo "ABORT: snapshot missing at $HUB/$SNAP"; exit 1; }
  if docker ps --format '{{.Names}}' | grep -q "^${NAME}$"; then echo "already running: $NAME"; exit 0; fi
  other=$(docker ps --format '{{.Names}}' | grep '^kserve-' | grep -v "^${NAME}$" || true)
  [ -n "$other" ] && { echo "ABORT: another kserve server is up ($other). Stop it first (serve one at a time)."; exit 1; }
  gpu_free_check || exit 1
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  # Vendor-documented Solar Open 2 serving args. NVFP4 = compressed-tensors -> NO --quantization flag.
  # Solar Open 2 is a HYBRID attention+Mamba MoE: each decode seq needs a Mamba cache block,
  # so max_num_seqs must be <= available Mamba blocks (was 401 at util 0.90). 256 is ample for a benchmark.
  serve_args
  set -x
  docker run -d --name "$NAME" \
    --runtime nvidia -e NVIDIA_VISIBLE_DEVICES="$DEVS" -e NVIDIA_DRIVER_CAPABILITIES=all \
    --network host --ipc host --shm-size 16g \
    --ulimit memlock=-1 --ulimit stack=67108864:67108864 \
    -e HF_HUB_OFFLINE=1 -e HF_HOME=/cache/hf -e XDG_CACHE_HOME=/cache/xdg \
    -e VLLM_CACHE_ROOT=/cache -e TORCHINDUCTOR_CACHE_DIR=/cache/inductor -e TRITON_CACHE_DIR=/cache/triton \
    -v "$HUB":/hf:ro -v "$CACHE":/cache \
    "$IMG" "${args[@]}"
  set +x
  echo "[kserve-solar] launched; use '$0 wait' to block for readiness, '$0 logs -f' to watch load/compile"
  ;;
 stop)  docker stop -t 30 "$NAME" 2>/dev/null && echo "stopped $NAME" || echo "not running: $NAME";;
 logs)  docker logs "${@:2}" "$NAME";;
 wait)
  echo -n "[kserve-solar] waiting for $NAME /health "
  for i in $(seq 1 180); do   # NVFP4 MoE load+compile can be long; allow ~30 min
    if curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then echo " HEALTHY (~$((i*10))s)"; exit 0; fi
    if ! docker ps --format '{{.Names}}' | grep -q "^${NAME}$"; then echo " EXITED"; docker logs --tail 60 "$NAME"; exit 1; fi
    echo -n "."; sleep 10
  done
  echo " TIMEOUT"; exit 1
  ;;
 print-config)
  serve_args
  printf 'image=%s\n' "$IMG"
  printf 'arg=%s\n' "${args[@]}"
  ;;
 *) usage;;
esac
