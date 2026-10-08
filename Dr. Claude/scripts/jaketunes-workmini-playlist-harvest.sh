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

TMP_R="$(mktemp)"; TMP_RT="$(mktemp)"; TMP_RP="$(mktemp)"; TMP_RM="$(mktemp)"; TMP_RMT="$(mktemp)"; TMP_OUT="$(mktemp -d)"
trap 'rm -rf "$TMP_R" "$TMP_RT" "$TMP_RP" "$TMP_RM" "$TMP_RMT" "$TMP_OUT"' EXIT

if ! ssh $SSH_OPTS "$REMOTE" "cat \"$REMOTE_DIR/playlists.json\"" > "$TMP_R" 2>/dev/null; then
  echo "  workmini unreachable — nothing harvested"; exit 0
fi
ssh $SSH_OPTS "$REMOTE" "cat \"$REMOTE_DIR/playlist-tombstones.json\" 2>/dev/null" > "$TMP_RT" || true
[ -s "$TMP_RT" ] || echo '[]' > "$TMP_RT"
ssh $SSH_OPTS "$REMOTE" "cat \"$REMOTE_DIR/playlist-pins.json\" 2>/dev/null" > "$TMP_RP" || true
TMP_RM="$(mktemp)"; TMP_RMT="$(mktemp)"
ssh $SSH_OPTS "$REMOTE" "cat \"$REMOTE_DIR/mixtapes.json\" 2>/dev/null" > "$TMP_RM" || true
[ -s "$TMP_RM" ] || echo '[]' > "$TMP_RM"
ssh $SSH_OPTS "$REMOTE" "cat \"$REMOTE_DIR/mixtape-tombstones.json\" 2>/dev/null" > "$TMP_RMT" || true
[ -s "$TMP_RMT" ] || echo '[]' > "$TMP_RMT"

REMOTE_APP_RUNNING=0
if ssh $SSH_OPTS "$REMOTE" 'pgrep -x JakeTunes >/dev/null' 2>/dev/null; then REMOTE_APP_RUNNING=1; fi

# ── Mixtape exchange (2026-08-28) — same doctrine as playlists ────────────
# Tapes are add-by-id both ways (the deploy's wholesale push used to DESTROY
# a workmini-minted tape), deletes are tombstoned (union, applied both
# sides), and a tape's voice audio (intro/talkovers) travels with it —
# workmini held Jake's tape with two talkover paths that existed only on
# the MacBook, so his voice silently vanished from playback there.
python3 - "$TMP_RM" "$TMP_RMT" "$APPDIR/mixtapes.json" "$APPDIR/mixtape-tombstones.json" "$TMP_OUT" "$APPDIR" <<'PY' || true
import json, os, sys, tempfile, subprocess
remote_p, remote_ts_p, local_p, local_ts_p, out_dir, appdir = sys.argv[1:7]

def jload(p, dflt):
    try:
        v = json.load(open(p))
        return v if isinstance(v, list) else dflt
    except Exception:
        return dflt

r_tapes, l_tapes = jload(remote_p, []), jload(local_p, [])
union = {}
for t in jload(local_ts_p, []) + jload(remote_ts_p, []):
    tid = str(t.get('id'))
    cur = union.get(tid)
    if not cur or str(t.get('deletedAt','')) < str(cur.get('deletedAt','')):
        union[tid] = t
dead = set(union)

l_after = [x for x in l_tapes if str(x.get('id')) not in dead]
dropped = len(l_tapes) - len(l_after)
if dropped > 3 and dropped * 2 > len(l_tapes):
    print('  ⚠ GUARD: union would delete %d/%d local tapes — refusing the mass drop' % (dropped, len(l_tapes)))
    l_after, dropped = l_tapes, 0
elif dropped:
    print('  tapes: applying %d tombstoned delete(s) locally' % dropped)

l_ids = {str(x.get('id')) for x in l_after}
new = [x for x in r_tapes if str(x.get('id')) not in l_ids and str(x.get('id')) not in dead]
for x in new:
    print('  tape minted on workmini: %s' % str(x.get('title'))[:40])
merged = new + l_after   # local wins shared ids; remote-only tapes join

