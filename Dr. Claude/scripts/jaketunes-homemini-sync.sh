#!/usr/bin/env bash
#
# Seamless sync: MacBook → Synology JakeShared → homemini (JakeTunes).
#
# What it does:
#   1. Ensures /Volumes/JakeShared is mounted (auto-mounts if not).
#   2. rsyncs ~/Music2/JakeTunesLibrary → /Volumes/JakeShared/JakeTunesLibrary
#      (homemini reads music from this share).
#   3. scps library.json directly to homemini over Tailscale ssh.
#      Only pushes if local library.json is newer than remote — saves a
#      restart cycle when nothing's changed.
#   4. If library.json was pushed, restarts JakeTunes on homemini so it
#      picks up the new metadata. (Future: hot-reload via fs.watch in
#      JakeTunes itself, no restart needed.)
#   5. On any failure, posts a macOS notification so the user knows.
#
# 4.4.68 / Brief 019 — full-mode rsync NO LONGER uses --delete.
# Sync is additive only. Tombstones (deletions on Mac) do NOT
# propagate to NAS automatically. Reconciliation of orphan files
# is a separate, deliberate action — out of scope for this script.
# This change neutralized a destructive sync that deleted ~241k
# files over 7 days (recoverable only via Synology's recycle bin).
#
# Run by:
#   - LaunchAgent `com.jaketunes.sync` every 600s (background, idempotent).
#   - Manual invocation: bash ~/bin/jaketunes-homemini-sync.sh
#
# Lockfile prevents two runs colliding (launchd + manual + future
# post-import trigger). If a previous run is still in flight, this one
# exits quietly.
#
# Env overrides (rarely needed):
#   JT_LIBRARY_ROOT   default: $HOME/Music2/JakeTunesLibrary
#   JT_SHARE          default: smb://ds225/JakeShared
#   JT_MOUNT          default: /Volumes/JakeShared
#   JT_HOMEMINI       default: jakerosenbaumnas@homemini
#   JT_PLEX_SSH       default: jakerosenbaum@ds225  (Plex Media Server host)
#   JT_PLEX_SECTION   default: 2                   (JakeTunes library section id)
#   JT_PLEX_SKIP      set to 1 to skip the Plex scan step (e.g. local-only tests)
#
# Exit codes:
#   0  — success (music + library.json sync, and any needed restart)
#   1  — couldn't mount JakeShared
#   2  — rsync failed
#   3  — library.json scp failed
#   4  — homemini ssh unreachable
#   9  — another run is in progress (not an error)

set -uo pipefail

# Brief 016: propagate SIGTERM/SIGINT to any in-flight rsync child.
# The JS orchestrator (4.4.18 sync-orchestrator.ts) now kills the
# whole process group on timeout, which already covers this for
# orchestrator-triggered runs. This trap adds belt-and-suspenders
# coverage for manual `kill <bash-pid>` from a shell context where
# the JS-side group-kill doesn't apply.
#
# `pkill -P $$ rsync` targets only rsync processes whose direct
# parent is this bash script — cleaner than `kill 0` which would
# signal every process in the current process group (including
# bash itself, with potential re-entry weirdness). The 2>/dev/null
# and `|| true` keep the trap quiet when there's nothing to kill.
cleanup_children() {
  pkill -P $$ rsync 2>/dev/null || true
  exit 143  # 128 + SIGTERM, conventional shell exit for term-by-signal
}
trap cleanup_children TERM INT

