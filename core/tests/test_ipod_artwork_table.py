#!/usr/bin/env python3
"""
The artwork model table (core/ipod_artwork_models.json) and the generator that
reads it (core/ipod_artwork.py).

1. Every family has a source for every value, every colour family's formats are
   RGB565 LE with no row alignment, and the documented byte size is W*H*2.
2. Every table format renders to exactly its documented byte size, padded and
   centred, for a square, a wide and a tall cover.
3. Model detection: SysInfo ModelNumStr, SysInfoExtended's serial number, a
   remembered answer, the iPod's own thumbnail files, and "ask" when nothing
   names the model. Monochrome models never get artwork.
4. The thumbnail cache: a second run reads the cache and gives the same bytes;
   a damaged cache record is redrawn; the cache trims least recently used.
5. A format the generator can't draw stops artwork (the caller then writes the
   songs without art), never the music.

Builds everything in a temp folder. Never reads or writes an iPod. Parts 2, 4
and 5 need Pillow and are skipped (and say so) without it.

Run:  python3 core/tests/test_ipod_artwork_table.py
"""
import io
import json
import os
import plistlib
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import ipod_artwork as A  # noqa: E402

FAILURES = []


def check(label, cond, detail=''):
    print(f"  {'ok  ' if cond else 'FAIL'} {label}{'' if cond else '  ' + str(detail)}")
    if not cond:
        FAILURES.append(label)


def have_pil():
    try:
        import PIL  # noqa: F401
        return True
    except ImportError:
        return False


def part_table():
    print('\n1. the table')
    with open(A.MODELS_FILE, 'r', encoding='utf-8') as f:
        doc = json.load(f)
    check('libgpod commit pinned', len(doc['libgpod']['commit']) == 40)
    fams = {e['family']: e for e in doc['families']}
    for want in ('video', 'nano-1g', 'nano-2g', 'photo', 'mini', 'classic-mono'):
        check(f'family {want} present', want in fams)
    for k, e in fams.items():
        check(f'{k}: model numbers cited one for one', len(e['modelNumbers']) == len(e['modelNumberSources']))
        check(f'{k}: sparse artwork false and cited', e['sparseArtwork'] is False and 'itdb_device.c' in e['sparseArtworkSource'])
        if e['artwork']:
            check(f'{k}: format table cited', 'itdb_device.c' in e['formatTableSource'])
            for f in e['coverFormats']:
                ok = (f['pixelFormat'] == 'RGB565' and f['byteOrder'] == 'little' and f['rowAlignmentBytes'] == 0
                      and f['bytes'] == f['width'] * f['height'] * 2 and f['source'].startswith('itdb_device.c:'))
                check(f"{k}: format {f['formatId']} {f['width']}x{f['height']} = {f['bytes']} bytes, cited", ok, f)
        else:
            check(f'{k}: no artwork, cited', e['coverFormats'] == [] and 'itdb_device.c' in e['noArtworkSource'])
    v = A.VIDEO_COVER_FORMATS
    check('Video formats are exactly 1028 100x100 then 1029 200x200',
          [(f['formatId'], f['width'], f['height']) for f in v] == [(1028, 100, 100), (1029, 200, 200)])
    check('nano 2G formats are 1031 42x42 then 1027 100x100 (itdb_device.c:456-460)',
          [(f['formatId'], f['width'], f['height']) for f in A.COVER_FORMATS['nano-2g']] == [(1031, 42, 42), (1027, 100, 100)])
    check('Photo formats are 1017 56x56 then 1016 140x140 (itdb_device.c:442-446)',
          [(f['formatId'], f['width'], f['height']) for f in A.COVER_FORMATS['photo']] == [(1017, 56, 56), (1016, 140, 140)])
    check('only colour families get artwork', set(A.COVER_FORMATS) == {'video', 'nano-1g', 'nano-2g', 'photo'})


def cover(w, h, colour=(200, 30, 30)):
    from PIL import Image
    buf = io.BytesIO()
    Image.new('RGB', (w, h), colour).save(buf, 'PNG')
    return buf.getvalue()


