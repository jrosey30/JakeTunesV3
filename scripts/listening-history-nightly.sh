#!/bin/bash
# Nightly on homemini (launchd com.jaketunes.listening-history, 04:00 — after
# the brain trainer at 2:00 and brain-improve at 3:05): build the all-device
# listening history and the 28-day scorecard the weekly KPI report reads
# (Year in Review step 2, 2026-10-10), then this year's Year in Review facts
# from that history (step 4) — so the review is always current, not built
# by hand in December.
#
# Installed as ~/bin/jaketunes-listening-history.sh (a stable path, so the
# checkout below can move under it). Runs the code from its OWN checkout,
# ~/JakeTunesV3-yir, detached at origin/main and refreshed each night — it
# never moves the brain trainer's clone. Reads the logs; writes only
# ~/Library/Application Support/JakeTunes/yir/ (+ a copy on the NAS).
set -u
W="${JT_YIR_WORKTREE:-$HOME/JakeTunesV3-yir}"
UD="$HOME/Library/Application Support/JakeTunes"
NAS_STATE="${JT_NAS_STATE:-/Volumes/JakeShared/JakeTunesState}"
OUT="$UD/yir"
LOG="$HOME/Library/Logs/jaketunes-listening-history.log"
NODE="${JT_NODE:-/opt/homebrew/bin/node}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }
with_timeout() { local s="$1"; shift; perl -e 'alarm shift; exec @ARGV' "$s" "$@"; }

log "=== start"
if [ ! -d "$W/.git" ] && [ ! -f "$W/.git" ]; then
  log "no checkout at $W — run: git -C ~/JakeTunesV3 worktree add --detach $W origin/main"
  exit 1
fi
if with_timeout 60 git -C "$W" fetch -q origin main 2>>"$LOG"; then
  with_timeout 30 git -C "$W" checkout -q --detach origin/main 2>>"$LOG" && log "code @ $(git -C "$W" rev-parse --short HEAD)"
else
  log "fetch failed — running the code already checked out ($(git -C "$W" rev-parse --short HEAD))"
fi

args=(
  --laptop "$UD/listening-log.jsonl"
  --workmini "$UD/replicas/workmini/listening-log.jsonl"
  --phone "$NAS_STATE/mobile-listening-log.jsonl"
  --ipod "$UD/ipod-roundtrip-ledger.jsonl"
  --library "$UD/library.json"
  --out "$OUT"
)
if with_timeout 600 "$NODE" "$W/scripts/listening-history.mts" "${args[@]}" >> "$LOG" 2>&1; then
  log "built $OUT"
  # Year in Review facts. Its own failure never touches the history or the
  # scorecard above — those are already written. The year is New York's
  # (the review's calendar), and mixtapes.json is whichever copy is newer:
  # the NAS mirror of the laptop's, or homemini's own.
  YEAR=$(TZ=America/New_York date +%Y)
  TAPES="$NAS_STATE/mixtapes.json"
  [ "$UD/mixtapes.json" -nt "$TAPES" ] && TAPES="$UD/mixtapes.json"
  if with_timeout 300 "$NODE" "$W/scripts/year-in-review.mts" \
      --history "$OUT/listening-history.jsonl" --library "$UD/library.json" \
      --live-sets "$UD/live-sets.json" --mixtapes "$TAPES" --year "$YEAR" --out "$OUT" >> "$LOG" 2>&1; then
    log "built year-in-review-$YEAR.json"
  else
    log "year in review FAILED (error above) — history and scorecard are fine"
  fi
  # The NAS copy goes through node, not cp: under launchd macOS grants
  # network-volume access per program, and on homemini node has it while
  # /bin/cp is refused ("Operation not permitted", measured 2026-10-10).
  if "$NODE" -e '
    const fs = require("fs"), path = require("path")
    const [src, dst] = process.argv.slice(1)
    fs.mkdirSync(dst, { recursive: true })
    for (const f of fs.readdirSync(src)) if (/^(listening-(summary-\d+|kpi)|year-in-review-\d+)\.json$/.test(f)) fs.copyFileSync(path.join(src, f), path.join(dst, f))
  ' "$OUT" "$NAS_STATE/yir" 2>>"$LOG"; then
    log "copied the summary, scorecard and year in review to the NAS"
  else
    log "NAS copy FAILED (error above) — homemini's copy is current"
  fi
else
  log "FAILED — previous outputs left in place"
  exit 1
fi
