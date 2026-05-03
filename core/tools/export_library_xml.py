#!/usr/bin/env python3
"""
Export JakeTunes library.json as an iTunes-compatible Library.xml,
plus a cross-reference CSV showing which library tracks are present
on the mounted iPod and which aren't.

Outputs (Desktop by default):
  • JakeTunes Library.xml — Apple plist format, openable in iTunes /
    Music.app, parseable by anything that understands the iTunes
    Library schema.
  • JakeTunes Cross-Reference.csv — one row per library track with
    columns: id, title, artist, album, path, audioFingerprint,
    on_ipod (TRUE/FALSE), notes. Open in Numbers / Excel.

Usage:
    python3 core/tools/export_library_xml.py
    python3 core/tools/export_library_xml.py --out ~/Desktop

The cross-reference column requires the iPod to be mounted at
/Volumes/JAKETUNES (or pass --ipod-mount). If it's not mounted we
still produce both files; the on_ipod column will say UNKNOWN.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import plistlib
import sys
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

LIB = Path.home() / 'Library' / 'Application Support' / 'JakeTunes' / 'library.json'
DEFAULT_OUT = Path.home() / 'Desktop'
DEFAULT_IPOD = '/Volumes/JAKETUNES'


def mac_to_dt(epoch_ms_or_str) -> datetime | None:
    """Best-effort coerce JakeTunes' dateAdded (ISO string) to datetime."""
    if not epoch_ms_or_str:
        return None
    try:
        # ISO-8601 string (most common)
        return datetime.fromisoformat(str(epoch_ms_or_str).replace('Z', '+00:00'))
    except (TypeError, ValueError):
        try:
            # epoch ms
            return datetime.fromtimestamp(int(epoch_ms_or_str) / 1000, tz=timezone.utc)
        except (TypeError, ValueError):
            return None


def colon_path_to_file_url(colon: str, ipod_mount: str) -> str:
    """`:iPod_Control:Music:F00:foo.mp3` → `file:///Volumes/JAKETUNES/iPod_Control/Music/F00/foo.mp3`"""
    if not colon:
        return ''
    rel = colon.replace(':', '/').lstrip('/')
    abs_path = os.path.join(ipod_mount, rel)
    return 'file://' + urllib.parse.quote(abs_path)


def build_track_dict(t: dict, ipod_mount: str) -> dict:
    """Render one library.json track as an iTunes Library.xml track entry."""
    d: dict = {}
    d['Track ID'] = int(t.get('id', 0))
    # iTunes persistent ID is a 16-char uppercase hex string. Reuse the
    # 64-bit dbid we'd derive at sync time so this XML's identity
    # matches what would land on the iPod.
    fp = (t.get('audioFingerprint') or '') + '|' + (t.get('path') or '')
    import hashlib
    pid_int = int.from_bytes(hashlib.sha1(fp.encode('utf-8')).digest()[:8], 'big')
    pid_int |= 0x8000000000000000
    d['Persistent ID'] = f'{pid_int:016X}'
    d['Track Type'] = 'File'

    if t.get('title'):       d['Name']         = str(t['title'])
    if t.get('artist'):      d['Artist']       = str(t['artist'])
    if t.get('albumArtist'): d['Album Artist'] = str(t['albumArtist'])
    if t.get('album'):       d['Album']        = str(t['album'])
    if t.get('genre'):       d['Genre']        = str(t['genre'])

    def maybe_int(v):
        try: return int(v) if v not in (None, '') else None
        except (TypeError, ValueError): return None

    yr = maybe_int(t.get('year'))
    if yr: d['Year'] = yr
    tn = maybe_int(t.get('trackNumber'))
    if tn: d['Track Number'] = tn
    tc = maybe_int(t.get('trackCount'))
    if tc: d['Track Count'] = tc
    dn = maybe_int(t.get('discNumber'))
    if dn: d['Disc Number'] = dn
    dc = maybe_int(t.get('discCount'))
    if dc: d['Disc Count'] = dc

    dur = maybe_int(t.get('duration'))
    if dur: d['Total Time'] = dur

    pc = maybe_int(t.get('playCount'))
    if pc: d['Play Count'] = pc

    rating = maybe_int(t.get('rating'))
    if rating: d['Rating'] = rating * 20  # JakeTunes 0-5 → iTunes 0-100

    fs = maybe_int(t.get('fileSize'))
    if fs: d['Size'] = fs

    da = mac_to_dt(t.get('dateAdded'))
    if da: d['Date Added'] = da

    d['Location'] = colon_path_to_file_url(t.get('path', ''), ipod_mount)
    return d


