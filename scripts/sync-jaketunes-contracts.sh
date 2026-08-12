#!/usr/bin/env bash
#
# Vendor @jaketunes/contracts from the private GitHub repo into this tree.
#
# Usage:
#   npm run sync:contracts              # fetch main
#   npm run sync:contracts -- v0.1.0    # fetch a tag / SHA / branch
#   npm run sync:contracts -- --local   # regenerate TS + bash from the in-tree JSON (no network)
#
# Why vendor (not an npm git dependency): JakeTunesV3 is public, CI runs
# `npm ci` with no token for jaketunes-contracts, and a git dep would break
# install on any machine that cannot clone that private repo.
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/vendor/jaketunes-contracts"
REPO_SLUG="jrosey30/jaketunes-contracts"
REPO_URL="https://github.com/${REPO_SLUG}"
REF="${1:-main}"

mkdir -p "$DEST"

if [ "$REF" = "--local" ]; then
  echo "applying in-tree $DEST/contracts.json (no fetch)"
  node "$ROOT/scripts/apply-jaketunes-contracts.mjs"
  exit 0
fi

TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

echo "fetching ${REPO_URL}@${REF} …"
# Prefer gh (uses the same creds as `gh auth`); fall back to git clone.
if command -v gh >/dev/null 2>&1 && gh api "repos/${REPO_SLUG}/contents/contracts.json?ref=${REF}" --jq .content >/tmp/jt-contracts-b64 2>/tmp/jt-contracts-err; then
  python3 - "$DEST/contracts.json" <<'PY'
import base64, pathlib, sys
out = pathlib.Path(sys.argv[1])
raw = pathlib.Path("/tmp/jt-contracts-b64").read_text().strip()
out.write_bytes(base64.b64decode(raw))
PY
  SHA="$(gh api "repos/${REPO_SLUG}/commits/${REF}" --jq .sha 2>/dev/null || true)"
  VER="$(python3 -c "import json; print(json.load(open('$DEST/contracts.json')).get('version',''))" 2>/dev/null || true)"
else
  if ! git clone --depth 1 --branch "$REF" "$REPO_URL.git" "$TMP/repo" 2>"$TMP/clone.err"; then
    # ref might be a SHA, not a branch/tag
    if ! git clone --depth 1 "$REPO_URL.git" "$TMP/repo" 2>>"$TMP/clone.err"; then
      echo "ERROR: could not fetch ${REPO_URL}@${REF}" >&2
      echo "This repo is private. Run this script on a machine with access" >&2
      echo "(Jake's laptop, or a PAT that can read jaketunes-contracts)." >&2
      echo "To regenerate generated files from the already-vendored JSON:" >&2
      echo "  npm run sync:contracts -- --local" >&2
      cat "$TMP/clone.err" >&2 || true
      cat /tmp/jt-contracts-err >&2 || true
      exit 1
    fi
    git -C "$TMP/repo" fetch --depth 1 origin "$REF" && git -C "$TMP/repo" checkout "$REF"
  fi
  if [ ! -f "$TMP/repo/contracts.json" ]; then
    echo "ERROR: ${REPO_SLUG} has no contracts.json at ${REF}" >&2
    echo "Looked in the clone root. If the package moved the file, update this script." >&2
    ls -la "$TMP/repo" >&2 || true
    exit 1
  fi
  cp "$TMP/repo/contracts.json" "$DEST/contracts.json"
  SHA="$(git -C "$TMP/repo" rev-parse HEAD)"
  VER="$(python3 -c "import json; print(json.load(open('$DEST/contracts.json')).get('version',''))" 2>/dev/null || true)"
fi

{
  echo "repo=${REPO_URL}"
  echo "package=@jaketunes/contracts"
  echo "version=${VER:-unknown}"
  echo "ref=${REF}"
  echo "sha=${SHA:-}"
} > "$DEST/SOURCE"

node "$ROOT/scripts/apply-jaketunes-contracts.mjs"
echo "vendored @jaketunes/contracts ${VER:-} (${SHA:-$REF}) → $DEST/contracts.json"
echo "next: npm test"
