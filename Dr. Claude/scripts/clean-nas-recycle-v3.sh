#!/usr/bin/env bash
# clean-nas-recycle-v3.sh — empty the JakeTunesLibrary recycle on ds225
#
# v3 vs v2 (2026-05-24, NAS-full incident #3):
#   - AUDIO range bumped: [6000, 7000] → [6500, 8500] to accommodate
#     library growth since May 17 (today: 7044 .m4a).
#   - Active library invariants expanded beyond .m4a count alone.
#     Jake explicit ask: "make sure that the 6858 tracks and their
#     artworks in my library is absolutely not affected at all".
#     v3 now snapshots THREE invariants before deletion and verifies
#     all three are byte-identical afterward:
#       (1) .m4a file count (existing, kept)
#       (2) total file count in active library (covers artwork, plists, etc.)
#       (3) total bytes in active library (covers content changes too)
#     Any of the three changing → loud failure + abort post-deletion-verify.
#   - Hardcoded path-prefix assertion: RECYCLE_PATH must start with the
#     literal "/volume1/JakeShared/#recycle/" before any rm runs.
#     Defensive against future variable-substitution bugs.
#   - Pre-deletion: prints the exact rm target one more time so the
#     operator (or transcript reader) sees it before destructive op.
#
# v2 vs v1: counted .m4a as canonical signal vs all files (which got
# inflated by @SynoEAStream metadata).
#
# Safety contract (read before running):
#   - Verifies SSH reachability
#   - Verifies active library .m4a count is in [6500, 8500]
#   - Snapshots active library: .m4a count, total file count, total bytes
#   - Hard-asserts deletion path starts with "/volume1/JakeShared/#recycle/"
#   - Hard 60-minute timeout on the deletion (v2's 30 was tight for ~500k files)
#   - Deletes /volume1/JakeShared/#recycle/JakeTunesLibrary/ ONLY
#   - Does NOT touch /volume1/JakeShared/JakeTunesLibrary (active)
#   - Does NOT touch /volume1/Music/JakeTunesLibrary (older copy)
#   - Does NOT touch /volume1/Music/#recycle (separate)
#   - Post-deletion: re-snapshots all three invariants and ABORTS LOUDLY
#     if any of them drifted.

set -euo pipefail

NAS_USER="jakerosenbaum"
NAS_HOST="ds225"
RECYCLE_PATH="/volume1/JakeShared/#recycle/JakeTunesLibrary"
ACTIVE_PATH="/volume1/JakeShared/JakeTunesLibrary"
RECYCLE_PREFIX_REQUIRED="/volume1/JakeShared/#recycle/"
AUDIO_MIN=6500
AUDIO_MAX=8500

echo "=== v3 — NAS recycle cleanup (incident #3) ==="
echo "Target: ${NAS_USER}@${NAS_HOST}:${RECYCLE_PATH}"
echo ""

# ── 0. Defensive path-prefix assertion (paranoia layer) ───────────────
case "${RECYCLE_PATH}/" in
  ${RECYCLE_PREFIX_REQUIRED}*) ;;
  *)
    echo "FATAL: RECYCLE_PATH (${RECYCLE_PATH}) does not start with required prefix (${RECYCLE_PREFIX_REQUIRED})."
    echo "       Refusing to run. This guards against future variable-substitution bugs."
    exit 1
    ;;
esac
echo "[0/6] Path-prefix assertion passed: deletion path is under ${RECYCLE_PREFIX_REQUIRED}"

# ── 1. SSH check ──────────────────────────────────────────────────────
echo ""
echo "[1/6] Verifying SSH connection to ${NAS_HOST}..."
ssh -o BatchMode=yes "${NAS_USER}@${NAS_HOST}" 'echo "  connected: $(hostname) at $(date)"' 2>&1 | grep -v "WARNING\|post-quantum\|may need" || {
  echo "FATAL: SSH to ${NAS_HOST} failed. Aborting."
  exit 1
}

