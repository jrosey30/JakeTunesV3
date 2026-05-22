#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# jaketunes-workmini-deploy.sh — one-shot JakeTunes deployment to the
# work Mac mini ("workmini" on Tailscale). App + full music library +
# library metadata, end to end.
#
# Usage:
#   jaketunes-workmini-deploy.sh <workmini-username> [--with-env]
#
#   <workmini-username>  the macOS short username ON workmini. Get it by
#                        running `whoami` in Terminal on workmini — it is
#                        NOT necessarily "jacobrosenbaum" (homemini's, for
#                        comparison, is "jakerosenbaumnas").
#   --with-env           ALSO copy ~/Library/Application Support/JakeTunes/
#                        .env (the API keys for the AI personas). Off by
#                        default because it moves secrets between machines
#                        — opt in explicitly.
#
# PREREQUISITE (the one thing this script can't do for you):
#   Remote Login must be ON on workmini —
#   System Settings → General → Sharing → Remote Login.
#   Until then SSH is refused and the script stops at preflight.
#
# Safe to re-run: the app re-installs cleanly and rsync resumes a
# partial library transfer where it left off.
#
# Why the paths work out:
#   - library.json stores RELATIVE iPod-style paths
#     (":iPod_Control:Music:F13:GYUR.m4a"), so it's portable across
#     machines/usernames untouched.
#   - JakeTunes' library-root resolver (Brief 011b) is three-tier:
#     library.musicRoot in app-settings.json wins absolutely; otherwise
#     it picks the richer of ~/Music2/JakeTunesLibrary (legacy) and
#     ~/Music/JakeTunesLibrary (default) by F00-F49 subdirectory count.
#     This script writes library.musicRoot to ~/Music/JakeTunesLibrary
#     on every deploy (step 4.5) so Tier 1 wins — making the stale-
#     legacy bug architecturally impossible on workmini, regardless of
#     what's left over in ~/Music2/ from prior installs.
# ─────────────────────────────────────────────────────────────────────
set -uo pipefail

WORKMINI_USER="${1:-}"
WITH_ENV=false
[[ "${2:-}" == "--with-env" ]] && WITH_ENV=true

if [[ -z "$WORKMINI_USER" ]]; then
  echo "Usage: $(basename "$0") <workmini-username> [--with-env]"
  echo "  Run 'whoami' in Terminal on workmini to get the username."
  exit 1
fi

HOST="workmini"                       # Tailscale MagicDNS name
SSH_OPTS="-o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new"
REMOTE="${WORKMINI_USER}@${HOST}"
REPO="/Users/jacobrosenbaum/JakeTunesV3"
DMG="$(ls -t "$REPO"/release/JakeTunes-*-arm64.dmg 2>/dev/null | head -1)"
LIB_SRC="/Users/jacobrosenbaum/Music2/JakeTunesLibrary/"
LIBJSON_SRC="/Users/jacobrosenbaum/Library/Application Support/JakeTunes/library.json"
ENV_SRC="/Users/jacobrosenbaum/Library/Application Support/JakeTunes/.env"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

say "JakeTunes → workmini deployment"
echo "  app:    $(basename "${DMG:-<none found>}")"
echo "  target: ${REMOTE}"
echo "  .env:   $([[ $WITH_ENV == true ]] && echo 'will copy (--with-env)' || echo 'skipped (default)')"

# ── 1. Preflight ─────────────────────────────────────────────────────
say "[1/5] Preflight"
[[ -n "$DMG" && -f "$DMG" ]] || die "No DMG in $REPO/release/ — run 'npm run dist:dmg' first."
[[ -f "$LIBJSON_SRC" ]]      || die "library.json not found at $LIBJSON_SRC"
[[ -d "$LIB_SRC" ]]         || die "Music library not found at $LIB_SRC"
ping -c1 -t3 "$HOST" >/dev/null 2>&1 || die "$HOST is not reachable on Tailscale (is it awake / on the tailnet?)."
if ! ssh $SSH_OPTS -o BatchMode=yes "$REMOTE" true 2>/dev/null; then
  die "SSH to ${REMOTE} failed.
    → Enable Remote Login on workmini:
        System Settings → General → Sharing → Remote Login (ON)
    → Double-check the username (run 'whoami' on workmini).
    Then re-run this script."
