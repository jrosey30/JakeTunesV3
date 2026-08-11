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

WORKMINI_USER=""
WITH_ENV=false
BUILD_FIRST=false

# Flags are order-independent: the first bare word is the username, and
# --with-env / --build can appear on either side of it. The old code read
# --with-env from $2 positionally, so `deploy.sh --build jacobrosenbaum`
# would have silently dropped it.
for arg in "$@"; do
  case "$arg" in
    --with-env) WITH_ENV=true ;;
    --build)    BUILD_FIRST=true ;;
    -*)         echo "Unknown flag: $arg" >&2; exit 1 ;;
    *)          [[ -z "$WORKMINI_USER" ]] && WORKMINI_USER="$arg" ;;
  esac
done

if [[ -z "$WORKMINI_USER" ]]; then
  echo "Usage: $(basename "$0") <workmini-username> [--with-env] [--build]"
  echo "  Run 'whoami' in Terminal on workmini to get the username."
  echo "  --build  compile a fresh DMG from the working tree before deploying"
  exit 1
fi

HOST="workmini"                       # Tailscale MagicDNS name
SSH_OPTS="-o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new"
REMOTE="${WORKMINI_USER}@${HOST}"
REPO="/Users/jacobrosenbaum/JakeTunesV3"
DMG="$(ls -t "$REPO"/release/JakeTunes-*-arm64.dmg 2>/dev/null | head -1)"
LIB_SRC="/Users/jacobrosenbaum/Music2/JakeTunesLibrary/"
USERDATA="/Users/jacobrosenbaum/Library/Application Support/JakeTunes"
NAS_STATE="/Volumes/JakeShared/JakeTunesState"
ENV_SRC="$USERDATA/.env"
ART_SRC="$USERDATA/artwork/"           # album covers (md5(artist|||album).jpg)
ARTIST_IMG_SRC="$USERDATA/artist-images/"  # artist portraits ({slug}.jpg)

# Streaming mode (workmini, set up 2026-06-08, corrected 2026-08-10/11).
# When the marker exists: skip the 157 GB music rsync, keep a local cache-
# farm under ~/JakeTunesLib (real files + NAS symlinks), and play through
# homemini's HTTP audio server — the same path the phone uses. The SMB
# mount (~/JakeShareNAS) is ONLY a fallback / cache source; reading it on
# the playback hot path is what made workmini hang (203s readdir, libuv
# threadpool starvation, Howler XHR silence). Toggle with the marker:
# create it to stream, remove it to return to local-copy mode.
STREAM_MARKER="$HOME/.config/jaketunes/workmini-streaming"
STREAMING=false
[[ -f "$STREAM_MARKER" ]] && STREAMING=true

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
validate_json() {
  python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$1" 2>/dev/null
}

# library.json source-of-truth: LOCAL userData.
#
# Architecture history:
#   Brief 119 Phase 2 → V3 desktop read/wrote the NAS copy when mounted,
#     so deploys had to prefer NAS or they shipped 24h-stale libraries.
#   4.5.0-114 (2026-05-29 fix, see memory feedback_library_dataloss_nas)
#     → flipped LOCAL to be the source of truth; NAS demoted to an
#     async backup mirror the app never reads/blocks on.
#
# Why this matters here: the NAS mirror is now prone to torn writes
# during async mirroring. Observed 2026-06-03: a NAS torn write left
# ~1.5KB of trailing garbage past byte 5,793,043 of library.json, and
# the deploy script faithfully scp'd that corrupt copy to workmini →
# JSON parse error → empty JakeTunes UI. The LOCAL copy was clean the
# whole time because V3 writes it atomically.
#
# Rule: prefer LOCAL userData; only fall back to NAS if local is
# somehow missing. Validate JSON before pushing either way.
if [[ -f "$USERDATA/library.json" ]] && validate_json "$USERDATA/library.json"; then
  LIBJSON_SRC="$USERDATA/library.json"
  LIBJSON_LABEL="userData (canonical, post 4.5.0-114)"
elif [[ -f "$NAS_STATE/library.json" ]] && validate_json "$NAS_STATE/library.json"; then
  LIBJSON_SRC="$NAS_STATE/library.json"
  LIBJSON_LABEL="NAS mirror (userData missing/corrupt — using fallback)"
elif [[ -f "$USERDATA/library.json" ]]; then
  die "Local library.json at $USERDATA/library.json failed JSON validation. Refusing to deploy a corrupt library. Repair the local copy first."
else
  die "No library.json found in userData or on NAS — nothing to deploy."
fi

