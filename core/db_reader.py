import struct
import json
import sys
import os
import plistlib

IPOD_PATH = os.path.expanduser("~/Music2/JakeTunesLibrary/iPod_Control/iTunes/iTunesDB")
ITUNES_XML_PATH = os.path.expanduser("~/Desktop/April 10 2026 library.xml")

def read_utf16(data, offset, length):
    try:
        return data[offset:offset+length].decode('utf-16-le', errors='replace').rstrip('\x00')
    except:
        return ''

def parse_tracks(db_path=IPOD_PATH):
    with open(db_path, "rb") as f:
        data = f.read()

    tracks = []
    pos = data.find(b'mhit')
    track_id = 0

    while pos != -1 and pos < len(data) - 4:
        if data[pos:pos+4] != b'mhit':
            break
        header_len = struct.unpack_from('<I', data, pos+4)[0]
        total_len  = struct.unpack_from('<I', data, pos+8)[0]

        # Extract duration (milliseconds) at offset 0x28 in mhit header
        duration_ms = 0
        if header_len >= 44:
            duration_ms = struct.unpack_from('<I', data, pos + 0x28)[0]

        # Try to extract year from mhit header
        year = ''
        if header_len >= 208:
            raw_year = struct.unpack_from('<I', data, pos + 204)[0]
            if 1900 <= raw_year <= 2030:
                year = raw_year

        # Track number and count (offsets 0x2C, 0x30)
        track_num = 0
        track_count = 0
        if header_len >= 52:
            raw_tn = struct.unpack_from('<I', data, pos + 0x2C)[0]
            raw_tc = struct.unpack_from('<I', data, pos + 0x30)[0]
            if 0 < raw_tn <= 9999:
                track_num = raw_tn
            if 0 < raw_tc <= 9999:
                track_count = raw_tc

        # Disc number and count (offsets 0x64, 0x68)
        disc_num = 0
        disc_count = 0
        if header_len >= 108:
            raw_dn = struct.unpack_from('<I', data, pos + 0x64)[0]
            raw_dc = struct.unpack_from('<I', data, pos + 0x68)[0]
            if 0 < raw_dn <= 99:
                disc_num = raw_dn
            if 0 < raw_dc <= 99:
                disc_count = raw_dc

        # iPod internal unique track ID (offset 0x10) — used to resolve playlist references
        dbid = struct.unpack_from('<I', data, pos + 0x10)[0] if header_len >= 20 else 0

        track_info = {
            'id': track_id, 'dbid': dbid, 'year': year, 'duration': duration_ms,
            'trackNumber': track_num, 'trackCount': track_count,
            'discNumber': disc_num, 'discCount': disc_count,
            'playCount': 0, 'dateAdded': '', 'fileSize': 0, 'rating': 0,
        }
        child_pos = pos + header_len
        end_pos = pos + total_len

        while child_pos < end_pos - 4:
            if data[child_pos:child_pos+4] == b'mhod':
                mhod_total = struct.unpack_from('<I', data, child_pos+4)[0]
                str_type   = struct.unpack_from('<I', data, child_pos+12)[0]
                str_len    = struct.unpack_from('<I', data, child_pos+28)[0]
                if str_len > 0 and child_pos+40+str_len <= len(data):
                    str_val = read_utf16(data, child_pos+40, str_len)
                    type_map = {1:'title', 2:'path', 3:'album', 4:'artist', 5:'genre'}
                    if str_type in type_map and str_val:
                        track_info[type_map[str_type]] = str_val
                child_pos += mhod_total
            else:
                child_pos += 1

        if 'title' in track_info:
            tracks.append(track_info)
            track_id += 1

        next_pos = data.find(b'mhit', pos + total_len)
        pos = next_pos if next_pos != -1 else len(data)

    return tracks

