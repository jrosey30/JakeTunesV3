"""
Re-embed full metadata from library.json into every audio file's
embedded tags. Fixes the case where a re-encode (alac_compat_fix.py
or import/convert ALAC) lost track number, disc number, year, and
genre because the tag-writer call was missing those fields.

Default: only writes when the file lacks a track tag.
With --force: overwrites every file's tags from library.json,
guaranteeing consistent format across the whole library (so Navidrome
groups albums correctly — without --force, mixed legacy "track=2" and
re-tagged "track=2/13" formats split albums into multiple entries).
"""

import argparse
import json
import os
import subprocess
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
from tag_reader import read_tags  # noqa: E402

LIBRARY = os.path.expanduser('~/Library/Application Support/JakeTunes/library.json')
LOCAL   = os.path.expanduser('~/Music2/JakeTunesLibrary')


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--force', action='store_true',
                    help='overwrite tags on every file, even ones that already have them. '
                         'Use this to normalize tag format across the library so Navidrome '
                         'groups albums correctly (mixed legacy "track=N" and "track=N/total" '
                         'formats cause split albums).')
    ap.add_argument('--dry-run', action='store_true', help='count what would change without writing')
    args = ap.parse_args()

    with open(LIBRARY) as f:
        lib = json.load(f)
    tracks = lib.get('tracks', [])
    print(f'library tracks: {len(tracks)}  mode: {"FORCE rewrite" if args.force else "incremental"}')

    rewritten = 0
    skipped_unchanged = 0
    skipped_missing = 0
    failed = 0
    for i, t in enumerate(tracks, 1):
        rel = (t.get('path') or '').lstrip(':').replace(':', '/')
        if not rel:
            continue
        path = os.path.join(LOCAL, rel)
        if not os.path.isfile(path):
            skipped_missing += 1
            continue
        # Build the payload from library.json
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
        # In incremental mode, skip files that already have the right
        # track number — avoids touching files that were tagged
        # correctly originally. In --force mode, always rewrite, which
        # normalizes mixed legacy "track=2" + new "track=2/13" formats
        # so Navidrome groups albums consistently.
        if not args.force:
            try:
                r = subprocess.run(
                    ['ffprobe', '-v', 'error',
                     '-show_entries', 'format_tags=track,disc',
                     '-of', 'default=nw=1', path],
                    capture_output=True, timeout=10,
                )
                existing = r.stdout.decode().lower()
                has_track = 'track=' in existing and len(existing.split('track=')[1].split('\n')[0].strip()) > 0
                if has_track and not payload['trackNumber']:
                    skipped_unchanged += 1
                    continue
                if has_track and payload['trackNumber']:
                    tn_in_file = existing.split('track=')[1].split('\n')[0].strip().split('/')[0]
                    if tn_in_file == str(payload['trackNumber']):
                        skipped_unchanged += 1
                        continue
            except Exception:  # noqa: BLE001
                pass

        if args.dry_run:
            rewritten += 1
            continue

        # Pipe payload to tag_writer.py
        try:
            r = subprocess.run(
                ['python3', os.path.join(_HERE, 'tag_writer.py'), path],
                input=json.dumps(payload).encode(),
                capture_output=True, timeout=15,
            )
            if r.returncode != 0:
                failed += 1
                if failed < 5:
                    print(f'  FAIL #{t["id"]} {t["title"]}: {r.stderr.decode()[:120]}')
            else:
                rewritten += 1
        except Exception as e:  # noqa: BLE001
            failed += 1
            if failed < 5:
                print(f'  EXC  #{t["id"]} {t["title"]}: {e}')

        if i % 200 == 0:
            print(f'  …processed {i}/{len(tracks)}  rewritten={rewritten} skipped={skipped_unchanged} failed={failed}',
                  flush=True)

    print(f'\nDone.')
    print(f'  Rewrote tags:        {rewritten}')
    print(f'  Skipped (already ok): {skipped_unchanged}')
    print(f'  Skipped (missing):    {skipped_missing}')
    print(f'  Failed:              {failed}')


if __name__ == '__main__':
    main()
