"""Read-only audit of an iPod iTunesDB to diagnose count mismatches
between JakeTunes' library, the iTunesDB on disk, and what the iPod
firmware actually plays.

Used during the 2026-04-26 investigation of a 4546-vs-4396 song-count
gap. Confirmed the iTunesDB itself is internally consistent at all
levels — if you're seeing the iPod report a different count from this
audit, the issue is in the firmware's runtime cache, not the database.

Usage:
  python3 ipod_db_audit.py /Volumes/<iPod-name>

Reports:
  1. mhit count (total tracks in DB)
  2. Master playlist item_count + actual mhip count + all sort index sizes
  3. Codec marker distribution at 0x18
  4. Disk-existence check for every track's file
  5. Visibility and mediaKind flag distributions
  6. Integrity flaws (empty title/path, zero duration/filesize, duplicate dbids)
  7. Duration bucket distribution (<30s, 30-60s, 1-10min, >=10min)
  8. Per-offset bimodal scan looking for fields that discriminate ~150 tracks

If everything reads as uniform/consistent and the iPod still shows a
different count, the next step is empirical: try to play specific
tracks from the suspected-missing set on the iPod, or eject/replug to
force a runtime cache rebuild.
"""
import collections
import os
import struct
import sys


def read_utf16(data, offset, length):
    return data[offset:offset+length].decode('utf-16-le', errors='replace')


def parse_tracks(data):
    """Yield per-track dicts with {pos, header_len, total_len, title, artist,
    path, duration_ms, dbid, file_size, visible, codec, media_kind}."""
    pos = data.find(b'mhit')
    while pos != -1:
        if pos + 0x44 > len(data) or data[pos:pos+4] != b'mhit':
            return
        header_len = struct.unpack_from('<I', data, pos + 4)[0]
        total_len = struct.unpack_from('<I', data, pos + 8)[0]
        if total_len <= 0:
            return
        info = {
            'pos': pos,
            'header_len': header_len,
            'total_len': total_len,
            'dbid': struct.unpack_from('<I', data, pos + 0x10)[0],
            'visible': struct.unpack_from('<I', data, pos + 0x14)[0],
            'codec': bytes(data[pos + 0x18:pos + 0x1C]),
            'codec_subtype': struct.unpack_from('<I', data, pos + 0x1C)[0],
            'file_size': struct.unpack_from('<I', data, pos + 0x24)[0],
            'duration_ms': struct.unpack_from('<I', data, pos + 0x28)[0],
            'media_kind': struct.unpack_from('<I', data, pos + 0x40)[0] if header_len >= 0x44 else 0,
            'title': '', 'artist': '', 'path': '',
        }
        cp = pos + header_len
        end = pos + total_len
        while cp < end - 4:
            if data[cp:cp+4] == b'mhod':
                mhod_total = struct.unpack_from('<I', data, cp + 8)[0]
                if mhod_total <= 0:
                    break
                str_type = struct.unpack_from('<I', data, cp + 12)[0]
                str_len = struct.unpack_from('<I', data, cp + 28)[0]
                if str_len > 0 and cp + 40 + str_len <= len(data):
                    val = read_utf16(data, cp + 40, str_len)
                    if str_type == 1:
                        info['title'] = val
                    elif str_type == 4:
                        info['artist'] = val
                    elif str_type == 2:
                        info['path'] = val
                cp += mhod_total
            else:
                cp += 1
        yield info
        next_pos = data.find(b'mhit', pos + total_len)
        pos = next_pos if next_pos != -1 else -1


def find_master_mhyp(data):
    """Return (yp_pos, header_len, total_len, item_count) for the master
    playlist, or None if not found."""
    pos = 0
    while pos < len(data) - 12:
        idx = data.find(b'mhsd', pos)
        if idx == -1:
            break
        mhsd_header_len = struct.unpack_from('<I', data, idx + 4)[0]
        mhsd_total_len = struct.unpack_from('<I', data, idx + 8)[0]
        mhsd_type = struct.unpack_from('<I', data, idx + 12)[0]
        if mhsd_type == 2:
            mhlp_pos = idx + mhsd_header_len
            if data[mhlp_pos:mhlp_pos+4] == b'mhlp':
                mhlp_header_len = struct.unpack_from('<I', data, mhlp_pos + 4)[0]
                playlist_count = struct.unpack_from('<I', data, mhlp_pos + 8)[0]
                yp_pos = mhlp_pos + mhlp_header_len
                for _ in range(playlist_count):
                    if yp_pos >= len(data) - 4 or data[yp_pos:yp_pos+4] != b'mhyp':
                        break
                    yp_header_len = struct.unpack_from('<I', data, yp_pos + 4)[0]
                    yp_total_len = struct.unpack_from('<I', data, yp_pos + 8)[0]
                    item_count = struct.unpack_from('<I', data, yp_pos + 0x10)[0]
                    is_master = struct.unpack_from('<I', data, yp_pos + 0x14)[0]
                    if is_master == 1:
                        return (yp_pos, yp_header_len, yp_total_len, item_count)
                    yp_pos += yp_total_len
            return None
        pos = idx + mhsd_total_len
    return None


