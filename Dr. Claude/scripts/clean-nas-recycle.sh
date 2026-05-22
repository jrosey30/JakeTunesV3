#!/usr/bin/env bash
# clean-nas-recycle.sh — empty the JakeTunesLibrary recycle on ds225
#
# Brief 021v2 (2026-05-17). The destructive-sync bug week (pre-Brief 019)
# left ~112k files in /volume1/JakeShared/#recycle/JakeTunesLibrary/ on
# the Synology NAS. Brief 019 made the sync non-destructive — no new
# files accumulate. This script empties the existing backlog.
#
# v2 vs v1: counts .m4a files as the canonical library-integrity
# signal instead of all files. Synology's Extended Attribute Stream
# files (@SynoEAStream) and @eaDir indexing folders inflate the
# generic find -type f count but are filesystem metadata, not user
# data — v1's threshold (5,500) was set against the inflated count
# and would have failed. v2 keys on .m4a count (6,000–7,000) which
# tracks the actual music library 1-to-1.
#
# Safety:
#   - Verifies SSH reachability
#   - Verifies active library .m4a count is in [6,000, 7,000]
#     (canonical library-integrity signal; excludes @SynoEAStream)
#   - Hard 30-minute timeout on the deletion
#   - Deletes /volume1/JakeShared/#recycle/JakeTunesLibrary/ ONLY
#   - Does NOT touch /volume1/JakeShared/JakeTunesLibrary (active)
#   - Does NOT touch /volume1/Music/JakeTunesLibrary (older copy)
#   - Does NOT touch /volume1/Music/#recycle (separate, 16 files)

set -euo pipefail

NAS_USER="jakerosenbaum"
NAS_HOST="ds225"
RECYCLE_PATH="/volume1/JakeShared/#recycle/JakeTunesLibrary"
ACTIVE_PATH="/volume1/JakeShared/JakeTunesLibrary"
AUDIO_MIN=6000  # audio file count below this = abort
AUDIO_MAX=7000  # audio file count above this = abort

echo "=== Brief 021v2 — NAS recycle cleanup ==="
echo "Target: ${NAS_USER}@${NAS_HOST}:${RECYCLE_PATH}"
echo ""

# 1. SSH check
echo "[1/5] Verifying SSH connection..."
ssh "${NAS_USER}@${NAS_HOST}" 'echo "  connected: $(hostname) at $(date)"' || {
  echo "FATAL: SSH to ${NAS_HOST} failed. Aborting."
  exit 1
}

# 2. Active library audio file count (Synology EA streams excluded).
# The canonical library-integrity signal — if this is in range we know
# the active library wasn't accidentally swept into the recycle and the
# rm -rf below targets only trash.
echo ""
echo "[2/5] Verifying active library audio file count at ${ACTIVE_PATH}..."
AUDIO_COUNT=$(ssh "${NAS_USER}@${NAS_HOST}" "find ${ACTIVE_PATH} -type f -name '*.m4a' ! -name '*@SynoEAStream' 2>/dev/null | wc -l")
echo "  active library .m4a file count: ${AUDIO_COUNT}"
if [ "${AUDIO_COUNT}" -lt "${AUDIO_MIN}" ] || [ "${AUDIO_COUNT}" -gt "${AUDIO_MAX}" ]; then
  echo "FATAL: Audio file count ${AUDIO_COUNT} is outside expected range [${AUDIO_MIN}, ${AUDIO_MAX}]."
  echo "       Something is unusual. Aborting before any deletion."
  echo "       To investigate:"
  echo "       ssh ${NAS_USER}@${NAS_HOST} 'find ${ACTIVE_PATH} -type f -name \"*.m4a\" ! -name \"*@SynoEAStream\" | head -20'"
  exit 1
fi
echo "  audio count OK — active library is intact"

# 3. Show what we're about to delete
echo ""
echo "[3/5] Recycle contents to be deleted:"
RECYCLE_COUNT=$(ssh "${NAS_USER}@${NAS_HOST}" "find ${RECYCLE_PATH} -type f 2>/dev/null | wc -l")
echo "  files in recycle (including Synology metadata): ${RECYCLE_COUNT}"
ssh "${NAS_USER}@${NAS_HOST}" "du -sh ${RECYCLE_PATH} 2>/dev/null" | sed 's/^/  size: /'

if [ "${RECYCLE_COUNT}" -lt 100 ]; then
  echo "  recycle is already nearly empty (${RECYCLE_COUNT} files). Skipping deletion."
  exit 0
fi

# 4. Delete with timeout
echo ""
echo "[4/5] Deleting recycle contents (30-minute timeout)..."
echo "  this may take 2-15 minutes depending on NAS load"
timeout 1800 ssh "${NAS_USER}@${NAS_HOST}" "rm -rf ${RECYCLE_PATH}" || {
  echo "FATAL: Deletion command failed or timed out. Investigate manually."
  exit 1
}

# 5. Verify post-deletion
echo ""
echo "[5/5] Verifying post-deletion state..."
REMAINING=$(ssh "${NAS_USER}@${NAS_HOST}" "find ${RECYCLE_PATH} -type f 2>/dev/null | wc -l" 2>/dev/null || echo "0")
POST_AUDIO=$(ssh "${NAS_USER}@${NAS_HOST}" "find ${ACTIVE_PATH} -type f -name '*.m4a' ! -name '*@SynoEAStream' 2>/dev/null | wc -l")
echo "  files remaining in recycle path: ${REMAINING}"
echo "  active library .m4a count post-deletion: ${POST_AUDIO}"
echo ""

if [ "${POST_AUDIO}" -ne "${AUDIO_COUNT}" ]; then
  echo "WARNING: Audio file count changed from ${AUDIO_COUNT} to ${POST_AUDIO} during cleanup."
  echo "         Small drift (±5) is normal. Larger drift needs investigation."
fi

echo "=== Cleanup complete ==="
ssh "${NAS_USER}@${NAS_HOST}" 'df -h /volume1 | grep volume1' | sed 's/^/  /'
echo ""
echo "Done."
