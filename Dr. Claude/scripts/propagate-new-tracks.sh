#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# propagate-new-tracks.sh — push newly imported tracks everywhere they
# need to be, so a song added on the laptop actually plays on the other
# machines.
#
# WHY THIS EXISTS
#   Imports land on the laptop only. Nothing carried them onward, so every
#   time Jake added music the other machines silently fell behind: the track
#   appeared in their library list (metadata syncs) but had no audio, so it
#   just didn't play. It happened with "Vanished"/"Ralph Wiggum", then again
#   the next day with "Casey Jones"/"Have You Seen Her" — same failure, fixed
#   by hand both times. This is that fix, written down.
#
# THE TOPOLOGY (learned the hard way — do not assume)
#   laptop   ~/Music2/JakeTunesLibrary          the masters
#   NAS hub  /Volumes/JakeShared/JakeTunesLibrary   what everything else reads
#   workmini ~/JakeTunesLib/JakeTunesLibrary    LOCAL CACHE of real files +
#            symlinks into its own NAS mount (~/JakeShareNAS/...). Its
#            musicRoot is NOT ~/Music — check app-settings.json before
#            believing otherwise.
#   homemini serves /audio/:id from a node backend that reads library.json
#            ONCE AT STARTUP, so new ids need a restart to be servable.
#
# Safe to re-run: every step is a no-op when there is nothing to do.
set -uo pipefail

LOCAL="$HOME/Music2/JakeTunesLibrary"
NAS="/Volumes/JakeShared/JakeTunesLibrary"
STATE="$HOME/Library/Application Support/JakeTunes"
WM="jacobrosenbaum@workmini"
HM="jakerosenbaumnas@homemini"
WM_CACHE="/Users/jacobrosenbaum/JakeTunesLib/JakeTunesLibrary/iPod_Control/Music"
WM_NASROOT="/Users/jacobrosenbaum/JakeShareNAS/JakeTunesLibrary/iPod_Control/Music"
DRY=false
[[ "${1:-}" == "--dry-run" ]] && DRY=true

say() { echo "▶ $*"; }

# ── 1. NAS hub must be mounted ───────────────────────────────────────
if [[ ! -d "$NAS" ]]; then
  say "NAS not mounted — mounting over the tailnet"
  # .local is mDNS and cannot resolve off the home LAN; the tailnet IP can.
  /usr/bin/osascript -e 'try
    mount volume "smb://jakerosenbaum@100.117.19.93/JakeShared"
  end try' >/dev/null 2>&1
  sleep 4
fi
[[ -d "$NAS" ]] || { echo "✗ NAS hub unreachable — cannot propagate"; exit 1; }

# ── 2. Sync audio to the hub (missing OR changed) ────────────────────
# rsync, not a hand-rolled loop. The first version compared os.path.getsize()
# per track, which meant ~8,800 stat() calls across SMB-over-Tailscale and took
# longer than the 10-minute timeout. rsync does the same size/mtime comparison
# in one pass, and unlike an existence check it also carries REPAIRED files —
# a re-encoded or replaced track keeps its path, so "does it exist" propagates
# nothing and the other machines keep serving the bad audio.
say "syncing audio to the hub (missing or changed)"
# --size-only: the hub is SMB, and SMB does not round-trip mtimes faithfully,
# so a plain -a comparison called 4,105 identical files 'changed' and wanted
# to re-push 63 GB. Size alone is the honest signal here — a re-encode or a
# replaced track always changes it, and audio files never change size in place.
# --no-links: NEVER carry symlinks. A symlinked local track means "the truth
# for this file IS the NAS" — pushing the link hubward overwrites the real
# bytes with a link pointing at itself. That is not hypothetical: it destroyed
# the 1.7 GB Alive 2007 merged concert on 2026-08-04 (found 08-06). The hub
# holds real files only.
RSYNC_FLAGS=(-a --no-links --size-only --info=stats2 --include='*/' --include='*.m4a' --include='*.mp3' --include='*.flac' --exclude='*')
$DRY && RSYNC_FLAGS+=(--dry-run)
rsync "${RSYNC_FLAGS[@]}" "$LOCAL/iPod_Control/Music/" "$NAS/iPod_Control/Music/" 2>&1 \
  | grep -E "Number of regular files transferred|Total transferred file size" | sed 's/^/   /' \
  || echo "   ⚠ hub rsync reported errors"

