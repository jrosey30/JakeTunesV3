#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────
# SCOTUS vault backup — Poppy's Beck v. Prupis argument (2026-07-08).
#
# Jake's grandfather's 1999 Supreme Court argument is a one-of-one, irreplaceable
# family artifact. It was previously laptop-ONLY; Jake asked for it to also live
# on the NAS and homemini. This mirrors the vault from the laptop (the source of
# truth — the desktop app writes it there) to both, keeping three independent
# physical copies (laptop SSD · NAS RAID · homemini SSD).
#
# TWO HARD SAFETY RULES for irreplaceable data:
#   1. APPEND/UPDATE ONLY — never --delete. A local corruption or accidental
#      deletion must NEVER propagate to wipe a backup. Backups only ever gain
#      or refresh files; they never lose one.
#   2. NON-DESTRUCTIVE + BREAKER-SAFE — a slow NAS or offline homemini is
#      skipped and logged, never hung on, never fatal. Each run is independent;
#      a missed destination simply catches up next run.
#
# All three copies stay PRIVATE (laptop + household NAS + private tailnet Mac).
# Never publish / expose this anywhere.
#
# Canonical live copy: ~/.local/bin/scotus-archive-backup.sh (stable path so a
# repo migration can't orphan the launchd agent). Version-controlled twin:
# JakeTunesV3/scripts/scotus-archive-backup.sh — keep in sync.
# Runs via launchd: com.jaketunes.scotus-backup (daily 04:30 + at load).
# ─────────────────────────────────────────────────────────────────────────
set -uo pipefail

# launchd runs with a minimal PATH that lacks Homebrew's `timeout` (coreutils),
# which broke the scheduled run ("timeout: command not found"). Prepend the usual
# brew locations, then define a portable timeout shim that still works even if no
# timeout binary exists at all (degrades to running the command uncapped).
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if   command -v timeout  >/dev/null 2>&1; then TO() { timeout "$@"; }
elif command -v gtimeout >/dev/null 2>&1; then TO() { gtimeout "$@"; }
else TO() { shift; "$@"; }; fi

SRC="$HOME/Library/Application Support/JakeTunes/scotus-archive"
NAS_DIR="/Volumes/JakeShared/JakeTunesState"
NAS="$NAS_DIR/scotus-archive"
MINI_USER="jakerosenbaumnas"
MINI_HOST="homemini"
MINI_DEST="JakeTunesState/scotus-archive"          # relative to homemini's $HOME
LOG="$HOME/Library/Logs/jaketunes-scotus-backup.log"

ts()  { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "$(ts) $*" >> "$LOG"; }

[ -d "$SRC" ] || { log "SOURCE MISSING ($SRC) — nothing to back up, exiting clean"; exit 0; }
SRC_N=$(find "$SRC" -type f | wc -l | tr -d ' ')
log "run start — source has $SRC_N file(s)"

# ── NAS (RAID) — local mount, but SMB can be slow: reachability-gated + capped ──
if TO 20 ls -d "$NAS_DIR" >/dev/null 2>&1; then
  mkdir -p "$NAS" 2>>"$LOG"
  if TO 180 ditto "$SRC" "$NAS" 2>>"$LOG"; then
    NAS_N=$(TO 20 sh -c "find '$NAS' -type f | wc -l" 2>/dev/null | tr -d ' ')
    log "NAS mirror OK -> $NAS (${NAS_N:-?} files)"
  else
    log "NAS mirror FAILED/slow — will retry next run"
  fi
else
  log "NAS not mounted or slow — skipped this run"
fi

# ── homemini (independent SSD over tailnet) — connect-timeout gated, tar-pipe ──
if TO 12 ssh -o BatchMode=yes -o ConnectTimeout=10 "$MINI_USER@$MINI_HOST" "mkdir -p ~/$MINI_DEST" 2>>"$LOG"; then
  if TO 120 bash -c "tar -C \"$SRC\" -cf - . | ssh -o BatchMode=yes '$MINI_USER@$MINI_HOST' 'tar -C ~/$MINI_DEST -xf -'" 2>>"$LOG"; then
    MINI_N=$(ssh -o BatchMode=yes "$MINI_USER@$MINI_HOST" "find ~/$MINI_DEST -type f | wc -l" 2>/dev/null | tr -d ' ')
    log "homemini mirror OK (${MINI_N:-?} files)"
  else
    log "homemini mirror FAILED — will retry next run"
  fi
else
  log "homemini unreachable — skipped this run"
fi

log "run end"
