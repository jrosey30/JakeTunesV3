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
SHARE_URL="${JT_SHARE:-smb://ds225.local/JakeShared}"
MOUNT="${JT_MOUNT:-/Volumes/JakeShared}"
# The live JakeShared mountpoint, WHEREVER macOS parked it (2026-08-07):
# a root-locked ghost dir at the canonical path forces every remount onto
# /Volumes/JakeShared-1, and chasing the canonical path forever meant a
# pill error on every save. If the share is mounted under any name, use
# that mount; the canonical path is a preference, not a requirement.
resolve_jakeshared() {
  /sbin/mount | /usr/bin/sed -n 's|^//[^ ]*/JakeShared on \([^ ]*\) (smbfs.*|\1|p' | /usr/bin/head -1
}
LIVE=$(resolve_jakeshared)
if [ -n "$LIVE" ] && [ -d "$LIVE/JakeTunesLibrary" ]; then
  MOUNT="$LIVE"
fi
HOMEMINI="${JT_HOMEMINI:-jakerosenbaumnas@homemini}"
PLEX_SSH="${JT_PLEX_SSH:-jakerosenbaum@ds225}"
PLEX_SECTION="${JT_PLEX_SECTION:-2}"
PLEX_SKIP="${JT_PLEX_SKIP:-0}"
PLEX_SCANNER="/volume1/@appstore/PlexMediaServer/Plex Media Scanner"
JT_DATA_LOCAL="$HOME/Library/Application Support/JakeTunes"
JT_DATA_REMOTE='Library/Application Support/JakeTunes'

# Shared remount helper (2026-08-07). A host qualifies ONLY by silently
# proving it's the DS225 (smbutil view -N via keychain lists JakeShared —
# never a prompt, never a dialog); then mount silently. Used both at startup
# and MID-RUN: on remote networks the tailnet SMB session drops every so
# often, and a drop between the startup check and the music rsync used to
# kill the whole sync with the "sync script exited 2" banner.
is_ds225() {
  /usr/bin/perl -e 'alarm 12; exec @ARGV' /usr/bin/smbutil view -N "//jakerosenbaum@$1" 2>/dev/null | grep -q JakeShared
}
ensure_jakeshared() {
  # Mounted anywhere (canonical OR suffix-drifted) = mounted. Adopt it.
  local live
  live=$(resolve_jakeshared)
  if [ -n "$live" ] && [ -d "$live/JakeTunesLibrary" ]; then MOUNT="$live"; return 0; fi
  [ -d "$MOUNT/JakeTunesLibrary" ] && return 0
  MHOST=""
  if /sbin/ping -c1 -W1000 ds225.local >/dev/null 2>&1 && is_ds225 ds225.local; then
    MHOST="ds225.local"
  elif is_ds225 192.168.1.223; then
    MHOST="192.168.1.223"
  elif is_ds225 100.117.19.93; then
    MHOST="100.117.19.93"
  fi
  if [ -z "$MHOST" ]; then
    log "NAS unreachable on every path (mDNS/LAN/tailnet) — no mount attempt (no dialog)"
    return 1
  fi
  log "mounting smb://jakerosenbaum@$MHOST/JakeShared …"
  /bin/rmdir "$MOUNT" 2>/dev/null || true   # stale dir would suffix-drift the mount
  /usr/bin/perl -e 'alarm 45; exec @ARGV' /usr/bin/osascript -e "mount volume \"smb://jakerosenbaum@$MHOST/JakeShared\"" >> "$LOG" 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    live=$(resolve_jakeshared)
    if [ -n "$live" ] && [ -d "$live/JakeTunesLibrary" ]; then MOUNT="$live"; return 0; fi
    sleep 1
  done
  return 1
}
# 4.5.0-90 Phase 2 — when the app is in NAS-source mode, the freshest
# copies of the SYNC_FILES live at JT_STATE_NAS, NOT in JT_DATA_LOCAL
# (the local userData copies go stale because the app reads/writes
# the NAS path directly). Sync's rsync source-selection below probes
# JT_STATE_NAS first and falls back to JT_DATA_LOCAL when the NAS
# mount isn't present.
# NAS state dir follows the LIVE mount — computed at use, since
# ensure_jakeshared may relocate $MOUNT after this point.
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
# 2026-07-01 — added listening-log.jsonl (append-only 'p'/'s' play+skip log,
# desktop-authored only — same one-way-push safety as play-events.jsonl). Carries
# the skip signal play-events.jsonl doesn't have, for a per-subgenre engagement
# quality prior in mix ranking.
# 2026-07-02 — added live-sets.json (V5 Live Concert Mode setlist cues,
# desktop-authored only — V3 is the single writer). The merged audio itself
# reaches the Mini through the normal library/audio sync as a regular track;
# this sidecar lets the mobile backend serve per-song setlist data later.
# 2026-07-11 — REMOVED embeddings.bin (and it never carried mood-index.bin):
# the brain is now OWNED + written by homemini's nightly job on the NAS
# canonical (project_brain_homemini_migration). The laptop must NOT push
# embeddings.bin to the NAS or it would clobber the mini's enriched brain —
# single-writer. The laptop still authors metadata-overrides.json (Cynthia +
# taxonomy) which the mini's brain-trainer READS to fold subgenres.
SYNC_FILES=(library.json metadata-overrides.json playlists.json play-events.jsonl listening-log.jsonl live-sets.json listener-profile.json musicman-memory.json musicman-interactions.jsonl picks-cache.json mobile-playlists.json playlist-additions.json)

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"
}