LOG=/tmp/jaketunes-sync.log
LOCK=/tmp/jaketunes-sync.lock
LIBRARY_ROOT="${JT_LIBRARY_ROOT:-$HOME/Music2/JakeTunesLibrary}"
SHARE_URL="${JT_SHARE:-smb://ds225/JakeShared}"
MOUNT="${JT_MOUNT:-/Volumes/JakeShared}"
HOMEMINI="${JT_HOMEMINI:-jakerosenbaumnas@homemini}"
PLEX_SSH="${JT_PLEX_SSH:-jakerosenbaum@ds225}"
PLEX_SECTION="${JT_PLEX_SECTION:-2}"
PLEX_SKIP="${JT_PLEX_SKIP:-0}"
PLEX_SCANNER="/volume1/@appstore/PlexMediaServer/Plex Media Scanner"
JT_DATA_LOCAL="$HOME/Library/Application Support/JakeTunes"
JT_DATA_REMOTE='Library/Application Support/JakeTunes'
# 4.5.0-90 Phase 2 — when the app is in NAS-source mode, the freshest
# copies of the SYNC_FILES live at JT_STATE_NAS, NOT in JT_DATA_LOCAL
# (the local userData copies go stale because the app reads/writes
# the NAS path directly). Sync's rsync source-selection below probes
# JT_STATE_NAS first and falls back to JT_DATA_LOCAL when the NAS
# mount isn't present.
JT_STATE_NAS='/Volumes/JakeShared/JakeTunesState'
# Files that comprise the per-device library state we want everywhere
# (treat homemini's JakeTunes as a read-mostly mirror of the laptop's):
#   library.json            — track metadata, the master
#   metadata-overrides.json — Get Info edits + audio-analysis fields
#   playlists.json          — user-created playlists
# Excluded on purpose:
#   chat-history.json       — per-device Music Man conversations
#   *.bak / *.tmp           — backup/working files; rsync's defaults skip
# 4.5.0-92 — added listener-profile.json + musicman-memory.json +
# musicman-interactions.jsonl. Per Phase 2 these now live on NAS so
# the desktop reads/writes them there; for Mini (which doesn't mount
# NAS yet) the sync pushes them locally so its mobile-backend sees
# the same listener signal the desktop does.
# 2026-06-07 — added play-events.jsonl (append-only desktop-authored play log;
# nothing on homemini writes it, so a one-way push is safe). Prepares the
# mobile side for windowed play history. NOT added: recommendations.json — it's
# written on BOTH sides (desktop + phone via homemini's backend), so a blunt
# rsync overwrite could clobber a recent phone add; that one needs a merge-aware
# push, handled separately.
SYNC_FILES=(library.json metadata-overrides.json playlists.json play-events.jsonl embeddings.bin listener-profile.json musicman-memory.json musicman-interactions.jsonl picks-cache.json mobile-playlists.json playlist-additions.json)

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"
}

notify() {
  # macOS user notification — works whether launchd or interactive.
  osascript -e "display notification \"$1\" with title \"JakeTunes sync\"" 2>/dev/null || true
}

# Acquire lock, exit 9 if another run is in flight.
exec 9>"$LOCK"
if ! flock -n 9 2>/dev/null; then
  # macOS may not have flock; fall back to a stale-aware check.
  if [ -f "$LOCK.pid" ] && kill -0 "$(cat "$LOCK.pid" 2>/dev/null)" 2>/dev/null; then
    log "another sync run is in progress (PID $(cat "$LOCK.pid")) — skipping"
    exit 9
  fi
fi
echo $$ > "$LOCK.pid"
trap 'rm -f "$LOCK.pid"' EXIT

log "=== sync started (PID $$) ==="

# 4.4.18: this script is now invoked from JakeTunes' main process (a
# user GUI Electron app), NOT by launchd. Therefore plain rsync against
# /Volumes/JakeShared works — JakeTunes' process inherits the user's
# TCC permissions for network volumes. The old launchd-wrapping with
# osascript / launchctl-asuser is gone (didn't work anyway on Sequoia
# — see the tombstone at ~/Library/LaunchAgents/com.jaketunes.sync.plist).

