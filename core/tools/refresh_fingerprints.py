#!/usr/bin/env python3
"""
One-shot library migration: walk every track in library.json, recompute
its audioFingerprint from the actual file on disk, and write the
results back. Used to unstick tracks that are missing fingerprints,
sharing a fingerprint with another track, or carrying a stale
fingerprint that no longer matches the file.

Why this matters (4.0): the iTunesDB writer derives each track's
64-bit persistent_dbid as SHA1(audioFingerprint | path)[:8]. If two
tracks have empty or identical audioFingerprints, they hash to the
same dbid, the iPod's browse cache de-duplicates them, and they
silently disappear from "Music > Songs". Reimporting unsticks them
because import recomputes the fingerprint — this tool reproduces
that effect on the whole library at once.

Algorithm matches main/index.ts::computeAudioFingerprint exactly:
  sha1(first 256KB of file)[:16] + '|' + round(duration_ms)

Usage:
    # Dry run — report only, don't write library.json
    python3 core/tools/refresh_fingerprints.py

    # Apply changes
    python3 core/tools/refresh_fingerprints.py --apply

Safety:
  - Always writes a timestamped backup of library.json before changes.
  - Never deletes or reorders tracks; only rewrites the
    audioFingerprint field.
  - Dry-run by default. --apply is required to mutate.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import time
from pathlib import Path

LIB = Path.home() / 'Library' / 'Application Support' / 'JakeTunes' / 'library.json'
IPOD_MOUNT_DEFAULT = '/Volumes/JAKETUNES'
LOCAL_MOUNT_DEFAULT = str(Path.home() / 'Music' / 'JakeTunesLibrary')
FP_BLOCK = 256 * 1024


def compute_fingerprint(abs_path: str, duration_ms: float) -> str | None:
    """Match main/index.ts::computeAudioFingerprint byte-for-byte."""
    try:
        with open(abs_path, 'rb') as f:
            buf = f.read(FP_BLOCK)
        if not buf:
            return None
        h = hashlib.sha1(buf).hexdigest()[:16]
        return f"sha1:{h}|{round(duration_ms or 0)}"
    except OSError:
        return None


def resolve_path(colon_path: str, mounts: list[str]) -> str | None:
    """colon → '/' path; return the first mount where the file exists."""
    if not colon_path:
        return None
    rel = colon_path.replace(':', '/').lstrip('/')
    for m in mounts:
        candidate = os.path.join(m, rel)
        if os.path.isfile(candidate):
            return candidate
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true',
                    help='Write the updated library.json (default: dry run).')
    ap.add_argument('--ipod-mount', default=IPOD_MOUNT_DEFAULT)
    ap.add_argument('--local-mount', default=LOCAL_MOUNT_DEFAULT)
    args = ap.parse_args()

    mounts = [args.ipod_mount, args.local_mount]
    print(f"library:      {LIB}")
    print(f"mounts:       {mounts}")
    print(f"mode:         {'APPLY' if args.apply else 'dry run'}")
    print()

    with open(LIB) as f:
        data = json.load(f)
    tracks = data.get('tracks', data) if isinstance(data, dict) else data
    is_wrapped = isinstance(data, dict)
    print(f"tracks:       {len(tracks):,}")

    # Pass 1: compute fresh fingerprints, classify each track.
    refreshed = 0          # had a fingerprint, recomputed value matches → no change
    backfilled = 0         # had NO fingerprint (or empty), filled in
    drifted = 0            # had a stored fp that doesn't match the file's actual fp
    unresolved = 0         # file not found on any known mount
    fp_after: dict[int, str | None] = {}

    fp_map: dict[str, list[int]] = {}  # fingerprint → list of track indexes (collision detect)
    for i, t in enumerate(tracks):
        path = t.get('path') or ''
        abs_path = resolve_path(path, mounts)
        if not abs_path:
            unresolved += 1
            fp_after[i] = t.get('audioFingerprint')
            continue
        live = compute_fingerprint(abs_path, t.get('duration', 0))
        stored = t.get('audioFingerprint') or ''
        fp_after[i] = live
        if live:
            fp_map.setdefault(live, []).append(i)
        if not stored and live:
            backfilled += 1
        elif stored and live and stored != live:
            drifted += 1
        elif stored and live and stored == live:
            refreshed += 1

    # Detect collisions in the FRESHLY computed fingerprints.
    collisions = {fp: ix for fp, ix in fp_map.items() if len(ix) > 1}

    print()
    print(f"fingerprint reconciliation:")
    print(f"  unchanged (stored matches file):       {refreshed:,}")
    print(f"  backfilled (no stored fingerprint):    {backfilled:,}")
    print(f"  drifted (stored ≠ file):               {drifted:,}")
    print(f"  unresolved (file not found):           {unresolved:,}")
    print(f"  fingerprint COLLISIONS in result set:  {len(collisions):,}")
    if collisions:
        print()
        print("Collision detail (these tracks WOULD STILL collide on dbid"
              " — usually a sign of identical files on disk):")
        for fp, idxs in list(collisions.items())[:10]:
            print(f"  {fp}")
            for ix in idxs[:5]:
                t = tracks[ix]
                print(f"    {t.get('title')!r}  by  {t.get('artist')!r}  ({t.get('path')})")

    if not args.apply:
        print()
        print("Dry run — re-run with --apply to write library.json.")
        return 0

    # Apply: write fresh fingerprints back into library.json.
    n_changed = 0
    for i, t in enumerate(tracks):
        new = fp_after.get(i)
        if new and t.get('audioFingerprint') != new:
            t['audioFingerprint'] = new
            n_changed += 1

    if n_changed == 0:
        print("\nNothing to write — library is already in sync with file fingerprints.")
        return 0

    # Backup BEFORE writing.
    ts = time.strftime('%Y%m%d-%H%M%S')
    backup = LIB.with_suffix(f'.json.{ts}.bak')
    shutil.copy2(LIB, backup)
    print(f"\nbacked up library.json → {backup}")

    if is_wrapped:
        data['tracks'] = tracks
        out = data
    else:
        out = tracks
    with open(LIB, 'w') as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
    print(f"wrote library.json: {n_changed:,} tracks updated")
    return 0


if __name__ == '__main__':
    sys.exit(main())
