#!/usr/bin/env bash
# install-launchagents.sh — Brief 183: scheduler definitions live in git.
#
# Renders the managed jobs from jobs.json + templates/ into
# ~/Library/LaunchAgents, shows a diff against what's installed, and
# reloads only the agents whose plist actually changed.
#
#   install-launchagents.sh            DRY-RUN (default): render + diff, change nothing
#   install-launchagents.sh --apply    install changed plists and reload those agents
#   install-launchagents.sh --status   per-job status (delegates to status.sh)
#   … --apply --only <label>             install ONE job. The manifest mixes
#                                        laptop and homemini jobs, and a bare
#                                        --apply installs every managed job on
#                                        whichever Mac runs it (2026-10-20).
#
# Idempotent: an agent whose rendered plist is byte-identical to the
# installed one is reported "up to date" and never reloaded.
#
# Test/override hooks (used by the fixture runs in the brief doc):
#   LAUNCHAGENTS_DIR   where plists install (default ~/Library/LaunchAgents)
#   JAKETUNES_REPO_DIR repo root the templates point at (default: this repo)
#   NODE_BIN           node path rendered into templates
#   PYTHON_BIN         python3 path rendered into templates
# launchctl is used only when present (macOS); elsewhere the reload step
# is reported and skipped, so dry-run/apply file behaviour is testable
# anywhere.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${JAKETUNES_REPO_DIR:-$(cd "$HERE/../.." && pwd)}"
LA_DIR="${LAUNCHAGENTS_DIR:-$HOME/Library/LaunchAgents}"
NODE_BIN="${NODE_BIN:-$(command -v node || echo /opt/homebrew/bin/node)}"
PYTHON_BIN="${PYTHON_BIN:-$(command -v python3 || echo /usr/bin/python3)}"

if [ "${1:-}" = "--status" ]; then
  exec "$HERE/status.sh"
fi
MODE="dry-run"
ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) MODE="apply" ;;
    --only) ONLY="${2:-}"; [ -n "$ONLY" ] || { echo "--only needs a label" >&2; exit 2; }; shift ;;
    *) echo "usage: $0 [--apply] [--only <label>] | --status" >&2; exit 2 ;;
  esac
  shift
done

echo "launchd installer — mode: $MODE"
echo "repo: $REPO_DIR | agents dir: $LA_DIR | node: $NODE_BIN | python3: $PYTHON_BIN"
echo

# Managed jobs: label <TAB> template, from the manifest (python3 is the
# JSON parser — it exists on every machine these jobs run on).
MANAGED="$(python3 - "$HERE/jobs.json" "$ONLY" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
only = sys.argv[2]
hits = [j for j in m["jobs"] if j["kind"] == "managed" and (not only or j["label"] == only)]
if only and not hits:
    sys.exit(f"--only {only}: no managed job with that label in jobs.json")
for j in hits:
    print(f"{j['label']}\t{j['template']}")
PY
)" || exit 2

changed=0; current=0
while IFS=$'\t' read -r label template; do
  [ -n "$label" ] || continue
  dest="$LA_DIR/$label.plist"
  rendered="$(mktemp)"
  sed -e "s|__HOME__|$HOME|g" -e "s|__REPO__|$REPO_DIR|g" \
      -e "s|__NODE__|$NODE_BIN|g" -e "s|__PYTHON3__|$PYTHON_BIN|g" \
      "$HERE/$template" > "$rendered"
  if [ -f "$dest" ] && cmp -s "$rendered" "$dest"; then
    echo "✓ $label — up to date"
    current=$((current + 1))
  else
    changed=$((changed + 1))
    if [ -f "$dest" ]; then
      echo "≠ $label — installed plist differs from the template:"
      diff -u "$dest" "$rendered" || true
    else
      echo "+ $label — not installed; rendered plist:"
      diff -u /dev/null "$rendered" || true
    fi
    if [ "$MODE" = "apply" ]; then
      mkdir -p "$LA_DIR"
      cp "$rendered" "$dest"
      if command -v launchctl >/dev/null 2>&1; then
        launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
        launchctl bootstrap "gui/$(id -u)" "$dest"
        echo "  → installed + reloaded ($dest)"
      else
        echo "  → installed ($dest); launchctl not available here — reload skipped"
      fi
    else
      echo "  → dry-run: no change made (re-run with --apply to install)"
    fi
  fi
  rm -f "$rendered"
done <<< "$MANAGED"

echo
echo "summary: $current up to date, $changed changed (mode: $MODE)"
python3 - "$HERE/jobs.json" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
for j in m["jobs"]:
    if j["kind"] != "managed":
        print(f"note: {j['label']} is '{j['kind']}' — not installed by this script. {j['notes'].split('.')[0]}.")
PY
