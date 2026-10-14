"""Brief 165 — shared write path for core/ tools that rewrite library.json.

Two protections, one import:

  1. atomic_write_json(path, obj) — serialize to a temp file in the SAME
     directory, fsync, parse it back, then os.replace over the target.
     A tool killed mid-write can no longer leave a torn library.json.
  2. require_app_not_running() — the app-quit gate
     scripts/taxonomy-classify.py already uses (its app_running()): the
     app serializes only its OWN saves, so an external write landing
     mid-save is silently overwritten (the mtime guard only catches
     writes from before the save started). Writers refuse (exit 3)
     while JakeTunes is running.

The gate is a same-host check only: a tool running on another machine
against a NAS-resident library cannot see the app process, and there
temp+rename is the protection. See
docs/briefs/165-script-writers-atomic-gate.md.

Callers keep their existing timestamped backup behaviour — this module
only replaces the final in-place write and adds the gate.

Import pattern (the one core/ siblings already use for tag_reader):

    _HERE = os.path.dirname(os.path.abspath(__file__))
    sys.path.insert(0, _HERE)
    from atomic_write import atomic_write_json, require_app_not_running

core/tools/ modules insert the PARENT directory (core/) instead.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile


def app_running() -> bool:
    """Mirror scripts/taxonomy-classify.py app_running() exactly."""
    try:
        r = subprocess.run(['pgrep', '-f', 'JakeTunes.app/Contents/MacOS/JakeTunes'],
                           capture_output=True)
        return r.returncode == 0
    except Exception:
        return False


def require_app_not_running(action: str = 'write library.json') -> None:
    """Refuse (exit 3) while the desktop app is running."""
    if app_running():
        print(f'REFUSED: JakeTunes is running — quit the app before you {action}.',
              file=sys.stderr)
        print('The app does not see an external write that lands mid-save; '
              'the change would be silently overwritten.', file=sys.stderr)
        sys.exit(3)


def atomic_write_json(path, obj, *, indent: int = 2, ensure_ascii: bool = False) -> None:
    """Write `obj` as JSON to `path` via temp file (same dir) + parse-back + os.replace.

    Defaults match the callers' existing on-disk format exactly
    (indent=2, ensure_ascii=False), so the landed bytes are unchanged
    apart from no longer being written in place.
    """
    path = os.fspath(path)
    directory = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(dir=directory,
                               prefix=os.path.basename(path) + '.',
                               suffix='.tmp')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as fh:
            json.dump(obj, fh, indent=indent, ensure_ascii=ensure_ascii)
            fh.flush()
            os.fsync(fh.fileno())
        with open(tmp, encoding='utf-8') as fh:
            json.load(fh)  # a torn/short temp must never become the live file
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