# ── 0. Build a fresh DMG from source (--build) ──────────────────────
# Without this, the deploy ships whatever DMG happens to be sitting in
# release/. That is how workmini ran a 3-day-old app across 103 commits
# (2026-08-10) — the whole 2.0 logo/palette, the rebuilt Downloads page,
# the accent-folding search fix — while reporting the SAME version string
# as this Mac. The version only moves on a real milestone, by design, so
# "both say 5.1.0" was never evidence that they matched.
if $BUILD_FIRST; then
  say "[0/5] Building a fresh DMG from source"
  cd "$REPO" || die "Cannot cd to $REPO"

  HEAD_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
  DIRTY="$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
  echo "  commit $HEAD_SHA, $DIRTY uncommitted file(s)"
  # Said plainly because it is easy to forget: this builds the WORKING
  # TREE, not HEAD. Uncommitted edits ship. That is what building from
  # source means, and the log records the state so a surprise on workmini
  # can be traced back to what was actually on disk at 11:30.

  # Gates. This runs unattended against the Mac Jake actually works on,
  # so a day skipped with a loud reason beats a broken app installed
  # quietly. Both are fast — typecheck ~15s, tests <1s.
  npm run typecheck >/dev/null 2>&1 \
    || die "typecheck failed — refusing to build. Run 'npm run typecheck' locally to see it."
  echo "  ✓ typecheck"
  npm test >/dev/null 2>&1 \
    || die "tests failed — refusing to build. Run 'npm test' locally to see it."
  echo "  ✓ tests pass"

  # Anti-staleness, and the reason this flag exists at all: mark the time
  # BEFORE building, then require the DMG to be newer than that mark. If
  # electron-builder fails, no-ops, or writes somewhere unexpected, the
  # old artifact is still sitting in release/ and every later step would
  # happily ship it. Falling through to a stale DMG is precisely the bug
  # being fixed, so it has to be an error, not a fallback.
  BUILD_STAMP="$(mktemp)"
  echo "  building (electron-vite + electron-builder, a few minutes)…"
  npm run dist:dmg > "$REPO/.deploy-build.log" 2>&1 || true
  DMG="$(ls -t "$REPO"/release/JakeTunes-*-arm64.dmg 2>/dev/null | head -1)"
  if [[ -z "$DMG" || ! -f "$DMG" ]]; then
    tail -25 "$REPO/.deploy-build.log" | sed 's/^/    /'
    rm -f "$BUILD_STAMP"
    die "Build produced no DMG in $REPO/release/ — see $REPO/.deploy-build.log"
  fi
  if [[ ! "$DMG" -nt "$BUILD_STAMP" ]]; then
    tail -25 "$REPO/.deploy-build.log" | sed 's/^/    /'
    rm -f "$BUILD_STAMP"
    die "$(basename "$DMG") predates this build — the build did not produce a new artifact. Refusing to ship a stale app (see $REPO/.deploy-build.log)."
  fi
  rm -f "$BUILD_STAMP"
  echo "  ✓ fresh DMG: $(basename "$DMG")  ($(stat -f '%Sm' -t '%Y-%m-%d %H:%M' "$DMG"), $(du -h "$DMG" | cut -f1))"
fi

say "JakeTunes → workmini deployment"
echo "  app:      $(basename "${DMG:-<none found>}")"
echo "  target:   ${REMOTE}"
echo "  library:  $LIBJSON_LABEL"
echo "  .env:     $([[ $WITH_ENV == true ]] && echo 'will copy (--with-env)' || echo 'skipped (default)')"

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
scp -q $SSH_OPTS "$DMG" "${REMOTE}:jaketunes-deploy.dmg" || die "DMG copy failed."  # staged in $HOME — /tmp on workmini eats dmgs
ssh $SSH_OPTS "$REMOTE" 'bash -s' <<'REMOTE_INSTALL'
set -e
osascript -e 'quit app "JakeTunes"' 2>/dev/null || true
sleep 4                                    # let a running instance fully exit
MNT="$(hdiutil attach "$HOME"/jaketunes-deploy.dmg -nobrowse -quiet >/dev/null && ls -d /Volumes/JakeTunes* | head -1)"
[ -n "$MNT" ] || { echo "  ✗ DMG mount failed" >&2; exit 1; }
rm -rf /Applications/JakeTunes.app
ditto "$MNT/JakeTunes.app" /Applications/JakeTunes.app   # ditto preserves bundle/signature
hdiutil detach "$MNT" -quiet
rm -f "$HOME"/jaketunes-deploy.dmg
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
if $STREAMING; then
  say "[3/5] Music library — SKIPPED (workmini streams via homemini)"
  echo "  • streaming mode: audio comes from homemini:3000; local cache-farm + NAS mount are fallback only"
