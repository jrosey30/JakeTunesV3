"""
Album artwork for colour-screen iPods: ArtworkDB + .ithmb thumbnails.

Until this module the desktop sync wrote no artwork at all, so a colour iPod
(Jake's "iBANDCAMP", an iPod Video) showed no covers. db_reader.write_itunesdb
calls in here when it is given an --artwork-out directory; the files land
there on the Mac first and the sync copies them onto the iPod
(src/main/ipod-artwork.ts), the same way the catalog itself travels.

Only models whose formats were checked against libgpod are listed. Anything
else (every mini, the 1G-4G, an unknown or unreadable SysInfo) gets nothing:
no ArtworkDB, no change to a single mhit byte.

Byte layouts follow libgpod (strawberry-libgpod master, src/):
  - itdb_device.c   ipod_info_table: "A002", "A146", "A003", "A147", "A452"
                    are ITDB_IPOD_GENERATION_VIDEO_1; "A444", "A446", "A664",
                    "A448", "A450" are VIDEO_2. Both generations map to
                    ipod_video_cover_art_info = {1028, 100x100, RGB565_LE},
                    {1029, 200x200, RGB565_LE}, padding 0.
                    itdb_device_supports_sparse_artwork: FALSE for VIDEO_1/2.
                    The cover formats list is built with g_list_prepend, so
                    the mhlf lists the table reversed.
  - db-artwork-writer.c
                    non-sparse ipod_artwork_db_set_ids: every track with art
                    gets its OWN artwork id, consecutively from 0x64, and
                    mhii_link = that id; write_mhii: song_id = track dbid
                    (mhit +0x70), orig_img_size = artwork_size (the track's
                    + 1, itdb_track.c); write_mhfd: unknown2 = 2,
                    next_id = highest id, unknown_flag1 = 2; mhsd 1/2/3 =
                    mhli / mhla (empty) / mhlf.
  - ithumb-writer.c fit inside the format keeping the aspect (crop = FALSE),
                    pad centred, width/height include the leading padding;
                    a new F<id>_<n>.ithmb file every 256,000,000 bytes.
  - itdb_track.c    with art: artwork_count 1, artwork_size = image file
                    bytes, has_artwork 1; without: 0, 0, has_artwork 2.

The reference that works on real hardware is ~/bin/guest_ipod_sync.py (nano
3G); the records here are its records with the Video's formats and the
non-sparse id rule.

What libgpod does NOT settle, and only a real iPod Video will: whether its
firmware is happy with several mhii records pointing at the SAME ithmb offset.
JakeTunes keys covers by album, so the pixels are written once per cover and
every song of the album points at them; libgpod writes a copy per song.
The firmware reads offset + size from the mhni, so sharing should be fine.
"""

from __future__ import annotations

import io
import os
import struct
import time

MAC_EPOCH = 2082844800
ARTWORK_MIN_ID = 0x64            # db-artwork-writer.c ipod_artwork_db_set_ids
ITHUMB_MAX_SIZE = 256 * 1000 * 1000   # itdb_private.h

# mhit offsets (libgpod mk_mhit). Only the artwork fields are written here.
MHIT_DBID = 0x70                 # 64-bit, what the ArtworkDB's song_id names
MHIT_ARTWORK_COUNT = 0x7C        # u16
MHIT_ARTWORK_SIZE = 0x80         # u32
MHIT_HAS_ARTWORK = 0xA4          # u8: 1 = has, 2 = none
MHIT_MHII_LINK = 0x160           # u32, only when the header reaches it

# itdb_device.c ipod_video_cover_art_info, table order. (format_id, w, h)
VIDEO_COVER_FORMATS = ((1028, 100, 100), (1029, 200, 200))

# itdb_device.c ipod_info_table, the model number without its leading letter.
VIDEO_MODEL_NUMBERS = {
    'A002', 'A146', 'A003', 'A147', 'A452',          # VIDEO_1 (5G)
    'A444', 'A446', 'A664', 'A448', 'A450',          # VIDEO_2 (5.5G)
}

COVER_FORMATS = {'video': VIDEO_COVER_FORMATS}


