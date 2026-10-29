#!/usr/bin/env bash
# Isolated vLLM launcher for the 3 Korean models. One model at a time, port 8101.
# Reuses the shared HF cache READ-ONLY; writes compile/temp caches to a dedicated dir.
# Never touches GLM/MiMo (llm-glm/llm-mimo) or the karmic-kraken image.
#   ./kserve.sh start  <kanana|exaone|ax>   [maxlen]
#   ./kserve.sh stop   <kanana|exaone|ax>
#   ./kserve.sh logs   <kanana|exaone|ax>
#   ./kserve.sh wait   <kanana|exaone|ax>   # block until /health or exit
# Env: IMG_VARIANT=cu130(default)|cu129  -> selects primary vs fallback image digest.
set -uo pipefail

PORT=8101
HUB=/data/jackb/krasis/huggingface/hub
CACHE=/data/jackb/lil-cache-korean
# Pinned digests (linux/amd64), verified 2026-10-22 via buildx imagetools inspect.
IMG_CU130="vllm/vllm-openai@sha256:6ee133356d49ed24cee03dd0cda3d3980279a11c107ce3e752c89e76540f41c9"  # v0.32.0, CUDA 13.0.2
IMG_CU129="vllm/vllm-openai@sha256:be7326dd2f0731b3c49bd7c09975b46323733dcac74757aa5d5ada60acdee217"  # v0.32.0-cu129, CUDA 12.9.1
case "${IMG_VARIANT:-cu130}" in
  cu129) IMG="$IMG_CU129";; *) IMG="$IMG_CU130";;
esac

# key -> snapshot subpath | revision | TP | devices | reasoning_parser | extra
declare -A REPO=(
 [kanana]="models--kakaocorp--kanana-2-30b-a3b-thinking-2601/snapshots/cdcbf8b811c21366f20f8a10a1f83183433c0844"
 [exaone]="models--LGAI-EXAONE--EXAONE-4.5-33B-FP8/snapshots/69570ad5d9a5159816ef267f2f4d37e36447f1be"
 [ax]="models--skt--A.X-4.0/snapshots/a3393fd67bf09a34a85e66dfd2c2da61c4497b67"
)
declare -A SERVED=( [kanana]="Kanana-2" [exaone]="EXAONE-4.5" [ax]="A.X-4.0" )
declare -A TP=(     [kanana]=1          [exaone]=1            [ax]=2 )
declare -A DEV=(    [kanana]="0"        [exaone]="0"          [ax]="0,1" )
declare -A REASON=( [kanana]="deepseek_r1" [exaone]="qwen3"   [ax]="" )   # ax = non-thinking

usage(){ echo "usage: $0 {start|stop|logs|wait} {kanana|exaone|ax} [maxlen]"; exit 2; }
[ $# -ge 2 ] || usage
ACTION=$1; KEY=$2; MAXLEN=${3:-16384}
[ -n "${REPO[$KEY]:-}" ] || { echo "unknown model '$KEY'"; usage; }
NAME="kserve-$KEY"
DEVS=${KSERVE_DEV:-${DEV[$KEY]}}                 # override target device(s)
GPU_UTIL=${KSERVE_GPU_UTIL:-0.90}                # conservative budget for contended runs
ALLOW_FOREIGN=${KSERVE_ALLOW_FOREIGN_MIB:-0}     # tolerate known tiny residents (e.g. Sinsan ~1GB); 0=strict
MIN_FREE=${KSERVE_MIN_FREE_MIB:-0}               # require this much absolute free VRAM/device; 0=skip

gpu_free_check(){ # refuse unless each target device is sufficiently available
  local devs=$DEVS
  local busy=0
  for d in ${devs//,/ }; do
    local used free fused
    used=$(nvidia-smi -i "$d" --query-gpu=memory.used --format=csv,noheader,nounits 2>/dev/null | tr -dc '0-9')
    free=$(nvidia-smi -i "$d" --query-gpu=memory.free --format=csv,noheader,nounits 2>/dev/null | tr -dc '0-9')
    fused=$(nvidia-smi -i "$d" --query-compute-apps=used_memory --format=csv,noheader,nounits 2>/dev/null | tr -dc '0-9\n' | awk '{s+=$1} END{print s+0}')
    echo "  GPU $d: ${used:-?} MiB used, ${free:-?} MiB free, foreign-compute ~${fused:-0} MiB (allow<=$ALLOW_FOREIGN, min-free=$MIN_FREE)"
    if [ "${fused:-0}" -gt "$ALLOW_FOREIGN" ]; then echo "    -> foreign compute ${fused} MiB exceeds allowance"; busy=1; fi
    if [ "$MIN_FREE" -gt 0 ] && [ "${free:-0}" -lt "$MIN_FREE" ]; then echo "    -> free ${free} MiB below floor ${MIN_FREE}"; busy=1; fi
  done
  if [ $busy -ne 0 ]; then
    echo "ABORT: target GPU(s) [$devs] not sufficiently available. Not launching (would compete with shared work)."; return 1
  fi
}

case "$ACTION" in
 start)
  echo "[kserve] model=$KEY image=$IMG tp=${TP[$KEY]} devices=$DEVS maxlen=$MAXLEN util=$GPU_UTIL port=$PORT"
  if docker ps --format '{{.Names}}' | grep -q "^${NAME}$"; then echo "already running: $NAME"; exit 0; fi
  # one-at-a-time: refuse if another kserve-* is up
  other=$(docker ps --format '{{.Names}}' | grep '^kserve-' | grep -v "^${NAME}$" || true)
  [ -n "$other" ] && { echo "ABORT: another kserve server is up ($other). Stop it first (serve one at a time)."; exit 1; }
  gpu_free_check || exit 1
  docker rm -f "$NAME" >/dev/null 2>&1 || true   # clear any stale/exited container of same name
  MODEL="/hf/${REPO[$KEY]}"
  args=( --model "$MODEL" --served-model-name "${SERVED[$KEY]}"
         --tensor-parallel-size "${TP[$KEY]}" --max-model-len "$MAXLEN"
         --gpu-memory-utilization "$GPU_UTIL"
         --enable-auto-tool-choice --tool-call-parser hermes
         --port "$PORT" )   # note: v0.32.0 removed --disable-log-requests (requests off by default)
  [ -n "${REASON[$KEY]}" ] && args+=( --reasoning-parser "${REASON[$KEY]}" )
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
  echo "[kserve] launched; use '$0 wait $KEY' to block for readiness"
  ;;
 stop)
  docker stop -t 30 "$NAME" 2>/dev/null && echo "stopped $NAME" || echo "not running: $NAME"
  ;;
 logs) docker logs "${@:3}" "$NAME";;
 wait)
  echo -n "[kserve] waiting for $NAME /health "
  for i in $(seq 1 90); do
    if curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then echo " HEALTHY (~$((i*10))s)"; exit 0; fi
    if ! docker ps --format '{{.Names}}' | grep -q "^${NAME}$"; then echo " EXITED"; docker logs --tail 40 "$NAME"; exit 1; fi
    echo -n "."; sleep 10
  done
  echo " TIMEOUT"; exit 1
  ;;
 *) usage;;
esac
