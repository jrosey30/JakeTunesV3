#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# jaketunes-workmini-deploy.sh — one-shot JakeTunes deployment to the
# work Mac mini ("workmini" on Tailscale). App + full music library +
# library metadata, end to end.
#
# Usage:
#   jaketunes-workmini-deploy.sh <workmini-username> [--with-env] [--dry-run]
#
#   <workmini-username>  the macOS short username ON workmini. Get it by
#                        running `whoami` in Terminal on workmini — it is
#                        NOT necessarily "jacobrosenbaum" (homemini's, for
#                        comparison, is "jakerosenbaumnas").
#   --with-env           ALSO copy ~/Library/Application Support/JakeTunes/
#                        .env (the API keys for the AI personas). Off by
#                        default because it moves secrets between machines
#                        — opt in explicitly.
#   --dry-run            build main and run every proof and gate check, then
#                        stop before anything on workmini changes. SSH is
#                        read-only in this mode.
#   --build              accepted for old callers; every run builds now.
#
# What ships (2026-10-19): ALWAYS origin/main, built in a fresh detached
# worktree with a fresh `npm ci`. Never the ~/JakeTunesV3 checkout: other
# sessions work there, so its branch and its uncommitted edits are whatever
# they left. From 2026-08-10 to 2026-10-19 this job built that checkout,
# and it failed every single weekday (tests under launchd's node 18, then a
# feature branch). It never installed anything in that time.
#
# Before the swap, three things must hold or the run stops and changes
# nothing:
#   1. the app installed on workmini is a SUBSET of main: its stamped
#      commit (out/main/build-info.json) is an ancestor of origin/main and
#      was not built from uncommitted edits. Parallel sessions install
#      unmerged branches; installing main over one would silently delete
#      that work.
#   2. app.asar has not changed since that proof (another session did not
#      install in between).
#   3. the audio + idle gate: JakeTunes is not playing on workmini and
#      nobody has touched it for $IDLE_MIN_S seconds. Never quit the app
#      under Jake's music.
# Every ssh/scp/rsync has a hard wall-clock limit (tmo), so a dead link
# cannot hang the job with JakeTunes quit.
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

# A git child that inherits GIT_DIR / GIT_INDEX_FILE acts on whatever repo
# they name. That is how a test re-initialized ~/JakeTunesV3 as bare on
# 2026-10-14. Nothing this script runs should see them.
for v in $(env | sed -n 's/^\(GIT_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done

WORKMINI_USER=""
WITH_ENV=false
DRY_RUN=false

# Flags are order-independent: the first bare word is the username, and
# the flags can appear on either side of it. The old code read --with-env
# from $2 positionally, so `deploy.sh --build jacobrosenbaum` would have
# silently dropped it.
for arg in "$@"; do
  case "$arg" in
    --with-env) WITH_ENV=true ;;
    --build)    ;;  # every run builds origin/main now; kept so old callers work
    --dry-run)  DRY_RUN=true ;;
    -*)         echo "Unknown flag: $arg" >&2; exit 1 ;;
    *)          [[ -z "$WORKMINI_USER" ]] && WORKMINI_USER="$arg" ;;
  esac
done

if [[ -z "$WORKMINI_USER" ]]; then
  echo "Usage: $(basename "$0") <workmini-username> [--with-env] [--dry-run]"
  echo "  Run 'whoami' in Terminal on workmini to get the username."
  echo "  --dry-run  build main + run every proof and gate, change nothing on workmini"
  exit 1
fi

HOST="workmini"                       # Tailscale MagicDNS name
# ServerAlive drops a dead link in ~60 s; tmo (below) caps every call anyway.
SSH_OPTS=(-o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4
          -o BatchMode=yes -o StrictHostKeyChecking=accept-new)
RSYNC_SSH="ssh ${SSH_OPTS[*]}"
REMOTE="${WORKMINI_USER}@${HOST}"
# The shared checkout is used ONLY as a git object store (fetch + worktree
# add). Never cd into it, build in it, or read files from its working tree:
# its branch belongs to whichever session is working there.
REPO="/Users/jacobrosenbaum/JakeTunesV3"
BUILD_ROOT="$HOME/Library/Caches/JakeTunes-workmini-build"
WT="$BUILD_ROOT/worktree"             # recreated from origin/main every run
LOCK="$BUILD_ROOT/lock"
BUILD_LOG="$HOME/Library/Logs/JakeTunes/workmini-build.log"
IDLE_MIN_S="${JT_DEPLOY_IDLE_MIN_S:-120}"        # gate: workmini idle at least this long
GATE_WAIT_MIN="${JT_DEPLOY_GATE_WAIT_MIN:-60}"   # how long to wait for the gate to open
DMG=""
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
# Exit 75 (EX_TEMPFAIL) = "workmini wasn't there, try again later today".
# The launchd wrapper retries on it; every other failure waits for tomorrow.
EX_UNREACHABLE=75
die_unreachable() { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit "$EX_UNREACHABLE"; }
validate_json() {
  python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$1" 2>/dev/null
}