# ── 1. Ensure JakeShared is mounted ───────────────────────────────────
if [ ! -d "$MOUNT/JakeTunesLibrary" ] && [ ! -d "$MOUNT" ]; then
  log "mounting $SHARE_URL …"
  # osascript drives the user-session Finder mount; works fine because
  # the caller (JakeTunes main process) is already in the GUI session.
  /usr/bin/osascript -e "mount volume \"$SHARE_URL\"" >> "$LOG" 2>&1 || true
  # Wait up to 10 sec for the mount to settle.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [ -d "$MOUNT/JakeTunesLibrary" ] && break
    sleep 1
  done
fi

if [ ! -d "$MOUNT/JakeTunesLibrary" ]; then
  log "ERROR: $MOUNT/JakeTunesLibrary not present after mount attempt — aborting"
  notify "Couldn't mount JakeShared. Music sync skipped."
  exit 1
fi

# 4.5.0-115 — local userData is the source of truth; NAS holds an
# async backup mirror only (see src/main/state-dir.ts). Prefer LOCAL
# when picking rsync sources so homemini always receives this machine's
# freshest library.json, not a possibly-stale NAS copy.
resolve_sync_src() {
  if [ -f "$JT_DATA_LOCAL/$1" ]; then
    echo "$JT_DATA_LOCAL/$1"
  elif [ -f "$JT_STATE_NAS/$1" ]; then
    echo "$JT_STATE_NAS/$1"
  fi
}

# ── 2. JSON state → homemini FIRST (before the long music rsync) ─────
#
# 2026-06-06 — homemini sync was silently broken for hours: the
# orchestrator's 10-min timeout SIGTERM'd full safety-net runs while
# they were still walking the 73GB music tree (step 2, old order).
# library.json never reached homemini because steps 3–4 sat AFTER the
# music rsync. Pushing state first means metadata lands on homemini
# even when the music walk is slow, partial, or killed.
push_homemini_state() {
  local lib_src
  lib_src=$(resolve_sync_src "library.json")
  if [ -z "$lib_src" ] || [ ! -f "$lib_src" ]; then
    log "no library.json found (local or NAS) — skipping homemini state push"
    return 0
  fi

  local local_fp="" remote_fp="" remote_fp_cmd f src m
  for f in "${SYNC_FILES[@]}"; do
    src=$(resolve_sync_src "$f")
    if [ -n "$src" ] && [ -f "$src" ]; then
      m=$(stat -f "%m" "$src" 2>/dev/null || echo 0)
      local_fp="${local_fp}${f}:${m}|"
    fi
  done

  remote_fp_cmd='for f in '"${SYNC_FILES[*]}"'; do
  if [ -f "Library/Application Support/JakeTunes/$f" ]; then
    m=$(stat -f "%m" "Library/Application Support/JakeTunes/$f" 2>/dev/null || echo 0)
    printf "%s:%s|" "$f" "$m"
  fi
done'
  remote_fp=$(ssh -o BatchMode=yes -o ConnectTimeout=5 "$HOMEMINI" "$remote_fp_cmd" 2>/dev/null || echo "")

  if [ "$local_fp" = "$remote_fp" ] && [ -n "$local_fp" ]; then
    log "library state unchanged — skipping homemini push"
    return 0
  fi
  log "library state differs (local=$local_fp remote=$remote_fp) — pushing …"

  # --checksum: decide transfers by content hash, not mtime. Stops re-shipping
  # embeddings.bin (~100MB) when it was rewritten with identical content (new
  # mtime, same bytes). Hashing only runs when a push is already happening (the
  # mtime fingerprint gate above skips no-op syncs), so the cost is bounded.
  local rsync_args=(-tz --checksum --no-perms --no-owner --no-group)
  for f in "${SYNC_FILES[@]}"; do
    src=$(resolve_sync_src "$f")
    if [ -n "$src" ] && [ -f "$src" ]; then
      rsync_args+=("$src")
    fi
  done
  rsync "${rsync_args[@]}" "$HOMEMINI:$JT_DATA_REMOTE/" >> "$LOG" 2>&1
  local scp_rc=$?
  if [ $scp_rc -ne 0 ]; then
    log "ERROR: rsync of JSON state failed (exit $scp_rc) — homemini may be offline"
    notify "Library state sync to homemini failed. Music may still reach the NAS."
    return 3
  fi

  log "restarting JakeTunes on homemini …"
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOMEMINI" \
    'pkill -f "JakeTunes.app/Contents/MacOS" 2>/dev/null; sleep 2; open /Applications/JakeTunes.app' \
    >> "$LOG" 2>&1
  local ssh_rc=$?
  if [ $ssh_rc -ne 0 ]; then
    log "WARNING: ssh restart returned $ssh_rc (library.json was pushed though)"
    notify "library.json synced, but couldn't restart JakeTunes on homemini. Restart it manually."
    return 4
  fi
  log "homemini JakeTunes restarted — new tracks/edits should be visible now"
  return 0
}

