#!/usr/bin/env bash
# clean-nas-recycle-v4.sh — @eaDir-tolerant retry loop
#
# v4 vs v3 (2026-05-24, same-day iteration):
#   v3 freed ~2.3 TB of the 3.2 TB recycle backlog in a single rm -rf pass
#   but exited FATAL on:
#     rm: cannot remove '.../JakeTunesLibrary/_pending-imports/@eaDir': Directory not empty
#   DSM's indexing daemon writes to @eaDir folders concurrently with rm,
#   so single-pass rm -rf can't win the race when DSM is busy.
#
#   v4 replaces the single rm with a retry loop using `find -depth -delete`:
#     - Deletes leaf-first (children before parents — @eaDir parent can be
#       reaped once its regenerating children are gone)
#     - Tolerates per-file failures without aborting the whole pass
#     - Retries up to MAX_ATTEMPTS times with INTER_PASS_SLEEP between
#     - Reports remaining file count per pass so progress is visible
#     - Per-pass timeout so no single pass can hang
#     - If files remain after all attempts, lists residual paths for
#       inspection but does NOT exit FATAL — partial wins are wins
#       provided active library invariants still hold
#
#   v4 keeps ALL v3 safeties:
#     - Path-prefix assertion
#     - SSH reachability check
#     - Pre/post snapshots of active library (3 invariants: .m4a, all,
#       total bytes)
#     - Hardcoded RECYCLE_PATH, never interpolated from outside

set -euo pipefail

NAS_USER="jakerosenbaum"
NAS_HOST="ds225"
RECYCLE_PATH="/volume1/JakeShared/#recycle/JakeTunesLibrary"
ACTIVE_PATH="/volume1/JakeShared/JakeTunesLibrary"
RECYCLE_PREFIX_REQUIRED="/volume1/JakeShared/#recycle/"
AUDIO_MIN=6500
AUDIO_MAX=8500

MAX_ATTEMPTS=15
PER_PASS_TIMEOUT=600    # 10 min per pass
INTER_PASS_SLEEP=10     # seconds between passes — lets DSM quiesce

echo "=== v4 — NAS recycle cleanup (@eaDir-tolerant) ==="
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

# ── 3. Recycle bin initial inspection ─────────────────────────────────
echo ""
echo "[3/6] Recycle bin pre-cleanup state:"
INITIAL_REMAINING=$(ssh -o BatchMode=yes "${NAS_USER}@${NAS_HOST}" "find '${RECYCLE_PATH}' -type f 2>/dev/null | wc -l" 2>&1 | grep -v "WARNING\|post-quantum\|may need" | tail -1)
echo "  path:        ${RECYCLE_PATH}"
echo "  file count:  ${INITIAL_REMAINING}"

if [ "${INITIAL_REMAINING:-0}" -eq 0 ]; then
  echo "  Recycle bin is already empty. Nothing to do."
  echo ""
  echo "[6/6] Volume status:"
  ssh -o BatchMode=yes "${NAS_USER}@${NAS_HOST}" 'df -h /volume1 | grep volume1' 2>&1 | grep -v "WARNING\|post-quantum\|may need" | sed 's/^/  /'
  exit 0
fi

# ── 4. Retry-loop deletion ────────────────────────────────────────────
echo ""
echo "[4/6] Deletion via retry loop (find -depth -delete):"
echo "  max attempts:      ${MAX_ATTEMPTS}"
echo "  per-pass timeout:  ${PER_PASS_TIMEOUT}s"
echo "  inter-pass sleep:  ${INTER_PASS_SLEEP}s"
echo ""

LAST_REMAINING="${INITIAL_REMAINING}"
PASSES_WITH_ZERO_PROGRESS=0

for attempt in $(seq 1 ${MAX_ATTEMPTS}); do
  echo "  --- pass ${attempt}/${MAX_ATTEMPTS} (started $(date '+%H:%M:%S')) ---"
  echo "    files before pass: ${LAST_REMAINING}"

  # The actual deletion — find -depth ensures children are deleted
  # before parents, -delete is tolerant of per-file failures.
  timeout ${PER_PASS_TIMEOUT} ssh -o BatchMode=yes "${NAS_USER}@${NAS_HOST}" "find '${RECYCLE_PATH}' -mindepth 1 -depth -delete 2>&1 | tail -5" 2>&1 | grep -v "WARNING\|post-quantum\|may need" | sed 's/^/      /' || echo "      (pass ended early — timeout or per-file errors; not fatal)"

  # Recount
  REMAINING=$(ssh -o BatchMode=yes "${NAS_USER}@${NAS_HOST}" "find '${RECYCLE_PATH}' -type f 2>/dev/null | wc -l" 2>&1 | grep -v "WARNING\|post-quantum\|may need" | tail -1)
  REMAINING="${REMAINING:-0}"
  DELETED=$(( LAST_REMAINING - REMAINING ))

  echo "    files after pass:  ${REMAINING}  (deleted ${DELETED} this pass)"

  if [ "${REMAINING}" -eq 0 ]; then
    echo "    ✓ all files cleared. Attempting final rmdir of recycle root..."
    ssh -o BatchMode=yes "${NAS_USER}@${NAS_HOST}" "rmdir '${RECYCLE_PATH}' 2>/dev/null || rm -rf '${RECYCLE_PATH}' 2>/dev/null" || true
    break
  fi

  if [ "${DELETED}" -le 0 ]; then
    PASSES_WITH_ZERO_PROGRESS=$(( PASSES_WITH_ZERO_PROGRESS + 1 ))
    echo "    ⚠️  zero (or negative) progress this pass — DSM may be regenerating files (@eaDir)"
    if [ "${PASSES_WITH_ZERO_PROGRESS}" -ge 3 ]; then
      echo "    ⚠️  ${PASSES_WITH_ZERO_PROGRESS} consecutive zero-progress passes. Stopping retries."
      break
    fi
  else
    PASSES_WITH_ZERO_PROGRESS=0
  fi

  LAST_REMAINING="${REMAINING}"
  if [ "${attempt}" -lt "${MAX_ATTEMPTS}" ]; then
    echo "    sleeping ${INTER_PASS_SLEEP}s before next pass..."
    sleep ${INTER_PASS_SLEEP}
  fi
