#!/usr/bin/env python3
"""Brief 031 Phase 3 — apply approved variant decisions to library.json.

DESTRUCTIVE. Modifies ~/Library/Application Support/JakeTunes/library.json.
Backs up the pre-change file to library.json.bak-<ISO8601> first, and
verifies the backup's sha256 against the original before writing.

Four safety gates ALL must pass before the destructive write:
  1. Approval gate    : decisions.json["approved"] == True
  2. JakeTunes-quit   : pgrep -f "JakeTunes.app/Contents/MacOS/JakeTunes"
                        returns no output
  3. mtime+hash gate  : live library.json mtime + sha256 match the
                        values captured in audit-state.json
  4. Backup verified  : sha256 of the written backup file matches
                        the original library.json bytes

Embedded file tags NOT modified (Brief 020 territory). Only the
`artist` field in library.json's `tracks[]` is reassigned. The
indexer change in Phase 4b preserves the new canonical names across
subsequent re-imports.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_DR_CLAUDE = Path(__file__).resolve().parent.parent / 'Dr. Claude'
DECISIONS_PATH = REPO_DR_CLAUDE / '031-decisions.json'
AUDIT_STATE_PATH = REPO_DR_CLAUDE / '031-audit-state.json'
LIBRARY = os.path.expanduser('~/Library/Application Support/JakeTunes/library.json')


def fail(msg: str) -> int:
    print(f'FATAL: {msg}', file=sys.stderr)
    return 1


def main() -> int:
    # ── Load inputs ─────────────────────────────────────────────────────
    if not DECISIONS_PATH.exists():
        return fail(f'decisions.json not found at {DECISIONS_PATH}')
    if not AUDIT_STATE_PATH.exists():
        return fail(f'audit-state.json not found at {AUDIT_STATE_PATH} — re-run Phase 1 audit')

    decisions = json.loads(DECISIONS_PATH.read_text())
    audit_state = json.loads(AUDIT_STATE_PATH.read_text())

    # ── Gate 1: approval ────────────────────────────────────────────────
    if not decisions.get('approved'):
        return fail(
            'decisions.json has "approved": false. Phase 2 review not complete. '
            'Set "approved": true in decisions.json and re-run.'
        )
    print('[Gate 1] approval: ✓')

    # ── Gate 2: JakeTunes not running ──────────────────────────────────
    result = subprocess.run(
        ['pgrep', '-f', 'JakeTunes.app/Contents/MacOS/JakeTunes'],
        capture_output=True, text=True,
    )
    # pgrep also matches Helper processes; filter them out (Brief 031 pre-flight pattern)
    pids = [
        line for line in result.stdout.splitlines()
        if line.strip()
    ]
    # Cross-check: only fail if a non-Helper JakeTunes is actually running.
    if pids:
        ps_result = subprocess.run(
            ['ps', '-p', ','.join(pids), '-o', 'pid=,command='],
            capture_output=True, text=True,
        )
        non_helper = [
            line for line in ps_result.stdout.splitlines()
            if 'JakeTunes.app/Contents/MacOS/JakeTunes' in line
            and 'Helper' not in line
        ]
        if non_helper:
            return fail(
                'JakeTunes is running. Quit it first:\n'
                "  osascript -e 'quit app \"JakeTunes\"'\n"
                '  sleep 5\n'
                'Then re-run this script.\n'
                f'Found:\n  ' + '\n  '.join(non_helper)
            )
    print('[Gate 2] JakeTunes-not-running: ✓')

    # ── Gate 3: live library.json matches audit-state ──────────────────
    if not os.path.exists(LIBRARY):
        return fail(f'library.json not found at {LIBRARY}')
    with open(LIBRARY, 'rb') as f:
        raw_before = f.read()
    live_hash = hashlib.sha256(raw_before).hexdigest()
    live_mtime = os.stat(LIBRARY).st_mtime

    expected_hash = audit_state['sourceLibraryHash']
    expected_mtime_raw = audit_state['sourceLibraryMtimeRaw']
    if live_hash != expected_hash:
        return fail(
            f'library.json drifted since audit:\n'
            f'  audit hash: {expected_hash}\n'
            f'  live hash:  {live_hash}\n'
            f'Re-run Phase 1 audit (with JakeTunes quit) to refresh state, '
            f'then re-run this apply.'
        )
    if abs(live_mtime - expected_mtime_raw) > 0.001:
        return fail(
            f'library.json mtime drifted since audit:\n'
            f'  audit mtime: {expected_mtime_raw:.6f}\n'
            f'  live mtime:  {live_mtime:.6f}\n'
            f'Re-run Phase 1 audit to refresh state.'
        )
    print(f'[Gate 3] mtime+hash unchanged: ✓ (hash={live_hash[:16]}...)')

    # ── Build the variant -> canonical lookup map ───────────────────────
    # Note (Brief 031 Decision): a variant entry's canonical may NOT
    # appear in its own variants array (e.g. Iggy & The Stooges -> The
    # Stooges, where "The Stooges" was a manual Phase 2 addition). The
    # map is built by iterating entries in `variants` and mapping each
    # to its `canonical`. Tracks already attributed to the canonical
    # name aren't in any variant array, so they're left alone.
    variant_to_canonical: dict[str, str] = {}
    skipped_groups = 0
    for key, group in decisions['variants'].items():
        canonical = group.get('canonical')
        if canonical is None:
            skipped_groups += 1
            continue
        for variant in group.get('variants', []):
            variant_to_canonical[variant] = canonical

    print(f'Lookup map: {len(variant_to_canonical)} variant strings -> {len(set(variant_to_canonical.values()))} canonical names')
    if skipped_groups:
        print(f'  ({skipped_groups} variant groups skipped via canonical: null)')

    # ── Apply reassignments ────────────────────────────────────────────
    lib = json.loads(raw_before.decode('utf-8'))
    tracks = lib.get('tracks', [])
    reassignments_per_canonical: dict[str, int] = {}
    tracks_reassigned = 0
    for t in tracks:
        a = t.get('artist')
        if not isinstance(a, str):
            continue
        if a in variant_to_canonical:
            canonical = variant_to_canonical[a]
            t['artist'] = canonical
            reassignments_per_canonical[canonical] = reassignments_per_canonical.get(canonical, 0) + 1
            tracks_reassigned += 1

    print(f'Reassignments by canonical:')
    for canon, count in sorted(reassignments_per_canonical.items(), key=lambda kv: -kv[1]):
        print(f'  {canon!r}: {count} tracks')
    print(f'Total tracks reassigned: {tracks_reassigned}')

    if tracks_reassigned == 0:
        print()
        print('No tracks needed reassignment. library.json unchanged.')
        return 0

    # ── Gate 4: write backup + verify ──────────────────────────────────
    timestamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup_path = f'{LIBRARY}.bak-{timestamp}'
    with open(backup_path, 'wb') as f:
        f.write(raw_before)
    with open(backup_path, 'rb') as f:
        backup_raw = f.read()
    backup_hash = hashlib.sha256(backup_raw).hexdigest()
    if backup_hash != live_hash:
        # Backup didn't write completely / got corrupted somehow.
        return fail(
            f'Backup verification FAILED — aborting before destructive write.\n'
            f'  original hash: {live_hash}\n'
            f'  backup hash:   {backup_hash}\n'
            f'  backup path:   {backup_path}\n'
            f'Inspect filesystem before retrying.'
        )
    print(f'[Gate 4] backup verified: ✓ {backup_path}')

    # ── Atomic temp+rename write ───────────────────────────────────────
    partial_path = f'{LIBRARY}.partial'
    with open(partial_path, 'w', encoding='utf-8') as f:
        json.dump(lib, f, indent=2, ensure_ascii=False)
    os.rename(partial_path, LIBRARY)

    # ── Report ──────────────────────────────────────────────────────────
    consolidated = len(set(variant_to_canonical.values()))
    print()
    print(f'=== Phase 3 complete ===')
    print(f'  {consolidated} canonical artist names absorbed {len(variant_to_canonical)} variant strings')
    print(f'  {tracks_reassigned} tracks reassigned')
    print(f'  backup: {backup_path}')
    print()
    print('Next: run Phase 4 (scripts/brief-031-apply-collabs.py).')
    print('Do NOT restart JakeTunes between Phase 3 and Phase 4 — wait until both done.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