homemini_rc=0
push_homemini_state || homemini_rc=$?
# Non-fatal: continue to NAS music rsync even if homemini push failed.
if [ $homemini_rc -ne 0 ]; then
  log "homemini state push returned $homemini_rc (continuing to NAS music rsync)"
fi

# ── 3. rsync music to Synology ────────────────────────────────────────
# 4.4.36: --quick mode passes a `find -mmin -10` file list to rsync via
# --files-from, so we only touch tracks that just landed (typical case
# after an import). Skips the rsync stat-walk over the full 73GB
# library, cutting per-import sync from ~5 min to ~15 sec. The full
# rsync still runs from the 10-min safety-net tick so out-of-band edits
# get caught — but as of Brief 019 it NO LONGER deletes files on the
# NAS. Tombstones (deletions on Mac) stay local. The NAS is additive
# only. See the header NOTE for why.
QUICK_MODE=0
for arg in "$@"; do
  [ "$arg" = "--quick" ] && QUICK_MODE=1
done

if [ $QUICK_MODE -eq 1 ]; then
  log "rsync music (quick: files modified in last 10 min) → $MOUNT/JakeTunesLibrary/ …"
  TMP_LIST=$(mktemp /tmp/jaketunes-sync-files.XXXXXX)
  ( cd "$LIBRARY_ROOT" && find . -mmin -10 -type f \
      -not -path './.*' \
      -not -path './_pending-imports/*' \
      -not -name '._*' \
      -not -name '.DS_Store' \
      -not -name 'Icon?' ) > "$TMP_LIST"
  file_count=$(wc -l < "$TMP_LIST" | tr -d ' ')
  log "quick mode: $file_count files modified in the last 10 min"
  if [ "$file_count" -gt 0 ]; then
    rsync -rtz --files-from="$TMP_LIST" \
      "$LIBRARY_ROOT/" "$MOUNT/JakeTunesLibrary/" \
      >> "$LOG" 2>&1
    music_rc=$?
  else
    music_rc=0
  fi
  rm -f "$TMP_LIST"
else
  log "rsync music (full, additive only — never deletes) → $MOUNT/JakeTunesLibrary/ …"
  # 4.4.68 / Brief 019: --delete REMOVED. Previous behavior propagated
  # Mac state to NAS via destructive deletion, which combined with any
  # bug that produced a stale Mac library caused mass file removal.
  # 7 days of this destroyed ~241k files (saved only by Synology's
  # recycle bin). Sync is now additive-only. Orphan cleanup, if ever
  # needed, will be a separate deliberate user action — not an
  # automatic side effect of normal sync.
  # -a archive, -z compress. NO --delete.
  # 2026-05-24: --exclude='_pending-imports/' added after tracing the
  # NAS-fill-incident-#3 bleed source to JakeTunes' local staging dir
  # being mirrored to NAS. Some DSM-side daemon then sweeps those temp
  # files an hour later, into the recycle bin (3.2 TB accumulation over
  # months). _pending-imports/ has zero value on NAS (homemini doesn't
  # need staging, Plex shouldn't index it, mobile doesn't need it).
  # The canonical post-import content lives in iPod_Control/Music/F**/
  # via JakeTunes' importOneFile copy step. Local _pending-imports/ stays
  # untouched as a local "paper trail" per download-router.ts intent.
  rsync -az \
    --exclude='.DS_Store' --exclude='._*' --exclude='_pending-imports/' \
    "$LIBRARY_ROOT/" "$MOUNT/JakeTunesLibrary/" \
    >> "$LOG" 2>&1
  music_rc=$?