# --------------------------------------------------------------------------
# which iPod
# --------------------------------------------------------------------------

def parse_sysinfo(text):
    """iPod_Control/Device/SysInfo is 'Key: value' lines."""
    out = {}
    for line in (text or '').splitlines():
        if ':' not in line:
            continue
        k, v = line.split(':', 1)
        k, v = k.strip(), v.strip()
        if k and v:
            out[k] = v
    return out


def model_from_sysinfo(text):
    """'video' for an iPod Video (5G / 5.5G), else None. Like libgpod, the
    ModelNumStr's leading letter (M, P, x...) is dropped and the next four
    characters name the model."""
    num = parse_sysinfo(text).get('ModelNumStr', '')
    if num[:1].isalpha():
        num = num[1:]
    return 'video' if num[:4].upper() in VIDEO_MODEL_NUMBERS else None


def artwork_model_for_ipod(ipod_root):
    """(model, why). model is None for anything that must get no artwork."""
    if not ipod_root:
        return None, 'no iPod root given'
    path = os.path.join(ipod_root, 'iPod_Control', 'Device', 'SysInfo')
    try:
        with open(path, 'r', encoding='utf-8', errors='replace') as f:
            text = f.read()
    except OSError as e:
        return None, 'no readable SysInfo (%s)' % type(e).__name__
    model = model_from_sysinfo(text)
    if model is None:
        num = parse_sysinfo(text).get('ModelNumStr') or '(none)'
        return None, 'model %s has no artwork formats JakeTunes knows' % num
    return model, 'ModelNumStr %s' % parse_sysinfo(text).get('ModelNumStr')


# --------------------------------------------------------------------------
# pixels
# --------------------------------------------------------------------------

def _pil():
    from PIL import Image, ImageOps  # noqa: WPS433 — optional dependency
    return Image, ImageOps