else
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
fi

# ── 3.5. Artwork (album covers + artist images) ──────────────────────
# V3 stores album-cover JPGs in $USERDATA/artwork/ keyed by
# md5(artist|||album), and artist portraits in $USERDATA/artist-images/.
# Without this step workmini's artwork dir freezes at whatever was last
# manually copied — over time the library.json's hashes drift forward
# while the JPGs sit at hashes that don't exist anymore, so V3's
# fallback logic shows wrong covers on most tiles. Mirror the homemini
# watcher's flags (rtz + --update + --no-perms/owner/group) so an
# interrupted run resumes cleanly and ownership doesn't ping-pong.
# Non-fatal: if artwork rsync fails the user still gets music + the
# library list, they just see placeholder covers for new albums.
say "[3.5/5] Syncing artwork (album covers + artist images)"
if [[ -d "$ART_SRC" ]]; then
  ssh $SSH_OPTS "$REMOTE" "mkdir -p '$WM_HOME/Library/Application Support/JakeTunes/artwork'"
  rsync -rtz --update --no-perms --no-owner --no-group \
    --include='*.jpg' --include='*.meta.json' --exclude='*' \
    "$ART_SRC" "${REMOTE}:$WM_HOME/Library/Application Support/JakeTunes/artwork/" \
    && echo "  ✓ artwork synced" \
    || echo "  ⚠ artwork rsync had errors — V3 will show placeholders for affected covers"
else
  echo "  • $ART_SRC not present on this Mac — skipping album artwork"
fi
if [[ -d "$ARTIST_IMG_SRC" ]]; then
  ssh $SSH_OPTS "$REMOTE" "mkdir -p '$WM_HOME/Library/Application Support/JakeTunes/artist-images'"
  rsync -rtz --update --no-perms --no-owner --no-group \
    --include='*.jpg' --include='*.meta.json' --exclude='*' \
    "$ARTIST_IMG_SRC" "${REMOTE}:$WM_HOME/Library/Application Support/JakeTunes/artist-images/" \
    && echo "  ✓ artist images synced" \
    || echo "  ⚠ artist-images rsync had errors"
else
  echo "  • $ARTIST_IMG_SRC not present on this Mac — skipping artist images"
fi

# ── 4. library.json + sidecar metadata bootstrap ────────────────────
# Sidecar JSONs that V3 reads alongside library.json. All live ONLY in
# userData (V3 hardcodes the paths) and don't get propagated by any
# other sync chain, so without this step workmini diverges from
# macbook silently:
#   picks-cache.json     — weekly Music Man/Megan/DJ Hands picks
#                          (regenerated locally if missing → different
#                          picks per device)
#   mobile-playlists.json  — iPhone-created playlists (Brief 121),
#                          source-of-truth is /Volumes/JakeShared/
#                          JakeTunesState/, V3 merges them into the UI
#   playlist-additions.json — iPhone "add to playlist" pending writes
#                          waiting to merge into the canonical playlists
#   metadata-overrides.json — the genre/artist/title/album correction
#                          layer V3 merges over library.json (and feeds
#                          the subgenre Song-View column). Without it
#                          workmini shows uncorrected tags.
# embeddings.bin (the ~50 MB semantic "brain") rides along too but is
# pushed in its own block below — it's BINARY, so it can't go through the
# validate_json sidecar loop the JSON files share.
# Each push is best-effort; missing sources are skipped silently
# (different Macs have different feature subsets enabled).
say "[4/5] Bootstrapping library.json + sidecars"
ssh $SSH_OPTS "$REMOTE" "mkdir -p '$WM_HOME/Library/Application Support/JakeTunes'"
SIDECARS=(picks-cache.json mobile-playlists.json playlist-additions.json metadata-overrides.json)
for f in "${SIDECARS[@]}"; do
  # Sidecars prefer LOCAL userData (post 4.5.0-114, same reasoning as
  # library.json above). Fall back to NAS only if local is missing.
  # Validate JSON before pushing so a torn-write NAS file can't poison
  # workmini.
  src=""
  if [[ -f "$USERDATA/$f" ]] && validate_json "$USERDATA/$f"; then
    src="$USERDATA/$f"
  elif [[ -f "$NAS_STATE/$f" ]] && validate_json "$NAS_STATE/$f"; then
    src="$NAS_STATE/$f"
    echo "  ⚠ $f sourced from NAS (local missing/corrupt)"
  fi
  if [[ -n "$src" ]]; then
    scp -q $SSH_OPTS "$src" \
      "${REMOTE}:$WM_HOME/Library/Application Support/JakeTunes/$f" \
      && echo "  ✓ $f copied" \
      || echo "  ⚠ $f copy failed"
  else
    echo "  • $f not present (or corrupt) on this Mac — skipping"
  fi