def parse_playlists(db_path=IPOD_PATH, tracks=None):
    """Parse playlists from the iPod iTunesDB (mhlp → mhyp → mhip)."""
    with open(db_path, "rb") as f:
        data = f.read()

    # Build dbid → sequential id mapping
    dbid_to_id = {}
    if tracks:
        for t in tracks:
            dbid_to_id[t.get('dbid', 0)] = t['id']

    # Find the playlist dataset (mhsd type 2)
    playlists = []
    pos = 0
    mhlp_pos = None
    while pos < len(data) - 12:
        idx = data.find(b'mhsd', pos)
        if idx == -1:
            break
        mhsd_header_len = struct.unpack_from('<I', data, idx + 4)[0]
        mhsd_total_len = struct.unpack_from('<I', data, idx + 8)[0]
        mhsd_type = struct.unpack_from('<I', data, idx + 12)[0]
        if mhsd_type == 2:  # playlist dataset
            mhlp_pos = idx + mhsd_header_len
            break
        pos = idx + mhsd_total_len

    if mhlp_pos is None or data[mhlp_pos:mhlp_pos+4] != b'mhlp':
        print("No playlist data found in iTunesDB", file=sys.stderr)
        return []

    mhlp_header_len = struct.unpack_from('<I', data, mhlp_pos + 4)[0]
    playlist_count = struct.unpack_from('<I', data, mhlp_pos + 8)[0]
    print(f"Found {playlist_count} playlists in iTunesDB", file=sys.stderr)

    yp_pos = mhlp_pos + mhlp_header_len

    for _ in range(playlist_count):
        if yp_pos >= len(data) - 4 or data[yp_pos:yp_pos+4] != b'mhyp':
            break

        yp_header_len = struct.unpack_from('<I', data, yp_pos + 4)[0]
        yp_total_len = struct.unpack_from('<I', data, yp_pos + 8)[0]
        mhod_count = struct.unpack_from('<I', data, yp_pos + 0x0C)[0]
        item_count = struct.unpack_from('<I', data, yp_pos + 0x10)[0]
        is_master = struct.unpack_from('<I', data, yp_pos + 0x14)[0]

        if is_master == 1:
            # Skip the master (all-tracks) playlist
            yp_pos += yp_total_len
            continue

        next_yp = yp_pos + yp_total_len  # Save next position before parsing children

        # Parse mhod children to find playlist name
        playlist_name = ''
        child_pos = yp_pos + yp_header_len
        yp_end = yp_pos + yp_total_len
        mhods_parsed = 0

        while child_pos < yp_end - 4 and mhods_parsed < mhod_count:
            if data[child_pos:child_pos+4] == b'mhod':
                mhod_total = struct.unpack_from('<I', data, child_pos + 8)[0]
                str_type = struct.unpack_from('<I', data, child_pos + 12)[0]
                if str_type == 1 and not playlist_name:
                    str_len = struct.unpack_from('<I', data, child_pos + 0x1C)[0]
                    if str_len > 0 and child_pos + 0x28 + str_len <= len(data):
                        playlist_name = read_utf16(data, child_pos + 0x28, str_len)
                child_pos += mhod_total
                mhods_parsed += 1
            else:
                break

        # Parse mhip children to get track references
        track_ids = []
        for _ in range(item_count):
            if child_pos >= yp_end - 4 or data[child_pos:child_pos+4] != b'mhip':
                break
            ip_total = struct.unpack_from('<I', data, child_pos + 8)[0]
            ref_dbid = struct.unpack_from('<I', data, child_pos + 0x18)[0]
            if ref_dbid in dbid_to_id:
                track_ids.append(dbid_to_id[ref_dbid])
            child_pos += ip_total

        if playlist_name and track_ids:
            playlists.append({
                'name': playlist_name,
                'trackIds': track_ids,
            })
            print(f"  Playlist: {playlist_name} ({len(track_ids)} tracks)", file=sys.stderr)

        yp_pos = next_yp

    return playlists


