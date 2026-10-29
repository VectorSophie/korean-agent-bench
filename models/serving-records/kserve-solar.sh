#!/usr/bin/env bash
# Isolated vLLM launcher for Solar Open 2 (Nota NVFP4) on the Upstage fork image.
# SEPARATE from kserve.sh / the vllm/vllm-openai:v0.32.0 Korean stack:
#   different image (upstage/vllm-solar-open2), different port (8102), different
#   compile cache (/data/jackb/lil-cache-solar). Never touches GLM/MiMo/Sinsan or
#   the karmic-kraken image. TP2 over PCIe (no NVLink); both GPUs required.
#   ./kserve-solar.sh start [maxlen]   # default 4096 (conservative first run)
#   ./kserve-solar.sh stop
#   ./kserve-solar.sh logs [-f]
#   ./kserve-solar.sh wait
# Env: KSERVE_GPU_UTIL (default 0.92), KSERVE_MIN_FREE_MIB (default 85000 per GPU),
#      KSERVE_ALLOW_FOREIGN_MIB (default 2048 — tolerate Sinsan ~1GB), KSERVE_DEV (default 0,1),
#      SOLAR_IMG (default upstage/vllm-solar-open2:1.0.0), SOLAR_EXTRA (extra vllm args).
set -uo pipefail

PORT=8102
HUB=/data/jackb/krasis/huggingface/hub
CACHE=/data/jackb/lil-cache-solar
SNAP=models--nota-ai--Solar-Open2-250B-Nota-NVFP4/snapshots/3cc673335f4c2f41181e05a98fc2b8324d586a64
IMG=${SOLAR_IMG:-upstage/vllm-solar-open2:1.0.0}
NAME=kserve-solar
SERVED=solar-open2-250b

DEVS=${KSERVE_DEV:-0,1}
GPU_UTIL=${KSERVE_GPU_UTIL:-0.92}
MIN_FREE=${KSERVE_MIN_FREE_MIB:-85000}       # TP2 needs ~77GB weights + overhead per GPU
ALLOW_FOREIGN=${KSERVE_ALLOW_FOREIGN_MIB:-2048}

usage(){ echo "usage: $0 {start|stop|logs|wait} [maxlen]"; exit 2; }
[ $# -ge 1 ] || usage
ACTION=$1; MAXLEN=${2:-4096}

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
  docker image inspect "$IMG" >/dev/null 2>&1 || { echo "ABORT: image $IMG not present locally (pull not finished?)."; exit 1; }
  [ -f "$HUB/$SNAP/config.json" ] || { echo "ABORT: snapshot missing at $HUB/$SNAP"; exit 1; }
  if docker ps --format '{{.Names}}' | grep -q "^${NAME}$"; then echo "already running: $NAME"; exit 0; fi
  other=$(docker ps --format '{{.Names}}' | grep '^kserve-' | grep -v "^${NAME}$" || true)
  [ -n "$other" ] && { echo "ABORT: another kserve server is up ($other). Stop it first (serve one at a time)."; exit 1; }
  gpu_free_check || exit 1
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  MODEL="/hf/$SNAP"
  # Vendor-documented Solar Open 2 serving args. NVFP4 = compressed-tensors -> NO --quantization flag.
  # Solar Open 2 is a HYBRID attention+Mamba MoE: each decode seq needs a Mamba cache block,
  # so max_num_seqs must be <= available Mamba blocks (was 401 at util 0.90). 256 is ample for a benchmark.
  args=( "$MODEL" --served-model-name "$SERVED"
         --tensor-parallel-size 2 --max-model-len "$MAXLEN" --max-num-seqs "${SOLAR_MAX_SEQS:-256}"
         --gpu-memory-utilization "$GPU_UTIL" --trust-remote-code
         --default-chat-template-kwargs '{"think_render_option":"preserved"}'
         --reasoning-parser solar_open2 --tool-call-parser solar_open2 --enable-auto-tool-choice
         --logits-processors vllm.v1.sample.logits_processor.solar_open2:SolarOpen2TemplateLogitsProcessor
         --port "$PORT" )
  # SOLAR_EXTRA lets us drop/adjust args (e.g. remove the logits-processor) without editing the script.
  [ -n "${SOLAR_EXTRA:-}" ] && args+=( ${SOLAR_EXTRA} )
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
 *) usage;;
esac
