#!/usr/bin/env python3
"""Brief 031 Phase 4 — populate the contributingArtists derived field.

Runs against the POST-Phase-3 library.json. Adds a contributingArtists
field to every track. For sole-artist tracks: [artist]. For approved
collabs from Dr. Claude/031-decisions.json: the split array.

Field semantics: "track belongs to artist X's artist-page view if
track.contributingArtists.includes(X)." Renderer + mobile filter by
this field instead of `artist === X` so a collab track appears on
every contributing artist's page.

DESTRUCTIVE on library.json (additive field). Safety gates:
  1. Approval gate    : decisions.json["approved"] == true
  2. JakeTunes-quit   : pgrep returns no non-Helper matches
  3. Phase-3-applied  : library.json must NOT contain any variant
                        strings from decisions.json's variants (i.e.,
                        Phase 3 already consolidated them)
  4. Backup verified  : sha256(backup) == sha256(original)
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
LIBRARY = os.path.expanduser('~/Library/Application Support/JakeTunes/library.json')


def fail(msg: str) -> int:
    print(f'FATAL: {msg}', file=sys.stderr)
    return 1


def main() -> int:
    if not DECISIONS_PATH.exists():
        return fail(f'decisions.json not found at {DECISIONS_PATH}')
    decisions = json.loads(DECISIONS_PATH.read_text())

    # ── Gate 1: approval ────────────────────────────────────────────────
    if not decisions.get('approved'):
        return fail('decisions.json has "approved": false. Phase 2 review not complete.')
    print('[Gate 1] approval: ✓')

    # ── Gate 2: JakeTunes not running ──────────────────────────────────
    result = subprocess.run(
        ['pgrep', '-f', 'JakeTunes.app/Contents/MacOS/JakeTunes'],
        capture_output=True, text=True,
    )
    pids = [line for line in result.stdout.splitlines() if line.strip()]
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
                'JakeTunes is running. Quit it first.\n'
                f'Found:\n  ' + '\n  '.join(non_helper)
            )
    print('[Gate 2] JakeTunes-not-running: ✓')

    # ── Read library ───────────────────────────────────────────────────
    if not os.path.exists(LIBRARY):
        return fail(f'library.json not found at {LIBRARY}')
    with open(LIBRARY, 'rb') as f:
        raw_before = f.read()
    live_hash = hashlib.sha256(raw_before).hexdigest()
    lib = json.loads(raw_before.decode('utf-8'))
    tracks = lib.get('tracks', [])

    # ── Gate 3: Phase 3 was applied (no variant strings present) ────────
    # If any of the variant strings (e.g., "Blink-182", "Iggy & The
    # Stooges") still appear as a track's artist, Phase 3 didn't run.
    # Phase 4 reads the post-Phase-3 state; refuse to run without it.
    variant_strings: set[str] = set()
    for group in decisions['variants'].values():
        canonical = group.get('canonical')
        if canonical is None:
            continue
        for v in group.get('variants', []):
            # A variant is "still present" only if it's different from
            # the canonical (a canonical IS a variant of itself in some
            # entries; that's not a problem since it'd remain
            # unchanged after Phase 3).
            if v != canonical:
                variant_strings.add(v)
    leftover = [t for t in tracks if t.get('artist') in variant_strings]
    if leftover:
        sample = ', '.join(repr(t.get('artist')) for t in leftover[:3])
        return fail(
            f'Phase 3 not applied — found {len(leftover)} tracks still using '
            f'pre-Phase-3 variant artist names (sample: {sample}). Run '
            f'scripts/brief-031-apply-decisions.py first.'
        )
    print('[Gate 3] Phase 3 applied: ✓ (no leftover variant strings)')

    # ── Compute contributingArtists ─────────────────────────────────────
    collabs = decisions.get('collabs', {})
    # Only collabs with a non-null split apply.
    collab_to_split: dict[str, list[str]] = {}
    for raw, entry in collabs.items():
        split = entry.get('split')
        if split is None:
            continue
        collab_to_split[raw] = list(split)

    multi_count = 0
    sole_count = 0
    unchanged_count = 0
    sample_multi: list[tuple[str, list[str]]] = []
    for t in tracks:
        artist = t.get('artist')
        if not isinstance(artist, str):
            # No artist field — set contributingArtists to empty.
            new_ca = []
        elif artist in collab_to_split:
            new_ca = collab_to_split[artist]
            multi_count += 1
            if len(sample_multi) < 6:
                sample_multi.append((artist, new_ca))
        else:
            new_ca = [artist]
            sole_count += 1
        existing_ca = t.get('contributingArtists')
        if existing_ca == new_ca:
            unchanged_count += 1
        t['contributingArtists'] = new_ca

    print(f'contributingArtists populated:')
    print(f'  multi-artist (collab):     {multi_count}')
    print(f'  sole-artist:               {sole_count}')
    print(f'  unchanged from existing:   {unchanged_count}')
    print(f'Sample multi-artist:')
    for artist, ca in sample_multi:
        print(f'  {artist!r:42} -> {ca}')

    # ── Gate 4: backup ─────────────────────────────────────────────────
    timestamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup_path = f'{LIBRARY}.bak-{timestamp}'
    with open(backup_path, 'wb') as f:
        f.write(raw_before)
    with open(backup_path, 'rb') as f:
        backup_raw = f.read()
    backup_hash = hashlib.sha256(backup_raw).hexdigest()
    if backup_hash != live_hash:
        return fail(
            f'Backup verification FAILED.\n'
            f'  original hash: {live_hash}\n'
            f'  backup hash:   {backup_hash}\n'
            f'  backup path:   {backup_path}'
        )
    print(f'[Gate 4] backup verified: ✓ {backup_path}')

    # ── Atomic write ───────────────────────────────────────────────────
    partial_path = f'{LIBRARY}.partial'
    with open(partial_path, 'w', encoding='utf-8') as f:
        json.dump(lib, f, indent=2, ensure_ascii=False)
    os.rename(partial_path, LIBRARY)

    print()
    print(f'=== Phase 4 (data) complete ===')
    print(f'  {multi_count} tracks now have multi-artist contributingArtists')
    print(f'  backup: {backup_path}')
    print()
    print('Next: indexer + renderer code changes (Phase 4b + 4c), build DMG, commit.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