def load_itunes_xml(xml_path=ITUNES_XML_PATH):
    """Parse iTunes Library XML and build a lookup dict keyed by (title_lower, artist_lower)."""
    lookup = {}
    try:
        with open(xml_path, 'rb') as f:
            plist = plistlib.load(f)
        xml_tracks = plist.get('Tracks', {})
        for track_data in xml_tracks.values():
            name = (track_data.get('Name') or '').strip()
            artist = (track_data.get('Artist') or '').strip()
            if not name:
                continue
            key = (name.lower(), artist.lower())
            info = {}
            if 'Year' in track_data:
                y = track_data['Year']
                if isinstance(y, int) and 1900 <= y <= 2030:
                    info['year'] = y
            if 'Date Added' in track_data:
                da = track_data['Date Added']
                info['dateAdded'] = da.strftime('%Y-%m-%d') if hasattr(da, 'strftime') else str(da)
            if 'Play Count' in track_data:
                info['playCount'] = track_data['Play Count']
            if 'Track Number' in track_data:
                info['trackNumber'] = track_data['Track Number']
            if 'Track Count' in track_data:
                info['trackCount'] = track_data['Track Count']
            if 'Disc Number' in track_data:
                info['discNumber'] = track_data['Disc Number']
            if 'Disc Count' in track_data:
                info['discCount'] = track_data['Disc Count']
            if 'Size' in track_data:
                info['fileSize'] = track_data['Size']
            if 'Rating' in track_data:
                # iTunes stores rating as 0-100 (0, 20, 40, 60, 80, 100)
                raw = track_data['Rating']
                info['rating'] = max(0, min(5, round(raw / 20)))
            if 'Album Artist' in track_data:
                aa = (track_data['Album Artist'] or '').strip()
                if aa:
                    info['albumArtist'] = aa
            if info:
                lookup[key] = info
    except Exception as e:
        print(f"Warning: could not parse iTunes XML: {e}", file=sys.stderr)
    return lookup


def enrich_tracks(tracks, xml_path=ITUNES_XML_PATH):
    """Merge Year, Date Added, Play Count from iTunes XML into parsed tracks."""
    lookup = load_itunes_xml(xml_path)
    if not lookup:
        return tracks
    matched = 0
    for t in tracks:
        title = (t.get('title') or '').strip().lower()
        artist = (t.get('artist') or '').strip().lower()
        key = (title, artist)
        if key in lookup:
            info = lookup[key]
            if 'year' in info and not t.get('year'):
                t['year'] = info['year']
            if 'dateAdded' in info:
                t['dateAdded'] = info['dateAdded']
            if 'playCount' in info:
                t['playCount'] = info['playCount']
            if 'trackNumber' in info:
                t['trackNumber'] = info['trackNumber']
            if 'trackCount' in info:
                t['trackCount'] = info['trackCount']
            if 'discNumber' in info:
                t['discNumber'] = info['discNumber']
            if 'discCount' in info:
                t['discCount'] = info['discCount']
            if 'rating' in info:
                t['rating'] = info['rating']
            matched += 1
    print(f"Enriched {matched}/{len(tracks)} tracks from iTunes XML", file=sys.stderr)
    return tracks


IPOD_MOUNT = os.path.expanduser("~/Music2/JakeTunesLibrary")

def add_file_sizes(tracks):
    """Get actual file sizes from iPod filesystem (not iTunes XML source sizes)."""
    sized = 0
    for t in tracks:
        path = t.get('path', '')
        if path:
            fs_path = IPOD_MOUNT + path.replace(':', '/')
            try:
                t['fileSize'] = os.path.getsize(fs_path)
                sized += 1
            except OSError:
                pass
    print(f"Got file sizes for {sized}/{len(tracks)} tracks", file=sys.stderr)
    return tracks


# ── iTunesDB Writer ──