# tmo SECS cmd… — run cmd with a hard wall-clock limit; exit 124 on timeout
# (launchd's PATH has no coreutils `timeout`). The command gets its own
# process group so a timeout kills everything it spawned (npm → node →
# electron-builder, rsync → ssh), and a terminal stdin is swapped for
# /dev/null so a backgrounded ssh can never stop on SIGTTIN.
tmo() {
  perl -e '
    my $secs = shift;
    open(STDIN, "<", "/dev/null") if -t STDIN;
    my $pid = fork() // exit 125;
    if ($pid == 0) { setpgrp(0, 0); exec { $ARGV[0] } @ARGV or exit 127 }
    my $stop = sub { kill "TERM", -$pid; sleep 3; kill "KILL", -$pid; waitpid($pid, 0); exit $_[0] };
    $SIG{ALRM} = sub { $stop->(124) };
    $SIG{INT} = $SIG{TERM} = sub { $stop->(130) };
    alarm $secs;
    waitpid($pid, 0);
    exit(($? & 127) ? 128 + ($? & 127) : $? >> 8);
  ' "$@"
}
# Every remote command goes through one of these three.
rsh() { local secs="$1"; shift; tmo "$secs" ssh "${SSH_OPTS[@]}" "$REMOTE" "$@"; }
rcp() { local secs="$1"; shift; tmo "$secs" scp -q "${SSH_OPTS[@]}" "$@"; }
rsy() { local secs="$1"; shift; tmo "$secs" rsync -e "$RSYNC_SSH" "$@"; }

# step SECS LABEL cmd… — a build step: hard limit, full output to $BUILD_LOG.
step() {
  local secs="$1" label="$2"; shift 2
  printf '\n── %s (%s)\n' "$label" "$(date '+%H:%M:%S')" >>"$BUILD_LOG"
  tmo "$secs" "$@" >>"$BUILD_LOG" 2>&1
}
build_die() { tail -40 "$BUILD_LOG" | sed 's/^/    /'; die "$1 — full output: $BUILD_LOG"; }

# Reads an app.asar and prints key=value lines: present, mtime, deps (the
# packaged node_modules count — 18 instead of 58 shipped a dead app on
# 2026-10-13), sha + dirty from out/main/build-info.json. Runs here and,
# over ssh, on workmini (stock python3 3.9 there). The asar header is
# [u32 4][u32 headerSize] then a pickle [u32 payload][u32 jsonLen][json];
# file data starts at 8 + headerSize.
ASAR_INFO_PY="$(cat <<'PY'
import json, os, struct, sys
p = sys.argv[1]
try:
    st = os.stat(p)
except OSError:
    print("present=false"); sys.exit(0)
print("present=true")
print("mtime=%d" % int(st.st_mtime))
try:
    with open(p, "rb") as f:
        hsize = struct.unpack("<I", f.read(8)[4:8])[0]
        pickle = f.read(hsize)
        jlen = struct.unpack("<I", pickle[4:8])[0]
        files = json.loads(pickle[8:8 + jlen].decode("utf-8"))["files"]
        deps = 0
        for name, node in files.get("node_modules", {}).get("files", {}).items():
            kids = node.get("files", {})
            if name.startswith("@"):
                deps += sum(1 for k in kids.values() if "package.json" in k.get("files", {}))
            elif "package.json" in kids:
                deps += 1
        print("deps=%d" % deps)
        node = files["out"]["files"]["main"]["files"]["build-info.json"]
        f.seek(8 + hsize + int(node["offset"]))
        info = json.loads(f.read(node["size"]).decode("utf-8"))
except Exception as e:
    print("error=%s: %s" % (type(e).__name__, str(e).replace("\n", " "))); sys.exit(0)
print("sha=%s" % str(info.get("sha") or "").strip())
d = info.get("dirty")
print("dirty=%s" % ("true" if d is True else "false" if d is False else "unknown"))
PY
)"
kv() { sed -n "s/^$1=//p" <<<"$2" | head -1; }

# The audio + idle gate, as one remote snippet (arg 1 = idle seconds
# required). Exit 0 = clear, 10 = blocked; the reason is printed either
# way. Two audio signals because each has missed once: the "Playing audio"
# assertion (9/1: a gate that only grepped it inline in an && chain killed
# Jake's music mid-song), and a coreaudiod stream created for a JakeTunes
# process (it outlives a pause, so this side is conservative on purpose).
GATE_SH="$(cat <<'GATE'
idle_min="$1"
if pmset -g assertions | grep JakeTunes | grep -q "Playing audio"; then
  echo "JakeTunes is playing audio on workmini"; exit 10
