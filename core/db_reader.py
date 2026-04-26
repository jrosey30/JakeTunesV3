import struct
import json
import sys
import os
import random
import time
import plistlib

MAC_EPOCH_OFFSET = 2082844800  # seconds between 1904-01-01 and 1970-01-01

_legacy_lib = os.path.expanduser("~/Music2/JakeTunesLibrary")
_default_lib = os.path.expanduser("~/Music/JakeTunesLibrary")
_lib_root = _legacy_lib if os.path.isdir(_legacy_lib) else _default_lib
IPOD_PATH = os.path.join(_lib_root, "iPod_Control/iTunes/iTunesDB")
# iTunes XML is optional — used for enrichment only. Auto-discover from common locations.
_xml_candidates = [
    os.path.expanduser("~/Music/iTunes/iTunes Music Library.xml"),
    os.path.expanduser("~/Music/iTunes/iTunes Library.xml"),
]
# Also check Desktop for any exported XML
_desktop = os.path.expanduser("~/Desktop")
if os.path.isdir(_desktop):
    for f in os.listdir(_desktop):
        if f.endswith('.xml') and 'library' in f.lower():
            _xml_candidates.insert(0, os.path.join(_desktop, f))
ITUNES_XML_PATH = next((p for p in _xml_candidates if os.path.exists(p)), _xml_candidates[0] if _xml_candidates else '')

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

        # Try to extract year from mhit header (offset 0x34 = 52)
        year = ''
        if header_len >= 56:
            raw_year = struct.unpack_from('<I', data, pos + 0x34)[0]
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

        # Disc number and count.
        #
        # ⚠️ 2026-04-26 investigation (see docs/postmortems/) found that
        # 0x64 is NOT disc_num — the iPod firmware treats it as a
        # mediaKind classifier where value 2/3/4 silently drops the
        # track from "Music > Songs". Build_mhit_record now writes
        # 0x64 = 1 unconditionally; reading anything from 0x64 here
        # would just echo back 1 for every track and mislead the UI.
        #
        # The correct offset for iPod-side disc info is unknown. Until
        # we identify it, return 0 so the UI shows "no disc info" rather
        # than fake "Disc 1 of N" data. Disc info on freshly imported
        # tracks still flows from music-metadata file tags into
        # library.json on import; what we lose is round-tripping disc
        # info through the iPod's iTunesDB.
        disc_num = 0
        disc_count = 0

        # iPod internal unique track ID (offset 0x10) — used to resolve playlist references
        dbid = struct.unpack_from('<I', data, pos + 0x10)[0] if header_len >= 20 else 0

        # Date added (offset 0x20, Mac classic epoch: seconds since 1904-01-01).
        # Extract it natively so we don't depend on a matching entry existing
        # in whatever iTunes XML happens to be on the Desktop.
        date_added = ''
        if header_len >= 36:
            raw_mac = struct.unpack_from('<I', data, pos + 0x20)[0]
            if 2_000_000_000 < raw_mac < 4_000_000_000:
                unix_ts = raw_mac - MAC_EPOCH_OFFSET
                date_added = time.strftime('%Y-%m-%d', time.localtime(unix_ts))

        track_info = {
            'id': track_id, 'dbid': dbid, 'year': year, 'duration': duration_ms,
            'trackNumber': track_num, 'trackCount': track_count,
            'discNumber': disc_num, 'discCount': disc_count,
            'playCount': 0, 'dateAdded': date_added, 'fileSize': 0, 'rating': 0,
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
                    type_map = {1:'title', 2:'path', 3:'album', 4:'artist', 5:'genre', 32:'albumArtist'}
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


IPOD_MOUNT = _lib_root

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


def build_mhip(dbid, position, timestamp_mac=None):
    """Build an mhip record (76-byte header + 44-byte type-100 mhod)."""
    if timestamp_mac is None:
        timestamp_mac = int(time.time()) + MAC_EPOCH_OFFSET
    hdr = bytearray(76)
    struct.pack_into('<4s', hdr, 0, b'mhip')
    struct.pack_into('<I', hdr, 4, 76)
    struct.pack_into('<I', hdr, 8, 120)     # total = 76 + 44
    struct.pack_into('<I', hdr, 0x0C, 1)    # mhod_count
    struct.pack_into('<I', hdr, 0x14, position)
    struct.pack_into('<I', hdr, 0x18, dbid)
    struct.pack_into('<I', hdr, 0x1C, timestamp_mac)  # date added to playlist
    return bytes(hdr) + build_order_mhod()


def _safe_int(val, default=0):
    """Safely convert a value to int, returning default on failure."""
    try:
        return int(val) if val else default
    except (ValueError, TypeError):
        return default


# Filetype markers in mhit header (offset 0x18) — ASCII codec identifiers
CODEC_MARKERS = {
    'm4a': b'M4A ', 'aac': b'M4A ', 'alac': b'M4A ',
    'mp3': b'MP3 ',
    'wav': b'WAV ', 'wave': b'WAV ',
    'aif': b'AIFF', 'aiff': b'AIFF',
    'flac': b'FLAC',
}

# mhod types that we rebuild from JakeTunes metadata (may have changed).
# Type 32 is album artist — included so we can restore it instead of
# preserving whatever stale value was embedded in the existing mhod pool.
REBUILT_MHOD_TYPES = {1, 2, 3, 4, 5, 6, 22, 32}


def build_mhit_record(track, dbid, template_header, extra_mhods=None, is_new=False):
    """Build an mhit record.
    template_header: either the track's own header (existing track) or a generic template (new track).
    extra_mhods:     raw bytes of mhod types NOT in REBUILT_MHOD_TYPES, to preserve from existing DB.
    is_new:          True if this track is not in the existing DB (needs codec/timestamp init).
    """
    hdr = bytearray(template_header)

    struct.pack_into('<I', hdr, 0x10, dbid)
    struct.pack_into('<I', hdr, 0x14, 1)  # visible

    # File size — only overwrite if we have a value (don't zero-out existing header data)
    fs = _safe_int(track.get('fileSize', 0))
    if fs > 0 or is_new:
        struct.pack_into('<I', hdr, 0x24, fs)
    # Duration (ms) — same guard
    dur = _safe_int(track.get('duration', 0))
    if dur > 0 or is_new:
        struct.pack_into('<I', hdr, 0x28, dur)
    # Track number / count
    tn = _safe_int(track.get('trackNumber', 0))
    tc = _safe_int(track.get('trackCount', 0))
    struct.pack_into('<I', hdr, 0x2C, tn if tn > 0 else 0)
    struct.pack_into('<I', hdr, 0x30, tc if tc > 0 else 0)
    # Year
    y = _safe_int(track.get('year', 0))
    struct.pack_into('<I', hdr, 0x34, y if 1900 <= y <= 2030 else 0)
    # Play count
    struct.pack_into('<I', hdr, 0x50, _safe_int(track.get('playCount', 0)))
    # Force 0x64 = 1 (the iPod firmware's "music" mediaKind value).
    #
    # ⚠️ Previous versions of this code wrote `discNumber` to 0x64 and
    # `discCount` to 0x68, treating them as disc fields. The 2026-04-26
    # investigation (see docs/postmortems/2026-04-26-ipod-songcount-counter.md)
    # proved this is the WRONG offset: the iPod Classic firmware reads
    # 0x64 as a mediaKind-like classifier and silently drops tracks
    # whose 0x64 != 1 from "Music > Songs". For a single-disc library
    # the bug is invisible (every track gets discNumber=1, which by
    # coincidence equals the "music" sentinel). For multi-disc albums
    # the disc-2/3/4 tracks get classified as audiobook/podcast/etc.
    # and silently filtered. The user's library lost 150 of 4546 tracks
    # through this path.
    #
    # Setting 0x64 = 1 unconditionally restores all tracks to "music"
    # and is the immediate fix. Disc number/total info is preserved
    # in JakeTunes' library.json (and the renderer's Track interface)
    # so playlists and Get Info still know which disc a track is on;
    # only the iPod's per-track "Disc 1 of N" display is sacrificed
    # until we identify the correct iTunesDB offset for disc info.
    #
    # 0x68 is left untouched here — for new tracks it gets overwritten
    # to a Mac timestamp a few lines below (also probably wrong, but
    # not part of the filter we just diagnosed). A separate brief is
    # warranted to find the actual disc-info offsets and restore that
    # display.
    struct.pack_into('<I', hdr, 0x64, 1)

    # For new tracks: set filetype marker and timestamps (template has wrong values)
    path = str(track.get('path', ''))
    ext = path.rsplit('.', 1)[-1].lower() if '.' in path else ''
    if is_new:
        marker = CODEC_MARKERS.get(ext, b'MP3 ')
        struct.pack_into('<4s', hdr, 0x18, marker)
        # Set codec sub-type flag at 0x1C (MP3 uses 0x100, AAC uses 0)
        if ext in ('mp3',):
            struct.pack_into('<I', hdr, 0x1C, 0x100)
        else:
            struct.pack_into('<I', hdr, 0x1C, 0)
        # Set timestamps (Mac classic epoch: seconds since 1904-01-01)
        now_mac = int(time.time()) + MAC_EPOCH_OFFSET
        struct.pack_into('<I', hdr, 0x20, now_mac)   # date created
        struct.pack_into('<I', hdr, 0x58, now_mac)   # date modified
        struct.pack_into('<I', hdr, 0x68, now_mac)   # date added

    # Build standard mhod children: title(1), path(2), album(3), artist(4), genre(5), filetype(6), sort-artist(22)
    ft = 'AAC audio file' if ext in ('m4a', 'aac', 'alac') else 'MPEG audio file'

    mhods = bytearray()
    mhods += build_string_mhod(1, track.get('title', ''))
    mhods += build_string_mhod(4, track.get('artist', ''))
    mhods += build_string_mhod(22, track.get('artist', ''))
    mhods += build_string_mhod(3, track.get('album', ''))
    mhods += build_string_mhod(5, track.get('genre', ''))
    mhods += build_string_mhod(6, ft)
    mhods += build_string_mhod(2, path)
    mhod_count = 7

    # Album artist (mhod type 32). Only emit if present — don't pollute the
    # DB with empty strings.
    album_artist = str(track.get('albumArtist', '') or '').strip()
    if album_artist:
        mhods += build_string_mhod(32, album_artist)
        mhod_count += 1

    # Append preserved extra mhods from existing DB (composer, comment, artwork refs, etc.)
    if extra_mhods:
        mhods += extra_mhods
        # Count how many extra mhods there are
        p = 0
        while p < len(extra_mhods) - 4:
            if extra_mhods[p:p+4] == b'mhod':
                mt = struct.unpack_from('<I', extra_mhods, p + 8)[0]
                mhod_count += 1
                p += mt
            else:
                break

    struct.pack_into('<I', hdr, 0x0C, mhod_count)
    struct.pack_into('<I', hdr, 8, len(hdr) + len(mhods))   # total_len
    return bytes(hdr) + bytes(mhods)


def build_sort_mhod(sort_key, sorted_indices):
    """Build a type-52 sort index mhod for the master playlist.
    sorted_indices: list of 0-based track indices in sorted order.
    """
    num = len(sorted_indices)
    header_size = 72   # 72-byte header as seen in existing iPod DBs
    total = header_size + num * 4
    rec = bytearray(total)
    struct.pack_into('<4s', rec, 0, b'mhod')
    struct.pack_into('<I', rec, 4, 24)          # header_len (standard mhod)
    struct.pack_into('<I', rec, 8, total)       # total_len
    struct.pack_into('<I', rec, 12, 52)         # type = 52
    struct.pack_into('<I', rec, 24, sort_key)   # sort key
    struct.pack_into('<I', rec, 28, num)        # entry count
    # Bytes 32-71 are zero padding
    for i, idx in enumerate(sorted_indices):
        struct.pack_into('<I', rec, 72 + i * 4, idx)
    return bytes(rec)


def _sort_indices(tracks, sort_key):
    """Return list of track indices sorted by the given sort key."""
    def key_fn(idx):
        t = tracks[idx]
        if sort_key == 3:  # album
            return (str(t.get('album', '') or '').lower(),
                    int(t.get('discNumber', 0) or 0),
                    int(t.get('trackNumber', 0) or 0))
        elif sort_key == 4:  # artist
            return (str(t.get('artist', '') or '').lower(),
                    str(t.get('album', '') or '').lower(),
                    int(t.get('discNumber', 0) or 0),
                    int(t.get('trackNumber', 0) or 0))
        elif sort_key == 5:  # genre
            return (str(t.get('genre', '') or '').lower(),
                    str(t.get('artist', '') or '').lower(),
                    str(t.get('album', '') or '').lower())
        elif sort_key == 7:  # title
            return (str(t.get('title', '') or '').lower(),)
        elif sort_key == 18:  # artist + album + track (secondary sort)
            return (str(t.get('artist', '') or '').lower(),
                    str(t.get('album', '') or '').lower(),
                    int(t.get('discNumber', 0) or 0),
                    int(t.get('trackNumber', 0) or 0))
        elif sort_key in (35, 36):  # album artist / composer sort
            return (str(t.get('artist', '') or '').lower(),
                    str(t.get('album', '') or '').lower(),
                    int(t.get('trackNumber', 0) or 0))
        return (idx,)  # unknown key — preserve insertion order

    indices = list(range(len(tracks)))
    indices.sort(key=key_fn)
    return indices


def build_mhyp_record(name, dbids, is_master, template_header=None,
                       template_mhods=None, sort_mhods=None):
    """Build an mhyp playlist record with mhip items.
    template_header:  existing 184-byte mhyp header to reuse (preserves playlist ID, flags).
    template_mhods:   tuple of (type100_bytes, type102_bytes) from existing DB.
    sort_mhods:       list of type-52 sort index mhod bytes (master playlist only).
    """
    hlen = 184
    if template_header and len(template_header) >= hlen:
        # Reuse existing header — preserves playlist ID, flags, timestamps
        hdr = bytearray(template_header[:hlen])
    else:
        hdr = bytearray(hlen)
        struct.pack_into('<4s', hdr, 0, b'mhyp')
        struct.pack_into('<I', hdr, 4, hlen)
        # Generate a unique 64-bit playlist ID
        struct.pack_into('<Q', hdr, 0x18, random.getrandbits(64))
        struct.pack_into('<I', hdr, 0x28, 1)   # visible flag
        struct.pack_into('<I', hdr, 0x2C, 1)   # sort order

    struct.pack_into('<I', hdr, 0x14, 1 if is_master else 0)
    struct.pack_into('<I', hdr, 0x10, len(dbids))

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

    # Type-52 sort index mhods (master playlist)
    if sort_mhods:
        for sm in sort_mhods:
            mhods += sm
            mhod_count += 1

    struct.pack_into('<I', hdr, 0x0C, mhod_count)

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

    # ── Build path → dbid, path → per-track mhit header, path → extra mhods ──
    path_to_dbid = {}
    path_to_mhit = {}
    path_to_extra_mhods = {}   # mhods we don't rebuild (composer, comment, artwork refs, etc.)
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
        # Save this track's own mhit header (preserves codec, bitrate, sample rate, etc.)
        track_mhit_hdr = bytes(existing[tp:tp+h])
        mc = struct.unpack_from('<I', existing, tp + 12)[0]
        mp = tp + h
        track_path = None
        extra_mhods = bytearray()
        for _ in range(mc):
            if existing[mp:mp+4] == b'mhod':
                mt   = struct.unpack_from('<I', existing, mp + 8)[0]
                mtyp = struct.unpack_from('<I', existing, mp + 12)[0]
                if mtyp == 2:  # path
                    slen = struct.unpack_from('<I', existing, mp + 28)[0]
                    if slen > 0:
                        track_path = existing[mp+40:mp+40+slen].decode('utf-16-le', errors='replace').rstrip('\x00')
                # Preserve mhods we don't rebuild (composer, comment, sort fields, artwork, etc.)
                if mtyp not in REBUILT_MHOD_TYPES:
                    extra_mhods += existing[mp:mp+mt]
                mp += mt
            else:
                break
        if track_path:
            path_to_dbid[track_path] = dbid
            path_to_mhit[track_path] = track_mhit_hdr
            if extra_mhods:
                path_to_extra_mhods[track_path] = bytes(extra_mhods)
        tp += t

    # ── Extract existing playlist headers & mhods ──
    master_mhyp_hdr = None
    template_t100 = None
    template_t102 = None
    existing_sort_keys = []
    name_to_mhyp_hdr = {}   # map playlist name → its 184-byte mhyp header

    for sec in sections:
        if sec['type'] not in (2, 3):
            continue
        mhlp_pos = sec['start'] + sec['hlen']
        if existing[mhlp_pos:mhlp_pos+4] != b'mhlp':
            continue
        mhlp_hlen = struct.unpack_from('<I', existing, mhlp_pos + 4)[0]
        pl_count = struct.unpack_from('<I', existing, mhlp_pos + 8)[0]

        yp = mhlp_pos + mhlp_hlen
        for _ in range(pl_count):
            if existing[yp:yp+4] != b'mhyp':
                break
            yh = struct.unpack_from('<I', existing, yp + 4)[0]
            yt = struct.unpack_from('<I', existing, yp + 8)[0]
            mc = struct.unpack_from('<I', existing, yp + 0x0C)[0]
            is_master_flag = struct.unpack_from('<I', existing, yp + 0x14)[0]

            pl_hdr = bytes(existing[yp:yp+yh])

            # Parse mhods to get name, type-100/102 templates, and sort key list
            cp = yp + yh
            pl_name = None
            for _ in range(mc):
                if existing[cp:cp+4] != b'mhod':
                    break
                mt = struct.unpack_from('<I', existing, cp + 8)[0]
                mtyp = struct.unpack_from('<I', existing, cp + 12)[0]

                if mtyp == 1:  # name string
                    slen = struct.unpack_from('<I', existing, cp + 28)[0]
                    if slen > 0:
                        pl_name = existing[cp+40:cp+40+slen].decode('utf-16-le', errors='replace').rstrip('\x00')
                if mtyp == 100 and not template_t100:
                    template_t100 = bytes(existing[cp:cp+mt])
                elif mtyp == 102 and not template_t102:
                    template_t102 = bytes(existing[cp:cp+mt])
                if is_master_flag and mtyp == 52:
                    sort_key = struct.unpack_from('<I', existing, cp + 24)[0]
                    if sort_key not in existing_sort_keys:
                        existing_sort_keys.append(sort_key)
                cp += mt

            if is_master_flag and not master_mhyp_hdr:
                master_mhyp_hdr = pl_hdr
            elif not is_master_flag and pl_name:
                name_to_mhyp_hdr[pl_name] = pl_hdr
            yp += yt
        break  # Only need one playlist section for templates

    if existing_sort_keys:
        print(f"Existing sort keys: {existing_sort_keys}", file=sys.stderr)
    else:
        existing_sort_keys = [3, 4, 5, 7, 18, 35, 36]
        print("No existing sort keys found, using defaults: [3,4,5,7,18,35,36]", file=sys.stderr)

    template_pl_mhods = (template_t100, template_t102)
    print(f"Template mhods: type100={len(template_t100) if template_t100 else 0}b, "
          f"type102={len(template_t102) if template_t102 else 0}b", file=sys.stderr)
    print(f"Master mhyp header: {'reused' if master_mhyp_hdr else 'new'}", file=sys.stderr)
    print(f"Matched {len(name_to_mhyp_hdr)} existing playlist headers by name", file=sys.stderr)

    # ── Assign dbids ──
    #
    # Each library entry must end up with a UNIQUE dbid in this sync. The
    # mhit record uses it, AND the master library playlist's mhip records
    # use it — so if two entries share a dbid, the iPod hardware "Songs"
    # view (which walks mhip and dedupes by dbid) silently collapses them
    # and reports "1 of N-k" instead of "1 of N". User-visible symptom:
    # iTunesDB has 4550 tracks, click-wheel hardware shows "1 of 4542".
    #
    # The collision source is `path_to_dbid` itself — built from the
    # existing iTunesDB. If a prior sync ever wrote two different paths
    # with the same dbid (which has happened in this codebase's history),
    # both library entries pointing at those paths inherit the duplicate
    # dbid and we propagate the bug forward forever.
    #
    # Defense: track which dbids we've already claimed in this sync. If
    # the prior dbid is already taken, allocate a fresh one. The mhit
    # record + the mhip reference both pull from track_dbids, so this
    # one fix-up keeps both consistent.
    track_dbids = {}
    used_dbids = set()
    collisions = 0
    next_dbid = max_dbid + 2
    for t in tracks:
        path = t.get('path', '')
        candidate = path_to_dbid.get(path)
        if candidate is None or candidate in used_dbids:
            if candidate is not None and candidate in used_dbids:
                collisions += 1
            candidate = next_dbid
            next_dbid += 2
        track_dbids[t['id']] = candidate
        used_dbids.add(candidate)
    if collisions > 0:
        print(f"dbid collision dedupe: reassigned {collisions} duplicate dbids", file=sys.stderr)

    reused = sum(1 for t in tracks if t.get('path', '') in path_to_mhit)
    new_count = len(tracks) - reused
    extra_count = sum(1 for t in tracks if t.get('path', '') in path_to_extra_mhods)
    print(f"Existing: {ex_count} tracks, max_dbid={max_dbid}", file=sys.stderr)
    print(f"Writing: {len(tracks)} tracks ({reused} reused headers, {new_count} new, {extra_count} with preserved extra mhods)", file=sys.stderr)

    # ── Build type 1: track list ──
    mhlt = bytearray(92)
    struct.pack_into('<4s', mhlt, 0, b'mhlt')
    struct.pack_into('<I', mhlt, 4, 92)
    struct.pack_into('<I', mhlt, 8, len(tracks))

    track_data = bytearray(mhlt)
    for t in tracks:
        # Use track's own existing mhit header if available (preserves codec, bitrate, etc.)
        path = t.get('path', '')
        is_new = path not in path_to_mhit
        per_track_hdr = path_to_mhit.get(path, template_mhit)
        extra_mhods = path_to_extra_mhods.get(path)
        track_data += build_mhit_record(t, track_dbids[t['id']], per_track_hdr,
                                         extra_mhods=extra_mhods, is_new=is_new)

    type1_mhsd = bytearray(96)
    struct.pack_into('<4s', type1_mhsd, 0, b'mhsd')
    struct.pack_into('<I', type1_mhsd, 4, 96)
    struct.pack_into('<I', type1_mhsd, 8, 96 + len(track_data))
    struct.pack_into('<I', type1_mhsd, 12, 1)
    type1_section = bytes(type1_mhsd) + bytes(track_data)

    # ── Build type-52 sort index mhods for master playlist ──
    sort_mhods = []
    for sk in existing_sort_keys:
        sorted_idx = _sort_indices(tracks, sk)
        sort_mhods.append(build_sort_mhod(sk, sorted_idx))
    print(f"Built {len(sort_mhods)} type-52 sort index mhods", file=sys.stderr)

    # ── Build playlist data (shared by types 2 and 3) ──
    all_dbids = [track_dbids[t['id']] for t in tracks]
    total_pl = 1 + len(playlists)

    mhlp = bytearray(92)
    struct.pack_into('<4s', mhlp, 0, b'mhlp')
    struct.pack_into('<I', mhlp, 4, 92)
    struct.pack_into('<I', mhlp, 8, total_pl)

    pl_data = bytearray(mhlp)
    pl_data += build_mhyp_record('', all_dbids, is_master=True,
                                  template_header=master_mhyp_hdr,
                                  template_mhods=template_pl_mhods,
                                  sort_mhods=sort_mhods)
    for pl in playlists:
        pl_name = pl.get('name', '')
        pl_dbids = [track_dbids[tid] for tid in pl.get('trackIds', []) if tid in track_dbids]
        existing_hdr = name_to_mhyp_hdr.get(pl_name)
        pl_data += build_mhyp_record(pl_name, pl_dbids, is_master=False,
                                      template_header=existing_hdr,
                                      template_mhods=template_pl_mhods)

    def wrap_mhsd(typ, payload):
        h = bytearray(96)
        struct.pack_into('<4s', h, 0, b'mhsd')
        struct.pack_into('<I', h, 4, 96)
        struct.pack_into('<I', h, 8, 96 + len(payload))
        struct.pack_into('<I', h, 12, typ)
        return bytes(h) + bytes(payload)

    type2_section = wrap_mhsd(2, pl_data)
    type3_section = wrap_mhsd(3, pl_data)

    # ── Build mhsd type 4 (album list) from current library data ──
    #
    # Prior versions of write_itunesdb copied mhsd type 4 verbatim from the
    # existing template, which meant the iPod's "Music > Artists/Albums"
    # views never picked up newly-imported albums until the album list was
    # rebuilt by some other tool. The 2026-04-26 investigation traced
    # missing artists (Hannah Jadagu et al.) on the iPod to this exact
    # gap — current library had ~787 albums but the on-iPod mhia list
    # was frozen at 211.
    #
    # Each mhia record is 0x58 bytes of header + 0..3 child mhods. The
    # mhia mhod types are 200=album, 201=artist, 202=albumArtist (NOT
    # the same as track-mhod types 1/2/3/4/5 — different namespace).
    seen_albums = set()
    album_tuples = []
    for t in tracks:
        artist_str = (t.get('artist', '') or '').strip()
        albumartist_str = (t.get('albumArtist', '') or t.get('artist', '') or '').strip()
        album_str = (t.get('album', '') or '').strip()
        if not album_str:
            continue
        key = (albumartist_str.lower(), album_str.lower())
        if key in seen_albums:
            continue
        seen_albums.add(key)
        album_tuples.append((artist_str, albumartist_str, album_str))

    def build_album_mhod(mhod_type, s):
        sb = s.encode('utf-16-le')
        rec = bytearray(0x28)
        struct.pack_into('<4s', rec, 0x00, b'mhod')
        struct.pack_into('<I', rec, 0x04, 0x18)
        struct.pack_into('<I', rec, 0x08, 0x28 + len(sb))
        struct.pack_into('<I', rec, 0x0C, mhod_type)
        struct.pack_into('<I', rec, 0x18, 0x00000001)
        struct.pack_into('<I', rec, 0x1C, len(sb))
        struct.pack_into('<I', rec, 0x20, 0x00000001)
        return bytes(rec) + sb

    def build_mhia(album_id, artist, album_artist, album):
        children = b''
        n = 0
        if album:
            children += build_album_mhod(200, album); n += 1
        if artist:
            children += build_album_mhod(201, artist); n += 1
        if album_artist:
            children += build_album_mhod(202, album_artist); n += 1
        hdr = bytearray(0x58)
        struct.pack_into('<4s', hdr, 0x00, b'mhia')
        struct.pack_into('<I', hdr, 0x04, 0x58)
        struct.pack_into('<I', hdr, 0x08, 0x58 + len(children))
        struct.pack_into('<I', hdr, 0x0C, n)
        struct.pack_into('<I', hdr, 0x10, album_id)
        return bytes(hdr) + children

    mhia_blocks = b''
    for i, (a, aa, al) in enumerate(album_tuples, start=1):
        mhia_blocks += build_mhia(0x100000 + i, a, aa, al)

    mhla = bytearray(92)
    struct.pack_into('<4s', mhla, 0, b'mhla')
    struct.pack_into('<I', mhla, 4, 92)
    struct.pack_into('<I', mhla, 8, len(album_tuples))
    type4_section = wrap_mhsd(4, bytes(mhla) + mhia_blocks)
    print(f"Built mhsd type 4 with {len(album_tuples)} albums", file=sys.stderr)

    # ── Assemble final database ──
    body = bytearray()
    for sec in sections:
        if sec['type'] == 1:
            body += type1_section
        elif sec['type'] == 2:
            body += type2_section
        elif sec['type'] == 3:
            body += type3_section
        elif sec['type'] == 4:
            body += type4_section
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
