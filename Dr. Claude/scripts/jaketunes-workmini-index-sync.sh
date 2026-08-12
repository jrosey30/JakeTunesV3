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
# Jake, 2026-08-12: still broken this morning. Two bugs in the Aug-11 fix:
#   1. Order was workmini-first, THEN homemini — race window still 404s.
#   2. Early-exit keyed only on workmini already having the bytes. Overnight
#      the broken v1 (or a partial run) left workmini current and homemini
#      never kickstarted; every later tick exited 0 and never healed.
#
# Audio already propagates to the NAS (macbook-nas-sync every 60s) and
# homemini pulls from there. This script must:
#   1. push the index to NAS state + homemini local state
#   2. kickstart the stream backend and WAIT for healthz
#   3. THEN push the index to workmini (so the UI cannot race ahead)
#   4. link any missing cache entries on workmini to the NAS mount
#      (lstat-safe symlink only — never exists()/stat into SMB)
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
# Stamp: last LOCAL library mtime we successfully taught homemini.
# Independent of workmini — heals the "workmini already current, homemini
# still stale" morning failure mode.
HM_STAMP="$HOME/Library/Logs/JakeTunes/workmini-index-sync.hm-mtime"
NAS_STATE="/Volumes/JakeShared/JakeTunesState"
WM_CACHE='~/JakeTunesLib/JakeTunesLibrary/iPod_Control/Music'
WM_NASROOT='~/JakeShareNAS/JakeTunesLibrary/iPod_Control/Music'
mkdir -p "$(dirname "$LOG")"
say() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }

# LOCAL userData is the source of truth (post 4.5.0-114); the NAS copy is an
# async mirror and has been caught torn. Never push something that does not parse.
LIB="$UD/library.json"
[ -s "$LIB" ] || exit 0
python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$LIB" 2>/dev/null || {
  say "local library.json failed to parse — refusing to push"; exit 1; }

LOCAL_SIZE=$(stat -f %z "$LIB")
LOCAL_MTIME=$(stat -f %m "$LIB")
HM_DONE_MTIME=0
[ -f "$HM_STAMP" ] && HM_DONE_MTIME=$(cat "$HM_STAMP" 2>/dev/null || echo 0)

# workmini reachability — needed for the workmini leg, not for teaching homemini.
WM_UP=0
ssh $SSH_OPTS "$REMOTE" true 2>/dev/null && WM_UP=1

REMOTE_SIZE=0
REMOTE_MTIME=0
if [ "$WM_UP" = 1 ]; then
  REMOTE_STAMP=$(ssh $SSH_OPTS "$REMOTE" 'stat -f "%z %m" "$HOME/Library/Application Support/JakeTunes/library.json" 2>/dev/null || echo "0 0"')
  REMOTE_SIZE=$(echo "$REMOTE_STAMP" | awk '{print $1}')
  REMOTE_MTIME=$(echo "$REMOTE_STAMP" | awk '{print $2}')
fi

NEED_HM=0
NEED_WM=0
[ "$LOCAL_MTIME" -gt "$HM_DONE_MTIME" ] && NEED_HM=1
if [ "$WM_UP" = 1 ]; then
  if [ "$LOCAL_SIZE" != "$REMOTE_SIZE" ] || [ "$LOCAL_MTIME" -gt "$REMOTE_MTIME" ]; then
    NEED_WM=1
  fi
fi

# Nothing for us to do — common quiet case.
[ "$NEED_HM" = 0 ] && [ "$NEED_WM" = 0 ] && exit 0

TRACKS=$(python3 -c "
import json,sys
d=json.load(open(sys.argv[1])); print(len(d.get('tracks', d)))" "$LIB" 2>/dev/null || echo '?')

# ── 1+2. Homemini FIRST — teach ids before workmini can ask for them ──
# Without this order (or when NEED_HM alone fires after a partial overnight
# run), workmini shows today's imports and homemini 404s them.
teach_homemini() {
  # NAS state (what mini-nas-pull / stream backend also read).
  if [[ -d "$NAS_STATE" ]]; then
    cp "$LIB" "$NAS_STATE/library.json.tmp" 2>/dev/null &&
      mv -f "$NAS_STATE/library.json.tmp" "$NAS_STATE/library.json" 2>/dev/null &&
      say "pushed index → NAS state" || say "NAS state push failed (non-fatal)"
  fi

  if ! ssh $SSH_OPTS "$HM" true 2>/dev/null; then
    say "homemini unreachable — cannot teach new ids yet"
    return 1
  fi

  # Local state on homemini (LIBRARY_JSON_PATH=~/JakeTunesState/library.json).
  scp -q $SSH_OPTS "$LIB" "$HM:JakeTunesState/library.json.tmp" 2>/dev/null || {
    say "scp to homemini JakeTunesState failed"
    return 1
  }
  ssh $SSH_OPTS "$HM" 'mv -f "$HOME/JakeTunesState/library.json.tmp" "$HOME/JakeTunesState/library.json"' 2>/dev/null || {
    say "homemini library.json install failed"
    return 1
  }

  # Kickstart rebuilds the in-memory id map (backend reads library.json once).
  if ! ssh $SSH_OPTS "$HM" 'launchctl kickstart -k "gui/$(id -u)/com.jaketunes.mobile.backend"' >/dev/null 2>&1; then
    say "homemini kickstart failed"
    return 1
  fi

  # Wait until healthz answers — kickstart returns before the process is ready.
  # Cap ~20s so a wedged backend cannot freeze the LaunchAgent tick.
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if ssh $SSH_OPTS "$HM" 'curl -fsS -m 2 http://127.0.0.1:3000/healthz >/dev/null' 2>/dev/null; then
      say "kickstarted homemini stream backend (healthz ok after ${i}s)"
      echo "$LOCAL_MTIME" > "$HM_STAMP"
      return 0
    fi
    sleep 2
  done
  say "homemini kickstarted but healthz never came up in 20s"
  return 1
}

if [ "$NEED_HM" = 1 ]; then
  if teach_homemini; then
    :
  else
    # Do NOT push to workmini if homemini did not learn the ids — that is
    # exactly the "shows in list, won't play" bug. Retry next minute.
    # Exception: if workmini is already ahead of homemini (partial prior run),
    # we already refused to make it worse; stamp stays old so we keep trying.
    say "deferring workmini push — homemini not ready (tracks=$TRACKS)"
    [ "$NEED_WM" = 1 ] && exit 4
    exit 4
  fi
fi

# ── 3. Workmini index (only after homemini can serve, or homemini already current) ──
if [ "$NEED_WM" = 1 ]; then
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

  # ── 4. Cache-farm links for anything the index knows that workmini lacks ──
  # Symlink only — NEVER exists()/stat-follow into JakeShareNAS (SMB hang).
  # Broken targets are fine: playback is homemini-first and never follows.
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
made = skipped = 0
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
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    try:
        os.symlink(src, dst)
        made += 1
    except FileExistsError:
        skipped += 1
print('linked %d · present %d' % (made, skipped))
PY" >> "$LOG" 2>&1 || say "workmini link pass failed (non-fatal)"

  say "pushed index → workmini — $TRACKS tracks (was ${REMOTE_SIZE} bytes, now ${LOCAL_SIZE})"
elif [ "$NEED_HM" = 1 ]; then
  say "homemini taught ($TRACKS tracks); workmini already current"
fi