fi
for p in $(pmset -g assertions | grep -A1 coreaudiod | sed -nE 's/.*Created for PID: ([0-9]+).*/\1/p'); do
  if ps -o comm= -p "$p" 2>/dev/null | grep -q JakeTunes; then
    echo "JakeTunes holds an audio stream on workmini"; exit 10
  fi
done
idle=$(ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print int($NF/1000000000); exit}')
if [ -z "$idle" ] || [ "$idle" -lt "$idle_min" ]; then
  echo "workmini was used ${idle:-?}s ago (gate needs ${idle_min}s idle)"; exit 10
fi
echo "clear: no JakeTunes audio, idle ${idle}s"
GATE
)"
check_gate() { rsh 30 "bash -s -- $IDLE_MIN_S" <<<"$GATE_SH" 2>&1; }

# Polls the gate (read-only) until it opens or GATE_WAIT_MIN runs out.
# Any failure to check counts as closed.
GATE_REASON=""
wait_for_gates() {
  local deadline=$(( $(date +%s) + GATE_WAIT_MIN * 60 )) said=""
  while :; do
    if GATE_REASON="$(check_gate)"; then echo "  ✓ gate $GATE_REASON"; return 0; fi
    (( $(date +%s) >= deadline )) && return 1
    [[ -n "$said" ]] || { echo "  … gate closed ($GATE_REASON); re-checking every 2 min for up to ${GATE_WAIT_MIN} min"; said=1; }
    sleep 120
  done
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

# ── 1. Preflight + the subset proof ─────────────────────────────────
mkdir -p "$BUILD_ROOT" "$(dirname "$BUILD_LOG")"
if ! mkdir "$LOCK" 2>/dev/null; then
  other="$(cat "$LOCK/pid" 2>/dev/null)"
  if [[ -n "$other" ]] && kill -0 "$other" 2>/dev/null; then
    die "Another workmini deploy is running (pid $other)."
  fi
  rm -rf "$LOCK"; mkdir "$LOCK" || die "Cannot take the deploy lock at $LOCK"
fi
echo $$ >"$LOCK/pid"
cleanup() {
  cd / || true
  if [[ -z "${JT_DEPLOY_KEEP_WORKTREE:-}" && -d "$WT" ]]; then
    git -C "$REPO" worktree remove --force "$WT" >/dev/null 2>&1 || rm -rf "$WT"
    git -C "$REPO" worktree prune >/dev/null 2>&1
  fi
  rm -rf "$LOCK"
}
trap cleanup EXIT

say "[1/5] Preflight"
$DRY_RUN && echo "  DRY RUN — nothing on workmini will change"
# launchd once put /usr/local/bin's node 18 first: `npm test` died on the
# --experimental-strip-types flag in 2 s, every weekday for two months,
# and the log only ever said "tests failed".
node --experimental-strip-types -e 0 >/dev/null 2>&1 \
  || die "node $(node -v 2>/dev/null) at $(command -v node) cannot run the test suite (needs Node ≥ 22.6 for --experimental-strip-types). Fix PATH in jaketunes-workmini-nightly.sh."
echo "  ✓ node $(node -v) ($(command -v node))"
[[ -f "$LIBJSON_SRC" ]]      || die "library.json not found at $LIBJSON_SRC"
[[ -d "$LIB_SRC" ]]         || die "Music library not found at $LIB_SRC"
# Reachability — ask ssh, patiently. Until 2026-10-20 one ICMP ping with a
# 3 s timeout decided the whole day: at 11:31 that morning workmini was awake
# and playing music, but Tailscale had no direct path (relay only) and the
# first packet didn't make it in 3 s. ssh is what every later step needs, so
# ssh is the test: 4 tries over ~2 minutes, nudging Tailscale to (re)open the
# path between tries.
TS="$(command -v tailscale || echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)"
reach_workmini() {
  local i
  for i in 1 2 3 4; do
    rsh 25 true && return 0
    echo "  … no answer from $HOST over ssh (try $i of 4)"
    if [[ -x "$TS" ]]; then tmo 15 "$TS" ping -c 1 --timeout 10s "$HOST" >/dev/null 2>&1 || true; fi
    if [[ $i -lt 4 ]]; then sleep 20; fi
  done
  return 1
}
if ! reach_workmini; then
  # Tailscale answers but ssh doesn't → a login problem on workmini (tomorrow
  # won't fix it either). Tailscale doesn't answer → asleep / off the tailnet
  # (worth another try later today).
  if [[ -x "$TS" ]] && tmo 15 "$TS" ping -c 1 --timeout 10s "$HOST" >/dev/null 2>&1; then
    die "SSH to ${REMOTE} failed, though Tailscale reaches it.
    → Enable Remote Login on workmini:
        System Settings → General → Sharing → Remote Login (ON)
    → Double-check the username (run 'whoami' on workmini).
    Then re-run this script."
  fi
  die_unreachable "$HOST is not reachable on Tailscale after 4 tries (asleep, or off the tailnet?)."
fi
WM_HOME="$(rsh 20 'echo $HOME')"
[[ -n "$WM_HOME" ]] || die "Couldn't resolve workmini's home directory."
echo "  ✓ SSH OK — workmini home: $WM_HOME"

[[ "$(git -C "$REPO" rev-parse --is-bare-repository 2>/dev/null)" == false ]] \
  || die "$REPO reports core.bare=true, which breaks every worktree. Back up .git/config, then: git config --file $REPO/.git/config core.bare false"
tmo 180 git -C "$REPO" fetch --quiet origin main || die "git fetch origin main failed (exit $?)."
MAIN_SHA="$(git -C "$REPO" rev-parse --verify --quiet 'origin/main^{commit}')"
[[ -n "$MAIN_SHA" ]] || die "Cannot resolve origin/main."
echo "  ✓ origin/main = ${MAIN_SHA:0:12}  $(git -C "$REPO" log -1 --format=%s "$MAIN_SHA" | cut -c1-70)"

# The subset proof. Installing main replaces the whole app, so anything the
# installed build has that main lacks is deleted by the install. Prove
# there is nothing: the stamped commit is an ancestor of origin/main and
# was built clean. A build with no stamp proves nothing, so it refuses.
INST="$(rsh 60 'python3 - /Applications/JakeTunes.app/Contents/Resources/app.asar' <<<"$ASAR_INFO_PY")" \
  || die "Could not read workmini's installed app (exit $?)."
[[ "$(kv present "$INST")" == true ]] \
  || die "workmini has no /Applications/JakeTunes.app/Contents/Resources/app.asar. Another install may be mid-swap. Refusing."
[[ -z "$(kv error "$INST")" ]] || die "Could not read workmini's app.asar: $(kv error "$INST")"
INST_SHA="$(kv sha "$INST")"; INST_DIRTY="$(kv dirty "$INST")"
INST_DEPS="$(kv deps "$INST")"; INST_MTIME="$(kv mtime "$INST")"
[[ "$INST_SHA" =~ ^[0-9a-f]{40}$ ]] \
  || die "workmini's installed build has no commit stamp (sha='$INST_SHA'), so nothing proves it is a subset of main. Refusing."
[[ "$INST_DIRTY" != true ]] \
  || die "workmini's installed build ${INST_SHA:0:12} was made from uncommitted edits: it holds code main does not. Refusing to replace it."
if ! git -C "$REPO" merge-base --is-ancestor "$INST_SHA" "$MAIN_SHA" 2>/dev/null; then
  where="$(git -C "$REPO" branch -a --contains "$INST_SHA" 2>/dev/null | sed 's/^[* ]*//' | head -3 | paste -sd, -)"
  die "workmini runs ${INST_SHA:0:12}, which is NOT in origin/main${where:+ (it is on: $where)}. Installing main would delete that work. Refusing."
fi
if [[ "$INST_DIRTY" == unknown ]]; then
  # Builds stamped before 2026-10-19 carry no "dirty" field. Ancestry is
  # still proven; cleanliness is recorded from the next stamped install on.
  echo "  ✓ installed ${INST_SHA:0:12} is in origin/main (older stamp: clean/dirty not recorded)"
else
  echo "  ✓ installed ${INST_SHA:0:12} is in origin/main, built clean"
fi
ALREADY_CURRENT=false
[[ "$INST_SHA" == "$MAIN_SHA" ]] && ALREADY_CURRENT=true

# ── 1.5. Build main in a fresh worktree ─────────────────────────────
# A new detached worktree at exactly $MAIN_SHA and a fresh `npm ci` every
# run. Never a symlinked or copied node_modules: electron-builder cannot
# walk a symlink and shipped an app with 18 of 58 packages (2026-10-13).
if $ALREADY_CURRENT && ! $DRY_RUN; then
  say "[1.5/5] Build — skipped, workmini already runs main ${MAIN_SHA:0:12}"
else
  say "[1.5/5] Building main ${MAIN_SHA:0:12} in a fresh worktree"
  printf 'workmini build %s — main %s\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')" "$MAIN_SHA" >"$BUILD_LOG"
  if [[ -e "$WT" ]]; then git -C "$REPO" worktree remove --force "$WT" >/dev/null 2>&1 || rm -rf "$WT"; fi
  git -C "$REPO" worktree prune
  step 180 "worktree add" git -C "$REPO" worktree add --detach "$WT" "$MAIN_SHA" \
    || build_die "git worktree add failed"
  [[ "$(git -C "$WT" rev-parse HEAD)" == "$MAIN_SHA" && -z "$(git -C "$WT" status --porcelain)" ]] \
    || die "The worktree at $WT is not a clean checkout of $MAIN_SHA."
  cd "$WT" || die "Cannot cd to $WT"
  step 1800 "npm ci" npm ci --no-audit --no-fund || build_die "npm ci failed (exit $?)"
  [[ -d node_modules && ! -L node_modules ]] || die "node_modules in $WT is not a real directory."
  echo "  ✓ npm ci ($(ls node_modules | wc -l | tr -d ' ') top-level packages)"

  # Tests are hard — they lock the workmini playback path. Typecheck is
  # soft: CI marks tsc continue-on-error (pre-existing debt); hard-failing
  # it here blocked the Aug-12 urgent workmini ship while music was dead.
  if step 900 typecheck npm run typecheck; then
    echo "  ✓ typecheck"
  else
    echo "  ⚠ typecheck failed (pre-existing; CI soft-gates this) — continuing build"
  fi
  step 1200 tests npm test || build_die "tests failed on main ${MAIN_SHA:0:12} (exit $?) — refusing to build"
  echo "  ✓ tests pass ($(sed -n 's/^# pass //p' "$BUILD_LOG" | tail -1) passed)"

  echo "  building (electron-vite + electron-builder, a few minutes)…"
  step 2700 "dist:dmg" npm run dist:dmg || build_die "build failed (exit $?)"
  DMG="$(ls "$WT"/release/JakeTunes-*-arm64.dmg 2>/dev/null | head -1)"
  NEW_APP="$WT/release/mac-arm64/JakeTunes.app"
  [[ -n "$DMG" && -f "$DMG" && -d "$NEW_APP" ]] || build_die "the build produced no DMG/app in $WT/release"
  [[ -z "$(git -C "$WT" status --porcelain --untracked-files=no)" ]] \
    || die "Building changed tracked files in $WT — refusing to ship a build that is not exactly main."

  # The new build must BE main, and must not have lost packages.
  NEW="$(python3 -c "$ASAR_INFO_PY" "$NEW_APP/Contents/Resources/app.asar")"
  [[ -z "$(kv error "$NEW")" ]] || die "Could not read the new app.asar: $(kv error "$NEW")"
  [[ "$(kv sha "$NEW")" == "$MAIN_SHA" ]] || die "The new build is stamped '$(kv sha "$NEW")', not $MAIN_SHA."
  [[ "$(kv dirty "$NEW")" != true ]] || die "The new build is stamped dirty."
  NEW_DEPS="$(kv deps "$NEW")"
  if [[ ! "$NEW_DEPS" =~ ^[0-9]+$ ]] || (( NEW_DEPS == 0 || NEW_DEPS * 10 < ${INST_DEPS:-0} * 8 )); then
    die "The new app packs ${NEW_DEPS:-?} node_modules packages; workmini's has ${INST_DEPS:-?}. A drop like that is a broken package. Refusing."
  fi
  codesign --verify --deep --strict "$NEW_APP" 2>/dev/null || die "The new app's code signature does not verify."
  echo "  ✓ fresh DMG: $(basename "$DMG")  ($(du -h "$DMG" | cut -f1)) — main ${MAIN_SHA:0:12}, ${NEW_DEPS} packages (installed has ${INST_DEPS})"
