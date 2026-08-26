#!/bin/bash
# Harvest playlists CREATED ON WORKMINI back to the MacBook (2026-08-26).
#
# Jake: "if i make a new playlist on workmini, it should appear everywhere
# else too... i never deleted the perfect playlist... this feature needs to
# work like spotify."
#
# Full multi-device playlist sync is a real feature and is NOT this. This is
# the narrow half that stops workmini being a DEAD END: today its playlists
# have nowhere to go, and the next deploy overwrites them. This harvests any
# workmini-only playlist (matched by stable ID, never by name) into the
# MacBook's playlists.json, after which the normal LOCAL -> NAS -> deploy flow
# carries it to every machine.
#
# ADD-ONLY, by design. It never deletes on either side — deletion needs
# tombstones, which do not exist for playlists yet, and an add-only harvest
# cannot resurrect anything on its own.
set -euo pipefail
REMOTE="${1:-jacobrosenbaum}@workmini"
LOCAL_PL="$HOME/Library/Application Support/JakeTunes/playlists.json"
SSH_OPTS="-o ConnectTimeout=15 -o BatchMode=yes"

TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
if ! ssh $SSH_OPTS "$REMOTE" 'cat "$HOME/Library/Application Support/JakeTunes/playlists.json"' > "$TMP" 2>/dev/null; then
  echo "  workmini unreachable — nothing harvested"; exit 0
fi

python3 - "$TMP" "$LOCAL_PL" <<'PY'
import json, os, sys, tempfile, shutil, subprocess
remote_p, local_p = sys.argv[1], sys.argv[2]
def items(d): return d if isinstance(d, list) else d.get('playlists', [])
remote = json.load(open(remote_p))
local  = json.load(open(local_p))
r_items, l_items = items(remote), items(local)
l_ids = {str(x.get('id')) for x in l_items}
# Identity-gated: stable ID only. Never name text — that rule cost real tracks.
new = [x for x in r_items if str(x.get('id')) not in l_ids]
if not new:
    print('  nothing new on workmini (%d there, %d here)' % (len(r_items), len(l_items))); sys.exit(0)
print('  %d playlist(s) created on workmini:' % len(new))
for x in new:
    print('     %-32s %d tracks' % (str(x.get('name'))[:32], len(x.get('trackIds') or [])))
# The desktop app owns this file while running; refuse rather than race it.
if subprocess.run(['pgrep','-f','JakeTunes.app'], capture_output=True).returncode == 0:
    print('  ⚠ JakeTunes is running on this Mac — quit it and re-run, or the app will overwrite the merge')
    sys.exit(3)
shutil.copy(local_p, os.path.expanduser('~/.jaketunes-playlists-preharvest-backup.json'))
merged = l_items + new
if isinstance(local, list): local = merged
else: local['playlists'] = merged
d = os.path.dirname(local_p)
fd, tmp = tempfile.mkstemp(dir=d, suffix='.tmp')
with os.fdopen(fd, 'w') as f: json.dump(local, f)
os.replace(tmp, local_p)
back = items(json.load(open(local_p)))
assert len(back) == len(merged), 'verification failed after write'
print('  merged: %d -> %d playlists (backup at ~/.jaketunes-playlists-preharvest-backup.json)' % (len(l_items), len(back)))
PY
