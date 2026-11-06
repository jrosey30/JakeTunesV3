#!/bin/bash
# jaketunes-install-gate.sh <staged .app> <backup name> [max wait minutes] [sha] [note]
#
# Gated JakeTunes install on THIS Mac. Deployed copies: ~/bin/jaketunes-install-gate.sh
# on the MacBook and ~/install-jt-wait.sh on workmini — this file is the source of
# truth (scripts/install/README.md says how the pipeline calls it). Lessons folded in:
#  - audio gate is its own hard stop (9/1: an inline || let it kill a song)
#  - two audio signals: "Playing audio" assertion + a coreaudiod stream owned
#    by JakeTunes; plus ≥120 s of keyboard/mouse idle
#  - asar-mtime guard: another session installing mid-way = abort
#  - quit by process NAME (pgrep -x), never a path regex (10/11)
#  - a process on its way out (state E or Z) has quit: it runs no code and never comes
#    back. But `open` while it still exists exits 0 and starts nothing (measured, below),
#    so the app starts when that pid is gone, and only a live process proves it started.
#    Once the quit is asked for, every way out of this script ends with the app running
#    or a watcher that will start it: on 11/5 a quit took 21 minutes, this script gave
#    up after 30 s, and when the old process finally died the Mac had no app running.
#  - the copy is made and checked under a hidden name, then two renames swap it in, so nothing
#    can find half a build at the path. A kill between them puts the previous build back.
#  - previous build kept OUTSIDE /Applications (LaunchServices); codesign verify; lsregister -f;
#    caffeinate (10/19 sleep gap)
#
# "Update ready" protocol (2026-10-30, Jake: "there should be an indication somewhere
# within jaketunes that it is ready to update"). Two marker files in the app's data
# folder, ~/Library/Application Support/JakeTunes (Electron userData):
#  - update-ready.json — written here, atomically (temp file + mv), the moment the
#    wait begins, when a sha was given and the data folder exists:
#      { "v": 1, "sha": "<sha>", "version": "<CFBundleShortVersionString of the staged
#        app>", "note": "<note>", "stagedAt": "<ISO-8601 UTC>", "gatePid": <this pid> }
#    The app (src/main/update-ready.ts) shows "Update ready · Install" in its status
#    bar while the marker names a build other than the one running and gatePid is alive.
#  - update-go — written by the app when Jake clicks Install; holds the sha. The gate
#    checks for it every 2 s (one stat) and, when it carries OUR sha, installs as soon
#    as the audio checks pass — the ≥120 s idle requirement is waived, the audio hard
#    stop never is. A go-file for another sha is ignored and deleted. The heavier
#    checks (pmset / ioreg) keep their 15 s cadence until a go-file appears.
#  Both markers are removed on EVERY exit path (install done, any ABORT, timeout, a
#  TERM/INT kill) by the EXIT trap — only our own marker (our gatePid / our sha), so a
#  newer gate's files survive an older gate's death. No sha, or no data folder (a dev
#  machine): the markers are skipped and the gate behaves exactly as before.
#
# Exit codes and messages are parsed by the install pipeline — keep them:
#   0 installed · 1 ABORT (precondition, quit, copy, asar changed) · 3 gate timeout
#   4 installed, but no app came up: open -a said no, or said yes and nothing started.
#     The watcher keeps asking.
#
# Test-harness overrides (src/main/__tests__/install-gate.test.ts), all defaulting to
# the real thing: JT_GATE_APP, JT_GATE_DATA_DIR, JT_GATE_LSREGISTER, JT_GATE_PLISTBUDDY,
# JT_GATE_POLL_S (15), JT_GATE_GO_POLL_S (2), JT_GATE_QUIT_WAIT_S (30), JT_GATE_GONE_WAIT_S (30),
# JT_GATE_WATCH_S (1800, counted in polls: time awake), JT_GATE_WATCH_POLL_S (5),
# JT_GATE_OPEN_RETRY_S (2), JT_GATE_START_WAIT_S (10).
set -u
# Whatever reads this may go away first: a client that exits, a pipeline killed along with it.
# By default the next echo then gets SIGPIPE, bash runs the EXIT trap, and the trap's own first
# echo dies the same way, before it restores anything or leaves the watcher. Measured 2026-11-06:
# rc 141 and no app, one way with half a bundle. It has to be the empty trap: one that runs a
# command didn't hold on bash 3.2. And every line goes through say. With the signal ignored the
# echo just fails, but bash 3.2 keeps the text in stdout's buffer, and the next $(function) prints
# it into its capture: jt_live then read the time of day as a pid, and an app that had quit ended
# as "did not quit". So the first failure points stdout at /dev/null and flushes the text there.
trap '' PIPE
say() { echo "$@" || { exec >/dev/null; echo; }; }
NEW="$1"; BK="$2"; MAXMIN="${3:-45}"; SHA="${4:-}"; NOTE="${5:-}"
APP="${JT_GATE_APP:-/Applications/JakeTunes.app}"
ASAR="$APP/Contents/Resources/app.asar"
LSREG="${JT_GATE_LSREGISTER:-/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister}"
PLISTBUDDY="${JT_GATE_PLISTBUDDY:-/usr/libexec/PlistBuddy}"
DATA_DIR="${JT_GATE_DATA_DIR:-$HOME/Library/Application Support/JakeTunes}"
READY="$DATA_DIR/update-ready.json"
GO="$DATA_DIR/update-go"
HEAVY_EVERY="${JT_GATE_POLL_S:-15}"
GO_EVERY="${JT_GATE_GO_POLL_S:-2}"
QUIT_WAIT="${JT_GATE_QUIT_WAIT_S:-30}"
GONE_WAIT="${JT_GATE_GONE_WAIT_S:-30}"
WATCH_S="${JT_GATE_WATCH_S:-1800}"
WATCH_POLL="${JT_GATE_WATCH_POLL_S:-5}"
OPEN_RETRY="${JT_GATE_OPEN_RETRY_S:-2}"
START_WAIT="${JT_GATE_START_WAIT_S:-10}"