fi

say "JakeTunes → workmini deployment"
if $ALREADY_CURRENT; then
  echo "  app:      already main ${MAIN_SHA:0:12} — no install"
else
  echo "  app:      $(basename "$DMG")  ${INST_SHA:0:12} → ${MAIN_SHA:0:12}"
fi
echo "  target:   ${REMOTE}"
echo "  library:  $LIBJSON_LABEL"
echo "  .env:     $([[ $WITH_ENV == true ]] && echo 'will copy (--with-env)' || echo 'skipped (default)')"

if $DRY_RUN; then
  say "Dry run — stopping before anything on workmini changes"
  if GATE_REASON="$(check_gate)"; then echo "  gate now: $GATE_REASON"; else echo "  gate now: closed — $GATE_REASON"; fi
  echo "  a real run would $($ALREADY_CURRENT && echo 'skip the install (already current) and sync data' || echo "install main ${MAIN_SHA:0:12} once the gate is clear, then sync data")"
  exit 0
fi

# ── 2. Install the app (+ fail-fast launch check) ───────────────────
# Install BEFORE the data sync and verify the app actually runs — a
# code-signature / Gatekeeper kill is instant, so we catch it here.
# ditto (not cp -R) because cp -R over a running bundle corrupts the
# embedded signature → SIGKILL "Code Signature Invalid" at launch. The
# previous bundle is moved OUT of /Applications (a renamed copy inside it
# makes LaunchServices launch the old build) and kept for a manual undo.
if $ALREADY_CURRENT; then
  say "[2/5] Install — skipped, workmini already runs main ${MAIN_SHA:0:12}"