def build_string_mhod(str_type, text):
    """Build a UTF-16 string mhod record."""
    if not text:
        text = ''
    str_bytes = str(text).encode('utf-16-le')
    total = 40 + len(str_bytes)
    rec = bytearray(total)
    struct.pack_into('<4s', rec, 0, b'mhod')
    struct.pack_into('<I', rec, 4, 24)          # header_len
    struct.pack_into('<I', rec, 8, total)       # total_len
    struct.pack_into('<I', rec, 12, str_type)   # type
    struct.pack_into('<I', rec, 24, 1)          # position
    struct.pack_into('<I', rec, 28, len(str_bytes))  # string byte length
    struct.pack_into('<I', rec, 32, 1)          # encoding = UTF-16-LE
    rec[40:] = str_bytes
    return bytes(rec)


def build_order_mhod():
    """Build a type-100 ordering mhod (44 bytes, used inside mhip)."""
    rec = bytearray(44)
    struct.pack_into('<4s', rec, 0, b'mhod')
    struct.pack_into('<I', rec, 4, 24)
    struct.pack_into('<I', rec, 8, 44)
    struct.pack_into('<I', rec, 12, 100)
    return bytes(rec)


def build_mhip(dbid, position):
    """Build an mhip record (76-byte header + 44-byte type-100 mhod)."""
    hdr = bytearray(76)
    struct.pack_into('<4s', hdr, 0, b'mhip')
    struct.pack_into('<I', hdr, 4, 76)
    struct.pack_into('<I', hdr, 8, 120)     # total = 76 + 44
    struct.pack_into('<I', hdr, 0x0C, 1)    # mhod_count
    struct.pack_into('<I', hdr, 0x14, position)
    struct.pack_into('<I', hdr, 0x18, dbid)
    return bytes(hdr) + build_order_mhod()


def build_mhit_record(track, dbid, template_header):
    """Build an mhit record from a library track, using a 624-byte template."""
    hdr = bytearray(template_header)

    struct.pack_into('<I', hdr, 0x10, dbid)
    struct.pack_into('<I', hdr, 0x14, 1)  # visible

    # File size
    struct.pack_into('<I', hdr, 0x24, int(track.get('fileSize', 0) or 0))
    # Duration (ms)
    struct.pack_into('<I', hdr, 0x28, int(track.get('duration', 0) or 0))
    # Track number / count
    tn = track.get('trackNumber', 0)
    tc = track.get('trackCount', 0)
    struct.pack_into('<I', hdr, 0x2C, int(tn) if tn and int(tn) > 0 else 0)
    struct.pack_into('<I', hdr, 0x30, int(tc) if tc and int(tc) > 0 else 0)
    # Year (at 0x34 in this DB version)
    try:
        y = int(track.get('year', 0) or 0)
        struct.pack_into('<I', hdr, 0x34, y if 1900 <= y <= 2030 else 0)
    except (ValueError, TypeError):
        struct.pack_into('<I', hdr, 0x34, 0)
    # Play count
    struct.pack_into('<I', hdr, 0x50, int(track.get('playCount', 0) or 0))

    # Build 7 mhod children: title, artist, sort-artist, album, genre, filetype, path
    path = str(track.get('path', ''))
    ext = path.rsplit('.', 1)[-1].lower() if '.' in path else ''
    ft = 'AAC audio file' if ext in ('m4a', 'aac') else 'MPEG audio file'

    mhods = bytearray()
    mhods += build_string_mhod(1, track.get('title', ''))
    mhods += build_string_mhod(4, track.get('artist', ''))
    mhods += build_string_mhod(22, track.get('artist', ''))
    mhods += build_string_mhod(3, track.get('album', ''))
    mhods += build_string_mhod(5, track.get('genre', ''))
    mhods += build_string_mhod(6, ft)
    mhods += build_string_mhod(2, path)

    struct.pack_into('<I', hdr, 0x0C, 7)                    # mhod count
    struct.pack_into('<I', hdr, 8, len(hdr) + len(mhods))   # total_len
    return bytes(hdr) + bytes(mhods)


