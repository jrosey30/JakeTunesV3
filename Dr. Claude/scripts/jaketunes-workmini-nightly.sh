#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# jaketunes-workmini-nightly.sh — launchd wrapper for the nightly
# automated workmini deploy.
#
# Brief 029. Called by ~/Library/LaunchAgents/com.jaketunes.workmini-
# nightly.plist at 11:30 AM local time, weekdays (Mon-Fri).
#
# Why a wrapper exists:
#   launchd's environment is minimal — no PATH, no shell defaults.
#   The deploy script relies on `ping`, `ssh`, `rsync`, `hdiutil`,
#   `ditto`, `osascript`, `/usr/libexec/PlistBuddy`, `lsregister`,
#   `python3`. Setting PATH here is more reliable than putting it
#   in the plist's EnvironmentVariables dict.
#
# Failure handling:
#   The deploy script's preflight catches the common failure modes
#   (workmini unreachable, missing DMG, missing library.json, SSH
#   refused). If preflight fails, the script exits non-zero and
#   tomorrow's run tries again. No retry logic here by design —
#   we want consistent daily attempts, not adaptive backoff that
#   could mask a real workmini outage.
#
#   --build (added 2026-08-10): compile a fresh DMG from source before
#   deploying. Without it this job shipped "the newest DMG in release/",
#   which drifted 3 days / 103 commits behind while the version string
#   stayed 5.1.0 — so nothing about the app LOOKED stale. A failed
#   typecheck, failed test, or a build that produces no new artifact
#   now aborts the run loudly instead of installing yesterday's app.
#
#   2026-10-19: --build never once worked. This PATH put /usr/local/bin
#   first, and the node there is v18, which rejects the test script's
#   --experimental-strip-types flag. `npm test` died in 2 s every weekday
#   from Aug 10 and the log only said "tests failed". Homebrew's node
#   comes first now, and the deploy script refuses up front, by name,
#   if the node it finds cannot run the tests. Every run now builds
#   origin/main in a fresh worktree (never the ~/JakeTunesV3 checkout),
#   so the old --build flag is the default and no longer passed.
# ──────────────────────────────────────────────────────────────────────
set -uo pipefail

# Standard PATH for launchd context. /opt/homebrew/bin MUST come before
# /usr/local/bin: its node is node@22, and /usr/local/bin/node is a stale
# v18 that cannot run the test suite (see above). The rest covers system
# binaries the deploy script reaches for.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

LOG_DIR="$HOME/Library/Logs/JakeTunes"
LOG_FILE="$LOG_DIR/workmini-nightly.log"
mkdir -p "$LOG_DIR"

# Append both stdout and stderr to the log file.
exec >> "$LOG_FILE" 2>&1

echo ""
echo "=============================================================="
echo "Run started: $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "=============================================================="

"$HOME/bin/jaketunes-workmini-deploy.sh" jacobrosenbaum --with-env
RC=$?

echo ""
echo "Run finished: $(date '+%Y-%m-%d %H:%M:%S %Z') — exit code: $RC"
echo ""

exit $RC