fi
WM_HOME="$(ssh $SSH_OPTS "$REMOTE" 'echo $HOME')"
[[ -n "$WM_HOME" ]] || die "Couldn't resolve workmini's home directory."
echo "  ✓ SSH OK — workmini home: $WM_HOME"

# ── 2. Install the app (+ fail-fast launch check) ───────────────────
# Install BEFORE the 73 GB sync and verify the app actually runs — a
# code-signature / Gatekeeper kill is instant, so we catch it here
# instead of after a long music transfer. ditto (not cp -R) is used
# precisely because cp -R over a running bundle corrupts the embedded
# signature → SIGKILL "Code Signature Invalid" at launch.
say "[2/5] Installing JakeTunes.app on workmini"
scp -q $SSH_OPTS "$DMG" "${REMOTE}:/tmp/jaketunes-deploy.dmg" || die "DMG copy failed."
ssh $SSH_OPTS "$REMOTE" 'bash -s' <<'REMOTE_INSTALL'
set -e
osascript -e 'quit app "JakeTunes"' 2>/dev/null || true
sleep 4                                    # let a running instance fully exit
MNT="$(hdiutil attach /tmp/jaketunes-deploy.dmg -nobrowse -quiet >/dev/null && ls -d /Volumes/JakeTunes* | head -1)"
[ -n "$MNT" ] || { echo "  ✗ DMG mount failed" >&2; exit 1; }
rm -rf /Applications/JakeTunes.app
ditto "$MNT/JakeTunes.app" /Applications/JakeTunes.app   # ditto preserves bundle/signature
hdiutil detach "$MNT" -quiet
rm -f /tmp/jaketunes-deploy.dmg
# Re-register with Launch Services so Dock/Finder resolve the icon to
# THIS bundle. A ditto install doesn't trigger LS registration the way a
# drag-install does; without this the OS can keep showing a stale icon
# indefinitely — the MacBook did, for ~10 versions, until 4.4.60 traced
# it to ~25 ghost /Volumes/JakeTunes*/ registrations and zero entry for
# the real /Applications bundle.
LSREG="/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister"
"$LSREG" -f /Applications/JakeTunes.app 2>/dev/null || true
VER="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' /Applications/JakeTunes.app/Contents/Info.plist)"
echo "  ✓ Installed JakeTunes $VER"
# Signature must be intact, or the OS SIGKILLs it at exec.
if ! codesign --verify --strict /Applications/JakeTunes.app 2>/dev/null; then
  echo "  ✗ Code signature INVALID on workmini — aborting before the music sync." >&2
  exit 2
fi
echo "  ✓ Code signature valid"
# Launch and confirm it STAYS alive (signature/Gatekeeper kills are
# instant — catch it now, not after a 73 GB transfer). An empty
# library at this point is expected; music + metadata come next.
open -a JakeTunes
sleep 6
if pgrep -f 'JakeTunes.app/Contents/MacOS' >/dev/null; then
  echo "  ✓ JakeTunes launches and stays running on workmini"
else
  echo "  ✗ JakeTunes crashed on launch — see ~/Library/Logs/DiagnosticReports/" >&2
  exit 3
fi
REMOTE_INSTALL
RC=$?
[[ $RC -eq 0 ]] || die "Remote install/launch failed (exit $RC). Music sync NOT started — the app must run first."

# ── 3. Music library (~73 GB — rsync, resumable) ─────────────────────
# NO -z: the library is already-compressed audio (.m4a/.mp3/.flac), so
# rsync -z burns single-threaded CPU for ~0 size gain and becomes the
# bottleneck on a CPU-contended machine. Plain -a is I/O-bound instead.
# Note: if the transfer is network-throttled, copying to an external
# drive and walking it over is far faster than any rsync tuning.
say "[3/5] Syncing music library (~73 GB — first run is long; resumable)"
ssh $SSH_OPTS "$REMOTE" "mkdir -p '$WM_HOME/Music/JakeTunesLibrary'"
rsync -a --partial --timeout=300 --info=progress2 \
  "$LIB_SRC" "${REMOTE}:$WM_HOME/Music/JakeTunesLibrary/"
