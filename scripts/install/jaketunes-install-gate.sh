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
# JT_GATE_POLL_S (15), JT_GATE_GO_POLL_S (2).
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
# removed so it cannot linger into a later gate.
go_requested() {
  [ "$markers_on" = 1 ] || return 1
  [ -f "$GO" ] || return 1
  local want; want=$(go_sha)
  [ "$want" = "$SHA" ] && return 0
  echo "$(date +%H:%M:%S) ignoring update-go for another build (${want:-empty}) — removed"
  rm -f "$GO"
  return 1
}

cleanup_markers() {
  [ "$markers_on" = 1 ] || return 0
  if [ -f "$READY" ] && grep -q "\"gatePid\": $$[,} ]" "$READY" 2>/dev/null; then rm -f "$READY"; fi
  if [ -f "$GO" ] && [ "$(go_sha)" = "$SHA" ]; then rm -f "$GO"; fi
}
trap cleanup_markers EXIT
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
perl -e 'alarm 20; exec @ARGV' osascript -e 'quit app id "com.jacobrosenbaum.jaketunes"' 2>&1
for i in $(seq 1 30); do pgrep -x JakeTunes >/dev/null || break; sleep 1; done
pgrep -x JakeTunes >/dev/null && { echo "ABORT: JakeTunes did not quit — install untouched"; kill $CAF 2>/dev/null; exit 1; }
gate >/dev/null || true
[ "$(stat -f %m "$ASAR")" = "$M0" ] || { echo "ABORT: app.asar changed at quit time"; open -a "$APP"; kill $CAF 2>/dev/null; exit 1; }

mv "$APP" "$HOME/$BK" || { echo "ABORT: could not move the old app aside"; open -a "$APP"; kill $CAF 2>/dev/null; exit 1; }
if ! ditto "$NEW" "$APP"; then
  echo "COPY FAILED — restoring the previous build"
  rm -rf "$APP"; mv "$HOME/$BK" "$APP"; "$LSREG" -f "$APP"; open -a "$APP"; kill $CAF 2>/dev/null; exit 1
fi
xattr -dr com.apple.quarantine "$APP" 2>/dev/null
codesign --verify --deep --strict "$APP" || echo "WARN: installed app signature check failed"
"$LSREG" -f "$APP"
open -a "$APP"
for i in $(seq 1 30); do pgrep -x JakeTunes >/dev/null && break; sleep 1; done
kill $CAF 2>/dev/null
echo "$(scutil --get ComputerName 2>/dev/null): $("$PLISTBUDDY" -c 'Print CFBundleShortVersionString' "$APP/Contents/Info.plist"), $(stat -f 'app.asar %z bytes, %Sm' "$ASAR"), pid $(pgrep -x JakeTunes | head -1), previous kept at ~/$BK"