def build_mhyp_record(name, dbids, is_master, template_mhods=None):
    """Build an mhyp playlist record with mhip items.
    template_mhods: tuple of (type100_bytes, type102_bytes) extracted from existing DB.
    """
    hlen = 184
    hdr = bytearray(hlen)
    struct.pack_into('<4s', hdr, 0, b'mhyp')
    struct.pack_into('<I', hdr, 4, hlen)
    struct.pack_into('<I', hdr, 0x14, 1 if is_master else 0)

    mhods = bytearray()
    mhod_count = 0

    # Name mhod (type 1)
    if is_master:
        mhods += build_string_mhod(1, 'JakeTunes')
        mhod_count += 1
    elif name:
        mhods += build_string_mhod(1, name)
        mhod_count += 1

    # Column layout / sort mhods (types 100 + 102) — required by iPod firmware
    if template_mhods:
        t100, t102 = template_mhods
        if t100:
            mhods += t100
            mhod_count += 1
        if t102:
            mhods += t102
            mhod_count += 1

    struct.pack_into('<I', hdr, 0x0C, mhod_count)
    struct.pack_into('<I', hdr, 0x10, len(dbids))

    items = bytearray()
    for i, d in enumerate(dbids):
        items += build_mhip(d, i + 1)

    total = hlen + len(mhods) + len(items)
    struct.pack_into('<I', hdr, 8, total)
    return bytes(hdr) + bytes(mhods) + bytes(items)


