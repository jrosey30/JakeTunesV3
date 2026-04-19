"""
Restore iPod iTunesDB metadata from an iTunes Library XML export.

The iPod's iTunesDB got garbled during a re-sync after a storage upgrade —
titles became filename-like (e.g. "01 Dancing Queen"), artist/album went
blank, and the tags in the audio files themselves are mostly stripped. The
XML (exported from iTunes before the mod) is the only clean source.

Matching strategy:
  - Primary key:    duration (iTunes 'Total Time' vs iPod mhit duration_ms)
  - Tolerance:      ±2 ms to absorb rounding
  - Disambiguation: when several XML tracks share a duration, narrow by iPod's
                    surviving artist, then album, then (for corrupt titles
                    prefixed with a track number) the XML track number.

Modes:
  --scan <ipod_mount> <xml_path>    Print JSON diff (used by the Electron app)
  --preview <ipod_mount> <xml_path> Print a human-readable summary of what
                                     would change — same data as --scan, just
                                     formatted for a terminal
  --apply <ipod_mount> <xml_path>   Read {"approvedIds": [...]} from stdin,
                                     back up iTunesDB, write corrected DB.
"""
import json
import os
import re
import shutil
import struct
import sys
from collections import defaultdict
from datetime import datetime
from urllib.parse import unquote

import plistlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import db_reader


DURATION_TOLERANCE_MS = 2
CORRUPT_PREFIX_RE = re.compile(r'^\d{1,2}\s')

STRING_FIELDS = ['title', 'artist', 'album', 'albumArtist', 'genre']
NUMERIC_FIELDS = ['year', 'trackNumber', 'trackCount', 'discNumber', 'discCount']
ALL_FIELDS = STRING_FIELDS + NUMERIC_FIELDS

XML_FIELD_MAP = {
    'title': 'Name',
    'artist': 'Artist',
    'album': 'Album',
    'albumArtist': 'Album Artist',
    'genre': 'Genre',
    'year': 'Year',
    'trackNumber': 'Track Number',
    'trackCount': 'Track Count',
    'discNumber': 'Disc Number',
    'discCount': 'Disc Count',
}


def _xml_to_track_dict(xml_entry):
    """Extract just the fields we care about from an iTunes XML track entry."""
    out = {}
    for our_key, xml_key in XML_FIELD_MAP.items():
        v = xml_entry.get(xml_key)
        if v is None:
            out[our_key] = '' if our_key in STRING_FIELDS else 0
        else:
            out[our_key] = str(v).strip() if our_key in STRING_FIELDS else int(v)
    return out


