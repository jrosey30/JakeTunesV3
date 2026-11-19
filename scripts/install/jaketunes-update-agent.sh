#!/bin/bash
# jaketunes-update-agent.sh — the install side of the weekly release, one per Mac (2026-11-14).
#
# Run by launchd (com.jaketunes.update-gate, installed by jaketunes-offer-update.sh) at load and
# every 5 minutes. It holds nothing open: each run looks, maybe starts the gate, and leaves.
#
#   staged-updates/<sha>/            in the app's data folder (~/Library/Application Support/JakeTunes)
#     JakeTunes.app                  the staged build (jaketunes-offer-update.sh put it there)
#     release.json                   { label, kind, notes }
#     staged-at                      epoch seconds; the newest staged release wins
#     gate.pid / gate.exit           the gate this agent started, and how it ended
#     tries / skipped / gave-up      what the agent has learnt about this release
#
# Each run, under a lock (one agent at a time):
#  1. Take the NEWEST staged release. Older ones are never started again; a gate still waiting
#     on one ends by itself (a v 2 gate sees the newer marker and exits 6) or, on an idle-policy
#     Mac, is sent TERM here (a v 1 gate has no marker check and could install the older build).
#  2. Already the installed build (its sha is in the installed app.asar): nothing to do; keep at
#     most the last two staged releases and the newest rollback bundle.
#  3. A gate alive for it (gate.pid names a live process that is ours): it is waiting; leave it.
#  4. How the last gate ended (gate.exit):
#       5 skipped on this Mac   → never started again ("skipped")
#       0 / 4 installed         → step 2 next time
#       1 ABORT                 → counted; after 3 the agent gives up on this release ("gave-up")
#       3 timeout, 6 replaced, 143/130 killed → started again, not counted
#     No gate.exit but a dead gate.pid: the Mac rebooted or the gate was killed hard. Started again.
#  5. Start the gate, detached, for this Mac's policy:
#       decide  the release file goes to the gate (v 2 marker): nothing installs until Jake picks
#               Install now, Install at… or Skip in the app. The default everywhere but homemini.
#       idle    no release file (v 1 marker): the gate installs at the first idle, no-audio
#               moment, as it always has. homemini's default: Jake never sees its screen
#               (2026-10-30: "the homemini you can update automatically because i dont see it
#               unless i logon to that screen").
#     The policy is ~/.config/jaketunes/update-policy ("decide" or "idle") when that file says
#     one, else by host name. ⚠️ TWIN: src/common/usage-log.ts deviceFromHostname (homemini is
#     "Jakes-Mini-…" / "Jakes-Mac-mini…"); update-agent.test.ts pins them together.
#
# launchd must not kill the gate when this script exits: the plist sets AbandonProcessGroup.
# Everything goes to ~/Library/Logs/jaketunes-update-gate.log (rotated at 1 MB).
#
# Test overrides (src/main/__tests__/update-agent.test.ts): JT_AGENT_DATA_DIR, JT_AGENT_GATE,
# JT_AGENT_APP, JT_AGENT_LOG, JT_AGENT_HOSTNAME, JT_AGENT_HOME_BACKUPS, JT_AGENT_DECIDE_MAX_MIN,
# JT_AGENT_IDLE_MAX_MIN, JT_AGENT_LOCK_HOLD. All default to the real thing.
set -u
trap '' PIPE
DATA="${JT_AGENT_DATA_DIR:-$HOME/Library/Application Support/JakeTunes}"
STAGE="$DATA/staged-updates"
GATE="${JT_AGENT_GATE:-$DATA/update-agent/jaketunes-install-gate.sh}"
APP="${JT_AGENT_APP:-/Applications/JakeTunes.app}"
LOG="${JT_AGENT_LOG:-$HOME/Library/Logs/jaketunes-update-gate.log}"
BACKUPS="${JT_AGENT_HOME_BACKUPS:-$HOME}"
POLICY_FILE="$HOME/.config/jaketunes/update-policy"
DECIDE_MAX_MIN="${JT_AGENT_DECIDE_MAX_MIN:-11520}"
IDLE_MAX_MIN="${JT_AGENT_IDLE_MAX_MIN:-180}"
MAX_TRIES=3
KEEP=2