notify() {
  # macOS user notification — works whether launchd or interactive.
  osascript -e "display notification \"$1\" with title \"JakeTunes sync\"" 2>/dev/null || true
}

# Pull a file that may legitimately not exist yet, WITHOUT crying wolf.
#
# 2026-08-08: the log had 515 "rsync error: some files/attrs were not
# transferred (code 23)" lines against 58 real errors — a 9:1 noise ratio that
# made the real ones unfindable. Every one of the 515 was the phone listening
# log, which simply hasn't been created yet (it appears after the first phone
# play post-deploy). The control flow already handled that correctly; only the
# stderr spam was wrong.
#
# So: run rsync with stderr captured. If it failed ONLY because the source
# isn't there, stay silent and return 1 so the caller's `||` chain still works.
# Anything else gets logged verbatim, exactly as before. An error in this log
# should always mean something is actually wrong.
# Log a standing-condition note at most once an hour. The sync runs every ~2
# minutes, so a message about a state that persists for days (a file that won't
# exist until Jake next plays on his phone) would otherwise write ~700 lines a
# day. Same message, 1/30th the volume.
log_hourly() {
  local stamp=$1; shift
  if [ -z "$(find "$stamp" -mmin -60 2>/dev/null)" ]; then
    : > "$stamp"
    log "$@"
  fi
}

rsync_optional() {
  local err rc
  err=$(rsync -tz --no-perms --no-owner --no-group "$@" 2>&1 >/dev/null)
  rc=$?
  [ $rc -eq 0 ] && return 0
  case "$err" in
    *"No such file or directory"*) return 1 ;;   # expected absence — say nothing
    *) [ -n "$err" ] && printf '%s\n' "$err" >> "$LOG"; return 1 ;;
  esac
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
# 2026-08-07: this used to fire `mount volume "smb://ds225.local/…"`
# UNCONDITIONALLY — no reachability check, no username in the URL. Off
# the home LAN, ds225.local can't resolve and macOS raises the Finder
# "There was a problem connecting to the server ds225.local" dialog —
# one per sync the app triggered, which is the dialog storm Jake kept
# seeing. Now: pick a reachable host first (mDNS → LAN IP → tailnet IP,
# same ladder as ~/bin/nas-mount-keeper.sh), mount with the USERNAME in
# the URL (keychain, silent), alarm-capped, and if nothing is reachable
# SKIP the mount quietly — never attempt a mount that must fail.
ensure_jakeshared || true

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
  elif [ -f "$MOUNT/JakeTunesState/$1" ]; then
    echo "$MOUNT/JakeTunesState/$1"
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

