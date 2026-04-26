"""
Walk the local JakeTunes music mirror, find audio files that aren't
referenced by any library.json entry, then:

  • delete macOS metadata files (`._*`) — not real audio, just cruft
  • delete files with ZERO readable tags — we can't identify them, so
    re-adding them to the library would just create "Unknown" entries
  • delete files whose tags prove they're *wrong* content at the
    orphan path (e.g. a Pink Floyd file sitting where a Beatles entry
    used to live; sync would have matched the basename and played it
    back as a mystery song — exactly the bug we spent yesterday
    fixing)
  • KEEP files with real tags that don't conflict with existing
    library entries; add them back into library.json with their
    embedded title/artist/album metadata so they show up in the app

Usage:
    python3 core/reclaim_orphans.py             # dry run
    python3 core/reclaim_orphans.py --apply     # actually do it

Writes a backup of library.json before any apply.
"""

import argparse
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
from tag_reader import read_tags  # noqa: E402


DEFAULT_LIB = os.path.expanduser('~/Library/Application Support/JakeTunes/library.json')
DEFAULT_ROOT = os.path.expanduser('~/Music2/JakeTunesLibrary/iPod_Control/Music')
FALLBACK_ROOT = os.path.expanduser('~/Music/JakeTunesLibrary/iPod_Control/Music')


def colon_path(root: str, abs_path: str) -> str:
    """/Volumes/Foo/iPod_Control/Music/F12/X.m4a → :iPod_Control:Music:F12:X.m4a"""
    # Strip root back up to the iPod_Control segment.
    rel = abs_path
    for anchor in ('/iPod_Control/', '\\iPod_Control\\'):
        idx = abs_path.find(anchor)
        if idx >= 0:
            rel = abs_path[idx:]
            break
    return ':' + rel.lstrip('/\\').replace('/', ':').replace('\\', ':')