def scaled_cover(img, w, h):
    """ithumb_writer_scale_and_crop (crop = FALSE): fit inside w x h keeping
    the aspect ratio."""
    Image, _ = _pil()
    iw, ih = img.size
    ws, hs = w / iw, h / ih
    if ws < hs:
        sw, sh = w, min(int(-(-ih * ws // 1)), h)
    elif ws > hs:
        sw, sh = min(int(-(-iw * hs // 1)), w), h
    else:
        sw, sh = w, h
    lanczos = getattr(getattr(Image, 'Resampling', Image), 'LANCZOS')
    return img.resize((max(1, sw), max(1, sh)), lanczos)


def rgb_to_rgb565_le(raw):
    """Packed RGB bytes -> RGB565 little-endian bytes."""
    try:
        import numpy as np
    except ImportError:
        np = None
    if np is not None:
        a = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3).astype(np.uint16)
        v = ((a[:, 0] >> 3) << 11) | ((a[:, 1] >> 2) << 5) | (a[:, 2] >> 3)
        return v.astype('<u2').tobytes()
    out = bytearray(len(raw) // 3 * 2)
    j = 0
    for i in range(0, len(raw), 3):
        v = ((raw[i] >> 3) << 11) | ((raw[i + 1] >> 2) << 5) | (raw[i + 2] >> 3)
        out[j] = v & 0xFF
        out[j + 1] = v >> 8
        j += 2
    return bytes(out)


def pack_thumb(img, W, H):
    """pack_RGB_565 on a black W x H canvas. Returns (bytes, hpad, vpad,
    width_incl_pad, height_incl_pad)."""
    Image, _ = _pil()
    w, h = img.size
    hpad, vpad = (W - w) // 2, (H - h) // 2
    canvas = Image.new('RGB', (W, H), (0, 0, 0))
    canvas.paste(img, (hpad, vpad))
    data = rgb_to_rgb565_le(canvas.tobytes())
    assert len(data) == W * H * 2
    return data, hpad, vpad, hpad + w, vpad + h


def render_thumbs(image_bytes, formats):
    """One cover -> one thumbnail per format, in table order."""
    Image, ImageOps = _pil()
    img = Image.open(io.BytesIO(image_bytes))
    img = ImageOps.exif_transpose(img).convert('RGB')
    thumbs = []
    for fid, W, H in formats:
        data, hpad, vpad, w, h = pack_thumb(scaled_cover(img, W, H), W, H)
        thumbs.append({'format_id': fid, 'data': data, 'hpad': hpad, 'vpad': vpad,
                       'width': w, 'height': h})
    return thumbs


def prepare_covers(tracks, formats, log, read=None):
    """Read and shrink each distinct cover once. Returns
    {track_id: cover} where cover = {'key', 'size', 'thumbs'}; tracks with no
    cover, or one that can't be read or decoded, are left out (no art).
    `read` is the file reader (tests pass their own)."""
    read = read or _read_file
    covers, by_track, failed = {}, {}, 0
    for t in tracks:
        path = t.get('artworkPath')
        if not path or not isinstance(path, str):
            continue
        key = os.path.realpath(path)
        if key not in covers:
            try:
                raw = read(key)
                covers[key] = {'key': key, 'size': len(raw), 'thumbs': render_thumbs(raw, formats)}
            except Exception as e:  # noqa: BLE001 — a bad cover costs only its album
                covers[key] = None
                failed += 1
                log('artwork: could not use %s (%s: %s)' % (os.path.basename(key), type(e).__name__, e))
        if covers[key] is not None:
            by_track[t['id']] = covers[key]
    log('artwork: %d cover(s) for %d of %d song(s)%s'
        % (sum(1 for c in covers.values() if c), len(by_track), len(tracks),
           ', %d unreadable' % failed if failed else ''))
    return by_track


def _read_file(path):
    with open(path, 'rb') as f:
        return f.read()


# --------------------------------------------------------------------------
# mhit fields
# --------------------------------------------------------------------------

def song_id_of(mhit):
    """The 64-bit id at mhit +0x70, exactly as the record carries it."""
    return struct.unpack_from('<Q', mhit, MHIT_DBID)[0]


def patch_mhit_artwork(mhit, image_id, artwork_size):
    """Set the artwork fields of one built mhit record. image_id 0 = none.
    Touches only +0x7C, +0x80, +0xA4 and (when the header reaches it)
    +0x160; nothing else in the record moves."""
    rec = bytearray(mhit)
    hlen = struct.unpack_from('<I', rec, 4)[0]
    if hlen < MHIT_HAS_ARTWORK + 1:
        return bytes(rec)
    if image_id:
        struct.pack_into('<H', rec, MHIT_ARTWORK_COUNT, 1)
        struct.pack_into('<I', rec, MHIT_ARTWORK_SIZE, artwork_size)
        rec[MHIT_HAS_ARTWORK] = 1
    else:
        struct.pack_into('<H', rec, MHIT_ARTWORK_COUNT, 0)
        struct.pack_into('<I', rec, MHIT_ARTWORK_SIZE, 0)
        rec[MHIT_HAS_ARTWORK] = 2
    if hlen >= MHIT_MHII_LINK + 4:
        struct.pack_into('<I', rec, MHIT_MHII_LINK, image_id or 0)
    return bytes(rec)


# --------------------------------------------------------------------------
# ArtworkDB + .ithmb (db-artwork-writer.c / ithumb-writer.c)
# --------------------------------------------------------------------------

def _u16(v): return struct.pack('<H', v & 0xFFFF)
def _u32(v): return struct.pack('<I', v & 0xFFFFFFFF)
def _u64(v): return struct.pack('<Q', v & 0xFFFFFFFFFFFFFFFF)


def _mhod_type3(s):
    enc = s.encode('utf-16-le')
    pad = (4 - ((36 + len(enc)) % 4)) % 4
    total = 36 + len(enc) + pad
    return (b'mhod' + _u32(24) + _u32(total) + _u16(3) + bytes([0, pad])
            + bytes(8) + _u32(len(enc)) + bytes([2, 0]) + _u16(0) + _u32(0) + enc + bytes(pad))


def _mhni(th):
    child = _mhod_type3(th['filename'])
    hdr = (b'mhni' + _u32(0x4C) + _u32(0x4C + len(child)) + _u32(1) + _u32(th['format_id'])
           + _u32(th['offset']) + _u32(th['size']) + _u16(th['vpad']) + _u16(th['hpad'])
           + _u16(th['height']) + _u16(th['width']))
    hdr += bytes(0x4C - len(hdr))
    return hdr + child


def _mhod_container(th):
    inner = _mhni(th)
    return b'mhod' + _u32(24) + _u32(24 + len(inner)) + _u16(2) + _u16(0) + bytes(8) + inner


def build_artwork_db(entries, formats, now=None):
    """entries: [{'id', 'song_id', 'cover'}] in id order, cover as from
    prepare_covers. Each distinct cover's pixels go into the .ithmb once.
    Returns (artworkdb_bytes, {filename: ithmb_bytes})."""
    now = int(time.time()) if now is None else now
    files = {}                       # name -> bytearray
    current = {fid: 1 for fid, _, _ in formats}
    placed = {}                      # (cover key, format id) -> thumb record
    for e in entries:
        e['_thumbs'] = []
        for th in e['cover']['thumbs']:
            fid = th['format_id']
            k = (e['cover']['key'], fid)
            if k not in placed:
                name = 'F%d_%d.ithmb' % (fid, current[fid])
                buf = files.setdefault(name, bytearray())
                if len(buf) >= ITHUMB_MAX_SIZE:
                    current[fid] += 1
                    name = 'F%d_%d.ithmb' % (fid, current[fid])
                    buf = files.setdefault(name, bytearray())
                placed[k] = {'format_id': fid, 'offset': len(buf), 'size': len(th['data']),
                             'hpad': th['hpad'], 'vpad': th['vpad'],
                             'width': th['width'], 'height': th['height'],
                             'filename': ':' + name}
                buf += th['data']
            e['_thumbs'].append(placed[k])

    mac_now = now + MAC_EPOCH
    mhii_list = b''
    for e in entries:
        kids = b''.join(_mhod_container(th) for th in e['_thumbs'])
        hdr = (b'mhii' + _u32(0x98) + _u32(0x98 + len(kids)) + _u32(len(e['_thumbs']))
               + _u32(e['id']) + _u64(e['song_id']) + _u32(0) + _u32(0) + _u32(0)
               + _u32(mac_now) + _u32(0) + _u32(e['cover']['size'] + 1))
        hdr += bytes(0x98 - len(hdr))
        mhii_list += hdr + kids
        del e['_thumbs']
    mhli = b'mhli' + _u32(0x5C) + _u32(len(entries)) + bytes(0x5C - 12) + mhii_list
    mhla = b'mhla' + _u32(0x5C) + _u32(0) + bytes(0x5C - 12)
    mhifs = b''
    for fid, W, H in reversed(formats):   # g_list_prepend: the table reversed
        mhifs += b'mhif' + _u32(0x7C) + _u32(0x7C) + _u32(0) + _u32(fid) + _u32(W * H * 2) + bytes(0x7C - 24)
    mhlf = b'mhlf' + _u32(0x5C) + _u32(len(formats)) + bytes(0x5C - 12) + mhifs

    def a_mhsd(index, payload):
        return b'mhsd' + _u32(0x60) + _u32(0x60 + len(payload)) + _u16(index) + _u16(0) + bytes(0x60 - 16) + payload

    sds = a_mhsd(1, mhli) + a_mhsd(2, mhla) + a_mhsd(3, mhlf)
    id_max = entries[-1]['id'] if entries else 0
    hdr = bytearray(b'mhfd' + _u32(0x84) + _u32(0) + _u32(0) + _u32(2) + _u32(3) + _u32(0)
                    + _u32(id_max) + _u64(0) + _u64(0) + bytes([2, 0, 0, 0]))
    hdr += bytes(0x84 - len(hdr))
    db = bytearray(hdr + sds)
    struct.pack_into('<I', db, 8, len(db))
    return bytes(db), {name: bytes(buf) for name, buf in files.items() if buf}


def parse_artworkdb(data):
    """Independent reader: raises ValueError on any structural problem."""
    def chk(cond, msg):
        if not cond:
            raise ValueError(msg)
    chk(data[:4] == b'mhfd', 'not mhfd')
    hl, total, _, unk2, nchild, _, next_id = struct.unpack_from('<IIIIIII', data, 4)
    chk(total == len(data), 'mhfd total %d != %d' % (total, len(data)))
    res = {'header_len': hl, 'next_id': next_id, 'unknown2': unk2, 'images': [], 'formats': [], 'mhsd': []}
    pos = hl
    for _ in range(nchild):
        chk(data[pos:pos + 4] == b'mhsd', 'mhsd at %d' % pos)
        shl, stot = struct.unpack_from('<II', data, pos + 4)
        index = struct.unpack_from('<H', data, pos + 12)[0]
        res['mhsd'].append(index)
        lp = pos + shl
        lhl, cnt = struct.unpack_from('<II', data, lp + 4)
        p = lp + lhl
        for _ in range(cnt):
            if index == 1:
                chk(data[p:p + 4] == b'mhii', 'mhii')
                mhl, mtot, mkids, img_id, song_id = struct.unpack_from('<IIIIQ', data, p + 4)
                orig = struct.unpack_from('<I', data, p + 48)[0]
                thumbs = []
                q = p + mhl
                for _ in range(mkids):
                    chk(data[q:q + 4] == b'mhod' and struct.unpack_from('<H', data, q + 12)[0] == 2, 'mhod2')
                    ohl, otot = struct.unpack_from('<II', data, q + 4)
                    n = q + ohl
                    chk(data[n:n + 4] == b'mhni', 'mhni')
                    nhl, ntot, nk, fid, off, size, vp, hp, hh, ww = struct.unpack_from('<IIIIIIHHHH', data, n + 4)
                    s = n + nhl
                    chk(data[s:s + 4] == b'mhod' and struct.unpack_from('<H', data, s + 12)[0] == 3, 'mhod3')
                    slen = struct.unpack_from('<I', data, s + 24)[0]
                    enc = data[s + 28]
                    fname = data[s + 36:s + 36 + slen].decode('utf-16-le' if enc == 2 else 'utf-8')
                    chk(n + ntot == q + otot, 'mhni/mhod size')
                    thumbs.append({'format_id': fid, 'offset': off, 'size': size, 'vpad': vp,
                                   'hpad': hp, 'height': hh, 'width': ww, 'filename': fname,
                                   'mhni_header_len': nhl})
                    q += otot
                chk(q == p + mtot, 'mhii size')
                res['images'].append({'id': img_id, 'song_id': song_id, 'orig_size': orig,
                                      'header_len': mhl, 'thumbs': thumbs})
                p += mtot
            elif index == 3:
                chk(data[p:p + 4] == b'mhif', 'mhif')
                fhl, ftot, _, fid, isz = struct.unpack_from('<IIIII', data, p + 4)
                res['formats'].append((fid, isz))
                p += ftot
            else:
                raise ValueError('unexpected album list entries')
        chk(p == pos + stot, 'artwork mhsd %d size' % index)
        pos += stot
    chk(pos == len(data), 'artwork trailing bytes')
    return res


def write_artwork_dir(out_dir, db, files):
    """Write ArtworkDB + ithmbs into a fresh local directory. Any old
    contents are removed first, so the directory holds exactly one set."""
    os.makedirs(out_dir, exist_ok=True)
    for name in os.listdir(out_dir):
        try:
            os.unlink(os.path.join(out_dir, name))
        except OSError:
            pass
    for name, data in sorted(files.items()):
        _atomic_write(os.path.join(out_dir, name), data)
    # ArtworkDB last: its presence is what says "a complete set is here".
    _atomic_write(os.path.join(out_dir, 'ArtworkDB'), db)


def clear_artwork_dir(out_dir):
    try:
        for name in os.listdir(out_dir):
            try:
                os.unlink(os.path.join(out_dir, name))
            except OSError:
                pass
    except OSError:
        pass


def _atomic_write(path, data):
    tmp = path + '.tmp-%d' % os.getpid()
    with open(tmp, 'wb') as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