def part_sizes():
    print('\n2. every table format renders to its documented size')
    if not have_pil():
        print('  skip (no Pillow)')
        return
    for fam, formats in A.COVER_FORMATS.items():
        for shape, (w, h) in (('square', (600, 600)), ('wide', (800, 400)), ('tall', (300, 900))):
            thumbs = A.render_thumbs(cover(w, h), formats)
            for f, th in zip(formats, thumbs):
                ok = len(th['data']) == f['bytes'] and th['format_id'] == f['formatId']
                ok = ok and 0 <= th['hpad'] and 0 <= th['vpad'] and th['width'] <= f['width'] and th['height'] <= f['height']
                check(f"{fam} {f['formatId']} {shape}: {len(th['data'])} bytes", ok, th['data'][:0] or (th['hpad'], th['vpad']))


def ipod(sysinfo=None, ext=None, ithmbs=()):
    root = tempfile.mkdtemp(prefix='jt-art-detect-')
    os.makedirs(os.path.join(root, 'iPod_Control', 'Device'))
    os.makedirs(os.path.join(root, 'iPod_Control', 'Artwork'))
    if sysinfo is not None:
        with open(os.path.join(root, 'iPod_Control', 'Device', 'SysInfo'), 'w') as f:
            f.write(sysinfo)
    if ext is not None:
        with open(os.path.join(root, 'iPod_Control', 'Device', 'SysInfoExtended'), 'wb') as f:
            plistlib.dump(ext, f)
    for n in ithmbs:
        open(os.path.join(root, 'iPod_Control', 'Artwork', n), 'wb').close()
    return root


def part_detect():
    print('\n3. which iPod')
    d = A.detect_ipod
    check('Video ModelNumStr MA002 -> video', d(ipod('ModelNumStr: MA002\n'))['family'] == 'video')
    check('nano 2G ModelNumStr MA477 -> nano-2g, artwork', d(ipod('ModelNumStr: MA477\n'))['family'] == 'nano-2g'
          and d(ipod('ModelNumStr: MA477\n'))['artwork'])
    check('nano 1G ModelNumStr MA350 -> nano-1g', d(ipod('ModelNumStr: MA350\n'))['family'] == 'nano-1g')
    check('Photo ModelNumStr M9829 -> photo', d(ipod('ModelNumStr: M9829\n'))['family'] == 'photo')
    mini = d(ipod('ModelNumStr: M9803\n'))
    check('mini M9803 -> mini, no artwork, no question', mini['family'] == 'mini' and not mini['artwork'] and not mini['ask'])
    g3 = d(ipod('ModelNumStr: M9245\n'))
    check('3G M9245 -> no artwork, no question', not g3['artwork'] and not g3['ask'])
    suffix = next(iter(A.MODELS['nano-2g']['serialSuffixes']))
    check('SysInfoExtended serial names the model when SysInfo is empty',
          d(ipod('', {'SerialNumber': 'ABCDEFGH' + suffix}))['family'] == 'nano-2g')
    vsuffix = next(iter(A.MODELS['video']['serialSuffixes']))
    check("a mini's own SysInfo wins over a Video's leftover SysInfoExtended (no covers)",
          not d(ipod('ModelNumStr: M9800\n', {'SerialNumber': 'XX' + vsuffix}))['artwork'])
    unk = d(ipod(''))
    check('empty SysInfo, nothing else -> ask', unk['family'] is None and unk['ask'] and not unk['artwork'])
    unk2 = d(ipod('ModelNumStr: xB029\n'))
    check('a model the table lacks (classic) -> no covers, no question', not unk2['ask'] and not unk2['artwork'])
    check('...and a remembered answer cannot give it the wrong format',
          not d(ipod('ModelNumStr: xB029\n'), {'k': 'video'}, 'k')['artwork'])
    check('remembered answer used when nothing names the model',
          d(ipod(''), {'k': 'nano-2g'}, 'k')['family'] == 'nano-2g')
    check('remembered "none" -> no artwork, no question',
          not d(ipod(''), {'k': 'none'}, 'k')['artwork'] and not d(ipod(''), {'k': 'none'}, 'k')['ask'])
    check('SysInfo wins over a remembered answer', d(ipod('ModelNumStr: M9803\n'), {'k': 'video'}, 'k')['family'] == 'mini')
    check('Video thumbnail files, empty SysInfo -> video', d(ipod('', ithmbs=('F1028_1.ithmb', 'F1029_1.ithmb')))['family'] == 'video')
    check('Photo thumbnail files, empty SysInfo -> photo', d(ipod('', ithmbs=('F1017_1.ithmb', 'F1016_1.ithmb')))['family'] == 'photo')
    check('one of two files is not enough', d(ipod('', ithmbs=('F1028_1.ithmb',)))['ask'])
    check('artwork_model_for_ipod keeps its (model, why) shape',
          A.artwork_model_for_ipod(ipod('ModelNumStr: MA477\n'))[0] == 'nano-2g'
          and A.artwork_model_for_ipod(ipod('ModelNumStr: M9803\n'))[0] is None)