def main(mount: str) -> int:
    db_path = os.path.join(mount, 'iPod_Control', 'iTunes', 'iTunesDB')
    if not os.path.exists(db_path):
        print(f"iTunesDB not found at {db_path}", file=sys.stderr)
        return 1

    with open(db_path, "rb") as f:
        data = f.read()

    tracks = list(parse_tracks(data))
    print("=" * 72)
    print(f"ITUNESDB AUDIT — {db_path}")
    print("=" * 72)
    print()
    print(f"Total mhit records: {len(tracks)}")
    print()

    # --- Master playlist ---
    master = find_master_mhyp(data)
    if master:
        yp_pos, yp_hlen, yp_tlen, item_count = master
        # Walk children
        cp = yp_pos + yp_hlen
        end = yp_pos + yp_tlen
        mhip_count = 0
        sort_indices = []
        while cp < end - 4:
            if data[cp:cp+4] == b'mhod':
                mhod_total = struct.unpack_from('<I', data, cp + 8)[0]
                if mhod_total <= 0:
                    break
                str_type = struct.unpack_from('<I', data, cp + 12)[0]
                if str_type == 52:
                    sort_key = struct.unpack_from('<I', data, cp + 24)[0]
                    num_entries = struct.unpack_from('<I', data, cp + 28)[0]
                    sort_indices.append((sort_key, num_entries))
                cp += mhod_total
            elif data[cp:cp+4] == b'mhip':
                ip_total = struct.unpack_from('<I', data, cp + 8)[0]
                if ip_total <= 0:
                    break
                mhip_count += 1
                cp += ip_total
            else:
                cp += 1
        print(f"Master playlist:")
        print(f"  item_count (header):  {item_count}")
        print(f"  mhip records walked:  {mhip_count}")
        sort_key_names = {3: 'album', 4: 'artist', 5: 'genre', 7: 'title',
                          18: 'composer', 35: 'album-artist', 36: 'composer-sort'}
        for key, n in sort_indices:
            print(f"  sort index {key} ({sort_key_names.get(key, '?'):<14}): {n}")
    else:
        print("(no master playlist found)")
    print()

    # --- Codec marker distribution ---
    codec_buckets = collections.Counter(t['codec'] for t in tracks)
    print("Codec marker distribution (offset 0x18):")
    for c, n in sorted(codec_buckets.items(), key=lambda x: -x[1]):
        print(f"  {c!r:12} {n}")
    print()

    # --- Disk existence ---
    missing_on_disk = []
    for t in tracks:
        if not t['path']:
            continue
        rel = t['path'].replace(':', '/').lstrip('/')
        disk_path = os.path.join(mount, rel)
        if not os.path.exists(disk_path):
            missing_on_disk.append(t)
    print(f"Tracks whose audio file is missing on disk: {len(missing_on_disk)}")
    if missing_on_disk[:5]:
        for t in missing_on_disk[:5]:
            print(f"  {t['artist']} - {t['title']}")
    print()

    # --- Flag distributions ---
    visible_buckets = collections.Counter(t['visible'] for t in tracks)
    media_buckets = collections.Counter(t['media_kind'] for t in tracks)
    print(f"visible flag (offset 0x14): {dict(visible_buckets)}")
    print(f"mediaKind  (offset 0x40): {dict(media_buckets)}")
    print()

    # --- Integrity flaws ---
    no_title = sum(1 for t in tracks if not t['title'])
    no_path = sum(1 for t in tracks if not t['path'])
    zero_dur = sum(1 for t in tracks if t['duration_ms'] == 0)
    zero_size = sum(1 for t in tracks if t['file_size'] == 0)
    dbid_counts = collections.Counter(t['dbid'] for t in tracks)
    dup_dbids = sum(1 for v in dbid_counts.values() if v > 1)
    print(f"Tracks with empty title:    {no_title}")
    print(f"Tracks with empty path:     {no_path}")
    print(f"Tracks with duration == 0:  {zero_dur}")
    print(f"Tracks with fileSize == 0:  {zero_size}")
    print(f"Duplicate dbid groups:      {dup_dbids}")
    print()

    # --- Duration buckets ---
    dur_buckets = collections.Counter()
    for t in tracks:
        sec = t['duration_ms'] // 1000
        if sec < 30:
            key = '<30s'
        elif sec < 60:
            key = '30-60s'
        elif sec < 600:
            key = '1-10min'
        else:
            key = '>=10min'
        dur_buckets[key] += 1
    print("Duration distribution:")
    for k in ['<30s', '30-60s', '1-10min', '>=10min']:
        if k in dur_buckets:
            print(f"  {k:<10} {dur_buckets[k]}")
    print()

    # --- Bimodal scan (look for any field that discriminates) ---
    print("Per-offset bimodal scan (looking for fields that split tracks ~main vs ~short+long):")
    by_offset_main = collections.defaultdict(collections.Counter)
    by_offset_other = collections.defaultdict(collections.Counter)
    for t in tracks:
        sec = t['duration_ms'] // 1000
        target = by_offset_main if 60 <= sec < 600 else by_offset_other
        for off in range(0, t['header_len'] - 3, 4):
            v = struct.unpack_from('<I', data, t['pos'] + off)[0]
            target[off][v] += 1
    discriminating = []
    for off in sorted(by_offset_main.keys()):
        main = by_offset_main[off]
        other = by_offset_other.get(off, collections.Counter())
        if not main or not other:
            continue
        main_top_val, main_top_n = main.most_common(1)[0]
        if main_top_n / sum(main.values()) < 0.99:
            continue
        other_top_val, other_top_n = other.most_common(1)[0]
        if other_top_val == main_top_val:
            continue
        if other_top_n / sum(other.values()) < 0.5:
            continue
        discriminating.append((off, main_top_val, other_top_val,
                               main_top_n, other_top_n))
    if discriminating:
        for off, mv, ov, mn, on in discriminating:
            print(f"  offset 0x{off:02x}: main={mv} ({mn}), short+long={ov} ({on})")
    else:
        print("  (no offset cleanly discriminates)")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