changed = len(new) > 0 or dropped > 0
ts_changed = sorted(union) != sorted(str(t.get('id')) for t in jload(local_ts_p, []))
if changed or ts_changed:
    if subprocess.run(['pgrep','-f','JakeTunes.app'], capture_output=True).returncode == 0:
        print('  ⚠ tapes: JakeTunes is running on this Mac — local tape merge skipped (next run settles)')
    else:
        d = os.path.dirname(local_p)
        fd, tmp = tempfile.mkstemp(dir=d, suffix='.tmp')
        with os.fdopen(fd, 'w') as f: json.dump(merged, f, indent=2)
        os.replace(tmp, local_p)
        fd, tmp = tempfile.mkstemp(dir=d, suffix='.tmp')
        with os.fdopen(fd, 'w') as f: json.dump(sorted(union.values(), key=lambda t: str(t.get('deletedAt',''))), f, indent=2)
        os.replace(tmp, local_ts_p)
        print('  tapes: merged %d -> %d, %d tombstones' % (len(l_tapes), len(merged), len(union)))
else:
    print('  tapes: nothing to do (%d there, %d here, %d tombstones)' % (len(r_tapes), len(l_tapes), len(union)))

# Stage the workmini side: the merged shelf + union tombstones.
r_after = [x for x in r_tapes if str(x.get('id')) not in dead]
r_dropped = len(r_tapes) - len(r_after)
if r_dropped > 3 and r_dropped * 2 > len(r_tapes):
    print('  ⚠ GUARD: union would delete %d/%d workmini tapes — not staging the remote apply' % (r_dropped, len(r_tapes)))
else:
    json.dump(merged, open(os.path.join(out_dir, 'mixtapes.json'), 'w'), indent=2)
    json.dump(sorted(union.values(), key=lambda t: str(t.get('deletedAt',''))), open(os.path.join(out_dir, 'mixtape-tombstones.json'), 'w'), indent=2)

# Voice audio referenced by the FINAL shelf — candidates for the heal.
# PATH-GATED to the app's own mixtape-intros dir: a JSON path may never
# point this copier anywhere else.
intros_prefix = os.path.join(appdir, 'mixtape-intros') + os.sep
audio = set()
for t in merged:
    for pth in [t.get('introPath')] + [tv.get('path') for tv in (t.get('talkovers') or [])]:
        if isinstance(pth, str) and pth.startswith(intros_prefix) and os.sep not in pth[len(intros_prefix):]:
            audio.add(pth)
with open(os.path.join(out_dir, 'audio-candidates.list'), 'w') as f:
    f.write('\n'.join(sorted(audio)))
PY

# Heal voice audio: copy each referenced file to whichever side is missing
# it. NEVER overwrites — a file that exists on a side is left alone.
if [ -s "$TMP_OUT/audio-candidates.list" ]; then
  mkdir -p "$APPDIR/mixtape-intros"
  ssh $SSH_OPTS "$REMOTE" "mkdir -p \"$REMOTE_DIR/mixtape-intros\"" || true
  # `|| [ -n "$AUDIO" ]` keeps the FINAL line even without a trailing
  # newline — the list is join()ed, and read alone drops an unterminated
  # last line (caught live: the second of two talkovers never healed).
  while IFS= read -r AUDIO || [ -n "$AUDIO" ]; do
    [ -n "$AUDIO" ] || continue
    BASE="$(basename "$AUDIO")"
    # -n on every ssh that doesn't take a redirect: without it ssh slurps the
    # rest of the candidates list from the loop's stdin (caught live — only
    # the FIRST of two talkovers healed on the first run).
    if [ ! -f "$AUDIO" ]; then
      if ssh -n $SSH_OPTS "$REMOTE" "test -f \"$REMOTE_DIR/mixtape-intros/$BASE\"" 2>/dev/null; then
        ssh -n $SSH_OPTS "$REMOTE" "cat \"$REMOTE_DIR/mixtape-intros/$BASE\"" > "$AUDIO.partial" && mv "$AUDIO.partial" "$AUDIO"
        echo "  healed voice audio (pulled): $BASE"
      fi
    else
      if ! ssh -n $SSH_OPTS "$REMOTE" "test -f \"$REMOTE_DIR/mixtape-intros/$BASE\"" 2>/dev/null; then
        ssh $SSH_OPTS "$REMOTE" "cat > \"$REMOTE_DIR/mixtape-intros/.$BASE.staged\"" < "$AUDIO"
        ssh -n $SSH_OPTS "$REMOTE" "mv \"$REMOTE_DIR/mixtape-intros/.$BASE.staged\" \"$REMOTE_DIR/mixtape-intros/$BASE\""
        echo "  healed voice audio (pushed): $BASE"
      fi
    fi
  done < "$TMP_OUT/audio-candidates.list"
