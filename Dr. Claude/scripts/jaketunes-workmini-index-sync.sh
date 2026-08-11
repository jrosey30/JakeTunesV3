#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# jaketunes-workmini-index-sync — keep workmini's library INDEX current.
#
# Jake, 2026-08-10: "i add music almost everyday... i dont like how the
# workmini and other places where jaketunes lives lags in progress. it should
# all be seamless."
#
# Audio already propagates fast: macbook-nas-sync pushes to the NAS every 60s
# and homemini pulls from there, which is why the phone always has new music.
# workmini was the one client left out — its library.json only arrived on the
# 11:30 weekday deploy, so a song added tonight was invisible there until
# tomorrow lunchtime even though the bytes were on homemini within a minute.
#
# The desktop app watches library.json (fsWatch + an mtime-poll backstop) and
# reloads it in place, so pushing the file is enough. No restart, no deploy.
#
# Deliberately separate from macbook-nas-sync rather than bolted into it: that
# sync works and is load-bearing, and this runs against a machine that is
# often asleep or off the tailnet.
# ─────────────────────────────────────────────────────────────────────
set -uo pipefail
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

UD="$HOME/Library/Application Support/JakeTunes"
REMOTE="jacobrosenbaum@workmini"
SSH_OPTS="-o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new -o BatchMode=yes"
LOG="$HOME/Library/Logs/JakeTunes/workmini-index-sync.log"
mkdir -p "$(dirname "$LOG")"
say() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }

# workmini is a laptop-adjacent machine that sleeps. Unreachable is normal and
# must be silent, or this fills the log with noise every minute.
ssh $SSH_OPTS "$REMOTE" true 2>/dev/null || exit 0

# LOCAL userData is the source of truth (post 4.5.0-114); the NAS copy is an
# async mirror and has been caught torn. Never push something that does not parse.
LIB="$UD/library.json"
[ -s "$LIB" ] || exit 0
python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$LIB" 2>/dev/null || {
  say "local library.json failed to parse — refusing to push"; exit 1; }

LOCAL_SIZE=$(stat -f %z "$LIB")
LOCAL_MTIME=$(stat -f %m "$LIB")
REMOTE_STAMP=$(ssh $SSH_OPTS "$REMOTE" 'stat -f "%z %m" "$HOME/Library/Application Support/JakeTunes/library.json" 2>/dev/null || echo "0 0"')
REMOTE_SIZE=$(echo "$REMOTE_STAMP" | awk '{print $1}')
REMOTE_MTIME=$(echo "$REMOTE_STAMP" | awk '{print $2}')

# Nothing new — the common case, stay quiet.
[ "$LOCAL_SIZE" = "$REMOTE_SIZE" ] && [ "$LOCAL_MTIME" -le "$REMOTE_MTIME" ] && exit 0

TRACKS=$(python3 -c "
import json,sys
d=json.load(open(sys.argv[1])); print(len(d.get('tracks', d)))" "$LIB" 2>/dev/null || echo '?')

# Stage on the no-space path then mv: this Mac's rsync is openrsync (no
# --protect-args) and 'Application Support' breaks a direct remote path. mv is
# atomic on the same filesystem, so the app never reads a half-written index.
scp -q $SSH_OPTS "$LIB" "$REMOTE:jt-index-stage.json" || { say "scp failed"; exit 2; }
ssh $SSH_OPTS "$REMOTE" '
  /usr/bin/python3 -c "import json;json.load(open(\"$HOME/jt-index-stage.json\"))" || exit 1
  mv -f "$HOME/jt-index-stage.json" "$HOME/Library/Application Support/JakeTunes/library.json"
' 2>/dev/null || { say "remote install failed"; exit 3; }

# The correction layer the app merges over library.json. Without it workmini
# shows uncorrected tags for anything fixed since the last full deploy.
OV="$UD/metadata-overrides.json"
if [ -s "$OV" ] && python3 -c "import json,sys;json.load(open(sys.argv[1]))" "$OV" 2>/dev/null; then
  scp -q $SSH_OPTS "$OV" "$REMOTE:jt-ov-stage.json" 2>/dev/null &&
  ssh $SSH_OPTS "$REMOTE" 'mv -f "$HOME/jt-ov-stage.json" "$HOME/Library/Application Support/JakeTunes/metadata-overrides.json"' 2>/dev/null
fi

say "pushed index — $TRACKS tracks (was ${REMOTE_SIZE} bytes, now ${LOCAL_SIZE})"