# ── The app's process ────────────────────────────────────────────────────────
# Measured 2026-11-06 on a real bundle held in exit, launched by open and killed:
#  - ps -p says ?E and the name in parentheses, for as long as the exit takes. pgrep -x
#    and -f see NOTHING from the moment it turns E. launchd still holds its job.
#  - open -a then exits 0 and starts nothing, and nothing starts when the process goes.
# So "is it gone" is a question for ps, by pid, and only a live process proves "it
# started", never open's exit code. The first version of this asked pgrep and believed
# open, its fakes agreed with it, and on a real exit it left the Mac with no app.
jt_live() {
  local p st
  for p in $(pgrep -x JakeTunes); do
    st=$(ps -o state= -p "$p" 2>/dev/null)
    case "$st" in ''|*E*|*Z*) ;; *) echo "$p" ;; esac
  done
}
# On its way out already, where pgrep can't see it: a re-run of this gate, or a kill by hand.
# NF == 3 leaves out "JakeTunes Helper", whose name splits in two.
jt_dying() {
  ps -axo pid=,state=,comm= 2>/dev/null | awk 'NF == 3 && $2 ~ /E/ && ($3 == "(JakeTunes)" || $3 ~ /\/JakeTunes$/) { print $1 }'
}
# Which of the pids the app had before the quit still exist. A zombie has let go of
# everything and launchd reaps it at once, so it doesn't count.
old_left() {
  local p
  for p in $OLD_PIDS; do
    case "$(ps -o state= -p "$p" 2>/dev/null)" in ''|*Z*) ;; *) echo "$p" ;; esac
  done
}
OLD_PIDS=""
APP_DUE=0   # 1 from the moment the quit is asked for until the app is started or a watcher will start it
SWAPPING=0  # 1 from moving the old bundle aside until the new one is in its place
INCOMING="$HOME/.jt-incoming-$$.app"
# Detached: it outlives this script (and an ssh session running it). It starts the app
# when the old process is gone, unless something else already has.
# Its window counts polls, never the clock: date keeps counting while the Mac sleeps, so
# a closed lid used the window up with nothing running. And it looks before it decides,
# the last time after its last sleep.
# Only one thing ends the wait: an old process plainly alive at the end of the window.
# That app never quit, nothing is owed, and a quit by hand later stays a quit. A process
# on its way out (E, or U: the 11/5 quit sat in U for 7 minutes with its main thread parked
# in teardown) gets no limit: the app is owed, however long the kernel takes. A swap only
# ever happens over a process in E or Z, so an installed build always gets its app.
# It is done when a live process says so. Until then it asks open again every 6 polls, at
# most 10 times: enough for LaunchServices to come round, few enough that an app that
# crashes on launch doesn't throw up crash reports for half an hour.
start_app_when_gone() {
  APP_DUE=0
  say "$(date +%H:%M:%S) ${1:-the app starts by itself when the old JakeTunes is gone}"
  nohup /bin/bash -c '
    polls=$1; poll=$2; app=$3; shift 3
    max_opens=$(( polls / 6 )); [ "$max_opens" -lt 1 ] && max_opens=1; [ "$max_opens" -gt 10 ] && max_opens=10
    looks=0; opens=0; until_open=0
    while :; do
      left=""; going=""
      for p in "$@"; do
        case "$(ps -o state= -p "$p" 2>/dev/null)" in
          ""|*Z*) ;;
          *E*|*U*) left=1; going=1 ;;
          *) left=1 ;;
        esac
      done
      if [ -z "$left" ]; then
        [ -n "$(pgrep -x JakeTunes)" ] && exit 0
        [ -d "$app" ] || exit 0
        if [ "$until_open" -le 0 ]; then
          [ "$opens" -ge "$max_opens" ] && exit 1
          opens=$((opens + 1)); until_open=6
          open -a "$app"
        fi
        until_open=$((until_open - 1))
      elif [ -z "$going" ] && [ "$looks" -ge "$polls" ]; then
        exit 0
      fi
      looks=$((looks + 1))
      sleep "$poll"
    done' _ "$(awk -v s="$WATCH_S" -v p="$WATCH_POLL" 'BEGIN { n = int(s / p); print (n < 1 ? 1 : n) }')" \
    "$WATCH_POLL" "$APP" $OLD_PIDS >/dev/null 2>&1 &
}
# Start the app now if the old process is gone within GONE_WAIT, or leave it to the watcher.
# 0 a live process came up · 1 the old process is still there, the watcher has it · 2 none
# came up in 3 tries (LaunchServices has only just been told about the bundle), the watcher
# keeps asking.
start_app() {
  local i j
  for i in $(seq 1 "$GONE_WAIT"); do [ -z "$(old_left)" ] && break; sleep 1; done
  if [ -n "$(old_left)" ]; then start_app_when_gone; return 1; fi
  for i in 1 2 3; do
    if open -a "$APP"; then
      # jt_live, not pgrep: a dying process must not count as started.
      for j in $(seq 1 "$START_WAIT"); do
        if [ -n "$(jt_live)" ]; then APP_DUE=0; return 0; fi
        sleep 1
      done
    else
      sleep "$OPEN_RETRY"
    fi
  done
  start_app_when_gone "no app after 3 tries of open -a; still trying in the background"
  return 2
}
# The previous build back in /Applications.
restore_previous() {
  [ -d "$HOME/$BK" ] || return 0
  rm -rf "$APP"
  mv "$HOME/$BK" "$APP" && "$LSREG" -f "$APP"
}

