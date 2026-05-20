#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# jaketunes-workmini-nightly.sh — launchd wrapper for the nightly
# automated workmini deploy.
#
# Brief 029. Called by ~/Library/LaunchAgents/com.jaketunes.workmini-
# nightly.plist at 3:00 AM daily.
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
# ──────────────────────────────────────────────────────────────────────
set -uo pipefail

# Standard PATH for launchd context. /usr/local/bin and /opt/homebrew/bin
# cover Homebrew on both Intel and Apple Silicon; the rest covers
# system binaries the deploy script reaches for.
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

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