else
say "[2/5] Installing JakeTunes.app on workmini"
wait_for_gates || die "Install skipped — gate stayed closed for ${GATE_WAIT_MIN} min: $GATE_REASON. workmini keeps ${INST_SHA:0:12}."
rcp 1200 "$DMG" "${REMOTE}:jaketunes-deploy.dmg" || die "DMG copy failed (exit $?)."  # staged in $HOME — /tmp on workmini eats dmgs
BK="JakeTunes-prev-auto-$(date +%Y%m%d-%H%M).app"
{
  printf 'GATE_SH=%q\nASAR_INFO_PY=%q\n' "$GATE_SH" "$ASAR_INFO_PY"
  cat <<'REMOTE_INSTALL'
set -u
EXPECT_SHA="$1"; WANT_MTIME="$2"; BK="$3"; IDLE_MIN="$4"
APP=/Applications/JakeTunes.app
ASAR="$APP/Contents/Resources/app.asar"
DMG="$HOME/jaketunes-deploy.dmg"
MNT="$HOME/.jaketunes-deploy-mnt"
LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
abort() { echo "  ✗ $1" >&2; hdiutil detach "$MNT" -quiet -force 2>/dev/null; rm -f "$DMG"; exit "${2:-1}"; }
running() { pgrep -x JakeTunes >/dev/null; }

# A fixed mount point: ghost /Volumes/JakeTunes* attaches made the old
# `ls -d /Volumes/JakeTunes*` pick the wrong volume.
hdiutil detach "$MNT" -quiet -force 2>/dev/null; mkdir -p "$MNT"
hdiutil attach "$DMG" -nobrowse -readonly -noautoopen -mountpoint "$MNT" -quiet || abort "DMG mount failed"
NEW="$MNT/JakeTunes.app"
[ -d "$NEW" ] || abort "no JakeTunes.app inside the DMG"
got=$(python3 -c "$ASAR_INFO_PY" "$NEW/Contents/Resources/app.asar" | sed -n 's/^sha=//p')
[ "$got" = "$EXPECT_SHA" ] || abort "the DMG holds build ${got:-unstamped}, expected $EXPECT_SHA"
codesign --verify --deep --strict "$NEW" 2>/dev/null || abort "staged app signature invalid"

# The subset proof was made against this exact app.asar. If it changed or
# vanished since, another session installed in between: stop, never guess.
have=$(stat -f %m "$ASAR" 2>/dev/null) || abort "installed app.asar is missing (another install mid-swap?)"
[ "$have" = "$WANT_MTIME" ] || abort "installed app.asar changed since the subset proof ($have != $WANT_MTIME): another session installed"

# The gate again, last thing before the quit.
reason=$(bash -c "$GATE_SH" gate "$IDLE_MIN") || abort "gate closed at swap time: $reason" 10

if running; then
  perl -e 'alarm 20; exec @ARGV' osascript -e 'quit app id "com.jacobrosenbaum.jaketunes"' >/dev/null 2>&1
  for i in $(seq 1 45); do running || break; sleep 1; done
  running && abort "JakeTunes did not quit — install untouched"
fi
mv "$APP" "$HOME/$BK" || abort "could not move the old bundle aside"
if ! ditto "$NEW" "$APP"; then
  rm -rf "$APP"; mv "$HOME/$BK" "$APP"; open -a "$APP"
  abort "ditto failed — previous build restored and relaunched"
fi
hdiutil detach "$MNT" -quiet -force 2>/dev/null; rm -f "$DMG"
xattr -dr com.apple.quarantine "$APP" 2>/dev/null
codesign --verify --deep --strict "$APP" 2>/dev/null || abort "installed signature INVALID — previous build is at ~/$BK" 2
"$LSREG" -f "$APP" 2>/dev/null
# Keep this job's two newest set-aside bundles; never touch anyone else's.
ls -dt "$HOME"/JakeTunes-prev-auto-*.app 2>/dev/null | tail -n +3 | while IFS= read -r old; do rm -rf "$old"; done
VER="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
echo "  ✓ Installed JakeTunes $VER @ ${EXPECT_SHA:0:12} (previous build kept at ~/$BK)"
# Launch and confirm it STAYS alive (signature/Gatekeeper kills are
# instant). An empty library at this point is expected; data comes next.
open -a "$APP"
sleep 8
running || abort "JakeTunes crashed on launch — see ~/Library/Logs/DiagnosticReports/; previous build is at ~/$BK" 3
echo "  ✓ JakeTunes launches and stays running on workmini"
REMOTE_INSTALL
} | rsh 300 "bash -s -- '$MAIN_SHA' '$INST_MTIME' '$BK' '$IDLE_MIN_S'"
RC=$?
case $RC in
  0)  ;;
  10) die "Install skipped — the gate closed at swap time. workmini keeps ${INST_SHA:0:12}." ;;
  *)  die "Remote install/launch failed (exit $RC). Data sync NOT started — the app must run first." ;;