def write_itunesdb(tracks, playlists, template_path, output_path):
    """Rebuild the iPod iTunesDB from JakeTunes library data."""
    with open(template_path, 'rb') as f:
        existing = f.read()

    mhbd_hlen = struct.unpack_from('<I', existing, 4)[0]
    num_children = struct.unpack_from('<I', existing, 20)[0]

    # ── Parse existing mhsd sections ──
    sections = []
    pos = mhbd_hlen
    for _ in range(num_children):
        if pos >= len(existing) - 16:
            break
        hlen = struct.unpack_from('<I', existing, pos + 4)[0]
        total = struct.unpack_from('<I', existing, pos + 8)[0]
        typ  = struct.unpack_from('<I', existing, pos + 12)[0]
        sections.append({'type': typ, 'start': pos, 'hlen': hlen, 'total': total})
        pos += total

    # ── Get template mhit header from existing type-1 section ──
    type1 = next(s for s in sections if s['type'] == 1)
    mhlt_pos  = type1['start'] + type1['hlen']
    mhlt_hlen = struct.unpack_from('<I', existing, mhlt_pos + 4)[0]
    first_mhit = mhlt_pos + mhlt_hlen
    mhit_hlen  = struct.unpack_from('<I', existing, first_mhit + 4)[0]
    template_mhit = bytearray(existing[first_mhit : first_mhit + mhit_hlen])

    # ── Build path → dbid mapping from existing tracks ──
    path_to_dbid = {}
    max_dbid = 0
    tp = first_mhit
    ex_count = struct.unpack_from('<I', existing, mhlt_pos + 8)[0]
    for _ in range(ex_count):
        if tp >= len(existing) - 4 or existing[tp:tp+4] != b'mhit':
            break
        h = struct.unpack_from('<I', existing, tp + 4)[0]
        t = struct.unpack_from('<I', existing, tp + 8)[0]
        dbid = struct.unpack_from('<I', existing, tp + 0x10)[0]
        max_dbid = max(max_dbid, dbid)
        mc = struct.unpack_from('<I', existing, tp + 12)[0]
        mp = tp + h
        for _ in range(mc):
            if existing[mp:mp+4] == b'mhod':
                mt   = struct.unpack_from('<I', existing, mp + 8)[0]
                mtyp = struct.unpack_from('<I', existing, mp + 12)[0]
                if mtyp == 2:  # path
                    slen = struct.unpack_from('<I', existing, mp + 28)[0]
                    if slen > 0:
                        p = existing[mp+40:mp+40+slen].decode('utf-16-le', errors='replace').rstrip('\x00')
                        path_to_dbid[p] = dbid
                mp += mt
            else:
                break
        tp += t

    # ── Assign dbids ──
    track_dbids = {}
    next_dbid = max_dbid + 2
    for t in tracks:
        path = t.get('path', '')
        if path in path_to_dbid:
            track_dbids[t['id']] = path_to_dbid[path]
        else:
            track_dbids[t['id']] = next_dbid
            next_dbid += 2

    new_count = sum(1 for t in tracks if t.get('path', '') not in path_to_dbid)
    print(f"Existing: {ex_count} tracks, max_dbid={max_dbid}", file=sys.stderr)
    print(f"Writing: {len(tracks)} tracks ({new_count} new)", file=sys.stderr)

    # ── Build type 1: track list ──
    mhlt = bytearray(92)
    struct.pack_into('<4s', mhlt, 0, b'mhlt')
    struct.pack_into('<I', mhlt, 4, 92)
    struct.pack_into('<I', mhlt, 8, len(tracks))

    track_data = bytearray(mhlt)
    for t in tracks:
        track_data += build_mhit_record(t, track_dbids[t['id']], template_mhit)

    type1_mhsd = bytearray(96)
    struct.pack_into('<4s', type1_mhsd, 0, b'mhsd')
    struct.pack_into('<I', type1_mhsd, 4, 96)
    struct.pack_into('<I', type1_mhsd, 8, 96 + len(track_data))
    struct.pack_into('<I', type1_mhsd, 12, 1)
    type1_section = bytes(type1_mhsd) + bytes(track_data)

    # ── Extract template playlist mhods (type 100 + 102) from existing DB ──
    template_pl_mhods = (None, None)
    type2_sec = next((s for s in sections if s['type'] == 2), None)
    if type2_sec:
        mhlp_pos2 = type2_sec['start'] + type2_sec['hlen']
        if existing[mhlp_pos2:mhlp_pos2+4] == b'mhlp':
            mhlp_hlen2 = struct.unpack_from('<I', existing, mhlp_pos2 + 4)[0]
            pl_count2 = struct.unpack_from('<I', existing, mhlp_pos2 + 8)[0]
            # Find the first non-master playlist to get template mhods
            yp2 = mhlp_pos2 + mhlp_hlen2
            for _ in range(pl_count2):
                if existing[yp2:yp2+4] != b'mhyp':
                    break
                yh2 = struct.unpack_from('<I', existing, yp2 + 4)[0]
                yt2 = struct.unpack_from('<I', existing, yp2 + 8)[0]
                mc2 = struct.unpack_from('<I', existing, yp2 + 0x0C)[0]
                master2 = struct.unpack_from('<I', existing, yp2 + 0x14)[0]
                if not master2 and mc2 >= 3:
                    # Extract type 100 and type 102 mhods
                    cp2 = yp2 + yh2
                    t100 = None
                    t102 = None
                    for _ in range(mc2):
                        if existing[cp2:cp2+4] == b'mhod':
                            mt2 = struct.unpack_from('<I', existing, cp2 + 8)[0]
                            mtyp2 = struct.unpack_from('<I', existing, cp2 + 12)[0]
                            if mtyp2 == 100 and not t100:
                                t100 = bytes(existing[cp2:cp2+mt2])
                            elif mtyp2 == 102 and not t102:
                                t102 = bytes(existing[cp2:cp2+mt2])
                            cp2 += mt2
                        else:
                            break
                    if t100 or t102:
                        template_pl_mhods = (t100, t102)
                        print(f"Extracted playlist template mhods: type100={len(t100) if t100 else 0}b, type102={len(t102) if t102 else 0}b", file=sys.stderr)
                        break
                yp2 += yt2

    # ── Build playlist data (shared by types 2 and 3) ──
    all_dbids = [track_dbids[t['id']] for t in tracks]
    total_pl = 1 + len(playlists)

    mhlp = bytearray(92)
    struct.pack_into('<4s', mhlp, 0, b'mhlp')
    struct.pack_into('<I', mhlp, 4, 92)
    struct.pack_into('<I', mhlp, 8, total_pl)

    pl_data = bytearray(mhlp)
    pl_data += build_mhyp_record('', all_dbids, is_master=True, template_mhods=template_pl_mhods)
    for pl in playlists:
        pl_dbids = [track_dbids[tid] for tid in pl.get('trackIds', []) if tid in track_dbids]
        pl_data += build_mhyp_record(pl.get('name', ''), pl_dbids, is_master=False, template_mhods=template_pl_mhods)

    def wrap_mhsd(typ, payload):
        h = bytearray(96)
        struct.pack_into('<4s', h, 0, b'mhsd')
        struct.pack_into('<I', h, 4, 96)
        struct.pack_into('<I', h, 8, 96 + len(payload))
        struct.pack_into('<I', h, 12, typ)
        return bytes(h) + bytes(payload)

    type2_section = wrap_mhsd(2, pl_data)
    type3_section = wrap_mhsd(3, pl_data)

    # ── Assemble final database ──
    body = bytearray()
    for sec in sections:
        if sec['type'] == 1:
            body += type1_section
        elif sec['type'] == 2:
            body += type2_section
        elif sec['type'] == 3:
            body += type3_section
        else:
            body += existing[sec['start']:sec['start'] + sec['total']]

    mhbd = bytearray(existing[:mhbd_hlen])
    struct.pack_into('<I', mhbd, 8, mhbd_hlen + len(body))

    temp_path = output_path + '.tmp'
    with open(temp_path, 'wb') as f:
        f.write(bytes(mhbd) + bytes(body))
    os.rename(temp_path, output_path)

    final_size = mhbd_hlen + len(body)
    print(f"Wrote iTunesDB: {final_size:,} bytes → {output_path}", file=sys.stderr)
    return len(tracks)


