#!/usr/bin/env bash
# enrichment-nightly.sh — launchd wrapper for com.jaketunes.enrichment-catchup
# (Brief 177's driver: ledger refresh → lyrics batch → CLAP delta). Installed
# as ~/bin/jaketunes-enrichment-nightly.sh; the plist runs that copy.
#
# 2026-10-20: lyrics.json had not been written since 9/1 and the CLAP audio
# index was frozen the same day — the job was "proposed" in jobs.json and
# never installed, and both steps were otherwise manual. 1,790 songs had
# never been looked up.
#
# Runs origin/main's scripts from its OWN detached worktree, never the shared
# ~/JakeTunesV3 checkout: parallel sessions switch branches there, and a live
# job running whatever branch was left behind has bitten before. The scripts
# need no node_modules (node built-ins only); CLAP uses the repo's
# .venv-clap, which lives outside git and survives branch switches.
#
# While JakeTunes is playing audio, the CPU-heavy CLAP phase is skipped
# (--skip-clap); lyrics are network-light and still run.
set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

REPO="${JAKETUNES_REPO:-$HOME/JakeTunesV3}"
WT="${ENRICHMENT_WORKTREE:-$HOME/Library/Caches/JakeTunes-enrichment/worktree}"
NODE="${NODE_BIN:-/opt/homebrew/bin/node}"
PYTHON="$REPO/.venv-clap/bin/python"

# Hard timeout for git (no coreutils `timeout` on stock macOS).
tmo() { perl -e 'alarm shift; exec @ARGV or exit 127' "$@"; }
log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [enrichment-nightly] $*"; }

log "start"
tmo 120 git -C "$REPO" fetch --quiet origin main || log "git fetch failed (exit $?) — using the last fetched origin/main"
if [[ -d "$WT/.git" || -f "$WT/.git" ]]; then
  tmo 60 git -C "$WT" checkout --quiet --force --detach origin/main || { log "could not move the worktree to origin/main"; exit 1; }
else
  mkdir -p "$(dirname "$WT")"
  git -C "$REPO" worktree prune >/dev/null 2>&1
  tmo 120 git -C "$REPO" worktree add --quiet --detach "$WT" origin/main || { log "could not create the worktree"; exit 1; }
fi
log "scripts at origin/main $(git -C "$WT" rev-parse --short HEAD)"

ARGS=(--budget-min 60)
[[ -x "$PYTHON" ]] && ARGS+=(--python "$PYTHON")
if pmset -g assertions 2>/dev/null | grep -i jaketunes | grep -q "Playing audio"; then
  log "JakeTunes is playing audio — skipping the CLAP phase tonight, lyrics still run"
  ARGS+=(--skip-clap)
fi

cd "$WT" || exit 1
"$NODE" "$WT/scripts/enrichment-catchup.mjs" "${ARGS[@]}" "$@"   # "$@": e.g. --dry-run when testing by hand
RC=$?
log "finished — exit $RC"
exit $RC
