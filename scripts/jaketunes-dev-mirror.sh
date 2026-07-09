#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────
# Continuous dev mirror (2026-07-09) — keeps the laptop DISPOSABLE.
#
# Jake's goal: "absolutely not store anything on my laptop even if I make
# 99.99% of my edits/fixes/builds here." This makes it true for CODE: every
# committed change is auto-pushed to GitHub (and thus reachable on homemini)
# within the interval, so nothing UNIQUE is ever trapped on the laptop. Wipe
# the laptop anytime → re-clone from GitHub/homemini → lose nothing.
#
# SAFETY: push-only, current-branch-only, NEVER --force, never touches
# uncommitted files, never deletes. A rejected/diverged push just logs and
# retries next run — no harm. (App DATA — library.json/artwork/brain — is
# mirrored separately by the NAS backup + homemini; this handles code.)
#
# NOTE: only COMMITTED work mirrors. Uncommitted edits are safe once committed
# (which is how the Claude Code workflow operates — it commits frequently).
#
# Runs via launchd com.jaketunes.dev-mirror (every 5 min + at load).
# ─────────────────────────────────────────────────────────────────────────
set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
LOG="$HOME/Library/Logs/jaketunes-dev-mirror.log"
ts(){ date '+%Y-%m-%d %H:%M:%S'; }
log(){ echo "$(ts) $*" >> "$LOG"; }

REPOS=("$HOME/JakeTunesV3" "$HOME/JakeTunesMobile" "$HOME/nowhere-player")

for r in "${REPOS[@]}"; do
  [ -d "$r/.git" ] || continue
  cd "$r" 2>/dev/null || continue
  br=$(git branch --show-current 2>/dev/null) || continue
  [ -n "$br" ] || continue                      # detached HEAD — skip
  name=$(basename "$r")
  if ! up=$(git rev-list --count "@{upstream}..HEAD" 2>/dev/null); then
    # no upstream configured for this branch — establish it + push
    if git push -u origin "$br" >/dev/null 2>>"$LOG"; then log "$name [$br]: pushed + set upstream"; fi
  elif [ "$up" -gt 0 ] 2>/dev/null; then
    if git push origin "$br" >/dev/null 2>>"$LOG"; then
      log "$name [$br]: mirrored $up commit(s) to GitHub"
    else
      log "$name [$br]: push rejected (diverged/offline) — will retry"
    fi
  fi
  # (no-op case is intentionally silent to keep the log meaningful)
done