$DRY && { say "dry run — stopping before remote steps"; exit 0; }

# ── 3. Metadata to both machines ─────────────────────────────────────
# workmini runs the app too, and a running app OVERWRITES a pushed
# library.json with its stale in-memory state on its next save — the push
# "succeeds" and then silently unhappens (2026-08-05: Jake's last-24h music
# missing on workmini; the app had clobbered the push within minutes).
# Single-writer rule: quit it, push, relaunch after the links step.
WM_APP_WAS_RUNNING=false
if ssh "$WM" 'pgrep -f "JakeTunes.app/Contents/MacOS/JakeTunes" >/dev/null' 2>/dev/null; then
  WM_APP_WAS_RUNNING=true
  say "workmini app is running — quitting it so the push can't be clobbered"
  ssh "$WM" 'osascript -e "tell application \"JakeTunes\" to quit" 2>/dev/null; for i in 1 2 3 4 5 6 7 8; do pgrep -f "JakeTunes.app/Contents/MacOS/JakeTunes" >/dev/null || break; sleep 1; done'
fi
say "pushing library metadata"
for host in "$WM" "$HM"; do
  for f in library.json metadata-overrides.json; do
    scp -q "$STATE/$f" "$host:Library/Application Support/JakeTunes/$f" \
      && echo "   ✓ $f → ${host%@*}" || echo "   ✗ $f → ${host%@*} FAILED"
  done
done
# homemini's backend reads its own copy under ~/JakeTunesState (a link to the NAS)
scp -q "$STATE/library.json" "$HM:/Volumes/JakeShared/JakeTunesState/library.json" 2>/dev/null \
  && echo "   ✓ library.json → NAS state (what the stream backend reads)"

# ── 4. workmini cache symlinks ───────────────────────────────────────
say "linking new tracks into workmini's cache"
ssh "$WM" "/usr/bin/python3 - <<'PY'
import json, os, subprocess
lib = os.path.expanduser('~/Library/Application Support/JakeTunes/library.json')
cache = '$WM_CACHE'; nas = '$WM_NASROOT'
d = json.load(open(lib)); tracks = d['tracks'] if isinstance(d, dict) else d
made = skipped = nofile = 0
for t in tracks:
    rel = str(t.get('path','')).lstrip(':').replace(':', os.sep)
    if not rel or rel.startswith('iPod_Control'):
        rel = rel.split('Music' + os.sep, 1)[-1] if 'Music' + os.sep in rel else rel
    dst = os.path.join(cache, rel); src = os.path.join(nas, rel)
    if os.path.exists(dst):
        skipped += 1; continue
    if not os.path.exists(src):
        nofile += 1; continue
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    try:
        os.symlink(src, dst); made += 1
    except FileExistsError:
        skipped += 1
print('   linked %d · already present %d · not on NAS yet %d' % (made, skipped, nofile))
PY"

# relaunch workmini's app now that its library + links are fresh
if $WM_APP_WAS_RUNNING; then
  say "relaunching workmini's app on the fresh library"
  ssh "$WM" 'open -a /Applications/JakeTunes.app' 2>/dev/null || echo "   ⚠ relaunch failed — open it by hand"
fi

# ── 4b. homemini's SERVING root ──────────────────────────────────────
# The stream backend reads MUSIC_ROOT=~/Music/JakeTunesLibrary, a local copy —
# NOT the NAS. Fixing the hub alone leaves homemini serving stale audio, which
# is how three repaired tracks kept streaming their broken versions.
say "syncing homemini's serving root (rsync, size-based)"
rsync -a --no-links --size-only --info=stats2 \
  --include='*/' --include='*.m4a' --include='*.mp3' --include='*.flac' --exclude='*' \
  "$LOCAL/iPod_Control/Music/" "$HM:Music/JakeTunesLibrary/iPod_Control/Music/" 2>&1 \
  | grep -E "Number of regular files transferred|Total transferred file size" | sed 's/^/   /' \
  || echo "   ⚠ homemini music rsync had errors"

# ── 5. Restart the stream backend so new ids are servable ────────────
say "restarting homemini's stream backend (it reads library.json at startup)"
ssh "$HM" 'launchctl kickstart -k gui/$(id -u)/com.jaketunes.mobile.backend' >/dev/null 2>&1 \
  && echo "   ✓ kickstarted" || echo "   ✗ kickstart failed"

say "done"
