"""
Audit the JakeTunes play-cache: for each cached AAC transcode, compare
its duration to the source ALAC file. If the cache is shorter (by more
than 2s), the transcode was truncated — probably because the prewarm
process was killed mid-write. Delete the truncated cache so the app
regenerates a clean copy on next play (or run prewarm_play_cache.py
again afterward to batch-regenerate).

Usage: python3 core/audit_play_cache.py [--apply]
"""

import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path


PLAY_CACHE = os.path.expanduser('~/Library/Application Support/JakeTunes/play-cache')
LIBRARY    = os.path.expanduser('~/Library/Application Support/JakeTunes/library.json')
LOCAL_ROOT = os.path.expanduser('~/Music2/JakeTunesLibrary')


def ffprobe_duration(path: str) -> float:
    try:
        r = subprocess.run(
            ['ffprobe', '-v', 'error',
             '-show_entries', 'format=duration',
             '-of', 'default=nw=1:nk=1', path],
            capture_output=True, timeout=15,
        )
        return float(r.stdout.decode().strip() or '0')
    except Exception:  # noqa: BLE001
        return 0.0


def cache_path_for(src: str) -> str:
    h = hashlib.sha1(src.encode()).hexdigest()[:16]
    return os.path.join(PLAY_CACHE, f'{h}.m4a')


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true',
                    help='delete truncated cache entries (default: dry run)')
    args = ap.parse_args()

    with open(LIBRARY) as fh:
        lib = json.load(fh)
    tracks = lib.get('tracks', [])

    # Build source path → expected duration from library
    expected = {}
    for t in tracks:
        colon = t.get('path', '') or ''
        if not colon:
            continue
        rel = colon.lstrip(':').replace(':', '/')
        abs_p = os.path.join(LOCAL_ROOT, rel)
        expected[abs_p] = (t.get('duration') or 0) / 1000.0  # ms → s

    cached_files = [f for f in os.listdir(PLAY_CACHE) if f.endswith('.m4a')]
    print(f'cache entries: {len(cached_files)}')
    print(f'library tracks: {len(tracks)}')

    # For each source path in the library, check if cache is truncated
    truncated = []
    orphaned = []  # cache entry with no matching source (just noise)
    cache_src_pairs: list[tuple[str, str, float, float]] = []   # (src, cache_path, src_dur, cache_dur)
    # Reverse map from cache filename → source path requires hashing every
    # source ... do it lazily by first building source→cache for library items.
    src_to_cache = {src: cache_path_for(src) for src in expected}
    for src, cache in src_to_cache.items():
        if not os.path.isfile(cache):
            continue
        src_dur = expected[src]
        cache_dur = ffprobe_duration(cache)
        if src_dur > 0 and cache_dur < src_dur - 2.0:  # truncated
            truncated.append((src, cache, src_dur, cache_dur))

    print(f'\nTruncated cache entries: {len(truncated)}')
    for src, cache, sd, cd in truncated[:15]:
        print(f'  {os.path.basename(src)}  src={sd:.1f}s  cache={cd:.1f}s  → {os.path.basename(cache)}')
    if len(truncated) > 15:
        print(f'  …and {len(truncated) - 15} more')

    if not args.apply:
        print('\nDry run — re-run with --apply to delete truncated cache files.')
        return

    deleted = 0
    for _src, cache, _sd, _cd in truncated:
        try:
            os.unlink(cache)
            deleted += 1
        except OSError as e:
            print(f'  could not delete {cache}: {e}')
    print(f'\nDeleted {deleted}/{len(truncated)} truncated cache files.')
    print('Re-run prewarm_play_cache.py to regenerate them cleanly.')


if __name__ == '__main__':
    main()
