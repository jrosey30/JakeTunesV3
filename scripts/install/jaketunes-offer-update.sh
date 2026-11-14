#!/bin/bash
# jaketunes-offer-update.sh <built JakeTunes.app> <sha> <release.json>     (2026-11-14)
#
# The Thursday release job's one call per Mac. It stages and offers; it never waits and never
# installs. Run it on the Mac itself (over ssh for workmini and homemini); it returns in seconds.
#
#  1. Checks: the bundle exists and its signature verifies; the sha is 7–40 hex; the release file
#     reads with plutil as { label, kind: weekly|monthly|fix, notes: [one-line strings] }.
#  2. Stages a copy in ~/Library/Application Support/JakeTunes/staged-updates/<sha>/ (copied under
#     a hidden name, then renamed, so the agent never sees half a build), with release.json and
#     staged-at. Staging the same sha again keeps the copy and refreshes the release file.
#  3. Puts this script's siblings (jaketunes-update-agent.sh, jaketunes-install-gate.sh) in
#     .../JakeTunes/update-agent/, so the gate that runs is the one shipped with this release.
#  4. Writes ~/Library/LaunchAgents/com.jaketunes.update-gate.plist (every 5 minutes and at load;
#     AbandonProcessGroup, so the gate outlives the agent's run). Only a changed plist, or a job
#     that isn't loaded, is (re)bootstrapped; otherwise the job is kicked to look now. Idempotent.
#
# From there jaketunes-update-agent.sh owns it: the newest staged release wins, a reboot only
# delays it, the app's decision (or, on homemini, the first idle moment) starts the install.
#
# Exit: 0 offered · 1 refused (nothing staged or changed).
# Test overrides (update-agent.test.ts): JT_OFFER_DATA_DIR, JT_OFFER_PLIST, JT_OFFER_LAUNCHCTL,
# JT_OFFER_CODESIGN, JT_OFFER_LOG. All default to the real thing.
set -u
NEW="${1:-}"; SHA="${2:-}"; REL="${3:-}"
HERE=$(cd "$(dirname "$0")" && pwd)
DATA="${JT_OFFER_DATA_DIR:-$HOME/Library/Application Support/JakeTunes}"
STAGE="$DATA/staged-updates"
AGENT_DIR="$DATA/update-agent"
LABEL=com.jaketunes.update-gate
PLIST="${JT_OFFER_PLIST:-$HOME/Library/LaunchAgents/$LABEL.plist}"
LAUNCHCTL="${JT_OFFER_LAUNCHCTL:-/bin/launchctl}"
CODESIGN="${JT_OFFER_CODESIGN:-codesign}"
LOG="${JT_OFFER_LOG:-$HOME/Library/Logs/jaketunes-update-gate.log}"
fail() { echo "REFUSED: $*"; exit 1; }

[ -n "$NEW" ] && [ -n "$SHA" ] && [ -n "$REL" ] || fail "usage: $0 <JakeTunes.app> <sha> <release.json>"
[[ "$SHA" =~ ^[0-9a-f]{7,40}$ ]] || fail "sha must be 7-40 lower-case hex (got $SHA)"
[ -d "$NEW" ] || fail "no bundle at $NEW"
[ -f "$REL" ] || fail "no release file at $REL"
plutil -extract label raw -o - "$REL" >/dev/null 2>&1 || fail "the release file has no label"
KIND=$(plutil -extract kind raw -o - "$REL" 2>/dev/null) || fail "the release file has no kind"
case "$KIND" in weekly|monthly|fix) ;; *) fail "release kind must be weekly, monthly or fix (got $KIND)" ;; esac
case "$(plutil -extract notes json -o - "$REL" 2>/dev/null)" in \[*\]) ;; *) fail "the release notes must be a list" ;; esac
"$CODESIGN" --verify --deep --strict "$NEW" >/dev/null 2>&1 || fail "the bundle's signature does not verify"
for f in jaketunes-update-agent.sh jaketunes-install-gate.sh; do [ -f "$HERE/$f" ] || fail "$f is not beside this script"; done

mkdir -p "$STAGE" "$AGENT_DIR" "${PLIST%/*}" "${LOG%/*}" || fail "could not make the staging folders"
DEST="$STAGE/$SHA"
if [ -d "$DEST/JakeTunes.app" ] && [ -f "$DEST/staged-at" ]; then
  echo "already staged: $SHA (release file refreshed)"
else
  INC="$STAGE/.incoming-$SHA-$$"
  mkdir -p "$INC" || fail "could not make $INC"
  if ! ditto "$NEW" "$INC/JakeTunes.app"; then rm -rf "${INC:?}"; fail "the copy failed"; fi
  date +%s > "$INC/staged-at"
  cp "$REL" "$INC/release.json"
  [ -d "$DEST" ] && rm -rf "${DEST:?}"
  mv "$INC" "$DEST" || { rm -rf "${INC:?}"; fail "could not move the copy into place"; }
  echo "staged: $SHA"
fi
cp "$REL" "$DEST/release.json.tmp" && mv -f "$DEST/release.json.tmp" "$DEST/release.json"
# A release staged again after a skip or a give-up is a new offer.
rm -f "$DEST/skipped" "$DEST/gave-up" "$DEST/tries"

install -m 755 "$HERE/jaketunes-update-agent.sh" "$AGENT_DIR/jaketunes-update-agent.sh" || fail "could not install the agent"
install -m 755 "$HERE/jaketunes-install-gate.sh" "$AGENT_DIR/jaketunes-install-gate.sh" || fail "could not install the gate"

WANT=$(cat <<PLIST_END
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$AGENT_DIR/jaketunes-update-agent.sh</string></array>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
  <key>AbandonProcessGroup</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin</string></dict>
</dict>
</plist>
PLIST_END
)
DOMAIN="gui/$(id -u)"
changed=0
if [ "$(cat "$PLIST" 2>/dev/null)" != "$WANT" ]; then
  printf '%s\n' "$WANT" > "$PLIST.tmp" && mv -f "$PLIST.tmp" "$PLIST" || fail "could not write $PLIST"
  changed=1
fi
if [ "$changed" = 1 ] || ! "$LAUNCHCTL" print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  "$LAUNCHCTL" bootout "$DOMAIN/$LABEL" >/dev/null 2>&1
  "$LAUNCHCTL" bootstrap "$DOMAIN" "$PLIST" || fail "launchctl bootstrap failed"
  echo "agent loaded: $LABEL"
else
  "$LAUNCHCTL" kickstart "$DOMAIN/$LABEL" >/dev/null 2>&1
  echo "agent asked to look now: $LABEL"
fi
echo "offered $SHA on $(scutil --get ComputerName 2>/dev/null || hostname) — the agent takes it from here (log: $LOG)"
exit 0
