"""
Fix compilation-album-split-by-year bug.

When a compilation (Greatest Hits, Best Of, multi-decade anthology) has
each track tagged with its original release year, Navidrome groups them
by (album_artist, album, year) and creates one separate "album" per
distinct year. ABBA Gold ends up split into 5+ "ABBA Gold" entries.

Fix: per dupe-album group (same album_artist + same album, multiple
years), normalize every track's year to the most common year in that
group. Then file tags will all match → Navidrome merges back into one
album.

Updates BOTH library.json AND the embedded file tags so the change
propagates everywhere.

Usage:
    python3 core/dedupe_compilation_years.py [--dry-run] [--apply]
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)

LIBRARY = os.path.expanduser('~/Library/Application Support/JakeTunes/library.json')
LOCAL   = os.path.expanduser('~/Music2/JakeTunesLibrary')


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true', help='actually rewrite tags + library.json')
    args = ap.parse_args()

    with open(LIBRARY) as f:
        lib = json.load(f)
    tracks = lib.get('tracks', [])

    # Group by (album_artist or artist, album)
    groups: dict[tuple, list[dict]] = defaultdict(list)
    for t in tracks:
        if not t.get('album'):
            continue
        artist = (t.get('albumArtist') or t.get('artist') or '').strip()
        album = (t.get('album') or '').strip()
        if not artist or not album:
            continue
        groups[(artist, album)].append(t)

    # Find groups where year varies across tracks
    year_split_groups = []
    for key, ts in groups.items():
        years = [str(t.get('year') or '') for t in ts if t.get('year')]
        if len(set(years)) > 1:
            year_split_groups.append((key, ts, Counter(years)))

    print(f'Total album groups: {len(groups)}')
    print(f'Groups split by year: {len(year_split_groups)}')

    if not year_split_groups:
        print('Nothing to fix.')
        return

    # For each group, decide the canonical year (most common — or earliest if tie)
    plan = []
    affected_track_count = 0
    for (artist, album), ts, year_counter in year_split_groups:
        # Most-common wins; on tie, the earliest year (more likely the compilation year for older comps)
        sorted_years = sorted(year_counter.items(), key=lambda kv: (-kv[1], int(kv[0]) if kv[0].isdigit() else 9999))
        canonical_year = sorted_years[0][0]
        # Find tracks needing change
        needs_update = [t for t in ts if str(t.get('year') or '') != canonical_year]
        if needs_update:
            plan.append({
                'artist': artist,
                'album': album,
                'canonical_year': canonical_year,
                'all_years': dict(year_counter),
                'tracks_to_update': needs_update,
            })
            affected_track_count += len(needs_update)

    print(f'Compilation album groups to dedup: {len(plan)}')
    print(f'Total tracks needing year normalization: {affected_track_count}')
    print()
    for p in plan[:10]:
        print(f'  {p["artist"]} — {p["album"]}: {p["all_years"]} → canonical={p["canonical_year"]}, updating {len(p["tracks_to_update"])} tracks')
    if len(plan) > 10:
        print(f'  …and {len(plan) - 10} more groups')
    print()

    if not args.apply:
        print('Dry run — pass --apply to write')
        return

    # Backup library.json
    ts = datetime.now().strftime('%Y%m%d-%H%M%S')
    shutil.copy(LIBRARY, f'{LIBRARY}.bak-yeardedup-{ts}')
    print(f'Library backup: {LIBRARY}.bak-yeardedup-{ts}')

    # Build set of (track_id, new_year) updates
    updates = {}  # track_id → year
    for p in plan:
        for t in p['tracks_to_update']:
            updates[t['id']] = p['canonical_year']

    # Apply to library.json
    for t in tracks:
        if t['id'] in updates:
            t['year'] = updates[t['id']]
    with open(LIBRARY, 'w') as f:
        json.dump(lib, f, indent=2, ensure_ascii=False)
    print(f'Updated library.json: {len(updates)} tracks')

    # Re-embed tags into the corresponding files
    print(f'\nRe-embedding tags into {len(updates)} files...')
    written = failed = 0
    for i, t in enumerate(tracks, 1):
        if t['id'] not in updates:
            continue
        rel = (t.get('path') or '').lstrip(':').replace(':', '/')
        path = os.path.join(LOCAL, rel)
        if not os.path.isfile(path):
            failed += 1
            continue
        payload = {
            'title':       str(t.get('title') or ''),
            'artist':      str(t.get('artist') or ''),
            'album':       str(t.get('album') or ''),
            'albumArtist': str(t.get('albumArtist') or ''),
            'genre':       str(t.get('genre') or ''),
            'year':        str(t.get('year') or '') if t.get('year') else '',
            'trackNumber': int(t.get('trackNumber') or 0),
            'trackCount':  int(t.get('trackCount') or 0),
            'discNumber':  int(t.get('discNumber') or 0),
            'discCount':   int(t.get('discCount') or 0),
        }
        try:
            r = subprocess.run(
                ['python3', os.path.join(_HERE, 'tag_writer.py'), path],
                input=json.dumps(payload).encode(),
                capture_output=True, timeout=15,
            )
            if r.returncode == 0:
                written += 1
            else:
                failed += 1
        except Exception:  # noqa: BLE001
            failed += 1
    print(f'Wrote {written} files, {failed} failed.')


if __name__ == '__main__':
    main()
