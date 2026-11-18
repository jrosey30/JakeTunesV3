#!/usr/bin/env python3
"""
Album artwork for colour iPods (core/ipod_artwork.py, db_reader --artwork-out).

1. An ArtworkDB for 3 fake songs (two share an album cover) parses back:
   record sizes, ids, song ids, offsets, image byte counts = w*h*2, and the
   .ithmb files hold every thumbnail at the offset the DB names.
2. An iPod Video's SysInfo picks the Video formats; a mini, a 3G, an empty
   or missing SysInfo pick nothing.
3. Through the real writer: an iPod Video gets an ArtworkDB and mhits
   that point at it; a mini gets NO artwork file and the exact same
   iTunesDB bytes as a sync without --artwork-out.

Builds everything in a temp folder. Never reads or writes an iPod.
Parts 1 and 2 need only the standard library; part 3 needs Pillow and is
skipped (and says so) without it.

Run:  python3 core/tests/test_ipod_artwork.py
"""
import io
import json
import os
import struct
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import ipod_artwork as A  # noqa: E402
import db_reader  # noqa: E402

FAILURES = []

SYSINFO_VIDEO = 'BoardHwName: iPod M25\nModelNumStr: MA002\nvisibleBuildID: 0x01318000 (1.3)\n'
SYSINFO_VIDEO_55 = 'ModelNumStr: xA450\n'
SYSINFO_MINI = 'BoardHwName: iPod Q22B\nModelNumStr: M9803\nvisibleBuildID: 0x01418000 (1.4.1)\niPodFamily: 3\n'
SYSINFO_3G = 'BoardHwName: iPod Q14\nModelNumStr: M9245\n'


def check(label, cond, detail=''):
    print(f"  {'ok  ' if cond else 'FAIL'} {label}{'' if cond else '  ' + str(detail)}")
    if not cond:
        FAILURES.append(label)


def fake_cover(key, size, formats, shade):
    thumbs = []
    for fid, W, H in formats:
        thumbs.append({'format_id': fid, 'data': bytes([shade]) * (W * H * 2),
                       'hpad': 0, 'vpad': 0, 'width': W, 'height': H})
    return {'key': key, 'size': size, 'thumbs': thumbs}