RC=$?
if [[ $RC -eq 0 ]]; then
  echo "  ✓ Music library fully synced"
elif [[ $RC -eq 23 || $RC -eq 24 ]]; then
  # 23/24 = partial transfer (a file vanished or changed mid-copy) —
  # non-fatal, re-running the script picks up the rest.
  echo "  ⚠ rsync partial transfer (exit $RC) — re-run to finish the remainder."
else
  die "rsync failed (exit $RC)."
fi

# ── 4. library.json metadata bootstrap ──────────────────────────────
say "[4/5] Bootstrapping library.json (portable — relative paths)"
ssh $SSH_OPTS "$REMOTE" "mkdir -p '$WM_HOME/Library/Application Support/JakeTunes'"
scp -q $SSH_OPTS "$LIBJSON_SRC" \
  "${REMOTE}:$WM_HOME/Library/Application Support/JakeTunes/library.json" \
  || die "library.json copy failed."
echo "  ✓ library.json copied (5,675 tracks)"

# ── 4.5. Pin library.musicRoot in app-settings.json (Brief 011b) ────
# Without this, JakeTunes falls back to the auto-detect heuristic. The
# heuristic is pretty good, but it CAN still pick the wrong root if a
# user manually creates F-directories under a stale ~/Music2/ folder
# in the future. Explicit setting bypasses the heuristic entirely.
say "[4.5/5] Pinning library.musicRoot in app-settings.json"
ssh $SSH_OPTS "$REMOTE" "bash -s" <<'REMOTE_SETTINGS'
set -e
SETTINGS_DIR="$HOME/Library/Application Support/JakeTunes"
SETTINGS_PATH="$SETTINGS_DIR/app-settings.json"
LIB_ROOT="$HOME/Music/JakeTunesLibrary"

mkdir -p "$SETTINGS_DIR"
if [ ! -f "$SETTINGS_PATH" ]; then
  echo '{}' > "$SETTINGS_PATH"
fi

python3 <<PYEOF
import json, os
settings_path = "$SETTINGS_PATH"
lib_root = "$LIB_ROOT"
try:
    with open(settings_path) as f:
        settings = json.load(f)
except (json.JSONDecodeError, FileNotFoundError):
    settings = {}
if not isinstance(settings, dict):
    settings = {}
if "library" not in settings or not isinstance(settings.get("library"), dict):
    settings["library"] = {}
settings["library"]["musicRoot"] = lib_root
tmp_path = settings_path + ".tmp"
with open(tmp_path, "w") as f:
    json.dump(settings, f, indent=2)
os.replace(tmp_path, settings_path)
print(f"  ✓ library.musicRoot set to {lib_root}")
PYEOF
REMOTE_SETTINGS
RC=$?
[[ $RC -eq 0 ]] || die "Failed to write library.musicRoot (exit $RC)."

# ── 5. API keys (.env) — opt-in only ────────────────────────────────
say "[5/5] API keys (.env)"
if $WITH_ENV; then
  [[ -f "$ENV_SRC" ]] || die ".env not found at $ENV_SRC"
  scp -q $SSH_OPTS "$ENV_SRC" \
    "${REMOTE}:$WM_HOME/Library/Application Support/JakeTunes/.env" \
    || die ".env copy failed."
  echo "  ✓ .env copied — AI personas (Music Man / Megan / Stephen / Cynthia) have credentials"
else
  echo "  • Skipped. Without it the AI personas have no API keys."
  echo "    Re-run with --with-env to copy them, or add them on workmini yourself."
fi

# ── Relaunch so it picks up the freshly-synced library ──────────────
# Step 2 already proved the app runs, but it launched against an empty
# library. Quit + relaunch now that music + library.json (+ .env) are
# in place so it boots into the full library.
say "Relaunching JakeTunes with the full library…"
ssh $SSH_OPTS "$REMOTE" "osascript -e 'quit app \"JakeTunes\"' 2>/dev/null || true; sleep 3; open -a JakeTunes" || true
say "✓ Done — JakeTunes deployed and running on workmini."
echo "  Future versions auto-update from the GitHub release, same as homemini."
