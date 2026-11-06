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
#    back. But `open` while it still exists finds the old instance (or loses the
#    single-instance lock) and starts nothing, so the app starts when that pid is gone.
#    Once the quit is asked for, every way out of this script ends with the app running
#    or a watcher that will start it: on 11/5 a quit took 21 minutes, this script gave
#    up after 30 s, and when the old process finally died the Mac had no app running.
#  - previous build kept OUTSIDE /Applications (LaunchServices), restored if
#    the copy fails; codesign verify; lsregister -f; caffeinate (10/19 sleep gap)
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
#
# Test-harness overrides (src/main/__tests__/install-gate.test.ts), all defaulting to
# the real thing: JT_GATE_APP, JT_GATE_DATA_DIR, JT_GATE_LSREGISTER, JT_GATE_PLISTBUDDY,
# JT_GATE_POLL_S (15), JT_GATE_GO_POLL_S (2), JT_GATE_QUIT_WAIT_S (30), JT_GATE_GONE_WAIT_S (30),
# JT_GATE_WATCH_S (1800), JT_GATE_WATCH_POLL_S (5).
set -u
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

# ── The app's process ────────────────────────────────────────────────────────
# pgrep -x still lists a process that is exiting. ps state: E = trying to exit, Z = zombie.
jt_live() {
  local p st
  for p in $(pgrep -x JakeTunes); do
    st=$(ps -o state= -p "$p" 2>/dev/null)
    case "$st" in ''|*E*|*Z*) ;; *) echo "$p" ;; esac
  done
}
# Which of the pids the app had before the quit still exist, in any state.
old_left() {
  local p now
  now=" $(pgrep -x JakeTunes | tr '\n' ' ')"
  for p in $OLD_PIDS; do case "$now" in *" $p "*) echo "$p" ;; esac; done
}
OLD_PIDS=""
APP_DUE=0   # 1 from the moment the quit is asked for until the app is started or a watcher will start it
# Detached: it outlives this script (and an ssh session running it). It starts the app
# when the old process is gone, unless something else already has. If the old process is
# still there at the end, the app never quit, and there is nothing to start.
start_app_when_gone() {
  APP_DUE=0
  echo "$(date +%H:%M:%S) the app starts by itself when the old JakeTunes is gone"
  nohup /bin/bash -c '
    secs=$1; poll=$2; app=$3; shift 3
    end=$(( $(date +%s) + secs ))
    while [ "$(date +%s)" -lt "$end" ]; do
      now=" $(pgrep -x JakeTunes | tr "\n" " ")"; left=""
      for p in "$@"; do case "$now" in *" $p "*) left=1 ;; esac; done
      if [ -z "$left" ]; then
        [ "$now" = " " ] && [ -d "$app" ] && open -a "$app"
        exit 0
      fi
      sleep "$poll"
    done' _ "$WATCH_S" "$WATCH_POLL" "$APP" $OLD_PIDS >/dev/null 2>&1 &
}
# Start the app now if the old process is gone within GONE_WAIT, or leave it to the
# watcher. Returns 0 when it was started here.
start_app() {
  local i
  for i in $(seq 1 "$GONE_WAIT"); do [ -z "$(old_left)" ] && break; sleep 1; done
  if [ -n "$(old_left)" ]; then start_app_when_gone; return 1; fi
  APP_DUE=0
  open -a "$APP"
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
    echo "$(date +%H:%M:%S) update-ready.json written for $SHA — the app can push the install through"
  else
    rm -f "$tmp"; echo "WARN: could not write $READY — waiting on idle only"
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
  echo "$(date +%H:%M:%S) ignoring update-go for another build (${got:-empty}) — removed"
  return 1
}

cleanup_markers() {
  [ "$markers_on" = 1 ] || return 0
  if [ -f "$READY" ] && grep -q "\"gatePid\": $$[,} ]" "$READY" 2>/dev/null; then rm -f "$READY"; fi
  if [ -f "$GO" ] && [ "$(go_sha)" = "$SHA" ]; then rm -f "$GO"; fi
}
# Any exit after the quit, a kill included, still gets the app back.
on_exit() {
  cleanup_markers
  [ "$APP_DUE" = 1 ] && start_app_when_gone
  return 0
}
trap on_exit EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

# ── Preconditions ────────────────────────────────────────────────────────────
[ -d "$NEW" ] || { echo "ABORT: no staged app at $NEW"; exit 1; }
[ -e "$HOME/$BK" ] && { echo "ABORT: ~/$BK already exists"; exit 1; }
codesign --verify --deep --strict "$NEW" || { echo "ABORT: staged app signature invalid"; exit 1; }
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
    [ "$why" != "$last" ] && echo "$(date +%H:%M:%S) waiting: $why" && last="$why"
    [ "$now" -ge "$deadline" ] && { echo "ABORT: gate never cleared in ${MAXMIN} min — nothing changed"; exit 3; }
  fi
  sleep "$GO_EVERY"
done
echo "$(date +%H:%M:%S) gate $why"
[ "$(stat -f %m "$ASAR")" = "$M0" ] || { echo "ABORT: app.asar changed while waiting (another install?)"; exit 1; }

# ── Install ──────────────────────────────────────────────────────────────────
caffeinate -i -t 300 & CAF=$!
OLD_PIDS=$(pgrep -x JakeTunes | tr '\n' ' ')
[ -n "$OLD_PIDS" ] && APP_DUE=1
perl -e 'alarm 20; exec @ARGV' osascript -e 'quit app id "com.jacobrosenbaum.jaketunes"' 2>&1
for i in $(seq 1 "$QUIT_WAIT"); do [ -z "$(jt_live)" ] && break; sleep 1; done
# Still alive: the install stops here. It may yet be quitting, so the exit trap leaves
# the watcher behind: when it goes, the app comes back. If it never goes, nothing happens.
[ -n "$(jt_live)" ] && { echo "ABORT: JakeTunes did not quit — install untouched"; kill $CAF 2>/dev/null; exit 1; }
[ -n "$(old_left)" ] && echo "$(date +%H:%M:%S) JakeTunes pid $(old_left | tr '\n' ' ')is exiting (no code running) — that counts as quit"
gate >/dev/null || true
[ "$(stat -f %m "$ASAR")" = "$M0" ] || { echo "ABORT: app.asar changed at quit time"; start_app; kill $CAF 2>/dev/null; exit 1; }

mv "$APP" "$HOME/$BK" || { echo "ABORT: could not move the old app aside"; start_app; kill $CAF 2>/dev/null; exit 1; }
if ! ditto "$NEW" "$APP"; then
  echo "COPY FAILED — restoring the previous build"
  rm -rf "$APP"; mv "$HOME/$BK" "$APP"; "$LSREG" -f "$APP"; start_app; kill $CAF 2>/dev/null; exit 1
fi
xattr -dr com.apple.quarantine "$APP" 2>/dev/null
codesign --verify --deep --strict "$APP" || echo "WARN: installed app signature check failed"
"$LSREG" -f "$APP"
pid_note="pending, it starts when the old process is gone"
if start_app; then
  # jt_live, not pgrep: a dying process must not count as started.
  for i in $(seq 1 30); do [ -n "$(jt_live)" ] && break; sleep 1; done
  pid_note="$(jt_live | head -1)"
fi
kill $CAF 2>/dev/null
echo "$(scutil --get ComputerName 2>/dev/null): $("$PLISTBUDDY" -c 'Print CFBundleShortVersionString' "$APP/Contents/Info.plist"), $(stat -f 'app.asar %z bytes, %Sm' "$ASAR"), pid $pid_note, previous kept at ~/$BK"
