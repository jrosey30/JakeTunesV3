#!/bin/bash
# Install Boom API on homemini as a launchd user agent.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$ROOT/../.." && pwd)"
VENV="${HOME}/JakeTunesState/boom/venv"
DB_DIR="${HOME}/JakeTunesState/boom"
PLIST_SRC="$ROOT/deploy/com.jaketunes.boom.plist"
PLIST_DST="${HOME}/Library/LaunchAgents/com.jaketunes.boom.plist"
LABEL="com.jaketunes.boom"

mkdir -p "$DB_DIR" "$(dirname "$PLIST_DST")"

if [[ ! -d "$VENV" ]]; then
  python3 -m venv "$VENV"
fi
# shellcheck disable=SC1091
source "$VENV/bin/activate"
pip install -q -r "$ROOT/requirements.txt"

# Prefer local JakeTunesState library.json for first import if present.
IMPORT_ARGS=()
if [[ -f "${HOME}/JakeTunesState/library.json" ]]; then
  IMPORT_ARGS=(--import-library "${HOME}/JakeTunesState/library.json")
fi

# Render plist with absolute paths. Import arg is optional — empty marker stripped.
IMPORT_LINE=""
if [[ ${#IMPORT_ARGS[@]} -gt 0 ]]; then
  IMPORT_LINE="${HOME}/JakeTunesState/library.json"
fi

sed \
  -e "s|__BOOM_ROOT__|${ROOT}|g" \
  -e "s|__VENV__|${VENV}|g" \
  -e "s|__DB_DIR__|${DB_DIR}|g" \
  -e "s|__IMPORT__|${IMPORT_LINE}|g" \
  -e "s|__HOME__|${HOME}|g" \
  "$PLIST_SRC" > "$PLIST_DST"

# If no import file, drop the --import-library pair from the plist.
if [[ -z "$IMPORT_LINE" ]]; then
  python3 - <<'PY' "$PLIST_DST"
import sys
from pathlib import Path
p = Path(sys.argv[1])
text = p.read_text()
text = text.replace(
    "    <string>--import-library</string>\n    <string></string>\n",
    "",
)
p.write_text(text)
PY
fi

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"
launchctl enable "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl kickstart -k "gui/$(id -u)/$LABEL"

sleep 1
curl -sf "http://127.0.0.1:3001/healthz" && echo "" && echo "Boom API is up on :3001" \
  || echo "WARN: healthz not ready yet — check ~/Library/Logs/jaketunes-boom.log"

echo "Repo: $REPO_ROOT"