done
# embeddings.bin — the semantic "brain" (~50 MB binary): powers
# workmini's LOCAL semantic search, Music Man chat RAG, and the subgenre
# Song-View column. Like the sidecars it lives ONLY in userData and rides
# no other sync chain, so without this push workmini's brain freezes at
# whatever shipped last while library.json marches forward — stale
# embeddings, drifting results. (Daily mixes are unaffected — those come
# live from the homemini backend, not this file.) Source-of-truth rule is
# library.json's: prefer LOCAL userData, fall back to the NAS mirror only
# if local is missing. It's BINARY so validate_json can't vet it; we
# sanity-check non-empty instead, and push ATOMICALLY (scp to .tmp then
# ssh-mv) over the SAME scp path the JSONs use successfully — so this
# never touches openrsync (no -s/--protect-args, breaks on the spaced
# "Application Support" path) and a mid-transfer blip leaves the previous
# good brain intact instead of a truncated file. Non-fatal: a failed push
# just means the brain stays stale (today's status quo), not a broken app.
EMB_SRC=""
if [[ -s "$USERDATA/embeddings.bin" ]]; then
  EMB_SRC="$USERDATA/embeddings.bin"
elif [[ -s "$NAS_STATE/embeddings.bin" ]]; then
  EMB_SRC="$NAS_STATE/embeddings.bin"
  echo "  ⚠ embeddings.bin sourced from NAS (local missing/empty)"
fi
if [[ -n "$EMB_SRC" ]]; then
  WM_EMB="$WM_HOME/Library/Application Support/JakeTunes/embeddings.bin"
  if scp -q $SSH_OPTS "$EMB_SRC" "${REMOTE}:${WM_EMB}.tmp" \
     && ssh $SSH_OPTS "$REMOTE" "mv '${WM_EMB}.tmp' '${WM_EMB}'"; then
    EMB_BYTES="$(stat -f%z "$EMB_SRC" 2>/dev/null || echo '?')"
    echo "  ✓ embeddings.bin copied ($EMB_BYTES bytes — local brain refreshed)"
  else
    echo "  ⚠ embeddings.bin push failed — workmini keeps its previous (stale) brain"
    ssh $SSH_OPTS "$REMOTE" "rm -f '${WM_EMB}.tmp'" 2>/dev/null || true
  fi
else
  echo "  • embeddings.bin not present on this Mac — skipping (local brain stays as-is)"
fi
# library.json push is atomic: scp to .tmp then ssh-mv into place. If
# scp dies mid-transfer (network blip, NAS-side weirdness, etc.), the
# previous good library.json on workmini stays untouched instead of
# being half-overwritten — which is what produced an "empty UI" panic
# on 2026-06-03 when a corrupt source was scp'd directly over the
# canonical path.
WM_LIBJSON="$WM_HOME/Library/Application Support/JakeTunes/library.json"
scp -q $SSH_OPTS "$LIBJSON_SRC" "${REMOTE}:${WM_LIBJSON}.tmp" \
  || die "library.json copy failed."
ssh $SSH_OPTS "$REMOTE" "mv '${WM_LIBJSON}.tmp' '${WM_LIBJSON}'" \
  || die "library.json atomic install failed."
LIBJSON_TRACKS="$(python3 -c "import json; d=json.load(open('$LIBJSON_SRC')); k='tracks' if 'tracks' in d else 'songs'; print(len(d.get(k,[])))" 2>/dev/null || echo '?')"
echo "  ✓ library.json copied ($LIBJSON_TRACKS tracks)"

# ── 4.5. Pin library.* in app-settings.json (Brief 011b + Aug 10 fix) ────
# Without this, JakeTunes falls back to the auto-detect heuristic. The
# heuristic is pretty good, but it CAN still pick the wrong root if a
# user manually creates F-directories under a stale ~/Music2/ folder
# in the future. Explicit setting bypasses the heuristic entirely.
#
# Streaming mode MUST also pin streamSource=homemini. That flag is what
# makes ipod-audio:// fetch from homemini BEFORE any filesystem call.
# It was set by hand on 2026-08-10 ("app-settings, not code") — a redeploy
# or a wiped settings file silently dropped back to SMB-over-Tailscale,
# which is the exact path that made every song hang. Pin it every deploy.
if $STREAMING; then
  say "[4.5/5] Pinning streaming library settings (musicRoot + streamRoot + streamSource)"
  ssh $SSH_OPTS "$REMOTE" "bash -s" <<'REMOTE_SETTINGS'