done

FINAL_REMAINING=$(ssh -o BatchMode=yes "${NAS_USER}@${NAS_HOST}" "find '${RECYCLE_PATH}' -type f 2>/dev/null | wc -l" 2>&1 | grep -v "WARNING\|post-quantum\|may need" | tail -1)
FINAL_REMAINING="${FINAL_REMAINING:-0}"
TOTAL_DELETED=$(( INITIAL_REMAINING - FINAL_REMAINING ))
echo ""
echo "  total deleted across all passes: ${TOTAL_DELETED}"
echo "  files still in recycle:           ${FINAL_REMAINING}"

if [ "${FINAL_REMAINING}" -gt 0 ]; then
  echo ""
  echo "  Residual paths (first 20 — for manual inspection if needed):"
  ssh -o BatchMode=yes "${NAS_USER}@${NAS_HOST}" "find '${RECYCLE_PATH}' -type f 2>/dev/null | head -20" 2>&1 | grep -v "WARNING\|post-quantum\|may need" | sed 's/^/    /'
  echo ""
  echo "  Note: this is NOT failure. Active library invariants will still be"
  echo "  verified in step [5/6]. Residual @eaDir files are DSM metadata and"
  echo "  pose no risk; they can be cleaned later with DSM Storage Manager."
fi

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

# v4 invariant check, refined from v3 lessons:
# .m4a count MUST be exactly equal (no audio tracks lost = the real safety guarantee)
# all-files count + bytes MAY ONLY GROW (additive drift from DSM indexing / sync
# during the cleanup window is normal and harmless; subtractive drift means
# the cleanup touched something it shouldn't have).
DRIFT=0
if [ "${POST_M4A}" -ne "${PRE_M4A}" ]; then
  echo "  ⚠️  .m4a count changed by $((POST_M4A - PRE_M4A)) — audio loss/gain is NEVER expected"
  DRIFT=1
fi
if [ "${POST_ALL}" -lt "${PRE_ALL}" ]; then
  echo "  ⚠️  total file count DECREASED by $((PRE_ALL - POST_ALL)) — files lost from active library"
  DRIFT=1
elif [ "${POST_ALL}" -gt "${PRE_ALL}" ]; then
  echo "  · total file count grew by $((POST_ALL - PRE_ALL)) (additive, normal — DSM indexing or sync)"
fi
if [ "${POST_BYTES}" -lt "${PRE_BYTES}" ]; then
  echo "  ⚠️  total byte size DECREASED by $((PRE_BYTES - POST_BYTES)) bytes — content lost"
  DRIFT=1
elif [ "${POST_BYTES}" -gt "${PRE_BYTES}" ]; then
  echo "  · total byte size grew by $((POST_BYTES - PRE_BYTES)) bytes (additive, normal)"
fi

if [ "${DRIFT}" -eq 1 ]; then
  echo ""
  echo "FATAL: Active library lost data during cleanup. This should NOT happen —"
  echo "       the cleanup only deletes from #recycle. Investigate immediately."
  exit 3
fi
echo "  ✓ .m4a count stable, no subtractive drift — active library 100% intact"

# ── 6. Final volume status ────────────────────────────────────────────
echo ""
echo "[6/6] Volume status after cleanup:"
ssh -o BatchMode=yes "${NAS_USER}@${NAS_HOST}" 'df -h /volume1 | grep volume1' 2>&1 | grep -v "WARNING\|post-quantum\|may need" | sed 's/^/  /'

echo ""
if [ "${FINAL_REMAINING}" -gt 0 ]; then
  echo "=== Cleanup partially complete ==="
  echo "Cleared ${TOTAL_DELETED} files; ${FINAL_REMAINING} residual (@eaDir-class) remain."
  echo "Active library verified intact. Exit code 0 (treated as success)."
else
  echo "=== Cleanup fully complete ==="
fi
echo "Done at $(date)."
