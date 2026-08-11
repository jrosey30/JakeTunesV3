#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# jaketunes-workmini-index-sync — keep workmini's library INDEX current,
# AND keep homemini able to SERVE the new ids.
#
# Jake, 2026-08-10: "i add music almost everyday... i dont like how the
# workmini and other places where jaketunes lives lags in progress. it should
# all be seamless."
#
# Jake, 2026-08-11: "the newer music doesnt work well but everything basically
# before today does." That is this script's first version biting him. It
# pushed library.json to workmini every minute so new songs APPEARED in the
# list, but homemini's stream backend reads library.json ONCE AT STARTUP —
# so workmini asked homemini for brand-new ids, got 404, refused the SMB
# fallthrough, and the track sat dead. Older songs worked because homemini
# already knew those ids from the last restart.
#
# Audio already propagates to the NAS (macbook-nas-sync every 60s) and
# homemini pulls from there. This script must also:
#   1. push the index to workmini (so the UI is current)
#   2. push the index to NAS state (what the stream backend reads)
#   3. kickstart the stream backend so new ids become servable
#   4. link any missing cache entries on workmini to the NAS mount
#
# Deliberately separate from macbook-nas-sync rather than bolted into it: that
# sync works and is load-bearing, and this runs against a machine that is
# often asleep or off the tailnet.
# ─────────────────────────────────────────────────────────────────────
set -uo pipefail
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

UD="$HOME/Library/Application Support/JakeTunes"
REMOTE="jacobrosenbaum@workmini"
HM="jakerosenbaumnas@homemini"
SSH_OPTS="-o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new -o BatchMode=yes"
LOG="$HOME/Library/Logs/JakeTunes/workmini-index-sync.log"
NAS_STATE="/Volumes/JakeShared/JakeTunesState"
WM_CACHE='~/JakeTunesLib/JakeTunesLibrary/iPod_Control/Music'
WM_NASROOT='~/JakeShareNAS/JakeTunesLibrary/iPod_Control/Music'
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

# ── Homemini must learn the new ids BEFORE workmini tries to play them ──
# Push to NAS state (what the stream backend reads) and kickstart so the
# in-memory id map rebuilds. Without this, workmini shows today's imports
# and homemini 404s them — "newer music doesnt work, older does."
if [[ -d "$NAS_STATE" ]]; then
  cp "$LIB" "$NAS_STATE/library.json.tmp" 2>/dev/null &&
    mv -f "$NAS_STATE/library.json.tmp" "$NAS_STATE/library.json" 2>/dev/null &&
    say "pushed index → NAS state" || say "NAS state push failed (non-fatal)"
fi
# Best-effort homemini kickstart. Unreachable homemini must not fail the
# workmini push — the index is still useful for browsing.
if ssh $SSH_OPTS "$HM" true 2>/dev/null; then
  scp -q $SSH_OPTS "$LIB" "$HM:JakeTunesState/library.json.tmp" 2>/dev/null &&
    ssh $SSH_OPTS "$HM" 'mv -f "$HOME/JakeTunesState/library.json.tmp" "$HOME/JakeTunesState/library.json"' 2>/dev/null
  ssh $SSH_OPTS "$HM" 'launchctl kickstart -k "gui/$(id -u)/com.jaketunes.mobile.backend"' >/dev/null 2>&1 \
    && say "kickstarted homemini stream backend" \
    || say "homemini kickstart failed (non-fatal)"
fi

# ── Cache-farm links for anything the index knows that workmini lacks ──
# New rows with no local farm entry would only exist as "in the list" with
# nothing for lstat to find. Symlink to the NAS mount (lstat-safe; playback
# still goes through homemini and never follows the link).
ssh $SSH_OPTS "$REMOTE" "/usr/bin/python3 - <<'PY'
import json, os
lib = os.path.expanduser('~/Library/Application Support/JakeTunes/library.json')
cache = os.path.expanduser('$WM_CACHE')
nas = os.path.expanduser('$WM_NASROOT')
try:
    d = json.load(open(lib))
except Exception:
    raise SystemExit(0)
tracks = d.get('tracks', d) if isinstance(d, dict) else d
made = skipped = nofile = 0
for t in tracks:
    rel = str(t.get('path') or '').lstrip(':').replace(':', os.sep)
    if not rel:
        continue
    # Paths are :iPod_Control:Music:F00:x.m4a → iPod_Control/Music/F00/x.m4a
    # Cache and NAS roots already end at .../Music, so strip up to Music/.
    if 'Music' + os.sep in rel:
        rel = rel.split('Music' + os.sep, 1)[-1]
    dst = os.path.join(cache, rel)
    src = os.path.join(nas, rel)
    if os.path.lexists(dst):
        skipped += 1
        continue
    if not os.path.exists(src):
        nofile += 1
        continue
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    try:
        os.symlink(src, dst)
        made += 1
    except FileExistsError:
        skipped += 1
print('linked %d · present %d · not-on-NAS %d' % (made, skipped, nofile))
PY" >> "$LOG" 2>&1 || say "workmini link pass failed (non-fatal)"

say "pushed index — $TRACKS tracks (was ${REMOTE_SIZE} bytes, now ${LOCAL_SIZE})"