def part_db():
    print('\n1. ArtworkDB for 3 songs parses back')
    F = A.VIDEO_COVER_FORMATS
    album = fake_cover('/art/a.jpg', 5000, F, 0x11)
    other = fake_cover('/art/b.jpg', 7000, F, 0x22)
    entries = [
        {'id': 0x64, 'song_id': 0x8000000000000001, 'cover': album},
        {'id': 0x65, 'song_id': 0x8000000000000002, 'cover': album},
        {'id': 0x66, 'song_id': 0x8000000000000003, 'cover': other},
    ]
    db, files = A.build_artwork_db(entries, F, now=1_700_000_000)
    p = A.parse_artworkdb(db)
    check('mhfd header is 0x84, unknown2 = 2', p['header_len'] == 0x84 and p['unknown2'] == 2, p['header_len'])
    check('mhfd total_len = file length', struct.unpack_from('<I', db, 8)[0] == len(db))
    check('three datasets 1/2/3', p['mhsd'] == [1, 2, 3], p['mhsd'])
    check('next_id = highest id (0x66)', p['next_id'] == 0x66, p['next_id'])
    check('one mhii per song (non-sparse)', [im['id'] for im in p['images']] == [0x64, 0x65, 0x66])
    check('song ids are the tracks\' 64-bit ids',
          [im['song_id'] for im in p['images']] == [e['song_id'] for e in entries])
    check('mhii header is 0x98', all(im['header_len'] == 0x98 for im in p['images']))
    check('mhni header is 0x4C', all(th['mhni_header_len'] == 0x4C for im in p['images'] for th in im['thumbs']))
    check('orig_img_size = file bytes + 1', [im['orig_size'] for im in p['images']] == [5001, 5001, 7001])
    check('mhlf lists 1029 then 1028 (libgpod prepend order), w*h*2 each',
          p['formats'] == [(1029, 200 * 200 * 2), (1028, 100 * 100 * 2)], p['formats'])
    check('two .ithmb files, F1028_1 and F1029_1', sorted(files) == ['F1028_1.ithmb', 'F1029_1.ithmb'], sorted(files))
    check('F1028_1 holds 2 covers of 100x100x2', len(files['F1028_1.ithmb']) == 2 * 20000, len(files['F1028_1.ithmb']))
    check('F1029_1 holds 2 covers of 200x200x2', len(files['F1029_1.ithmb']) == 2 * 80000, len(files['F1029_1.ithmb']))
    dims = {1028: (100, 100), 1029: (200, 200)}
    ok_sizes, ok_bytes = True, True
    for im in p['images']:
        for th in im['thumbs']:
            W, H = dims[th['format_id']]
            ok_sizes &= th['size'] == W * H * 2 and th['width'] == W and th['height'] == H
            blob = files[th['filename'].lstrip(':')]
            ok_bytes &= th['offset'] + th['size'] <= len(blob)
    check('every thumbnail is w*h*2 bytes and full size', ok_sizes)
    check('every thumbnail lies inside its .ithmb', ok_bytes)
    a, b = p['images'][0]['thumbs'], p['images'][1]['thumbs']
    check('two songs of one album share the same pixels (same offsets)',
          [t['offset'] for t in a] == [t['offset'] for t in b])
    c = p['images'][2]['thumbs']
    check('the other album sits after it', all(x['offset'] == y['offset'] + y['size'] for x, y in zip(c, a)))
    blob = files['F1029_1.ithmb']
    check('the second cover\'s bytes are its own', blob[c[1]['offset']:c[1]['offset'] + 4] == b'\x22' * 4)
    check('filenames are :F<id>_1.ithmb', all(th['filename'] == ':F%d_1.ithmb' % th['format_id']
                                               for im in p['images'] for th in im['thumbs']))

    # mhit patch: only the artwork bytes move
    hdr = bytearray(0x248)
    hdr[0:4] = b'mhit'
    struct.pack_into('<I', hdr, 4, 0x248)
    for i in range(16, 0x248):
        hdr[i] = (i * 7) & 0xFF
    patched = A.patch_mhit_artwork(bytes(hdr), 0x65, 5000)
    changed = {i for i in range(0x248) if patched[i] != hdr[i]}
    allowed = set(range(0x7C, 0x7E)) | set(range(0x80, 0x84)) | {0xA4} | set(range(0x160, 0x164))
    check('patch touches only +0x7C, +0x80, +0xA4, +0x160', changed <= allowed, sorted(changed - allowed))
    check('patched fields read back', struct.unpack_from('<H', patched, 0x7C)[0] == 1
          and struct.unpack_from('<I', patched, 0x80)[0] == 5000 and patched[0xA4] == 1
          and struct.unpack_from('<I', patched, 0x160)[0] == 0)  # libgpod Video: mhii_link 0
    def _bad(_p): raise OSError('no Pillow')
    got = A.prepare_covers([{'id': 1, 'artworkPath': '/x/a.jpg'}, {'id': 2, 'artworkPath': '/x/b.jpg'}],
                           A.VIDEO_COVER_FORMATS, lambda *_: None, read=_bad)
    check('every cover unreadable: None (iPod keeps its covers)', got is None, got)
    short = bytearray(0xD4)
    short[0:4] = b'mhit'
    struct.pack_into('<I', short, 4, 0xD4)
    p2 = A.patch_mhit_artwork(bytes(short), 0x64, 10)
    check('a 0xD4 header is not grown (no +0x160 there)', len(p2) == 0xD4 and p2[0xA4] == 1)
    check('no cover: has_artwork 2, count/size 0', A.patch_mhit_artwork(bytes(hdr), 0, 0)[0xA4] == 2)

    # a big set rolls over to F<id>_2.ithmb past 256,000,000 bytes
    saved = A.ITHUMB_MAX_SIZE
    try:
        A.ITHUMB_MAX_SIZE = 20000 * 2   # two 100x100 covers per file
        many = [{'id': 0x64 + i, 'song_id': i + 1, 'cover': fake_cover('/art/%d' % i, 10, F, i)} for i in range(3)]
        db3, files3 = A.build_artwork_db(many, F, now=0)
        p3 = A.parse_artworkdb(db3)
        names = [th['filename'] for th in p3['images'][2]['thumbs'] if th['format_id'] == 1028]
        check('past the size cap the next cover goes to F1028_2.ithmb at offset 0',
              names == [':F1028_2.ithmb'] and p3['images'][2]['thumbs'][0]['offset'] == 0, names)
        check('F1028_2.ithmb exists', 'F1028_2.ithmb' in files3, sorted(files3))
    finally:
        A.ITHUMB_MAX_SIZE = saved

    check('RGB565: white, red, green, blue', A.rgb_to_rgb565_le(bytes([255, 255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 255]))
          == bytes([0xFF, 0xFF, 0x00, 0xF8, 0xE0, 0x07, 0x1F, 0x00]))