# ── Marker protocol ──────────────────────────────────────────────────────────
markers_on=0
[ -n "$SHA" ] && [ -d "$DATA_DIR" ] && markers_on=1

# Minimal JSON string escaping (the note is free text from the pipeline).
json_str() {
  local s="$1"
  s=${s//\\/\\\\}; s=${s//\"/\\\"}
  s=${s//$'\n'/ }; s=${s//$'\r'/ }; s=${s//$'\t'/ }
  printf '%s' "$s"
}

write_ready() {
  [ "$markers_on" = 1 ] || return 0
  local ver tmp
  ver=$("$PLISTBUDDY" -c 'Print CFBundleShortVersionString' "$NEW/Contents/Info.plist" 2>/dev/null || true)
  tmp="$DATA_DIR/.update-ready.$$.tmp"
  if printf '{ "v": 1, "sha": "%s", "version": "%s", "note": "%s", "stagedAt": "%s", "gatePid": %d }\n' \
      "$(json_str "$SHA")" "$(json_str "$ver")" "$(json_str "$NOTE")" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$$" > "$tmp" \
     && mv -f "$tmp" "$READY"; then
    say "$(date +%H:%M:%S) update-ready.json written for $SHA — the app can push the install through"
  else
    rm -f "$tmp"; say "WARN: could not write $READY — waiting on idle only"
  fi
}

go_sha() { head -c 200 "$GO" 2>/dev/null | tr -d '[:space:]'; }

# True when the app asked for THIS build. A go-file for another build is
# removed so it cannot linger into a later gate — taken aside first, so a
# file the app replaces in the same instant is never the one removed (a
# read-then-delete lost the right go-file under load, 2026-10-30, and the
# gate then waited its whole 45 minutes). An empty file is a write in
# progress: left alone until the next look.
go_requested() {
  [ "$markers_on" = 1 ] || return 1
  [ -f "$GO" ] || return 1
  local want; want=$(go_sha)
  [ "$want" = "$SHA" ] && return 0
  [ -n "$want" ] || return 1
  local aside="$GO.ignored.$$"
  mv -f "$GO" "$aside" 2>/dev/null || return 1
  local got; got=$(head -c 200 "$aside" 2>/dev/null | tr -d '[:space:]')
  if [ "$got" = "$SHA" ]; then mv -f "$aside" "$GO"; return 0; fi
  rm -f "$aside"
  say "$(date +%H:%M:%S) ignoring update-go for another build (${got:-empty}) — removed"
  return 1
}

cleanup_markers() {
  [ "$markers_on" = 1 ] || return 0
  if [ -f "$READY" ] && grep -q "\"gatePid\": $$[,} ]" "$READY" 2>/dev/null; then rm -f "$READY"; fi
  if [ -f "$GO" ] && [ "$(go_sha)" = "$SHA" ]; then rm -f "$GO"; fi
}
# Any exit after the quit, a kill included, still gets the app back. A kill between the two
# renames leaves no bundle at the path, so the previous build goes back first.
on_exit() {
  cleanup_markers
  if [ "$SWAPPING" = 1 ]; then
    say "$(date +%H:%M:%S) killed during the swap — restoring the previous build"
    restore_previous
  fi
  rm -rf "$INCOMING"
  [ "$APP_DUE" = 1 ] && start_app_when_gone
  return 0
}
trap on_exit EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

# ── Preconditions ────────────────────────────────────────────────────────────
[ -d "$NEW" ] || { say "ABORT: no staged app at $NEW"; exit 1; }
[ -e "$HOME/$BK" ] && { say "ABORT: ~/$BK already exists"; exit 1; }
codesign --verify --deep --strict "$NEW" || { say "ABORT: staged app signature invalid"; exit 1; }
M0=$(stat -f %m "$ASAR")

# $1 = 1 when the app asked for the install: idle is not required, audio still is.
gate() {
  if pmset -g assertions | grep JakeTunes | grep -q "Playing audio"; then echo "playing audio"; return 1; fi
  for p in $(pmset -g assertions | grep -A1 coreaudiod | sed -nE 's/.*Created for PID: ([0-9]+).*/\1/p'); do
    ps -o comm= -p "$p" 2>/dev/null | grep -q JakeTunes && { echo "JakeTunes holds an audio stream"; return 1; }
  done
  if [ "${1:-0}" = 1 ]; then echo "clear (install clicked in the app, no audio)"; return 0; fi
  idle=$(( $(ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print $NF; exit}') / 1000000000 ))
  [ "$idle" -ge 120 ] || { echo "in use ${idle}s ago"; return 1; }
  echo "clear (idle ${idle}s, no audio)"; return 0
}

# ── Wait ─────────────────────────────────────────────────────────────────────
write_ready
deadline=$(( $(date +%s) + MAXMIN * 60 )); last=""; heavy_at=0; why=""
while :; do
  go=0; go_requested && go=1
  now=$(date +%s)
  if [ "$go" = 1 ] || [ $(( now - heavy_at )) -ge "$HEAVY_EVERY" ]; then
    heavy_at=$now
    if why="$(gate "$go")"; then break; fi
    [ "$why" != "$last" ] && say "$(date +%H:%M:%S) waiting: $why" && last="$why"
    [ "$now" -ge "$deadline" ] && { say "ABORT: gate never cleared in ${MAXMIN} min — nothing changed"; exit 3; }
  fi
  sleep "$GO_EVERY"
done
say "$(date +%H:%M:%S) gate $why"
[ "$(stat -f %m "$ASAR")" = "$M0" ] || { say "ABORT: app.asar changed while waiting (another install?)"; exit 1; }

# ── Install ──────────────────────────────────────────────────────────────────
caffeinate -i -t 300 & CAF=$!
OLD_PIDS="$(pgrep -x JakeTunes | tr '\n' ' ')$(jt_dying | tr '\n' ' ')"
[ -n "$OLD_PIDS" ] && APP_DUE=1
perl -e 'alarm 20; exec @ARGV' osascript -e 'quit app id "com.jacobrosenbaum.jaketunes"' 2>&1
for i in $(seq 1 "$QUIT_WAIT"); do [ -z "$(jt_live)" ] && break; sleep 1; done
# Still alive: the install stops here. It may yet be quitting, so the exit trap leaves
# the watcher behind: when it goes, the app comes back. If it never goes, nothing happens.
[ -n "$(jt_live)" ] && { say "ABORT: JakeTunes did not quit — install untouched"; kill $CAF 2>/dev/null; exit 1; }
[ -n "$(old_left)" ] && say "$(date +%H:%M:%S) JakeTunes pid $(old_left | tr '\n' ' ')is exiting (no code running) — that counts as quit"
gate >/dev/null || true
[ "$(stat -f %m "$ASAR")" = "$M0" ] || { say "ABORT: app.asar changed at quit time"; start_app; kill $CAF 2>/dev/null; exit 1; }

# Copy first, swap second. In a bundle's order the executable lands long before Info.plist (line 5
# of 298 in ditto -V), so a copy straight into /Applications could start half done for anything
# that opened it (a watcher, a Dock click, the sync on homemini), and a kill or a power cut left
# it there. The copy goes to a hidden name and is checked there, so all of that finds a whole build
# at the path and only the gap between two renames is left. $HOME and /Applications are one volume
# on all three Macs (stat, 11/6), and restore_previous has always moved the bundle the same way.
for d in "$HOME"/.jt-incoming-*.app; do
  p=${d##*-}; p=${p%.app}
  [ -d "$d" ] && ! kill -0 "$p" 2>/dev/null && rm -rf "$d"
done
if ! ditto "$NEW" "$INCOMING"; then
  say "COPY FAILED — the installed build was not touched"
  start_app; kill $CAF 2>/dev/null; exit 1
fi
xattr -dr com.apple.quarantine "$INCOMING" 2>/dev/null
if ! codesign --verify --deep --strict "$INCOMING"; then
  say "ABORT: the copy failed its signature check — the installed build was not touched"
  start_app; kill $CAF 2>/dev/null; exit 1
fi
# Something started the app while that ran. Swapping now would leave it running from ~/$BK, and
# the new build's launch would lose the single-instance lock to it, with this gate reporting its
# pid as the new build's.
if [ -n "$(jt_live)" ]; then
  APP_DUE=0
  say "ABORT: JakeTunes started again during the copy — install untouched"
  kill $CAF 2>/dev/null; exit 1
fi

SWAPPING=1
mv "$APP" "$HOME/$BK" || { SWAPPING=0; say "ABORT: could not move the old app aside"; start_app; kill $CAF 2>/dev/null; exit 1; }
if ! mv "$INCOMING" "$APP"; then
  say "COPY FAILED — restoring the previous build"
  restore_previous; SWAPPING=0; start_app; kill $CAF 2>/dev/null; exit 1
fi
SWAPPING=0
"$LSREG" -f "$APP"
gate_rc=0
start_app
case $? in
  0) pid_note="$(jt_live | head -1)" ;;
  1) pid_note="pending, it starts when the old process is gone" ;;
  *) pid_note="none, the app did not come up, still trying"; gate_rc=4 ;;
esac
kill $CAF 2>/dev/null
say "$(scutil --get ComputerName 2>/dev/null): $("$PLISTBUDDY" -c 'Print CFBundleShortVersionString' "$APP/Contents/Info.plist"), $(stat -f 'app.asar %z bytes, %Sm' "$ASAR"), pid $pid_note, previous kept at ~/$BK"
exit $gate_rc
