#!/usr/bin/env bash
# Sequential, resumable Korean-model download queue. One model at a time (never
# compete for the throttled link). Bounded retries w/ exponential backoff.
# xet disabled (known to crash on this link). Writes a structured status file.
set -u
export HF_HOME=/data/jackb/krasis/huggingface
export HF_HUB_CACHE=/data/jackb/krasis/huggingface/hub
export HF_HUB_DISABLE_XET=1
export HF_HUB_ENABLE_HF_TRANSFER=0
HF=/home/jackb/.krasis/venv/bin/hf
PY=/home/jackb/.krasis/venv/bin/python
PREP=/home/jackb/workspace/model-prep
LOG=/data/jackb/logs/korean-dl.log
STATUS=$PREP/download-status.json
HUB=/data/jackb/krasis/huggingface/hub

# key|repo|sha|expected_GB|expected_shards
QUEUE=(
 "kanana-2|kakaocorp/kanana-2-30b-a3b-thinking-2601|cdcbf8b811c21366f20f8a10a1f83183433c0844|57.14|13"
 "exaone-4.5-fp8|LGAI-EXAONE/EXAONE-4.5-33B-FP8|69570ad5d9a5159816ef267f2f4d37e36447f1be|38.48|9"
 "ax-4.0|skt/A.X-4.0|a3393fd67bf09a34a85e66dfd2c2da61c4497b67|133.92|30"
)

log(){ echo "$(date -u +%FT%TZ) $*" >> "$LOG"; }
setstatus(){ # key status note
  $PY -I - "$1" "$2" "$3" <<'PY'
import json,sys,os
f="/home/jackb/workspace/model-prep/download-status.json"
d=json.load(open(f)) if os.path.exists(f) else {}
d[sys.argv[1]]={"status":sys.argv[2],"note":sys.argv[3],"ts":__import__("datetime").datetime.utcnow().isoformat()+"Z"}
json.dump(d,open(f,"w"),indent=2)
PY
}

echo $$ > "$PREP/download_queue.pid"
log "=== queue start pid=$$ ==="

for entry in "${QUEUE[@]}"; do
  IFS='|' read -r key repo sha egb eshards <<< "$entry"
  snap="$HUB/models--${repo//\//--}/snapshots/$sha"
  log "[$key] begin repo=$repo sha=$sha expect=${egb}GB/${eshards} shards"
  setstatus "$key" "downloading" "started"
  ok=0
  for attempt in 1 2 3 4 5 6; do
    df_free=$(df -BG --output=avail /data | tail -1 | tr -dc '0-9')
    log "[$key] attempt $attempt (free=${df_free}G)"
    if [ "${df_free:-0}" -lt 160 ]; then
      log "[$key] ABORT: free ${df_free}G < 160G floor"; setstatus "$key" "deferred_storage" "free ${df_free}G below 160G floor"; break
    fi
    "$HF" download "$repo" --revision "$sha" >> "$LOG" 2>&1
    rc=$?
    if [ $rc -eq 0 ]; then ok=1; log "[$key] hf download rc=0"; break; fi
    backoff=$(( 30 * (2 ** (attempt-1)) )); [ $backoff -gt 600 ] && backoff=600
    log "[$key] rc=$rc; backoff ${backoff}s"; setstatus "$key" "downloading" "retry $attempt rc=$rc"
    sleep $backoff
  done

  if [ $ok -ne 1 ]; then
    log "[$key] FAILED after retries"; setstatus "$key" "download_failed" "exhausted retries"; continue
  fi

  # verify: idempotent re-run must print the snapshot path fast; count shards; size
  "$HF" download "$repo" --revision "$sha" >> "$LOG" 2>&1
  got_shards=$(ls -1 "$snap"/*.safetensors 2>/dev/null | wc -l)
  incomplete=$(find "$HUB/models--${repo//\//--}/blobs" -name '*.incomplete' 2>/dev/null | wc -l)
  gotsz=$(du -shL "$snap" 2>/dev/null | cut -f1)
  idx_ok=$($PY -I - "$snap" <<'PY'
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
  log "[$key] verify shards=$got_shards/$eshards incomplete=$incomplete size=$gotsz index=$idx_ok"
  if [ "$got_shards" -ge "$eshards" ] && [ "$incomplete" -eq 0 ] && [ "$idx_ok" = "OK" ]; then
    setstatus "$key" "ready_downloaded" "shards=$got_shards size=$gotsz index=OK"
    log "[$key] DONE ready_downloaded"
  else
    setstatus "$key" "partially_downloaded" "shards=$got_shards/$eshards incomplete=$incomplete index=$idx_ok"
    log "[$key] PARTIAL shards=$got_shards/$eshards incomplete=$incomplete index=$idx_ok"
  fi
done

log "=== queue end ==="
rm -f "$PREP/download_queue.pid"