def part_cache():
    print('\n4. the thumbnail cache')
    if not have_pil():
        print('  skip (no Pillow)')
        return
    folder = tempfile.mkdtemp(prefix='jt-art-cache-')
    raw = cover(640, 480, (10, 120, 200))
    store = {'/c.png': raw}
    tracks = [{'id': 1, 'artworkPath': '/c.png'}]
    log = []
    first = A.prepare_covers(tracks, A.VIDEO_COVER_FORMATS, log.append, read=store.__getitem__, cache_dir=folder)
    files = sorted(os.listdir(folder))
    check('cache holds one record per format', len([n for n in files if n.endswith('.pix')]) == 2, files)
    calls = []
    real = A._decode
    A._decode = lambda b: calls.append(1) or real(b)
    try:
        second = A.prepare_covers(tracks, A.VIDEO_COVER_FORMATS, log.append, read=store.__getitem__, cache_dir=folder)
    finally:
        A._decode = real
    check('second run decodes nothing', calls == [])
    check('second run gives the same bytes', [t['data'] for t in first[1]['thumbs']] == [t['data'] for t in second[1]['thumbs']])
    pix = [n for n in os.listdir(folder) if n.endswith('.pix')][0]
    with open(os.path.join(folder, pix), 'wb') as f:
        f.write(b'torn')
    third = A.prepare_covers(tracks, A.VIDEO_COVER_FORMATS, log.append, read=store.__getitem__, cache_dir=folder)
    check('a damaged record is redrawn, same bytes', [t['data'] for t in first[1]['thumbs']] == [t['data'] for t in third[1]['thumbs']])
    meta = [n for n in os.listdir(folder) if n.endswith('.json')][0]
    with open(os.path.join(folder, meta), 'w') as f:
        f.write('[1, 2]')
    fourth = A.prepare_covers(tracks, A.VIDEO_COVER_FORMATS, log.append, read=store.__getitem__, cache_dir=folder)
    check('a damaged metadata record is redrawn, the album keeps its art',
          fourth and [t['data'] for t in first[1]['thumbs']] == [t['data'] for t in fourth[1]['thumbs']])
    with open(os.path.join(folder, meta), 'w') as f:
        f.write('{"w": 100, "h": 100}')
    fifth = A.prepare_covers(tracks, A.VIDEO_COVER_FORMATS, log.append, read=store.__getitem__, cache_dir=folder)
    check('metadata missing its pads is redrawn too', fifth and 1 in fifth)
    c = A.ThumbCache(folder)
    check('trim to 0 bytes drops everything', c.trim(0) == 2 and not [n for n in os.listdir(folder) if n.endswith('.pix')])


def part_missing_table():
    print('\n6. a missing table means no covers, never a crash')
    import subprocess
    code = ("import sys, builtins; sys.path.insert(0, %r); import ipod_artwork as A; "
            "A.MODELS_FILE = '/nonexistent.json'; print(A._load_models_safely() == {})") % os.path.join(os.path.dirname(__file__), '..')
    r = subprocess.run([sys.executable, '-c', code], capture_output=True, text=True)
    check('unreadable table -> {} and a log line', r.stdout.strip() == 'True' and 'model table unreadable' in r.stderr, r.stderr[-300:])


def part_unsupported():
    print('\n5. a format the generator cannot draw stops artwork, not music')
    if not have_pil():
        print('  skip (no Pillow)')
        return
    odd = dict(A.VIDEO_COVER_FORMATS[0], formatId=9999, byteOrder='big')
    raised = False
    try:
        A.prepare_covers([{'id': 1, 'artworkPath': '/c.png'}], (odd,), lambda *_: None,
                         read={'/c.png': cover(100, 100)}.__getitem__)
    except A.UnsupportedFormat:
        raised = True
    check('big-endian format raises UnsupportedFormat (db_reader then writes songs without art)', raised)


if __name__ == '__main__':
    part_table()
    part_sizes()
    part_detect()
    part_cache()
    part_unsupported()
    part_missing_table()
    print('\n' + ('all ok' if not FAILURES else f'{len(FAILURES)} FAILED: {FAILURES}'))
    sys.exit(1 if FAILURES else 0)