def _detect_duration_unit_divisor(xml_tracks):
    """iTunes's XML spec says Total Time is in milliseconds, but JakeTunes's
    own export writes microseconds (1000x larger). Detect which by taking the
    median duration: a typical song is a few minutes, so the median in ms
    should land in the 100k–500k range. If the median is much larger, the
    values are in microseconds and need dividing by 1000.
    """
    durs = sorted(tr['Total Time'] for tr in xml_tracks if tr.get('Total Time'))
    if not durs:
        return 1
    median = durs[len(durs) // 2]
    # 10 minutes in ms = 600,000. Anything bigger is suspicious.
    return 1000 if median > 10_000_000 else 1


def _build_duration_index(xml_tracks):
    """Map duration-in-ms -> list of XML entries, auto-handling µs XMLs."""
    divisor = _detect_duration_unit_divisor(xml_tracks)
    by_dur = defaultdict(list)
    for tr in xml_tracks:
        dur = tr.get('Total Time')
        if dur:
            by_dur[dur // divisor].append(tr)
    return by_dur


def _match_one(ipod_track, by_dur):
    """Return (xml_entry, method) or (None, None)."""
    dur = ipod_track.get('duration', 0)
    if not dur:
        return None, None

    # Exact, then within ±tolerance
    hits = by_dur.get(dur, [])
    if not hits:
        for d in range(-DURATION_TOLERANCE_MS, DURATION_TOLERANCE_MS + 1):
            if d == 0:
                continue
            hits = by_dur.get(dur + d, [])
            if hits:
                break
    if not hits:
        return None, None
    if len(hits) == 1:
        return hits[0], 'duration'

    ia = (ipod_track.get('artist') or '').strip().lower()
    ial = (ipod_track.get('album') or '').strip().lower()

    if ia:
        by_artist = [h for h in hits if (h.get('Artist') or '').strip().lower() == ia]
        if len(by_artist) == 1:
            return by_artist[0], 'duration+artist'
        if len(by_artist) > 1 and ial:
            by_album = [h for h in by_artist if (h.get('Album') or '').strip().lower() == ial]
            if len(by_album) == 1:
                return by_album[0], 'duration+album'

    # Corrupt titles carry a leading track number — use that to narrow
    title = ipod_track.get('title') or ''
    m = re.match(r'^(\d{1,2})\s', title)
    if m:
        try:
            tn = int(m.group(1))
            narrow = [h for h in hits if h.get('Track Number') == tn]
            if len(narrow) == 1:
                return narrow[0], 'duration+track#'
        except ValueError:
            pass

    return None, 'ambiguous'


def _field_differs(old_v, new_v):
    ov = '' if old_v in (None, 0) else str(old_v).strip()
    nv = '' if new_v in (None, 0) else str(new_v).strip()
    return ov != nv


def _read_play_counts(db_path):
    """Map dbid -> playCount from existing iTunesDB mhit headers."""
    with open(db_path, 'rb') as fh:
        data = fh.read()
    result = {}
    pos = data.find(b'mhit')
    while pos != -1 and pos < len(data) - 4:
        if data[pos:pos + 4] != b'mhit':
            break
        header_len = struct.unpack_from('<I', data, pos + 4)[0]
        total_len = struct.unpack_from('<I', data, pos + 8)[0]
        dbid = struct.unpack_from('<I', data, pos + 0x10)[0] if header_len >= 20 else 0
        pc = struct.unpack_from('<I', data, pos + 0x50)[0] if header_len >= 84 else 0
        if dbid:
            result[dbid] = pc
        nxt = data.find(b'mhit', pos + total_len)
        pos = nxt if nxt != -1 else -1
    return result


def scan(ipod_mount, xml_path):
    db_path = os.path.join(ipod_mount, 'iPod_Control', 'iTunes', 'iTunesDB')
    tracks = db_reader.parse_tracks(db_path)

    with open(xml_path, 'rb') as fh:
        plist = plistlib.load(fh)
    xml_tracks = list(plist.get('Tracks', {}).values())
    by_dur = _build_duration_index(xml_tracks)

    diffs = []
    unmatched = []
    ambiguous = []
    unchanged = 0

    for t in tracks:
        xml_entry, method = _match_one(t, by_dur)
        if xml_entry is None and method == 'ambiguous':
            ambiguous.append({
                'id': t['id'],
                'dbid': t.get('dbid', 0),
                'path': t.get('path', ''),
                'duration': t.get('duration', 0),
                'currentTitle': t.get('title', ''),
                'currentArtist': t.get('artist', ''),
                'currentAlbum': t.get('album', ''),
            })
            continue
        if xml_entry is None:
            unmatched.append({
                'id': t['id'],
                'dbid': t.get('dbid', 0),
                'path': t.get('path', ''),
                'duration': t.get('duration', 0),
                'currentTitle': t.get('title', ''),
                'currentArtist': t.get('artist', ''),
                'currentAlbum': t.get('album', ''),
            })
            continue

        new = _xml_to_track_dict(xml_entry)
        changed_fields = [f for f in ALL_FIELDS if _field_differs(t.get(f, ''), new.get(f, ''))]
        if not changed_fields:
            unchanged += 1
            continue

        group_artist = new.get('albumArtist') or new.get('artist') or t.get('artist') or '(unknown artist)'
        group_album = new.get('album') or t.get('album') or '(unknown album)'

        diffs.append({
            'id': t['id'],
            'dbid': t.get('dbid', 0),
            'path': t.get('path', ''),
            'xmlPersistentId': xml_entry.get('Persistent ID', ''),
            'xmlTrackId': xml_entry.get('Track ID', 0),
            'matchMethod': method,
            'old': {f: t.get(f, '') for f in ALL_FIELDS},
            'new': new,
            'changed': changed_fields,
            'groupKey': f"{group_artist}|||{group_album}",
            'groupAlbum': group_album,
            'groupArtist': group_artist,
        })

    return {
        'ipodMount': ipod_mount,
        'xmlPath': xml_path,
        'total': len(tracks),
        'changed': len(diffs),
        'unchanged': unchanged,
        'unmatched': unmatched,
        'ambiguous': ambiguous,
        'diffs': diffs,
    }


def apply(ipod_mount, xml_path, approved_ids):
    db_path = os.path.join(ipod_mount, 'iPod_Control', 'iTunes', 'iTunesDB')

    # Point db_reader's helpers at the right iPod
    db_reader.IPOD_PATH = db_path
    db_reader.IPOD_MOUNT = ipod_mount

    tracks = db_reader.parse_tracks(db_path)

    # Preserve play counts from existing DB — iPod is more current than XML
    play_counts = _read_play_counts(db_path)

    with open(xml_path, 'rb') as fh:
        plist = plistlib.load(fh)
    xml_tracks = list(plist.get('Tracks', {}).values())
    by_dur = _build_duration_index(xml_tracks)

    approved = set(int(i) for i in approved_ids)
    restored = 0
    skipped_no_match = 0

    for t in tracks:
        if t['id'] not in approved:
            continue
        xml_entry, method = _match_one(t, by_dur)
        if xml_entry is None:
            skipped_no_match += 1
            continue
        new = _xml_to_track_dict(xml_entry)
        for field in ALL_FIELDS:
            v = new.get(field)
            if v or v == 0:
                t[field] = v
        restored += 1

    # Enrich the rest from XML too (picks up dateAdded, rating, albumArtist
    # for tracks we didn't explicitly restore but whose titles might now match)
    tracks = db_reader.enrich_tracks(tracks)
    tracks = db_reader.add_file_sizes(tracks)

    # Play counts: preserve iPod-side (more recent than XML)
    for t in tracks:
        pc = play_counts.get(t.get('dbid', 0), 0)
        if pc:
            t['playCount'] = pc

    playlists = db_reader.parse_playlists(db_path, tracks)

    stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
    backup = db_path + '.bak-' + stamp
    shutil.copy2(db_path, backup)

    count = db_reader.write_itunesdb(tracks, playlists, db_path, db_path)

    return {
        'ok': True,
        'backup': backup,
        'tracksApproved': len(approved),
        'tracksRestored': restored,
        'tracksSkipped': skipped_no_match,
        'tracksWritten': count,
    }


def _print_preview(result):
    """Human-readable summary of scan results, for terminal use."""
    print(f"iPod:  {result['ipodMount']}")
    print(f"XML:   {result['xmlPath']}")
    print()
    print(f"Total tracks:       {result['total']}")
    print(f"  Will change:      {result['changed']}")
    print(f"  Already correct:  {result['unchanged']}")
    print(f"  Unmatched (skip): {len(result['unmatched'])}")
    print(f"  Ambiguous (skip): {len(result['ambiguous'])}")

    # Field histogram
    field_counts = {}
    for d in result['diffs']:
        for f in d['changed']:
            field_counts[f] = field_counts.get(f, 0) + 1
    if field_counts:
        print()
        print("Changes by field:")
        for f in sorted(field_counts, key=lambda k: -field_counts[k]):
            print(f"  {f:<14} {field_counts[f]}")

    # Group diffs by album, show first 15 groups with sample changes
    from collections import defaultdict
    by_group = defaultdict(list)
    for d in result['diffs']:
        by_group[d['groupKey']].append(d)
    groups = sorted(by_group.items(), key=lambda kv: (kv[1][0]['groupArtist'].lower(), kv[1][0]['groupAlbum'].lower()))

    print()
    print(f"Sample changes (first 15 of {len(groups)} albums):")
    for _, diffs in groups[:15]:
        d0 = diffs[0]
        print(f"  {d0['groupArtist']} — {d0['groupAlbum']}  ({len(diffs)} track{'s' if len(diffs) != 1 else ''})")
        for d in diffs[:2]:
            parts = []
            for f in d['changed']:
                old = d['old'][f]
                new = d['new'][f]
                old_s = f"'{old}'" if isinstance(old, str) else str(old)
                new_s = f"'{new}'" if isinstance(new, str) else str(new)
                if len(old_s) > 40: old_s = old_s[:37] + "...'"
                if len(new_s) > 40: new_s = new_s[:37] + "...'"
                parts.append(f"{f}: {old_s} → {new_s}")
            print(f"      · {'; '.join(parts)}")
        if len(diffs) > 2:
            print(f"      · ... and {len(diffs) - 2} more")

    # Flagged tracks
    flagged = result['ambiguous'] + result['unmatched']
    if flagged:
        print()
        print(f"Flagged tracks ({len(flagged)} — will NOT be changed):")
        for t in result['ambiguous'][:10]:
            title = t['currentTitle'] or '(no title)'
            artist = f" — {t['currentArtist']}" if t['currentArtist'] else ''
            print(f"  [ambiguous] {title}{artist}")
        for t in result['unmatched'][:10]:
            title = t['currentTitle'] or '(no title)'
            artist = f" — {t['currentArtist']}" if t['currentArtist'] else ''
            print(f"  [unmatched] {title}{artist}")
        remaining = len(flagged) - min(10, len(result['ambiguous'])) - min(10, len(result['unmatched']))
        if remaining > 0:
            print(f"  ... and {remaining} more")


if __name__ == '__main__':
    if len(sys.argv) < 4:
        print('Usage: restore_from_xml.py --scan|--preview|--apply <ipod_mount> <xml_path>', file=sys.stderr)
        sys.exit(1)

    mode = sys.argv[1]
    ipod_mount = sys.argv[2]
    xml_path = sys.argv[3]

    if not os.path.isdir(ipod_mount):
        print(f'iPod mount not found: {ipod_mount}', file=sys.stderr)
        sys.exit(1)
    if not os.path.isfile(xml_path):
        print(f'XML file not found: {xml_path}', file=sys.stderr)
        sys.exit(1)

    if mode == '--scan':
        json.dump(scan(ipod_mount, xml_path), sys.stdout, ensure_ascii=False)
    elif mode == '--preview':
        _print_preview(scan(ipod_mount, xml_path))
    elif mode == '--apply':
        payload = json.load(sys.stdin)
        out = apply(ipod_mount, xml_path, payload.get('approvedIds', []))
        json.dump(out, sys.stdout, ensure_ascii=False)
    else:
        print(f'Unknown mode: {mode}', file=sys.stderr)
        sys.exit(1)