def write_itunes_xml(tracks: list[dict], playlists: list[dict], out_path: Path,
                     ipod_mount: str) -> None:
    track_entries = {}
    for t in tracks:
        td = build_track_dict(t, ipod_mount)
        track_entries[str(td['Track ID'])] = td

    pl_entries = []
    for p in playlists:
        pl = {
            'Name': str(p.get('name', '')),
            'Playlist ID': abs(hash(p.get('name', ''))) & 0x7fffffff,
            'All Items': True,
            'Playlist Items': [{'Track ID': int(tid)} for tid in p.get('trackIds', [])],
        }
        pl_entries.append(pl)

    plist = {
        'Major Version': 1,
        'Minor Version': 1,
        'Date': datetime.now(timezone.utc),
        'Application Version': '4.0.5',
        'Features': 5,
        'Show Content Ratings': True,
        'Library Persistent ID': '0000000000000000',
        'Tracks': track_entries,
        'Playlists': pl_entries,
    }
    with open(out_path, 'wb') as f:
        plistlib.dump(plist, f, fmt=plistlib.FMT_XML)


def write_cross_reference(tracks: list[dict], on_ipod: dict[str, bool] | None,
                          out_path: Path) -> None:
    with open(out_path, 'w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(['id', 'title', 'artist', 'album', 'path',
                    'audioFingerprint', 'on_ipod', 'notes'])
        for t in tracks:
            path = t.get('path', '') or ''
            present = 'UNKNOWN'
            notes = ''
            if on_ipod is not None:
                if path in on_ipod:
                    present = 'TRUE'
                else:
                    present = 'FALSE'
                    if t.get('audioMissing'):
                        notes = 'audioMissing flag set'
                    elif not t.get('audioFingerprint'):
                        notes = 'no audioFingerprint stored'
            w.writerow([
                t.get('id', ''),
                t.get('title', ''),
                t.get('artist', ''),
                t.get('album', ''),
                path,
                t.get('audioFingerprint', ''),
                present,
                notes,
            ])


def parse_ipod_paths(ipod_mount: str) -> dict[str, bool] | None:
    """Parse the iPod iTunesDB and return {colon_path: True} for every
    track found. Returns None if iPod isn't mounted."""
    db = Path(ipod_mount) / 'iPod_Control' / 'iTunes' / 'iTunesDB'
    if not db.is_file():
        return None
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from db_reader import parse_tracks  # type: ignore
    out: dict[str, bool] = {}
    for t in parse_tracks(str(db)):
        p = (t.get('path') or '').strip()
        if p:
            out[p] = True
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=str(DEFAULT_OUT),
                    help='Output directory (default: ~/Desktop)')
    ap.add_argument('--ipod-mount', default=DEFAULT_IPOD)
    args = ap.parse_args()

    out_dir = Path(args.out).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)

    with open(LIB) as f:
        data = json.load(f)
    tracks = data.get('tracks', data) if isinstance(data, dict) else data
    playlists = data.get('playlists', []) if isinstance(data, dict) else []
    print(f"library: {len(tracks)} tracks, {len(playlists)} playlists")

    on_ipod = parse_ipod_paths(args.ipod_mount)
    if on_ipod is None:
        print(f"iPod not mounted at {args.ipod_mount} — cross-reference column will be UNKNOWN")
    else:
        print(f"iPod mounted: {len(on_ipod)} tracks parsed from iTunesDB")

    xml_path = out_dir / 'JakeTunes Library.xml'
    csv_path = out_dir / 'JakeTunes Cross-Reference.csv'
    write_itunes_xml(tracks, playlists, xml_path, args.ipod_mount)
    write_cross_reference(tracks, on_ipod, csv_path)
    print(f"wrote: {xml_path}")
    print(f"wrote: {csv_path}")

    if on_ipod is not None:
        missing = [t for t in tracks if (t.get('path') or '') not in on_ipod]
        print()
        print(f"== {len(missing)} library tracks NOT on iPod ==")
        for t in missing[:20]:
            print(f"  '{t.get('title')}' by '{t.get('artist')}' — {t.get('path')}")
        if len(missing) > 20:
            print(f"  ... and {len(missing) - 20} more (see CSV for full list)")
    return 0


if __name__ == '__main__':
    sys.exit(main())