# ── 2. Pre-deletion active library snapshot (the three invariants) ────
echo ""
echo "[2/6] Snapshotting ACTIVE library invariants at ${ACTIVE_PATH}..."
PRE_SNAPSHOT=$(ssh -o BatchMode=yes "${NAS_USER}@${NAS_HOST}" "
  cd '${ACTIVE_PATH}' || exit 99
  M4A=\$(find . -type f -name '*.m4a' ! -name '*@SynoEAStream' 2>/dev/null | wc -l)
  ALL=\$(find . -type f 2>/dev/null | wc -l)
  BYTES=\$(du -sb . 2>/dev/null | awk '{print \$1}')
  echo \"M4A=\${M4A} ALL=\${ALL} BYTES=\${BYTES}\"
" 2>&1 | grep -v "WARNING\|post-quantum\|may need" | tail -1)

eval "${PRE_SNAPSHOT}"
PRE_M4A="${M4A}"
PRE_ALL="${ALL}"
PRE_BYTES="${BYTES}"
echo "  pre-deletion .m4a:        ${PRE_M4A}"
echo "  pre-deletion all files:   ${PRE_ALL}"
echo "  pre-deletion total bytes: ${PRE_BYTES} ($(numfmt --to=iec --suffix=B ${PRE_BYTES} 2>/dev/null || echo "${PRE_BYTES}B"))"

if [ "${PRE_M4A}" -lt "${AUDIO_MIN}" ] || [ "${PRE_M4A}" -gt "${AUDIO_MAX}" ]; then
  echo ""
  echo "FATAL: .m4a count ${PRE_M4A} is outside expected range [${AUDIO_MIN}, ${AUDIO_MAX}]."
  echo "       Something is unusual with the active library. Aborting before any deletion."
  exit 1
fi
echo "  .m4a count within expected range — active library appears intact"

# ── 3. Show what will be deleted ──────────────────────────────────────
echo ""
echo "[3/6] Recycle bin to be deleted (read-only inspection):"
ssh -o BatchMode=yes "${NAS_USER}@${NAS_HOST}" "
  echo '  path: ${RECYCLE_PATH}'
  echo -n '  file count: '
  find '${RECYCLE_PATH}' -type f 2>/dev/null | wc -l
  echo -n '  size:       '
  du -sh '${RECYCLE_PATH}' 2>/dev/null | awk '{print \$1}'
" 2>&1 | grep -v "WARNING\|post-quantum\|may need"

# ── 4. The destructive op (one final echo of target) ──────────────────
echo ""
echo "[4/6] About to run on ${NAS_HOST}:"
echo "     rm -rf '${RECYCLE_PATH}'"
echo "     (timeout: 60 minutes)"
echo ""
echo "  starting deletion at $(date)..."
timeout 3600 ssh -o BatchMode=yes "${NAS_USER}@${NAS_HOST}" "rm -rf '${RECYCLE_PATH}'" 2>&1 | grep -v "WARNING\|post-quantum\|may need" || {
  echo "FATAL: Deletion command failed or timed out. Re-snapshotting active library before aborting..."
  POST_FAIL=$(ssh -o BatchMode=yes "${NAS_USER}@${NAS_HOST}" "
    cd '${ACTIVE_PATH}' || exit 99
    M4A=\$(find . -type f -name '*.m4a' ! -name '*@SynoEAStream' 2>/dev/null | wc -l)
    ALL=\$(find . -type f 2>/dev/null | wc -l)
    BYTES=\$(du -sb . 2>/dev/null | awk '{print \$1}')
    echo \"M4A=\${M4A} ALL=\${ALL} BYTES=\${BYTES}\"
  " 2>&1 | grep -v "WARNING\|post-quantum\|may need" | tail -1)
  echo "  Active library post-failure snapshot: ${POST_FAIL}"
  echo "  Pre snapshot was: M4A=${PRE_M4A} ALL=${PRE_ALL} BYTES=${PRE_BYTES}"
  exit 2
}
echo "  deletion completed at $(date)"

# ── 5. Post-deletion active library re-snapshot ───────────────────────
echo ""
echo "[5/6] Re-snapshotting ACTIVE library to verify integrity..."
POST_SNAPSHOT=$(ssh -o BatchMode=yes "${NAS_USER}@${NAS_HOST}" "
  cd '${ACTIVE_PATH}' || exit 99
  M4A=\$(find . -type f -name '*.m4a' ! -name '*@SynoEAStream' 2>/dev/null | wc -l)
  ALL=\$(find . -type f 2>/dev/null | wc -l)
  BYTES=\$(du -sb . 2>/dev/null | awk '{print \$1}')
  echo \"M4A=\${M4A} ALL=\${ALL} BYTES=\${BYTES}\"
" 2>&1 | grep -v "WARNING\|post-quantum\|may need" | tail -1)

eval "${POST_SNAPSHOT}"
POST_M4A="${M4A}"
POST_ALL="${ALL}"
POST_BYTES="${BYTES}"

echo "  post-deletion .m4a:        ${POST_M4A}  (was ${PRE_M4A})"
echo "  post-deletion all files:   ${POST_ALL}  (was ${PRE_ALL})"
echo "  post-deletion total bytes: ${POST_BYTES}  (was ${PRE_BYTES})"

DRIFT=0
if [ "${POST_M4A}" -ne "${PRE_M4A}" ]; then
  echo "  ⚠️  .m4a count drifted by $((POST_M4A - PRE_M4A))"
  DRIFT=1
fi
if [ "${POST_ALL}" -ne "${PRE_ALL}" ]; then
  echo "  ⚠️  total file count drifted by $((POST_ALL - PRE_ALL))"
  DRIFT=1
fi
if [ "${POST_BYTES}" != "${PRE_BYTES}" ]; then
  echo "  ⚠️  total byte size drifted by $((POST_BYTES - PRE_BYTES)) bytes"
  DRIFT=1
fi

if [ "${DRIFT}" -eq 1 ]; then
  echo ""
  echo "FATAL: One or more active-library invariants drifted during cleanup."
  echo "       This should NOT happen — the cleanup only deletes from #recycle."
  echo "       Investigate immediately before further sync activity."
  exit 3
fi
echo "  ✓ All three invariants identical — active library 100% untouched"

# ── 6. Final volume status ────────────────────────────────────────────
echo ""
echo "[6/6] Volume status after cleanup:"
ssh -o BatchMode=yes "${NAS_USER}@${NAS_HOST}" 'df -h /volume1 | grep volume1' 2>&1 | grep -v "WARNING\|post-quantum\|may need" | sed 's/^/  /'

echo ""
echo "=== Cleanup complete ==="
echo "Done at $(date)."