fi
log "music rsync exit=$music_rc (mode=$([ $QUICK_MODE -eq 1 ] && echo quick || echo full))"
# rsync exit 23/24 = PARTIAL transfer, not a hard failure:
#   23 — "some files could not be transferred" (classic cause here: a
#        track is busy because Plexamp is streaming it or Plex is mid-
#        scan, so rsync can't overwrite that one file)
#   24 — "some source files vanished before they could be copied"
# In both cases the NEW imports — the whole point of the sync — almost
# always transferred fine; only the locked/vanished file got skipped.
# Before this fix, ANY non-zero rsync exit did `exit 2`, which aborted
# the script BEFORE the Plex scan (step 2b) and the homemini push (3-4).
# Net effect: a single file the user happened to be listening to on
# Plexamp would silently block new music from reaching mobile at all.
# Now: 23/24 → warn + continue; only a HARD failure (connection lost,
# disk full, etc.) aborts.
if [ $music_rc -eq 23 ] || [ $music_rc -eq 24 ]; then
  log "WARNING: rsync partial transfer (exit $music_rc) — a file was busy (likely streaming) or vanished; new imports still synced, continuing to Plex scan + homemini push"
  notify "Music sync: a file was busy (probably playing) — everything else synced fine."
elif [ $music_rc -ne 0 ]; then
  notify "Music rsync failed (exit $music_rc). See /tmp/jaketunes-sync.log."
  exit 2
fi

# ── 2b. Trigger Plex scan on DS225 so new tracks appear in Plexamp ────
#
# This runs HERE (right after the music rsync) — NOT at the end of the
# script — because it depends only on MUSIC landing on the NAS, which is
# step 2. Step 3 below has an early `exit 0` for the common "library
# state unchanged" case; if the Plex scan lived after that, it would be
# skipped on every music-only sync. Mobile (Plexamp) cares about music
# files, not JakeTunes' JSON metadata, so this is the correct seam.
#
# Plex's auto-scan is unreliable on this network (project_plex_scan_workaround
# in memory — the DSM web UI's scan button never fires on the home network).
# The CLI scanner via SSH is the only consistently-working path. Plex Media
# Scanner is internally idempotent — back-to-back scans coalesce — so firing
# on every music-changing sync is safe.
#
# Non-critical: a scan failure just means "mobile won't see new tracks until
# the next scan." The music is on the NAS and homemini regardless, so we
# log + notify but DON'T exit non-zero.
#
# Skip rule: in --quick mode with file_count==0 nothing moved → nothing for
# Plex to index → skip the ssh round-trip. Full mode always fires (manual
# run, or the safety-net tick catching out-of-band edits that need indexing).
if [ "$PLEX_SKIP" = "1" ]; then
  log "Plex scan skipped (JT_PLEX_SKIP=1)"
elif [ $QUICK_MODE -eq 1 ] && [ "${file_count:-0}" -eq 0 ]; then
  log "Plex scan skipped (quick mode, no files changed)"
else
  log "triggering Plex scan (section $PLEX_SECTION) via $PLEX_SSH …"
  ssh -o BatchMode=yes -o ConnectTimeout=8 "$PLEX_SSH" \
    "export LD_LIBRARY_PATH=\"/volume1/@appstore/PlexMediaServer:\$LD_LIBRARY_PATH\"; \
     export PLEX_MEDIA_SERVER_APPLICATION_SUPPORT_DIR=\"/volume1/PlexMediaServer/AppData\"; \
     \"$PLEX_SCANNER\" --scan --refresh --section $PLEX_SECTION" \
    >> "$LOG" 2>&1
  plex_rc=$?
  if [ $plex_rc -eq 0 ]; then
    log "Plex scan kicked off (section $PLEX_SECTION) — JakeTunes-mobile will pick up new tracks shortly"
  else
    log "WARNING: Plex scan ssh returned $plex_rc — music IS synced but Plex won't index it until next manual scan / auto-scan"
    notify "Synced to NAS + homemini; Plex scan failed (mobile won't see new tracks yet)."
  fi