set -e
SETTINGS_DIR="$HOME/Library/Application Support/JakeTunes"
SETTINGS_PATH="$SETTINGS_DIR/app-settings.json"
# Local cache-farm (real files + NAS symlinks). Matches cache-manager.py DST.
MUSIC_ROOT="$HOME/JakeTunesLib/JakeTunesLibrary"
# LaunchAgent-mounted Synology share. Fallback / cache source only.
STREAM_ROOT="$HOME/JakeShareNAS/JakeTunesLibrary"

mkdir -p "$SETTINGS_DIR"
if [ ! -f "$SETTINGS_PATH" ]; then
  echo '{}' > "$SETTINGS_PATH"
fi

python3 <<PYEOF
import json, os
settings_path = "$SETTINGS_PATH"
try:
    with open(settings_path) as f:
        settings = json.load(f)
except (json.JSONDecodeError, FileNotFoundError):
    settings = {}
if not isinstance(settings, dict):
    settings = {}
if "library" not in settings or not isinstance(settings.get("library"), dict):
    settings["library"] = {}
settings["library"]["musicRoot"] = "$MUSIC_ROOT"
settings["library"]["streamRoot"] = "$STREAM_ROOT"
settings["library"]["streamSource"] = "homemini"
tmp_path = settings_path + ".tmp"
with open(tmp_path, "w") as f:
    json.dump(settings, f, indent=2)
os.replace(tmp_path, settings_path)
print(f"  ✓ library.musicRoot    = $MUSIC_ROOT")
print(f"  ✓ library.streamRoot   = $STREAM_ROOT")
print(f"  ✓ library.streamSource = homemini")
PYEOF
REMOTE_SETTINGS
  RC=$?
  [[ $RC -eq 0 ]] || die "Failed to write streaming library settings (exit $RC)."
else
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
fi

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

# ── 6. Refresh the local hot-cache (streaming mode only) ────────────
# workmini streams from the NAS with a capped local clone-cache of the
# hot rotation (NAS streaming, set up 2026-06-08). Now that library.json
# is updated above, refresh the cache so newly-added tracks get stream-
# links and the hot set re-ranks (local + symlink ops are instant; a few
# NAS clones for newly-hot tracks are best-effort). Non-fatal — every
# track still resolves and streams even if this hiccups.
if $STREAMING; then
  say "[6] Refreshing workmini local cache (hot rotation + new-music links)"
  # Ship the cache manager itself. It used to live ONLY on workmini — no
  # version control, no review — which is how a ranking bug that stopped every
  # newly-imported song from playing sat in it unnoticed (2026-08-10). The repo
  # copy is the source of truth now; this overwrites whatever is on the host.
  scp -q $SSH_OPTS "$REPO/Dr. Claude/scripts/cache-manager.py" \
    "${REMOTE}:$WM_HOME/Library/Application Support/JakeTunes/cache-manager.py" \
    && echo "  ✓ cache-manager.py updated" || echo "  ⚠ cache-manager.py push failed — host copy left as-is"
  # BACKGROUND, deliberately. This used to be awaited, and once the cache
  # started prioritising ALAC (which can be tens of GB over a slow link) the
  # deploy sat here for hours — with JakeTunes still QUIT, because the
  # relaunch comes after. A best-effort cache warm must never hold the app
  # closed. It is explicitly non-fatal; every track streams regardless.
  ssh $SSH_OPTS "$REMOTE" \
    'nohup /usr/bin/python3 "$HOME/Library/Application Support/JakeTunes/cache-manager.py" >/tmp/cache-manager.log 2>&1 &' \
    && echo "  ✓ cache warm started in background (see /tmp/cache-manager.log on workmini)" \
    || echo "  ⚠ could not start cache warm — music still streams from NAS"
fi

# ── Relaunch so it picks up the freshly-synced library ──────────────
# Step 2 already proved the app runs, but it launched against an empty
# library. Quit + relaunch now that music + library.json (+ .env) are
# in place so it boots into the full library.
say "Relaunching JakeTunes with the full library…"
ssh $SSH_OPTS "$REMOTE" "osascript -e 'quit app \"JakeTunes\"' 2>/dev/null || true; sleep 3; open -a JakeTunes" || true
say "✓ Done — JakeTunes deployed and running on workmini."
echo "  Future versions auto-update from the GitHub release, same as homemini."