def part_models():
    print('\n2. which iPods get artwork')
    check('iPod Video 5G (MA002) -> video', A.model_from_sysinfo(SYSINFO_VIDEO) == 'video')
    check('iPod Video 5.5G (xA450) -> video', A.model_from_sysinfo(SYSINFO_VIDEO_55) == 'video')
    check('iPod mini 2G (M9803) -> nothing', A.model_from_sysinfo(SYSINFO_MINI) is None)
    check('iPod 3G (M9245) -> nothing', A.model_from_sysinfo(SYSINFO_3G) is None)
    check('empty SysInfo -> nothing', A.model_from_sysinfo('') is None)
    d = tempfile.mkdtemp(prefix='jt-art-model-')
    check('no SysInfo file -> nothing', A.artwork_model_for_ipod(d)[0] is None)


def empty_template():
    mhlt = bytearray(92)
    struct.pack_into('<4sII', mhlt, 0, b'mhlt', 92, 0)
    mhsd = bytearray(96)
    struct.pack_into('<4sIII', mhsd, 0, b'mhsd', 96, 96 + len(mhlt), 1)
    mhbd = bytearray(104)
    struct.pack_into('<4sII', mhbd, 0, b'mhbd', 104, 104 + 96 + len(mhlt))
    struct.pack_into('<I', mhbd, 20, 1)
    return bytes(mhbd + mhsd + mhlt)


def make_ipod(root, sysinfo):
    os.makedirs(os.path.join(root, 'iPod_Control', 'Device'), exist_ok=True)
    with open(os.path.join(root, 'iPod_Control', 'Device', 'SysInfo'), 'w') as f:
        f.write(sysinfo)
    os.makedirs(os.path.join(root, 'iPod_Control', 'Music', 'F00'), exist_ok=True)
    for n in ('a', 'b', 'c'):
        with open(os.path.join(root, 'iPod_Control', 'Music', 'F00', n + '.m4a'), 'wb') as f:
            f.write(b'\0' * 1000)


def tracks(art_dir):
    def t(i, title, album, art):
        return {'id': i, 'title': title, 'artist': 'Band', 'album': album, 'genre': 'Rock',
                'path': ':iPod_Control:Music:F00:%s.m4a' % 'abc'[i - 1], 'duration': 200000,
                'codec': 'alac', 'fileSize': 1000, 'audioFingerprint': 'fp%d' % i,
                'artworkPath': os.path.join(art_dir, art) if art else None}
    return [t(1, 'One', 'First', 'first.png'), t(2, 'Two', 'First', 'first.png'), t(3, 'Three', 'Second', None)]


def mhits(path):
    with open(path, 'rb') as f:
        data = f.read()
    out, pos = [], data.find(b'mhit')
    while pos != -1:
        hl, tot = struct.unpack_from('<II', data, pos + 4)
        out.append(data[pos:pos + hl])
        pos = data.find(b'mhit', pos + tot)
    return data, out


