#!/bin/bash
# Nightly on homemini (launchd com.jaketunes.taste-engine, 04:40 — after the
# 04:00 all-device listening history it learns from). Runs
# scripts/taste-engine.py from the same detached origin/main checkout the
# 04:00 job refreshes (~/JakeTunesV3-yir), so only merged code ever runs.
#
# File access: under launchd, macOS grants network-volume access per program
# — on homemini node has it, /bin/cp is refused (measured 2026-10-10) and
# python is untested. So node moves bytes to and from the NAS; the python
# engine only ever touches local files.
#
# Publishes taste-state.json to ~/JakeTunesState (the backend reads that copy
# first — the NAS drops off homemini) and to the NAS (the laptop pulls it).
# Exit code is the engine's (a wrapper that ends on `echo` always exits 0 —
# the 2026-08 brain-improve lesson), and the engine pushes its own failures
# to the phone.
set -u
W="${JT_TE_WORKTREE:-$HOME/JakeTunesV3-yir}"
UD="${JT_TE_UD:-$HOME/Library/Application Support/JakeTunes}"
NAS_STATE="${JT_NAS_STATE:-/Volumes/JakeShared/JakeTunesState}"
LOCAL_STATE="${JT_LOCAL_STATE:-$HOME/JakeTunesState}"
WORK="$UD/taste-engine"
IN="$WORK/in"
NODE="${JT_NODE:-/opt/homebrew/bin/node}"
PY="${JT_PY:-/usr/bin/python3}"   # 3.9 + numpy; Homebrew's python3 lacks numpy here
LOG="${JT_TE_LOG:-$HOME/Library/Logs/jaketunes-taste-engine.log}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }
with_timeout() { local s="$1"; shift; perl -e 'alarm shift; exec @ARGV' "$s" "$@"; }

log "=== start (code @ $(git -C "$W" rev-parse --short HEAD 2>/dev/null || echo '?'))"
mkdir -p "$IN"

# NAS inputs -> local. A failed copy keeps last night's copy (logged); with
# no copy at all the engine fails loudly.
if ! "$NODE" -e '
  const fs = require("fs"), path = require("path")
  const [src, dst] = process.argv.slice(1)
  for (const f of ["mood-index.bin", "playlists.json"]) {
    const tmp = path.join(dst, f + ".tmp")
    fs.copyFileSync(path.join(src, f), tmp)
    fs.renameSync(tmp, path.join(dst, f))
  }
' "$NAS_STATE" "$IN" 2>>"$LOG"; then
  log "NAS inputs unavailable — using the last local copies"
fi

JT_TE_NOTIFY="${JT_TE_NOTIFY:-1}" JT_TE_UD="$UD" JT_TE_STATE="$IN" JT_TE_WORK="$WORK" \
JT_TE_LIBRARY="$LOCAL_STATE/library.json" JT_TE_MIXES="$LOCAL_STATE/mixes-cache.json" \
  with_timeout 900 "$PY" "$W/scripts/taste-engine.py" >> "$LOG" 2>&1
RC=$?

if [ $RC -eq 0 ]; then
  cp "$IN/taste-state.json" "$LOCAL_STATE/taste-state.json.tmp" && mv "$LOCAL_STATE/taste-state.json.tmp" "$LOCAL_STATE/taste-state.json" \
    && log "published to $LOCAL_STATE" || log "local publish FAILED"
  if "$NODE" -e '
    const fs = require("fs"), path = require("path")
    const [src, dst] = process.argv.slice(1)
    const tmp = path.join(dst, "taste-state.json.tmp")
    fs.copyFileSync(path.join(src, "taste-state.json"), tmp)
    fs.renameSync(tmp, path.join(dst, "taste-state.json"))
  ' "$IN" "$NAS_STATE" 2>>"$LOG"; then
    log "published to the NAS"
  else
    log "NAS publish FAILED — the laptop keeps its last copy until the next night"
  fi
fi
log "=== done (exit $RC)"
exit $RC
