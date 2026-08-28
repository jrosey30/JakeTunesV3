#!/bin/bash
# Harvest playlists CREATED ON WORKMINI back to the MacBook (2026-08-26),
# now TOMBSTONE-AWARE (2026-08-28).
#
# Jake: "if i make a new playlist on workmini, it should appear everywhere"
# and "THERE are playlists i deleted on macbook that are still on my
# workmini". The original add-only harvest gated on "does this ID exist
# here" — which quietly RESURRECTED anything deleted locally that still
# existed on workmini. Deletions are durable now (playlist-tombstones.json,
# written by the app on every deleting save):
#
#   • adds are still identity-gated by stable ID, never name text
#   • a tombstoned ID is never added back, whatever machine it lives on
#   • the two machines' tombstone files are UNIONED, and the union is
#     applied on both sides — a delete made anywhere lands everywhere
#   • mass-deletion guard mirrors the app's: >3 dropped AND >50% of the
#     collection in one pass is a malfunction, not an instruction
#
# Neither side is written while its app is running (the app owns the file).
set -euo pipefail
REMOTE="${1:-jacobrosenbaum}@workmini"
APPDIR="$HOME/Library/Application Support/JakeTunes"
LOCAL_PL="$APPDIR/playlists.json"
LOCAL_TS="$APPDIR/playlist-tombstones.json"
SSH_OPTS="-o ConnectTimeout=15 -o BatchMode=yes"
REMOTE_DIR='$HOME/Library/Application Support/JakeTunes'

TMP_R="$(mktemp)"; TMP_RT="$(mktemp)"; TMP_OUT="$(mktemp -d)"
trap 'rm -rf "$TMP_R" "$TMP_RT" "$TMP_OUT"' EXIT

if ! ssh $SSH_OPTS "$REMOTE" "cat \"$REMOTE_DIR/playlists.json\"" > "$TMP_R" 2>/dev/null; then
  echo "  workmini unreachable — nothing harvested"; exit 0
fi
ssh $SSH_OPTS "$REMOTE" "cat \"$REMOTE_DIR/playlist-tombstones.json\" 2>/dev/null" > "$TMP_RT" || true
[ -s "$TMP_RT" ] || echo '[]' > "$TMP_RT"

REMOTE_APP_RUNNING=0
if ssh $SSH_OPTS "$REMOTE" 'pgrep -x JakeTunes >/dev/null' 2>/dev/null; then REMOTE_APP_RUNNING=1; fi

python3 - "$TMP_R" "$TMP_RT" "$LOCAL_PL" "$LOCAL_TS" "$TMP_OUT" <<'PY'
import json, os, sys, tempfile, shutil, subprocess
remote_p, remote_ts_p, local_p, local_ts_p, out_dir = sys.argv[1:6]

def items(d): return d if isinstance(d, list) else d.get('playlists', [])
def load_ts(p):
    try:
        v = json.load(open(p))
        return v if isinstance(v, list) else []
    except Exception:
        return []

remote = json.load(open(remote_p))
local  = json.load(open(local_p))
r_items, l_items = items(remote), items(local)
union = {}
for t in load_ts(local_ts_p) + load_ts(remote_ts_p):
    tid = str(t.get('id'))
    cur = union.get(tid)
    if not cur or str(t.get('deletedAt','')) < str(cur.get('deletedAt','')):
        union[tid] = t
dead = set(union)

# Apply union locally (workmini deletions land here) — identity + mass-guard.
l_after = [x for x in l_items if str(x.get('id')) not in dead]
dropped = [x for x in l_items if str(x.get('id')) in dead]
if len(dropped) > 3 and len(dropped) * 2 > len(l_items):
    print('  ⚠ GUARD: union would delete %d/%d local playlists — refusing the mass drop' % (len(dropped), len(l_items)))
    l_after, dropped = l_items, []
for x in dropped:
    print('  applying delete (tombstoned elsewhere): %s' % str(x.get('name'))[:40])

l_ids = {str(x.get('id')) for x in l_after}
# Identity-gated adds: stable ID only, never name text — and NEVER a dead ID.
new = [x for x in r_items if str(x.get('id')) not in l_ids and str(x.get('id')) not in dead]
skipped_dead = [x for x in r_items if str(x.get('id')) in dead]
if skipped_dead:
    print('  refused to resurrect %d tombstoned playlist(s): %s' %
          (len(skipped_dead), ', '.join(str(x.get('name'))[:28] for x in skipped_dead[:5])))