def part_writer():
    print('\n3. through db_reader.write_itunesdb')
    try:
        from PIL import Image
    except ImportError:
        print('  skip (Pillow not installed)')
        return
    d = tempfile.mkdtemp(prefix='jt-art-writer-')
    art_dir = os.path.join(d, 'covers')
    os.makedirs(art_dir)
    Image.new('RGB', (600, 300), (200, 30, 10)).save(os.path.join(art_dir, 'first.png'))
    tpl = os.path.join(d, 'template')
    with open(tpl, 'wb') as f:
        f.write(empty_template())

    # iPod Video
    video = os.path.join(d, 'video')
    make_ipod(video, SYSINFO_VIDEO)
    out_v, art_v = os.path.join(d, 'itdb-video'), os.path.join(d, 'art-video')
    report = {}
    db_reader.write_itunesdb(tracks(art_dir), [], tpl, out_v, ipod_root=video,
                             artwork_out=art_v, artwork_report=report)
    check('report names the model', report.get('model') == 'video', report)
    names = sorted(os.listdir(art_v)) if os.path.isdir(art_v) else []
    check('ArtworkDB + F1028_1 + F1029_1 written locally', names == ['ArtworkDB', 'F1028_1.ithmb', 'F1029_1.ithmb'], names)
    with open(os.path.join(art_v, 'ArtworkDB'), 'rb') as f:
        p = A.parse_artworkdb(f.read())
    _, hdrs = mhits(out_v)
    check('two songs with a cover -> two mhii', len(p['images']) == 2, len(p['images']))
    ids = [A.song_id_of(h) for h in hdrs]
    check('each mhii names its song by mhit +0x70', [im['song_id'] for im in p['images']] == ids[:2], (ids, p['images']))
    check('songs with a cover: count 1, size = file bytes, has_artwork 1',
          all(struct.unpack_from('<H', h, 0x7C)[0] == 1 and h[0xA4] == 1
              and struct.unpack_from('<I', h, 0x80)[0] == os.path.getsize(os.path.join(art_dir, 'first.png'))
              for h in hdrs[:2]))
    check('song without a cover: has_artwork 2', hdrs[2][0xA4] == 2 and struct.unpack_from('<H', hdrs[2], 0x7C)[0] == 0)
    check('one album, one copy of the pixels', os.path.getsize(os.path.join(art_v, 'F1029_1.ithmb')) == 80000)
    th = [t for t in p['images'][0]['thumbs'] if t['format_id'] == 1028][0]
    check('a 2:1 cover is fit and padded (100x50, vpad 25)', (th['hpad'], th['vpad'], th['width'], th['height']) == (0, 25, 100, 75), th)
    with open(os.path.join(art_v, 'F1028_1.ithmb'), 'rb') as f:
        px = f.read()
    mid = struct.unpack_from('<H', px, (50 * 100 + 50) * 2)[0]
    corner = struct.unpack_from('<H', px, 0)[0]
    check('padding is black, the picture is red', corner == 0 and (mid >> 11) == (200 >> 3), (hex(corner), hex(mid)))

    # Mini: nothing, and the iTunesDB is byte-identical to a sync without the flag
    mini = os.path.join(d, 'mini')
    make_ipod(mini, SYSINFO_MINI)
    out_m, art_m = os.path.join(d, 'itdb-mini'), os.path.join(d, 'art-mini')
    out_plain = os.path.join(d, 'itdb-plain')
    report_m = {}
    db_reader.write_itunesdb(tracks(art_dir), [], tpl, out_m, ipod_root=mini, artwork_out=art_m, artwork_report=report_m)
    db_reader.write_itunesdb(tracks(art_dir), [], tpl, out_plain, ipod_root=mini)
    check('mini: report says no model', report_m.get('model') is None, report_m)
    check('mini: no artwork file at all', not os.path.isdir(art_m) or os.listdir(art_m) == [], os.listdir(art_m) if os.path.isdir(art_m) else None)
    _, mh = mhits(out_m)
    _, plain = mhits(out_plain)
    # date fields stamp time.time(); compare with them masked
    def masked(h):
        b = bytearray(h)
        for off in (0x20, 0x58, 0x68):
            b[off:off + 4] = b'\0\0\0\0'
        return bytes(b)
    check('mini: every mhit header identical to a sync without --artwork-out',
          [masked(h) for h in mh] == [masked(h) for h in plain])
    check('mini: no artwork fields set', all(h[0xA4] == 0 for h in mh))

    # A cover that can't be decoded costs only its album
    bad = os.path.join(art_dir, 'broken.jpg')
    with open(bad, 'wb') as f:
        f.write(b'not an image')
    tr = tracks(art_dir)
    tr[2]['artworkPath'] = bad
    out_b, art_b = os.path.join(d, 'itdb-bad'), os.path.join(d, 'art-bad')
    db_reader.write_itunesdb(tr, [], tpl, out_b, ipod_root=video, artwork_out=art_b)
    _, hb = mhits(out_b)
    check('broken cover: the catalog is still written with 3 songs', len(hb) == 3)
    check('broken cover: its song has no art, the others keep theirs', [h[0xA4] for h in hb] == [1, 1, 2])

    # CLI: rows carry no artworkPath; the covers come from --artwork-map, and
    # --artwork-out reports in the JSON on stdout
    import subprocess
    cli_out = os.path.join(d, 'itdb-cli')
    rows = tracks(art_dir)
    cover_map = {str(t['id']): t['artworkPath'] for t in rows if t['artworkPath']}
    for t in rows:
        t.pop('artworkPath')
    map_file = os.path.join(d, 'art-cli.map.json')
    with open(map_file, 'w') as f:
        json.dump(cover_map, f)
    r = subprocess.run([sys.executable, os.path.join(os.path.dirname(__file__), '..', 'db_reader.py'),
                        '--write', cli_out, '--template', tpl, '--ipod-root', video,
                        '--artwork-out', os.path.join(d, 'art-cli'), '--artwork-map', map_file],
                       input=json.dumps({'tracks': rows, 'playlists': []}),
                       capture_output=True, text=True)
    try:
        res = json.loads(r.stdout)
    except ValueError:
        res = {}
    check('CLI exits 0 and reports artwork images', r.returncode == 0 and res.get('artwork', {}).get('images') == 2,
          (r.returncode, r.stdout[-300:], r.stderr[-300:]))


def main():
    part_db()
    part_models()
    part_writer()
    print()
    if FAILURES:
        print(f'{len(FAILURES)} FAILED')
        sys.exit(1)
    print('all ok')


if __name__ == '__main__':
    main()