if __name__ == "__main__":
    # ── Write mode: rebuild iPod DB from JakeTunes library ──
    if '--write' in sys.argv:
        idx = sys.argv.index('--write')
        db_path = sys.argv[idx + 1] if idx + 1 < len(sys.argv) else None
        if not db_path:
            print("Usage: db_reader.py --write <ipod_itunesdb_path>", file=sys.stderr)
            sys.exit(1)
        input_data = json.load(sys.stdin)
        count = write_itunesdb(
            input_data['tracks'],
            input_data.get('playlists', []),
            db_path, db_path
        )
        json.dump({'ok': True, 'count': count}, sys.stdout)
        sys.exit(0)

    # ── Read mode: parse iPod DB and output JSON ──
    json_mode = '--json' in sys.argv
    args = [a for a in sys.argv[1:] if a != '--json']
    db_path = args[0] if args else IPOD_PATH

    tracks = parse_tracks(db_path)
    tracks = enrich_tracks(tracks)
    tracks = add_file_sizes(tracks)
    ipod_playlists = parse_playlists(db_path, tracks)

    if json_mode:
        # Strip internal dbid before outputting
        clean_tracks = [{k: v for k, v in t.items() if k != 'dbid'} for t in tracks]
        json.dump({'tracks': clean_tracks, 'playlists': ipod_playlists}, sys.stdout, ensure_ascii=False)
    else:
        for t in tracks[:25]:
            print(f"{t.get('artist','?')} — {t.get('title','?')} [{t.get('album','?')}] ({t.get('year','')}) added:{t.get('dateAdded','')}")
        print(f"\n{len(tracks)} total tracks parsed")
