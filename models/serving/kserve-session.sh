#!/usr/bin/env bash
# Queue-held model-server session (docs/ops/MODEL_OPERATIONS.md, "Serving under
# the GPU queue"). The launchers start DETACHED containers, which would outlive
# a queue slot. This wrapper is the queue job itself: it runs in the
# foreground for the whole serving session, serves only on the GPUs the queue
# assigned, and stops the container when the session ends for any reason.
#
#   gpuq -L kserve-<model> -G <TP> models/serving/kserve-session.sh <model> [maxlen]
#   touch "$KSERVE_SESSION_DIR/release"     # end the session (container stopped)
#
# model: kanana | exaone | ax (kserve.sh, port 8101) | solar (kserve-solar.sh, port 8102)
# Env: KSERVE_SESSION_DIR (default .cache/kserve-session), KSERVE_LEASE_SEC
#      (default 43200 = 12 h; the session ends and stops the server after it),
#      KSERVE_SESSION_POLL (default 10 s).
# Exit: 0 released/lease over · 1 server failed or died · 3 refused (not under
# the queue, wrong GPU count, a kserve-* container already exists).
# A SIGKILL of this script cannot be trapped; a later session refuses to start
# while the orphan exists, so it is never silently adopted.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
MODEL=${1:-}; MAXLEN=${2:-}
# KEY: the launcher's model argument (kserve.sh takes one for every action,
# kserve-solar.sh none).
case "$MODEL" in
  kanana|exaone) TP=1; L="$HERE/kserve.sh"; NAME=kserve-$MODEL; KEY=("$MODEL");;
  ax)            TP=2; L="$HERE/kserve.sh"; NAME=kserve-ax; KEY=(ax);;
  solar)         TP=2; L="$HERE/kserve-solar.sh"; NAME=kserve-solar; KEY=();;
  *) echo "usage: $0 {kanana|exaone|ax|solar} [maxlen]"; exit 2;;
esac
DIR=${KSERVE_SESSION_DIR:-$HERE/../../.cache/kserve-session}
LEASE=${KSERVE_LEASE_SEC:-43200}
POLL=${KSERVE_SESSION_POLL:-10}

# 1. Only inside a queue allocation: the queue sets CUDA_VISIBLE_DEVICES to the
#    GPUs it reserved ("-1" = a job submitted without -G).
CVD=${CUDA_VISIBLE_DEVICES:-}
if [ -z "$CVD" ] || [ "$CVD" = "-1" ]; then
  echo "REFUSED: not inside a GPU-queue allocation (CUDA_VISIBLE_DEVICES='$CVD'). Submit with: gpuq -L $NAME -G $TP $0 $MODEL"; exit 3
fi
IFS=, read -ra GPUS <<< "$CVD"
if [ "${#GPUS[@]}" -ne "$TP" ]; then
  echo "REFUSED: $MODEL needs exactly $TP GPU(s); the queue assigned '$CVD'. Submit with -G $TP."; exit 3
fi
# A CUDA_VISIBLE_DEVICES exported in a shell is not an allocation. The queue's
# ts client execs the job directly (parent = ts), and the gpuq wrapper exports
# the shared queue's socket (plain `ts` uses another queue). Tests substitute
# the parent name via KSERVE_SESSION_PARENT.
QSOCK=${GPUQ_SOCKET:-$HOME/.local/state/gpuq/ts.sock}
parent=$(ps -o comm= -p "$PPID" 2>/dev/null | tr -d ' ')
if [ "$parent" != "${KSERVE_SESSION_PARENT:-ts}" ] || [ "${TS_SOCKET:-}" != "$QSOCK" ]; then
  echo "REFUSED: not started by the shared GPU queue (parent '$parent', TS_SOCKET '${TS_SOCKET:-}'). Submit with: gpuq -L $NAME -G $TP $0 $MODEL"; exit 3
fi
# 2. Never adopt or replace a RUNNING server this session did not start (an
#    exited leftover holds no GPU; the launcher clears it by name).
existing=$(docker ps --format '{{.Names}}' | grep '^kserve-' || true)
if [ -n "$existing" ]; then
  echo "REFUSED: kserve container(s) already running: $existing (another session, or an orphan to inspect by hand)"; exit 3
fi

mkdir -p "$DIR"
rm -f "$DIR/release"
STATE="$DIR/$MODEL.json"
# The launchers' `stop` leaves the exited container; remove it so nothing of
# this session outlives it.
stop_server() { "$L" stop "${KEY[@]}" >/dev/null 2>&1 || true; docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -f "$STATE"; }
on_exit() { trap - EXIT INT TERM HUP; stop_server; }
trap on_exit EXIT
trap 'echo "[session] signal: stopping $NAME"; exit 143' INT TERM HUP

# 3. Serve on exactly the queue's GPUs (queue indices = nvidia-smi indices,
#    PCI bus order), through the unchanged launcher and its GPU gate.
export KSERVE_DEV="$CVD"
# In the background + `wait`, so a queue SIGTERM is handled at once, not after
# a launcher step that can take minutes (bash defers traps for foreground jobs).
run() { "$L" "$@" & wait $!; }
run start "${KEY[@]}" ${MAXLEN:+"$MAXLEN"} || { echo "[session] start failed"; exit 1; }
run wait "${KEY[@]}" || { echo "[session] server did not become healthy"; exit 1; }

started=$(date +%s)
printf '{"model":"%s","container":"%s","gpus":"%s","pid":%d,"startedAt":%d,"leaseSec":%d}\n' \
  "$MODEL" "$NAME" "$CVD" "$$" "$started" "$LEASE" > "$STATE"
echo "[session] $NAME healthy on GPU(s) $CVD; release with: touch $DIR/release"

# 4. Hold the queue slot while the server lives.
while :; do
  if [ -e "$DIR/release" ]; then echo "[session] released"; exit 0; fi
  if [ $(( $(date +%s) - started )) -ge "$LEASE" ]; then echo "[session] lease of ${LEASE}s over"; exit 0; fi
  if ! docker ps --format '{{.Names}}' | grep -q "^${NAME}$"; then echo "[session] $NAME exited"; exit 1; fi
  sleep "$POLL" & wait $!
done