esac
fi

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
rsh 30 "mkdir -p '$WM_HOME/Music/JakeTunesLibrary'"
rsy 21600 -a --partial --timeout=300 --info=progress2 \
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
  rsh 30 "mkdir -p '$WM_HOME/Library/Application Support/JakeTunes/artwork'"
  rsy 1800 -rtz --update --no-perms --no-owner --no-group \
    --include='*.jpg' --include='*.meta.json' --exclude='*' \
    "$ART_SRC" "${REMOTE}:$WM_HOME/Library/Application Support/JakeTunes/artwork/" \
    && echo "  ✓ artwork synced" \
    || echo "  ⚠ artwork rsync had errors — V3 will show placeholders for affected covers"
else
  echo "  • $ART_SRC not present on this Mac — skipping album artwork"
fi
if [[ -d "$ARTIST_IMG_SRC" ]]; then
  rsh 30 "mkdir -p '$WM_HOME/Library/Application Support/JakeTunes/artist-images'"
  rsy 1800 -rtz --update --no-perms --no-owner --no-group \
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
#   (metadata-overrides.json used to be pushed here — no longer, see
#    SIDECARS below: the copy erased Jake's workmini edits, and its catalog
#    fields now come from the hub catalog)
# embeddings.bin (the ~50 MB semantic "brain") rides along too but is
# pushed in its own block below — it's BINARY, so it can't go through the
# validate_json sidecar loop the JSON files share.
# Each push is best-effort; missing sources are skipped silently
# (different Macs have different feature subsets enabled).
say "[4/5a] Harvesting playlists created on workmini"
# workmini used to be a DEAD END: its playlists had nowhere to go and the push
# below overwrote them. Harvest first — workmini-only playlists (matched by
# stable ID, never by name) come home to the MacBook, and only then does the
# merged file go back out. ADD-ONLY: deletion needs tombstones, which playlists
# do not have yet, and an add-only harvest cannot resurrect anything by itself.
if [[ -x "$HOME/bin/jaketunes-workmini-playlist-harvest.sh" ]]; then
  tmo 600 bash "$HOME/bin/jaketunes-workmini-playlist-harvest.sh" "$WORKMINI_USER" \
    || echo "  ⚠ harvest skipped (see message above)"