_PUNCT = re.compile(r"[\(\)\[\]\{\}\"',.\-!?:;#/\\]+")
_WS    = re.compile(r'\s+')
def norm(s: str) -> str:
    if not s:
        return ''
    s = _PUNCT.sub(' ', s)
    return _WS.sub(' ', s).strip().lower()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true',
                    help='actually modify disk + library (default is dry run)')
    ap.add_argument('--root', default=None)
    ap.add_argument('--library', default=DEFAULT_LIB)
    args = ap.parse_args()

    root = args.root or (DEFAULT_ROOT if os.path.isdir(DEFAULT_ROOT) else FALLBACK_ROOT)
    if not os.path.isdir(root):
        print(f'No music root found. Checked:\n  {DEFAULT_ROOT}\n  {FALLBACK_ROOT}', file=sys.stderr)
        sys.exit(2)
    print(f'root:    {root}')
    print(f'library: {args.library}')

    with open(args.library, 'r') as fh:
        lib = json.load(fh)
    tracks = lib.get('tracks', [])
    max_id = max((int(t.get('id') or 0) for t in tracks), default=0)
    lib_paths = {t.get('path', '') for t in tracks if t.get('path')}

    # Index library by (norm_title, norm_artist) so we can detect
    # "this orphan's tags are claimed by a DIFFERENT file in library"
    # — a strong signal it's junk content not worth re-adding.
    lib_by_key: dict[tuple, list[dict]] = {}
    for t in tracks:
        k = (norm(t.get('title') or ''), norm(t.get('artist') or ''))
        if k[0]:
            lib_by_key.setdefault(k, []).append(t)

    # Walk disk.
    on_disk = []
    for base, _dirs, files in os.walk(root):
        for fn in files:
            lo = fn.lower()
            if lo.endswith(('.m4a', '.mp3', '.alac', '.aac', '.flac', '.aif', '.aiff', '.wav')):
                on_disk.append(os.path.join(base, fn))

    print(f'on-disk audio files: {len(on_disk)}')
    print(f'library entries:     {len(tracks)}')

    to_delete: list[tuple[str, str]] = []   # (path, reason)
    to_add: list[dict] = []
    kept_as_is = 0
    for p in on_disk:
        cp = colon_path(root, p)
        if cp in lib_paths:
            continue

        fn = os.path.basename(p)
        if fn.startswith('._'):
            to_delete.append((p, 'macOS resource-fork metadata'))
            continue

        tags = read_tags(p)
        if not tags.get('ok'):
            to_delete.append((p, f'unreadable: {tags.get("error","?")}'))
            continue

        title  = (tags.get('title')  or '').strip()
        artist = (tags.get('artist') or '').strip()
        album  = (tags.get('album')  or '').strip()

        if not title and not artist:
            to_delete.append((p, 'no tags (unidentifiable)'))
            continue

        k = (norm(title), norm(artist))
        if k in lib_by_key and k[0]:
            # Another library entry already claims this title+artist.
            # Check whether this orphan's duration matches the claimant.
            claimants = lib_by_key[k]
            our_dur = int(tags.get('duration_ms') or 0)
            close = any(abs((c.get('duration') or 0) - our_dur) <= 2000 for c in claimants)
            if close:
                # Library already has this song at a different path.
                # Dropping the orphan avoids creating a duplicate that
                # the pre-sync check would then block.
                to_delete.append((p, f'duplicate of library entry #{claimants[0]["id"]} ({title}/{artist})'))
                continue
            # Title/artist collision but durations differ → probably a
            # live/alt version. Safe to add as a separate entry.

        # Reclaim: build a library entry from the embedded tags.
        max_id += 1
        file_size = 0
        try:
            file_size = os.path.getsize(p)
        except OSError:
            pass
        year = ''
        try:
            # mutagen exposes date as YYYY or YYYY-MM-DD — grab the year
            # if anything is there.
            raw_year = tags.get('year') or ''
            if raw_year:
                year = str(raw_year)[:4]
        except Exception:  # noqa: BLE001
            pass
        to_add.append({
            'id': max_id,
            'title': title or os.path.splitext(fn)[0],
            'artist': artist or 'Unknown Artist',
            'albumArtist': tags.get('albumartist') or '',
            'album': album or 'Unknown Album',
            'genre': '',
            'year': year,
            'duration': int(tags.get('duration_ms') or 0),
            'trackNumber': 0, 'trackCount': 0,
            'discNumber': 0, 'discCount': 0,
            'playCount': 0,
            'dateAdded': datetime.now().strftime('%Y-%m-%d'),
            'fileSize': file_size,
            'rating': 0,
            'path': cp,
        })
        kept_as_is += 1

    print()
    print('=== ORPHAN RECLAMATION PLAN ===')
    print(f'  will ADD to library:    {len(to_add)}')
    print(f'  will DELETE from disk:  {len(to_delete)}')
    # Categorize deletes by reason for the summary
    from collections import Counter
    reasons = Counter(r for _, r in to_delete)
    for reason, n in reasons.most_common():
        print(f'    • {n:4d}  {reason}')

    if to_add[:15]:
        print()
        print('First 15 reclaimed tracks:')
        for t in to_add[:15]:
            print(f'  #{t["id"]}  {t["title"][:40]:40} / {t["artist"][:25]:25}')
    if to_delete[:10]:
        print()
        print('First 10 deletions:')
        for p, r in to_delete[:10]:
            print(f'  {os.path.basename(p)}  →  {r}')

    if not args.apply:
        print()
        print('Dry run only — re-run with --apply to execute.')
        return

    if not to_add and not to_delete:
        print('Nothing to do.')
        return

    # Backup library before modifying.
    if to_add:
        ts = datetime.now().strftime('%Y%m%d-%H%M%S')
        bak = f'{args.library}.bak-reclaim-{ts}'
        Path(bak).write_bytes(Path(args.library).read_bytes())
        print(f'Library backup: {bak}')
        lib['tracks'] = tracks + to_add
        with open(args.library, 'w') as fh:
            json.dump(lib, fh, indent=2, ensure_ascii=False)
        print(f'Added {len(to_add)} entries. Library now has {len(lib["tracks"])} tracks.')

    deleted = 0
    for p, _r in to_delete:
        try:
            os.unlink(p)
            deleted += 1
        except OSError as e:
            print(f'  could not delete {p}: {e}')
    print(f'Deleted {deleted}/{len(to_delete)} orphan files from disk.')


if __name__ == '__main__':
    main()