mkdir -p "${LOG%/*}" 2>/dev/null
if [ -f "$LOG" ] && [ "$(stat -f %z "$LOG" 2>/dev/null || echo 0)" -gt 1048576 ]; then mv -f "$LOG" "$LOG.1"; fi
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') agent: $*" >> "$LOG" 2>/dev/null || true; }

[ -d "$STAGE" ] || exit 0

# ── one agent at a time ──
# The lock is a symlink whose target is its holder's pid, so taking it and naming the holder are one
# step: symlink() makes the whole link or fails because one is there. Until 2026-11-19 it was a
# folder (.agent.lock) that the holder wrote its pid into a moment after making it; an agent that
# looked in between found no pid, took the lock as left behind and went on, so on a busy Mac agents
# started together (launchd never starts two; tests and runs by hand can) could each start a gate
# for the same release.
LOCK="$STAGE/.agent-lock"
take_lock() { ln -s "$$" "$LOCK" 2>/dev/null; }
if ! take_lock; then
  holder=$(readlink "$LOCK" 2>/dev/null)
  if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then exit 0; fi
  # Its holder is gone (killed, or the Mac lost power): take it over, if it still names that pid.
  # No holder: it was let go between the two looks. Either way, one more try.
  if [ -n "$holder" ] && [ "$(readlink "$LOCK" 2>/dev/null)" = "$holder" ]; then rm -f "$LOCK"; fi
  take_lock || exit 0
  [ -n "$holder" ] && log "took over a lock left by pid $holder"
fi
trap '[ "$(readlink "$LOCK" 2>/dev/null)" = "$$" ] && rm -f "$LOCK"' EXIT   # only ever our own
# Tests only (update-agent.test.ts): hold the lock until told, so a test can start other agents at
# this moment. JT_AGENT_LOCK_HOLD is a folder: `held` appears in it once the lock is taken, and the
# agent goes on when `go` appears, the folder goes, or a minute has passed.
if [ -n "${JT_AGENT_LOCK_HOLD:-}" ]; then
  h=$JT_AGENT_LOCK_HOLD n=0
  touch "$h/held"
  while [ -d "$h" ] && [ ! -e "$h/go" ] && [ "$n" -lt 1200 ]; do sleep 0.05; n=$((n + 1)); done
fi

host_policy() {
  local h; h=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  case "$h" in
    homemini|homemini.*|jakes-mini|jakes-mini[-.]*|jakes-mac-mini|jakes-mac-mini[-.]*) echo idle ;;
    *) echo decide ;;
  esac
}
policy() {
  # No policy file is the usual case and says nothing; one that is there and can't be read still
  # says so in the log. (`tr < f 2>/dev/null` was never quiet: bash opens f before the 2> applies,
  # and wrote "No such file or directory" into the gate log, 510 lines on the MacBook by 2026-11-19,
  # 6 of them for `tries` below.)
  local p=
  [ -f "$POLICY_FILE" ] && p=$(tr -d '[:space:]' < "$POLICY_FILE")
  case "$p" in idle|decide) echo "$p"; return ;; esac
  host_policy "${JT_AGENT_HOSTNAME:-$(scutil --get LocalHostName 2>/dev/null || hostname)}"
}