else
  echo "  • harvest script missing — skipping"
fi

say "[4/5] Bootstrapping library.json + sidecars"
rsh 30 "mkdir -p '$WM_HOME/Library/Application Support/JakeTunes'"
# release-kinds.json (2026-10-18): workmini is a replica and never resolves
# release kinds itself — its artist page groups by the laptop's answers.
# metadata-overrides.json and mobile-stars.json are NOT pushed (2026-10-20):
# a copy over workmini's erased the stars and Get Info edits Jake made there.
# Workmini takes catalog fields from the hub catalog, its own edits from its
# journal (src/common/user-edits.ts), and stars by merge from homemini.
SIDECARS=(picks-cache.json mobile-playlists.json playlist-additions.json playlists.json mixtapes.json live-sets.json release-kinds.json lyrics.json friends.json friend-credits.json mobile-plays.json taste-weights.json taste-profile.json)
# Phone-authored playlist sidecars: NAS is fresher than a possibly-stale
# MacBook userData mirror (iOS backend writes via homemini → NAS). Prefer NAS
# for those two so workmini doesn't inherit an empty/stale clobber copy.
# ⚠️ TWIN: vendor/jaketunes-contracts/contracts.json phonePlaylistSidecarsNeverPushFromDesktop
# (rewritten by npm run sync:contracts — do not hand-edit).
PHONE_PLAYLIST_SIDECARS=(mobile-playlists.json playlist-additions.json)
is_phone_playlist_sidecar() {
  local x
  for x in "${PHONE_PLAYLIST_SIDECARS[@]}"; do
    [[ "$1" == "$x" ]] && return 0
  done
  return 1
}
for f in "${SIDECARS[@]}"; do
  # Desktop-authored sidecars prefer LOCAL userData (post 4.5.0-114).
  # Phone playlist sidecars prefer NAS (see above). Validate JSON before
  # pushing so a torn-write file can't poison workmini.
  src=""
  if is_phone_playlist_sidecar "$f"; then
    if [[ -f "$NAS_STATE/$f" ]] && validate_json "$NAS_STATE/$f"; then
      src="$NAS_STATE/$f"
    elif [[ -f "$USERDATA/$f" ]] && validate_json "$USERDATA/$f"; then
      src="$USERDATA/$f"
      echo "  ⚠ $f sourced from local (NAS missing/corrupt)"
    fi
  elif [[ -f "$USERDATA/$f" ]] && validate_json "$USERDATA/$f"; then
    src="$USERDATA/$f"
  elif [[ -f "$NAS_STATE/$f" ]] && validate_json "$NAS_STATE/$f"; then
    src="$NAS_STATE/$f"
    echo "  ⚠ $f sourced from NAS (local missing/corrupt)"
  fi
  if [[ -n "$src" ]]; then
    rcp 300 "$src" \
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
  if rcp 900 "$EMB_SRC" "${REMOTE}:${WM_EMB}.tmp" \
     && rsh 30 "mv '${WM_EMB}.tmp' '${WM_EMB}'"; then
    EMB_BYTES="$(stat -f%z "$EMB_SRC" 2>/dev/null || echo '?')"
    echo "  ✓ embeddings.bin copied ($EMB_BYTES bytes — local brain refreshed)"
  else
    echo "  ⚠ embeddings.bin push failed — workmini keeps its previous (stale) brain"
    rsh 30 "rm -f '${WM_EMB}.tmp'" 2>/dev/null || true
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
rcp 600 "$LIBJSON_SRC" "${REMOTE}:${WM_LIBJSON}.tmp" \
  || die "library.json copy failed."