fi

# ── 4. Artwork: rsync MacBook's artwork dir → homemini's. ────────────
#
# 2026-05-25 — the artwork-blank-on-mobile bug, closed once and for all.
# Pre-fix: desktop V3 wrote new artwork JPGs to
#   $JT_DATA_LOCAL/artwork/${md5(artist|||album)}.jpg
# but this script only synced the JSON state files (library.json,
# metadata-overrides.json, playlists.json) to homemini. The mobile
# backend on homemini serves artwork from its OWN local artwork dir
# under jakerosenbaumnas's home, which never received the new files.
# Mobile app → /artwork/{hash} → 404 → blank cover for every new
# import. Manual workaround was an ad-hoc /tmp/sync-artwork.sh; now
# built into the official chain so every desktop import → mobile sees
# the artwork within one sync cycle.
#
# --update skips files Mini already has at newer-or-equal mtime, so
# the artwork dir grows but doesn't churn — most syncs are near-empty
# rsync stat-walks. Sidecar JSONs (${hash}.meta.json from 4.5.0-55)
# also get carried so Mini's backend has the full ownership trail.
#
# Non-critical: an artwork sync failure logs + notifies but does NOT
# block the JSON state push below. Library is still useful on mobile
# without covers; missing covers backfill on the next sync.
LOCAL_ARTWORK="$JT_DATA_LOCAL/artwork/"
REMOTE_ARTWORK="$JT_DATA_REMOTE/artwork/"
if [ -d "$LOCAL_ARTWORK" ]; then
  log "rsync artwork → $HOMEMINI:$REMOTE_ARTWORK …"
  ssh -o BatchMode=yes -o ConnectTimeout=5 "$HOMEMINI" \
    "mkdir -p \"$REMOTE_ARTWORK\"" >> "$LOG" 2>&1 || true
  rsync -rtz --update --no-perms --no-owner --no-group \
    --include='*.jpg' --include='*.meta.json' --exclude='*' \
    "$LOCAL_ARTWORK" "$HOMEMINI:$REMOTE_ARTWORK" >> "$LOG" 2>&1
  art_rc=$?
  if [ $art_rc -eq 0 ]; then
    log "artwork rsync OK"
  else
    log "WARNING: artwork rsync exit $art_rc — mobile may show blank covers for new imports"
    notify "Artwork didn't reach homemini (rsync exit $art_rc). Mobile covers may be blank."
  fi
fi

# ── 5. mobile-set sidecars under LOCAL-PRIMARY (homemini ↔ local). ──
#
# 2026-06-07 sync B-pass. Pre-fix this synced the NAS copies, but under
# local-primary (4.5.0-114) the app reads/writes mobile-stars.json LOCALLY and
# never touches NAS — so a NAS-based sidecar sync was disconnected from the app
# entirely: desktop stars never reached homemini, phone stars never reached the
# desktop (the round-trip was severed).
#
# Stars now round-trip through the LOCAL file with the APP as the SOLE writer,
# so we never race its in-memory cache:
#   PULL homemini's set → mobile-stars.incoming.json (staging). The app unions
#        it into the local set on next launch (mergeIncomingMobileStars), then
#        deletes it.
#   PUSH the local set → homemini with --update (only when the desktop set is
#        newer), so a just-set phone star on homemini isn't clobbered before the
#        staging file has carried it back to the desktop.
# PULL BEFORE PUSH so a phone star is captured into staging before the push
# overwrites homemini. Additive union — cross-device un-star is best-effort
# (mobile-stars-merge.ts). No permanent loss: a phone star lives in staging
# until merged, then re-pushed next cycle.
log "pulling phone stars (homemini → local staging) …"
rsync -tz --no-perms --no-owner --no-group \
  "$HOMEMINI:$JT_DATA_REMOTE/mobile-stars.json" "$JT_DATA_LOCAL/mobile-stars.incoming.json" >> "$LOG" 2>&1
