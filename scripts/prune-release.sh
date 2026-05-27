#!/usr/bin/env bash
# prune-release.sh — keep last N JakeTunes build artifacts, prune the rest
#
# Background: 2026-05-24. `~/JakeTunesV3/release/` was found to contain
# 63 DMGs totaling 6.1 GB (215 total entries including blockmaps + zips)
# accumulated since May 3. electron-builder doesn't auto-prune, so dev
# iteration cycles leave the dir growing indefinitely.
#
# This script keeps the N most-recent build groups and prunes the rest.
# A "build group" is the set of files matching a single version, e.g.:
#   JakeTunes-4.5.0-55-arm64.dmg
#   JakeTunes-4.5.0-55-arm64.dmg.blockmap
#   JakeTunes-4.5.0-55-arm64-mac.zip
#   JakeTunes-4.5.0-55-arm64-mac.zip.blockmap
#
# Usage:
#   ./scripts/prune-release.sh              # dry-run, default (keep last 3)
#   ./scripts/prune-release.sh --keep 5     # dry-run, keep last 5
#   ./scripts/prune-release.sh --yes        # actually delete
#   ./scripts/prune-release.sh --keep 5 --yes
#
# Safety:
#   - Default is dry-run; --yes flag required to delete
#   - Never touches .yaml / .yml manifest files (electron-builder uses
#     these for update channels)
#   - Never touches anything that doesn't match the JakeTunes-* prefix
#   - Lists what will be / was deleted explicitly

set -euo pipefail

KEEP=3
DRY_RUN=1

while [ "$#" -gt 0 ]; do
  case "$1" in
    --keep)
      KEEP="$2"
      shift 2
      ;;
    --yes)
      DRY_RUN=0
      shift
      ;;
    -h|--help)
      sed -n '1,30p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 1
      ;;
  esac
done

if ! [[ "${KEEP}" =~ ^[0-9]+$ ]] || [ "${KEEP}" -lt 1 ]; then
  echo "ERROR: --keep must be a positive integer (got '${KEEP}')" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RELEASE_DIR="${REPO_ROOT}/release"

if [ ! -d "${RELEASE_DIR}" ]; then
  echo "ERROR: ${RELEASE_DIR} not found" >&2
  exit 1
fi

echo "=== prune-release.sh ==="
echo "  release dir: ${RELEASE_DIR}"
echo "  keep:        ${KEEP} most-recent versions"
echo "  mode:        $([ ${DRY_RUN} -eq 1 ] && echo 'DRY RUN (use --yes to actually delete)' || echo 'DELETE')"
echo ""

# Enumerate unique versions from DMG filenames. Pattern: JakeTunes-<version>-<arch>.dmg
# Captures e.g. "4.5.0-55" from "JakeTunes-4.5.0-55-arm64.dmg"
VERSIONS=$(ls -t "${RELEASE_DIR}"/JakeTunes-*.dmg 2>/dev/null | \
  sed -E 's|.*/JakeTunes-||; s|-arm64\.dmg$||; s|-x64\.dmg$||; s|-universal\.dmg$||' | \
  awk '!seen[$0]++')

VERSION_COUNT=$(echo "${VERSIONS}" | grep -c . || true)

if [ "${VERSION_COUNT}" -le "${KEEP}" ]; then
  echo "  Only ${VERSION_COUNT} versions present, ≤ keep=${KEEP}. Nothing to prune."
  exit 0
fi

KEEP_LIST=$(echo "${VERSIONS}" | head -n "${KEEP}")
PRUNE_LIST=$(echo "${VERSIONS}" | tail -n "+$((KEEP + 1))")
PRUNE_COUNT=$(echo "${PRUNE_LIST}" | grep -c . || true)

echo "  KEEPING (${KEEP} newest):"
echo "${KEEP_LIST}" | sed 's/^/    /'
echo ""
echo "  PRUNING (${PRUNE_COUNT} older):"
echo "${PRUNE_LIST}" | sed 's/^/    /'
echo ""

TOTAL_BYTES=0
DELETED_FILES=0
while IFS= read -r ver; do
  [ -z "${ver}" ] && continue
  # Match all files for this version (dmg, blockmap, zip, etc.)
  while IFS= read -r f; do
    [ -z "${f}" ] && continue
    case "${f}" in
      *.yaml|*.yml)
        continue  # never touch electron-builder update manifests
        ;;
    esac
    SIZE=$(stat -f %z "${f}" 2>/dev/null || echo 0)
    TOTAL_BYTES=$(( TOTAL_BYTES + SIZE ))
    DELETED_FILES=$(( DELETED_FILES + 1 ))
    if [ "${DRY_RUN}" -eq 1 ]; then
      echo "    [dry-run] would delete: ${f} ($(numfmt --to=iec ${SIZE} 2>/dev/null || echo "${SIZE}B"))"
    else
      rm -f "${f}"
      echo "    deleted: ${f}"
    fi
  done < <(ls "${RELEASE_DIR}"/JakeTunes-"${ver}"-* 2>/dev/null || true)
done <<< "${PRUNE_LIST}"

echo ""
echo "  files affected: ${DELETED_FILES}"
echo "  bytes affected: $(numfmt --to=iec ${TOTAL_BYTES} 2>/dev/null || echo "${TOTAL_BYTES}B")"

if [ "${DRY_RUN}" -eq 1 ]; then
  echo ""
  echo "  This was a DRY RUN. To actually delete, re-run with --yes:"
  echo "    ${0} --keep ${KEEP} --yes"
fi