for x in new:
    print('  new from workmini: %-32s %d tracks' % (str(x.get('name'))[:32], len(x.get('trackIds') or [])))

merged = l_after + new
ts_changed = sorted(union) != sorted(str(t.get('id')) for t in load_ts(local_ts_p))
if merged == l_items and not ts_changed:
    print('  nothing to do (%d there, %d here, %d tombstones)' % (len(r_items), len(l_items), len(union)))
else:
    # The desktop app owns these files while running; refuse rather than race it.
    if subprocess.run(['pgrep','-f','JakeTunes.app'], capture_output=True).returncode == 0:
        print('  ⚠ JakeTunes is running on this Mac — quit it and re-run, or the app will overwrite the merge')
        sys.exit(3)
    shutil.copy(local_p, os.path.expanduser('~/.jaketunes-playlists-preharvest-backup.json'))
    if isinstance(local, list): local = merged
    else: local['playlists'] = merged
    d = os.path.dirname(local_p)
    fd, tmp = tempfile.mkstemp(dir=d, suffix='.tmp')
    with os.fdopen(fd, 'w') as f: json.dump(local, f)
    os.replace(tmp, local_p)
    fd, tmp = tempfile.mkstemp(dir=d, suffix='.tmp')
    with os.fdopen(fd, 'w') as f: json.dump(sorted(union.values(), key=lambda t: str(t.get('deletedAt',''))), f, indent=2)
    os.replace(tmp, local_ts_p)
    back = items(json.load(open(local_p)))
    assert len(back) == len(merged), 'verification failed after write'
    print('  merged: %d -> %d playlists, %d tombstones (backup at ~/.jaketunes-playlists-preharvest-backup.json)'
          % (len(l_items), len(back), len(union)))

# Stage the workmini side of the exchange: union tombstones + the remote
# collection with the union APPLIED. Pushing tombstones without applying
# them would let the app clear them as "resurrected" — they travel together.
r_after = [x for x in r_items if str(x.get('id')) not in dead]
r_dropped = len(r_items) - len(r_after)
if r_dropped > 3 and r_dropped * 2 > len(r_items):
    print('  ⚠ GUARD: union would delete %d/%d workmini playlists — not staging the remote apply' % (r_dropped, len(r_items)))
else:
    if isinstance(remote, list): remote_out = r_after
    else:
        remote_out = dict(remote); remote_out['playlists'] = r_after
    json.dump(remote_out, open(os.path.join(out_dir, 'playlists.json'), 'w'))
    json.dump(sorted(union.values(), key=lambda t: str(t.get('deletedAt',''))), open(os.path.join(out_dir, 'playlist-tombstones.json'), 'w'), indent=2)
    print('  staged workmini exchange: %d playlists (%d removed), %d tombstones' % (len(r_after), r_dropped, len(union)))
PY
PYRC=$?
[ $PYRC -eq 3 ] && exit 3

# Push the staged exchange to workmini — only while its app is closed
# (stage + ssh-mv; scp/rsync choke on the spaced path).
if [ -s "$TMP_OUT/playlist-tombstones.json" ]; then
  if [ "$REMOTE_APP_RUNNING" = "1" ]; then
    echo "  ⚠ JakeTunes is RUNNING on workmini — exchange not pushed (next deploy/harvest will settle it)"
  else
    ssh $SSH_OPTS "$REMOTE" "cat > \"$REMOTE_DIR/.playlists.json.staged\"" < "$TMP_OUT/playlists.json"
    ssh $SSH_OPTS "$REMOTE" "cat > \"$REMOTE_DIR/.playlist-tombstones.json.staged\"" < "$TMP_OUT/playlist-tombstones.json"
    ssh $SSH_OPTS "$REMOTE" "cp \"$REMOTE_DIR/playlists.json\" \"$REMOTE_DIR/.playlists.json.pre-exchange-backup\" && mv \"$REMOTE_DIR/.playlists.json.staged\" \"$REMOTE_DIR/playlists.json\" && mv \"$REMOTE_DIR/.playlist-tombstones.json.staged\" \"$REMOTE_DIR/playlist-tombstones.json\""
    echo "  pushed exchange to workmini (backup at workmini:.playlists.json.pre-exchange-backup)"
  fi
fi