valid_sha() { [[ "$1" =~ ^[0-9a-f]{7,40}$ ]]; }
# The installed bundle carries the full sha it was built from (build-info.json); its first 12 are enough
# and match whichever length the release job used.
installed() { [ -f "$APP/Contents/Resources/app.asar" ] && LC_ALL=C grep -a -q -F "${1:0:12}" "$APP/Contents/Resources/app.asar"; }
# The gate this agent started for $1, if it is alive and really ours (a pid reused after a reboot is not).
gate_alive() {
  local pid; pid=$(cat "$STAGE/$1/gate.pid" 2>/dev/null)
  [ -n "$pid" ] || return 1
  ps -ww -o command= -p "$pid" 2>/dev/null | grep -q -F "jt-update-gate-run $STAGE/$1 "
}
staged_list() {   # "<epoch> <sha>" for every complete staged release, newest first
  local d s
  for d in "$STAGE"/*/; do
    s=$(basename "$d")
    valid_sha "$s" || continue
    [ -d "$d/JakeTunes.app" ] && [ -f "$d/staged-at" ] || continue
    echo "$(tr -dc 0-9 < "$d/staged-at") $s"
  done | sort -rn
}
prune() {   # keep the newest $KEEP staged releases; never one whose gate is alive
  local n=0 line s
  while read -r line; do
    s=${line#* }
    n=$((n + 1))
    [ "$n" -le "$KEEP" ] && continue
    gate_alive "$s" && continue
    valid_sha "$s" && rm -rf "${STAGE:?}/$s" && log "removed staged $s (older than the last $KEEP)"
  done < <(staged_list)
}

NEWEST=$(staged_list | head -1)
[ -n "$NEWEST" ] || exit 0
SHA=${NEWEST#* }
DIR="$STAGE/$SHA"
POLICY=$(policy)

# 1. Older releases: never started again; on an idle Mac a waiting v 1 gate for one is stopped.
while read -r line; do
  s=${line#* }
  [ "$s" = "$SHA" ] && continue
  if gate_alive "$s" && [ "$POLICY" = idle ]; then
    pkill -TERM -P "$(cat "$STAGE/$s/gate.pid")" 2>/dev/null && log "$s: newer release $SHA staged — stopped its gate"
  fi
done < <(staged_list)

# 2. Already installed.
if installed "$SHA"; then
  if [ ! -f "$DIR/installed" ]; then
    touch "$DIR/installed"; log "$SHA is installed"
    # The newest rollback bundle stays; older ones go (what the install recipes did after a leg).
    newest_bk=$(ls -dt "$BACKUPS"/JakeTunes-prev-*.app 2>/dev/null | head -1)
    for o in "$BACKUPS"/JakeTunes-prev-*.app; do
      [ -d "$o" ] && [ "$o" != "$newest_bk" ] && rm -rf "$o" && log "removed older rollback bundle $(basename "$o")"
    done
  fi
  prune
  exit 0
fi

# 3. A gate is waiting.
if gate_alive "$SHA"; then exit 0; fi

# 4. How the last one ended.
[ -f "$DIR/skipped" ] && exit 0
[ -f "$DIR/gave-up" ] && exit 0
tries=0; [ -f "$DIR/tries" ] && tries=$(tr -dc 0-9 < "$DIR/tries"); tries=${tries:-0}
if [ -f "$DIR/gate.exit" ]; then
  code=$(tr -dc 0-9 < "$DIR/gate.exit"); code=${code:-1}
  rm -f "$DIR/gate.exit"
  case "$code" in
    5) touch "$DIR/skipped"; log "$SHA skipped on this Mac — not offered again"; prune; exit 0 ;;
    0|4) log "$SHA: the gate said installed (exit $code) but the app is not that build yet"; tries=$((tries + 1)) ;;
    1) tries=$((tries + 1)); log "$SHA: the gate stopped (ABORT, try $tries of $MAX_TRIES)" ;;
    *) log "$SHA: the gate ended with $code — starting it again" ;;
  esac
  echo "$tries" > "$DIR/tries"
elif [ -f "$DIR/gate.pid" ]; then
  log "$SHA: its gate is gone without an answer (a restart?) — starting it again"
fi
if [ "$tries" -ge "$MAX_TRIES" ]; then
  touch "$DIR/gave-up"; log "$SHA: $tries failed tries — not trying again (stage a new build to retry)"; exit 0
fi

# 5. Start the gate, detached.
[ -f "$GATE" ] || { log "no gate script at $GATE"; exit 1; }
BK="JakeTunes-prev-${SHA:0:12}-$(date +%s).app"
NOTE=$(plutil -extract label raw -o - "$DIR/release.json" 2>/dev/null || echo "JakeTunes update")
if [ "$POLICY" = decide ]; then
  set -- "$DIR/JakeTunes.app" "$BK" "$DECIDE_MAX_MIN" "$SHA" "$NOTE" "$DIR/release.json"
else
  set -- "$DIR/JakeTunes.app" "$BK" "$IDLE_MAX_MIN" "$SHA" "$NOTE"
fi
rm -f "$DIR/gate.exit"
nohup /bin/bash -c 'd=$1; shift; /bin/bash "$@"; c=$?; echo "$c" > "$d/gate.exit.tmp" && mv -f "$d/gate.exit.tmp" "$d/gate.exit"' \
  jt-update-gate-run "$DIR" "$GATE" "$@" >> "$LOG" 2>&1 < /dev/null &
echo $! > "$DIR/gate.pid"
log "$SHA: gate started (pid $!, policy $POLICY)"
exit 0
