#!/usr/bin/env bash
# Resumable, integrity-checked download of the APPROVED Solar Open 2 unpruned
# NVFP4 checkpoint. Mirrors download_queue.sh safeguards: xet off (crashes this
# link), 160 GB free-space floor, bounded retries w/ exponential backoff,
# shard+index+incomplete verification, structured status file. One transfer at
# a time — do NOT run while another large download is active.
set -u
export HF_HOME=/data/jackb/krasis/huggingface
export HF_HUB_CACHE=/data/jackb/krasis/huggingface/hub
export HF_HUB_DISABLE_XET=1
export HF_HUB_ENABLE_HF_TRANSFER=0
HF=/home/jackb/.krasis/venv/bin/hf
PY=/home/jackb/.krasis/venv/bin/python
PREP=/home/jackb/workspace/model-prep
LOG=/data/jackb/logs/solar-dl.log
STATUS=$PREP/download-status.json
HUB=/data/jackb/krasis/huggingface/hub
FLOOR_GB=160

KEY="solar-open2-nvfp4"
REPO="nota-ai/Solar-Open2-250B-Nota-NVFP4"
SHA="3cc673335f4c2f41181e05a98fc2b8324d586a64"   # pinned HEAD 2026-10-23 (API + git ls-remote)
EGB="153.3"
ESHARDS=29
snap="$HUB/models--${REPO//\//--}/snapshots/$SHA"

log(){ echo "$(date -u +%FT%TZ) $*" | tee -a "$LOG"; }
setstatus(){ # key status note
  "$PY" -I - "$1" "$2" "$3" <<'PY'
import json,sys,os,datetime
f="/home/jackb/workspace/model-prep/download-status.json"
d=json.load(open(f)) if os.path.exists(f) else {}
d[sys.argv[1]]={"status":sys.argv[2],"note":sys.argv[3],
  "ts":datetime.datetime.utcnow().isoformat()+"Z"}
json.dump(d,open(f,"w"),indent=2)
PY
}

mkdir -p "$(dirname "$LOG")"
echo $$ > "$PREP/download_solar.pid"
log "=== solar download start pid=$$ repo=$REPO sha=$SHA expect=${EGB}GB/${ESHARDS} ==="
# refuse to compete with another active hf transfer
if pgrep -f 'hf download' | grep -vq "^$$\$"; then
  others=$(pgrep -fa 'hf download' | grep -v "download_solar" || true)
  if [ -n "$others" ]; then log "ABORT: another hf download active: $others"; setstatus "$KEY" "deferred_bandwidth" "another transfer active"; exit 1; fi
fi
setstatus "$KEY" "downloading" "started sha=$SHA"

ok=0
for attempt in 1 2 3 4 5 6; do
  df_free=$(df -BG --output=avail /data | tail -1 | tr -dc '0-9')
  log "[$KEY] attempt $attempt (free=${df_free}G, floor=${FLOOR_GB}G)"
  if [ "${df_free:-0}" -lt "$FLOOR_GB" ]; then
    log "[$KEY] ABORT: free ${df_free}G < ${FLOOR_GB}G floor"; setstatus "$KEY" "deferred_storage" "free ${df_free}G below ${FLOOR_GB}G floor"; break
  fi
  "$HF" download "$REPO" --revision "$SHA" >> "$LOG" 2>&1
  rc=$?
  if [ $rc -eq 0 ]; then ok=1; log "[$KEY] hf download rc=0"; break; fi
  backoff=$(( 30 * (2 ** (attempt-1)) )); [ $backoff -gt 600 ] && backoff=600
  log "[$KEY] rc=$rc; backoff ${backoff}s"; setstatus "$KEY" "downloading" "retry $attempt rc=$rc"
  sleep $backoff
done

if [ $ok -ne 1 ]; then
  log "[$KEY] FAILED after retries"; setstatus "$KEY" "download_failed" "exhausted retries"; rm -f "$PREP/download_solar.pid"; exit 1
fi

# verify (idempotent re-run resolves snapshot fast)
"$HF" download "$REPO" --revision "$SHA" >> "$LOG" 2>&1
got_shards=$(ls -1 "$snap"/*.safetensors 2>/dev/null | wc -l)
incomplete=$(find "$HUB/models--${REPO//\//--}/blobs" -name '*.incomplete' 2>/dev/null | wc -l)
gotsz=$(du -shL "$snap" 2>/dev/null | cut -f1)
idx_ok=$("$PY" -I - "$snap" <<'PY'
import json,sys,os,glob
snap=sys.argv[1]
idx=os.path.join(snap,"model.safetensors.index.json")
try:
    d=json.load(open(idx)); need={v for v in d["weight_map"].values()}
    have={os.path.basename(p) for p in glob.glob(snap+"/*.safetensors")}
    print("OK" if need<=have else f"MISSING:{len(need-have)}")
except Exception as e:
    print(f"NOINDEX:{type(e).__name__}")
PY
)
log "[$KEY] verify shards=$got_shards/$ESHARDS incomplete=$incomplete size=$gotsz index=$idx_ok"
if [ "$got_shards" -ge "$ESHARDS" ] && [ "$incomplete" -eq 0 ] && [ "$idx_ok" = "OK" ]; then
  setstatus "$KEY" "ready_downloaded" "shards=$got_shards size=$gotsz index=OK sha=$SHA"
  log "[$KEY] DONE ready_downloaded"
else
  setstatus "$KEY" "verify_failed" "shards=$got_shards/$ESHARDS incomplete=$incomplete index=$idx_ok"
  log "[$KEY] VERIFY FAILED"
fi
rm -f "$PREP/download_solar.pid"
log "=== solar download end ==="