fi

# Push the staged tape shelf — only while workmini's app is closed.
if [ -s "$TMP_OUT/mixtape-tombstones.json" ]; then
  if [ "$REMOTE_APP_RUNNING" = "1" ]; then
    echo "  ⚠ JakeTunes is RUNNING on workmini — tape exchange not pushed (next run settles)"
  else
    ssh $SSH_OPTS "$REMOTE" "cat > \"$REMOTE_DIR/.mixtapes.json.staged\"" < "$TMP_OUT/mixtapes.json"
    ssh $SSH_OPTS "$REMOTE" "cat > \"$REMOTE_DIR/.mixtape-tombstones.json.staged\"" < "$TMP_OUT/mixtape-tombstones.json"
    ssh $SSH_OPTS "$REMOTE" "cp \"$REMOTE_DIR/mixtapes.json\" \"$REMOTE_DIR/.mixtapes.json.pre-exchange-backup\" 2>/dev/null; mv \"$REMOTE_DIR/.mixtapes.json.staged\" \"$REMOTE_DIR/mixtapes.json\" && mv \"$REMOTE_DIR/.mixtape-tombstones.json.staged\" \"$REMOTE_DIR/mixtape-tombstones.json\""
    echo "  pushed tape exchange to workmini"
  fi
fi

python3 - "$TMP_R" "$TMP_RT" "$LOCAL_PL" "$LOCAL_TS" "$TMP_OUT" "$TMP_RP" "$APPDIR/playlist-pins.json" <<'PY'
import json, os, sys, tempfile, shutil, subprocess
remote_p, remote_ts_p, local_p, local_ts_p, out_dir, remote_pins_p, local_pins_p = sys.argv[1:8]

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

# Pins: Spotify semantics — the LAST pin change anywhere wins wholesale.
# ⚠️ TWIN: src/main/playlist-pins.ts newestPins (same rule in-app).
def load_pins(p):
    try:
        v = json.load(open(p))
        ids = v.get('pinnedPlaylists')
        if not isinstance(ids, list): return None
        return {'pinnedPlaylists': [x for x in ids if isinstance(x, str)][:3],
                'updatedAt': v.get('updatedAt') if isinstance(v.get('updatedAt'), str) else ''}
    except Exception:
        return None
lp, rp = load_pins(local_pins_p), load_pins(remote_pins_p)
if rp and (not lp or rp['updatedAt'] > lp['updatedAt']):
    if subprocess.run(['pgrep','-f','JakeTunes.app'], capture_output=True).returncode == 0:
        print('  pins: workmini is newer but JakeTunes is running here — skipped (next run settles)')
    else:
        json.dump(rp, open(local_pins_p, 'w'), indent=2)
        print('  pins: took workmini\'s (newer, %s)' % (rp['updatedAt'] or 'legacy'))
elif lp and (not rp or (lp['updatedAt'] or '') > (rp['updatedAt'] or '')):
    json.dump(lp, open(os.path.join(out_dir, 'playlist-pins.json'), 'w'), indent=2)
    print('  pins: staging ours for workmini (newer, %s)' % (lp['updatedAt'] or 'legacy'))
elif lp or rp:
    print('  pins: already in agreement')

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
if [ -s "$TMP_OUT/playlist-pins.json" ]; then
  if [ "$REMOTE_APP_RUNNING" = "1" ]; then
    echo "  ⚠ JakeTunes is RUNNING on workmini — pins not pushed (next run settles)"
  else
    ssh $SSH_OPTS "$REMOTE" "cat > \"$REMOTE_DIR/.playlist-pins.json.staged\"" < "$TMP_OUT/playlist-pins.json"
    ssh $SSH_OPTS "$REMOTE" "mv \"$REMOTE_DIR/.playlist-pins.json.staged\" \"$REMOTE_DIR/playlist-pins.json\""
    echo "  pushed pins to workmini"
  fi
fi

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