run_music_rsync() {
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
  # 2026-08-08: --exclude='.moov-repair-backup/' — same class of bug as
  # _pending-imports/ above, found the moment the log stopped crying wolf
  # about the phone listening log. That directory holds the pre-remux
  # ORIGINALS from the April faststart repair (1,136 files, 7.9 GB, all
  # dated Apr 25). Nothing in the app or any script references it; it is an
  # inert local safety copy. Mirroring it meant every full sync asked the
  # NAS to stat 983 files it had no reason to care about, 19 of which
  # timed out at 60s each — which is what made full syncs crawl, and what
  # made the script log "a file was busy (likely streaming) or vanished"
  # on every full run. That diagnosis was wrong; nothing was streaming.
  # NOTE: sync is additive-only, so this does NOT remove the 8 GB copy
  # already sitting on the NAS. Reclaiming that is a deliberate deletion
  # and needs Jake's say-so — it is not a side effect of this change.
  rsync -az \
    --exclude='.DS_Store' --exclude='._*' --exclude='_pending-imports/' \
    --exclude='.moov-repair-backup/' \
    "$LIBRARY_ROOT/" "$MOUNT/JakeTunesLibrary/" \
    >> "$LOG" 2>&1
  music_rc=$?
fi
}
run_music_rsync
# Mid-run share drop (2026-08-07): on remote networks the tailnet SMB
# session dies every so often; when it dies BETWEEN the startup check and
# this rsync, the target dir vanishes and rsync hard-fails — that was the
# "sync script exited 2" banner colliding with every flap window. Remount
# (identity-gated, silent) and retry ONCE; only a genuine outage still
# reaches the banner.
if [ "$music_rc" -ne 0 ] && [ "$music_rc" -ne 23 ] && [ "$music_rc" -ne 24 ] && [ ! -d "$MOUNT/JakeTunesLibrary" ]; then
  log "share dropped mid-run (music rsync exit=$music_rc, target gone) — remounting + one retry"
  if ensure_jakeshared; then
    run_music_rsync
  fi
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
# Phone listening stream (2026-08-07 parity: "same page as mobile at all
# times") — the backend appends {t,ts,ar,ti,al,g,pct,src:mobile} events;
# desktop KPIs merge them with its own listening-log. Backend writes it
# next to library.json on homemini's LOCAL state dir.
# Both locations are tried and BOTH may be absent pre-first-play, so these use
# rsync_optional: a missing source is normal here and must not log an error.
rsync_optional "$HOMEMINI:JakeTunesState/mobile-listening-log.jsonl" "$JT_DATA_LOCAL/mobile-listening-log.jsonl" || \
rsync_optional "$HOMEMINI:$JT_DATA_REMOTE/mobile-listening-log.jsonl" "$JT_DATA_LOCAL/mobile-listening-log.jsonl" || \
  log_hourly /tmp/.jt-phonelog-note "phone listening log not present yet (appears after the first phone play post-deploy)"
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
# tombstone in JakeTunesState/recommendations-deleted.json; this prune
# drops those rows from V3's LOCAL cache file.
#
# 2026-07-02 (Brief 125) — V3 no longer merges additively or mirrors to
# the NAS: its sync now MIRRORS the backend list (single-writer), so
# phone-deleted rows vanish on V3's next sync without this prune. Kept
# as a harmless fast-path only (takes effect before V3's next backend
# GET); writes V3's LOCAL file only, never the NAS files — safe to
# retire whenever. Atomic write (tmp + os.replace) so a concurrent V3
# read never sees a partial file.
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
