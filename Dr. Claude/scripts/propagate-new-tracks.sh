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

# ── 2. Copy any library track the hub is missing ─────────────────────
say "checking the hub for missing audio"
MISSING=$(/usr/bin/python3 - "$LOCAL" "$NAS" "$STATE/library.json" <<'PY'
import json, os, sys
local, nas, libp = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.load(open(libp)); tracks = d["tracks"] if isinstance(d, dict) else d
for t in tracks:
    rel = str(t.get("path", "")).lstrip(":").replace(":", os.sep)
    if not rel:
        continue
    if os.path.exists(os.path.join(local, rel)) and not os.path.exists(os.path.join(nas, rel)):
        print(rel)
PY
)
COUNT=$(printf '%s' "$MISSING" | grep -c . || true)
if [[ "$COUNT" -eq 0 ]]; then
  say "hub already has every track"
else
  say "$COUNT track(s) to copy to the hub"
  while IFS= read -r rel; do
    [[ -z "$rel" ]] && continue
    dest="$NAS/$rel"
    $DRY && { echo "   would copy $rel"; continue; }
    mkdir -p "$(dirname "$dest")"
    # .part then rename: a half-copied file must never look like a real track
    if cp "$LOCAL/$rel" "$dest.part" && mv "$dest.part" "$dest"; then
      echo "   ✓ $rel"
    else
      echo "   ✗ FAILED $rel"; rm -f "$dest.part" 2>/dev/null
    fi
  done <<< "$MISSING"
fi

$DRY && { say "dry run — stopping before remote steps"; exit 0; }

# ── 3. Metadata to both machines ─────────────────────────────────────
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

# ── 5. Restart the stream backend so new ids are servable ────────────
say "restarting homemini's stream backend (it reads library.json at startup)"
ssh "$HM" 'launchctl kickstart -k gui/$(id -u)/com.jaketunes.mobile.backend' >/dev/null 2>&1 \
  && echo "   ✓ kickstarted" || echo "   ✗ kickstart failed"

say "done"