pull_rc=$?
if [ $pull_rc -ne 0 ] && [ $pull_rc -ne 23 ] && [ $pull_rc -ne 24 ]; then
  log "WARNING: pull of mobile-stars returned $pull_rc (continuing)"
  notify "Couldn't pull phone stars from homemini — desktop may be behind."
fi
log "pushing desktop stars (local → homemini) …"
if [ -f "$JT_DATA_LOCAL/mobile-stars.json" ]; then
  rsync -tz --update --no-perms --no-owner --no-group \
    "$JT_DATA_LOCAL/mobile-stars.json" "$HOMEMINI:$JT_DATA_REMOTE/mobile-stars.json" >> "$LOG" 2>&1
  push_rc=$?
  if [ $push_rc -ne 0 ] && [ $push_rc -ne 23 ] && [ $push_rc -ne 24 ]; then
    log "WARNING: push of mobile-stars returned $push_rc (continuing)"
    notify "Couldn't push desktop stars to homemini — phone may be behind."
  fi
fi
# Plays: one-way push of the desktop play log to homemini. The iOS app doesn't
# write mobile-plays.json yet, so a full round-trip is a later iOS-side change;
# this is harmless prep (no staging/merge).
if [ -f "$JT_DATA_LOCAL/mobile-plays.json" ]; then
  rsync -tz --update --no-perms --no-owner --no-group \
    "$JT_DATA_LOCAL/mobile-plays.json" "$HOMEMINI:$JT_DATA_REMOTE/mobile-plays.json" >> "$LOG" 2>&1 || true
fi

# ── 5b. Prune phone-deleted recommendations from the DESKTOP copy. ────
#
# 2026-06-10 — the phone's backend records every reco deletion as a
# tombstone in JakeTunesState/recommendations-deleted.json. Desktop V3
# merges its LOCAL recommendations.json ADDITIVELY (by id) and mirrors
# the result back to the NAS, so without this prune a phone-deleted reco
# resurrects on every desktop sync cycle (Jake: "if it is deleted on
# phone it should be deleted on laptop, and vice versa" — the laptop→
# phone direction already works via V3's own tombstones + the mirror).
# V3 re-reads its local file on every reco IPC call, so a file-level
# prune takes effect on the desktop's next read — no app restart needed.
# Atomic write (tmp + os.replace) so a concurrent V3 read never sees a
# partial file.
TOMBSTONES="$MOUNT/JakeTunesState/recommendations-deleted.json"
LOCAL_RECOS="$JT_DATA_LOCAL/recommendations.json"
if [ -f "$TOMBSTONES" ] && [ -f "$LOCAL_RECOS" ]; then
  python3 - "$TOMBSTONES" "$LOCAL_RECOS" >> "$LOG" 2>&1 <<'PY' || log "WARNING: reco tombstone prune failed (continuing)"
import json, os, sys
tomb_path, recos_path = sys.argv[1], sys.argv[2]
tombs = set(map(str, json.load(open(tomb_path))))
recos = json.load(open(recos_path))
pruned = [r for r in recos if str(r.get("id")) not in tombs]
if len(pruned) != len(recos):
    tmp = recos_path + ".prune-tmp"
    with open(tmp, "w") as f:
        json.dump(pruned, f, indent=2)
    os.replace(tmp, recos_path)
    print(f"[reco-prune] removed {len(recos) - len(pruned)} phone-deleted reco(s) from the desktop copy")
PY
fi

log "=== sync done ==="
exit 0