rsh 30 "mv '${WM_LIBJSON}.tmp' '${WM_LIBJSON}'" \
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
  rsh 60 "bash -s" <<'REMOTE_SETTINGS'
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
rsh 60 "bash -s" <<'REMOTE_SETTINGS'
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
  rcp 60 "$ENV_SRC" \
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
  # Taken from main's commit, never the shared checkout's working tree.
  CM_SRC="$BUILD_ROOT/cache-manager.py"
  git -C "$REPO" show "$MAIN_SHA:Dr. Claude/scripts/cache-manager.py" >"$CM_SRC" 2>/dev/null \
    && rcp 60 "$CM_SRC" "${REMOTE}:$WM_HOME/Library/Application Support/JakeTunes/cache-manager.py" \
    && echo "  ✓ cache-manager.py updated (main ${MAIN_SHA:0:12})" || echo "  ⚠ cache-manager.py push failed — host copy left as-is"
  # BACKGROUND, deliberately. This used to be awaited, and once the cache
  # started prioritising ALAC (which can be tens of GB over a slow link) the
  # deploy sat here for hours — with JakeTunes still QUIT, because the
  # relaunch comes after. A best-effort cache warm must never hold the app
  # closed. It is explicitly non-fatal; every track streams regardless.
  rsh 30 \
    'nohup /usr/bin/python3 "$HOME/Library/Application Support/JakeTunes/cache-manager.py" >/tmp/cache-manager.log 2>&1 </dev/null &' \
    && echo "  ✓ cache warm started in background (see /tmp/cache-manager.log on workmini)" \
    || echo "  ⚠ could not start cache warm — music still streams from NAS"
fi

# ── Relaunch so it picks up the freshly-synced library ──────────────
# Step 2 already proved the app runs, but it launched against an empty
# library. Quit + relaunch now that music + library.json (+ .env) are
# in place so it boots into the full library. A relaunch is a quit, so it
# passes the same audio + idle gate as the install; if the gate is closed
# the new library simply loads at the next launch.
say "Relaunching JakeTunes with the full library…"
if GATE_REASON="$(check_gate)"; then
  rsh 60 "osascript -e 'quit app \"JakeTunes\"' 2>/dev/null || true; sleep 3; open -a JakeTunes" || true
  echo "  ✓ relaunched ($GATE_REASON)"
else
  echo "  • not relaunching — $GATE_REASON. The new library loads at JakeTunes' next launch."
fi
say "✓ Done — workmini runs main ${MAIN_SHA:0:12}, data synced."
echo "  Future versions auto-update from the GitHub release, same as homemini."
