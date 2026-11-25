#!/usr/bin/env python3
"""
Brief 265 Part 1: what is actually on an iPod, read-only.

For songs on a mounted iPod this prints, side by side:
  • the file on the iPod (iPod_Control/Music/F##/…)
  • its cached mirror in sync-convert-cache, if one is there
  • its master in the library
with, for each: sample rate, channels, codec + profile, bitrate, the esds
max/avg bitrate and the packet-size spread (CBR vs VBR), the encoder string,
the container brand, duration, size and SHA-256. Then the iTunesDB's own
stamps for the song (fileSize 0x24, duration 0x28, bitrate 0x38, sample
rate 0x3C, codec marker 0x18, mediatype 0xD0) against the file's real values,
and which encode generation the file belongs to.

READ-ONLY. It never writes to the iPod, the cache, the library or the NAS:
every file is opened for reading, and the only programs it runs are ffprobe
and afinfo.

  python3 scripts/ipod-forensic.py --mount /Volumes/IndieSleaze --summary
  python3 scripts/ipod-forensic.py --mount /Volumes/IndieSleaze --match "song title" --match "other"

--summary     one line per song: DB stamps vs the file, generation, mismatches
--match TEXT  full report for every song whose title/artist contains TEXT
--json PATH   also write everything as JSON
"""
import argparse
import hashlib
import json
import os
import statistics
import struct
import subprocess
import sys

HOME = os.path.expanduser('~')
USER_DATA = os.path.join(HOME, 'Library', 'Application Support', 'JakeTunes')
CACHE_DIR = os.path.join(USER_DATA, 'sync-convert-cache')
LIBRARY_ROOTS = [os.path.join(HOME, 'Music2', 'JakeTunesLibrary'), os.path.join(HOME, 'Music', 'JakeTunesLibrary')]
LIBRARY_JSONS = ['/Volumes/JakeShared/JakeTunesState/library.json', os.path.join(USER_DATA, 'library.json')]
# Every cache-key token the mirror builders have used (src/main/index.ts). The
# current AAC recipe is afenc-cbr-44100-2-v3.
AAC_TOKENS = ['afenc-cbr-44100-2-v3', 'afenc-44100-2-v2']
KBPS = [128, 192, 256, 320]


# ── iTunesDB (read only) ────────────────────────────────────────────────────

def read_mhod_string(buf, off):
    hdr_len = struct.unpack_from('<I', buf, off + 4)[0]
    total = struct.unpack_from('<I', buf, off + 8)[0]
    mtype = struct.unpack_from('<I', buf, off + 12)[0]
    text = None
    if mtype in (1, 2, 3, 4, 5, 6, 22, 32) and total >= 0x28:
        slen = struct.unpack_from('<I', buf, off + 0x1C)[0]
        raw = buf[off + 0x28: off + 0x28 + slen]
        try:
            text = raw.decode('utf-16-le')
        except UnicodeDecodeError:
            text = raw.decode('utf-8', 'replace')
    return mtype, total, text


def parse_itunesdb(path):
    with open(path, 'rb') as f:
        buf = f.read()
    tracks = []
    i = 0
    while True:
        i = buf.find(b'mhit', i)
        if i < 0:
            break
        hdr_len = struct.unpack_from('<I', buf, i + 4)[0]
        total = struct.unpack_from('<I', buf, i + 8)[0]
        nmhod = struct.unpack_from('<I', buf, i + 12)[0]
        if hdr_len < 0x40 or total < hdr_len or i + total > len(buf):
            i += 4
            continue
        t = {
            'dbOffset': i,
            'uniqueId': struct.unpack_from('<I', buf, i + 0x10)[0],
            'marker': buf[i + 0x18:i + 0x1C].decode('latin-1'),
            'fileSize': struct.unpack_from('<I', buf, i + 0x24)[0],
            'durationMs': struct.unpack_from('<I', buf, i + 0x28)[0],
            'bitrate': struct.unpack_from('<I', buf, i + 0x38)[0],
            'sampleRate': struct.unpack_from('<I', buf, i + 0x3C)[0] >> 16,
            'mediaType': struct.unpack_from('<I', buf, i + 0xD0)[0] if hdr_len >= 0xD4 else None,
        }
        off = i + hdr_len
        for _ in range(nmhod):
            if off + 16 > len(buf) or buf[off:off + 4] != b'mhod':
                break
            mtype, mlen, text = read_mhod_string(buf, off)
            if text is not None:
                key = {1: 'title', 2: 'path', 3: 'album', 4: 'artist', 5: 'genre', 6: 'filetype', 32: 'albumArtist'}.get(mtype)
                if key:
                    t[key] = text
            off += mlen
        tracks.append(t)
        i += total
    return tracks


# ── Files ───────────────────────────────────────────────────────────────────

def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def run(cmd, timeout=60):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout
    except Exception:
        return ''


def mp4_boxes(f, start, end):
    pos = start
    while pos + 8 <= end:
        f.seek(pos)
        head = f.read(8)
        if len(head) < 8:
            return
        size, kind = struct.unpack('>I4s', head)
        hlen = 8
        if size == 1:
            size = struct.unpack('>Q', f.read(8))[0]
            hlen = 16
        elif size == 0:
            size = end - pos
        if size < hlen:
            return
        yield kind.decode('latin-1'), pos, pos + hlen, pos + size
        pos += size


def mp4_facts(path):
    """ftyp brand and the esds DecoderConfigDescriptor's max/avg bitrate."""
    out = {}
    try:
        with open(path, 'rb') as f:
            end = os.fstat(f.fileno()).st_size

            def walk(s, e, want):
                for kind, _, body, stop in mp4_boxes(f, s, e):
                    if kind == want[0]:
                        if len(want) == 1:
                            return body, stop
                        skip = {'stsd': 8, 'mp4a': 28}.get(want[1], 0)
                        if want[1] == 'mp4a':
                            r = walk(body + 8, stop, want[1:])  # stsd: version/flags + count
                        elif want[1] == 'esds':
                            r = walk(body + 28, stop, want[1:])  # mp4a sample entry
                        else:
                            r = walk(body + skip, stop, want[1:])
                        if r:
                            return r
                return None

            for kind, _, body, stop in mp4_boxes(f, 0, end):
                if kind == 'ftyp':
                    f.seek(body)
                    out['brand'] = f.read(4).decode('latin-1')
                    break
            r = walk(0, end, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd', 'mp4a', 'esds'])
            if r:
                f.seek(r[0] + 4)  # version/flags
                data = f.read(r[1] - r[0] - 4)
                j = data.find(b'\x04')  # DecoderConfigDescriptor tag
                while j >= 0:
                    k = j + 1
                    while k < len(data) and data[k] & 0x80:
                        k += 1
                    k += 1
                    if k + 13 <= len(data):
                        out['esdsMaxBitrate'] = struct.unpack('>I', data[k + 5:k + 9])[0]
                        out['esdsAvgBitrate'] = struct.unpack('>I', data[k + 9:k + 13])[0]
                        break
                    j = data.find(b'\x04', j + 1)
    except OSError:
        pass
    return out


def probe(path, packets=False):
    p = {'path': path}
    try:
        st = os.stat(path)
        p['size'] = st.st_size
    except OSError as e:
        p['error'] = str(e)
        return p
    raw = run(['ffprobe', '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-select_streams', 'a:0', path])
    try:
        j = json.loads(raw or '{}')
    except ValueError:
        j = {}
    s = (j.get('streams') or [{}])[0]
    fm = j.get('format') or {}
    tags = {k.lower(): v for k, v in (fm.get('tags') or {}).items()}
    p.update({
        'codec': s.get('codec_name'),
        'profile': s.get('profile'),
        'sampleRate': int(s['sample_rate']) if s.get('sample_rate') else None,
        'channels': s.get('channels'),
        'bitsPerSample': s.get('bits_per_raw_sample') or s.get('bits_per_sample'),
        'streamBitrate': int(s['bit_rate']) if s.get('bit_rate') else None,
        'formatBitrate': int(fm['bit_rate']) if fm.get('bit_rate') else None,
        'durationMs': round(float(fm['duration']) * 1000) if fm.get('duration') else None,
        'encoder': tags.get('encoder') or tags.get('encoded_by') or tags.get('©too') or None,
        'formatName': fm.get('format_name'),
    })
    if path.lower().endswith(('.m4a', '.mp4', '.m4p')):
        p.update(mp4_facts(path))
    af = run(['afinfo', path], timeout=30)
    for line in af.splitlines():
        line = line.strip()
        if line.lower().startswith('bit rate:'):
            p['afinfoBitrate'] = line.split(':', 1)[1].strip()
        if line.startswith('Data format:'):
            p['afinfoFormat'] = line.split(':', 1)[1].strip()
    if packets and p.get('codec') in ('aac', 'mp3'):
        pk = run(['ffprobe', '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'packet=size', '-of', 'csv=p=0', path], timeout=120)
        sizes = [int(x) for x in pk.split() if x.strip().isdigit()]
        if sizes:
            p['packets'] = {
                'n': len(sizes), 'min': min(sizes), 'max': max(sizes),
                'mean': round(statistics.mean(sizes), 1),
                'stdev': round(statistics.pstdev(sizes), 1),
            }
    return p


def generation(dev, current_mirror=None):
    """Which encode generation an on-device file belongs to (Brief 265 audit fact 4).

    current_mirror: True when the file's bytes (or, in --summary, its size) match a
    mirror in sync-convert-cache. The muxer tells the encoders apart: ffmpeg writes
    a Lavf tag (plus an edit list and a 5-byte ASC), afconvert writes iTunSMPB and no
    Lavf tag. Found 2026-11-24 on the Nano: every mirror under the afenc-cbr-…-v3 key
    was ffmpeg-native, because afconvertAvailable() probed `afconvert --help`, which
    exits 2, so the afconvert branch never ran.
    """
    codec = (dev.get('codec') or '').lower()
    enc = (dev.get('encoder') or '')
    sr = dev.get('sampleRate')
    if codec == 'alac':
        return 'ALAC (lossless, not converted)' + (f' at {sr} Hz' if sr and sr != 44100 else '')
    if codec == 'mp3':
        return 'MP3' + (' (libmp3lame)' if 'lav' in enc.lower() or 'lame' in enc.lower() else '')
    if codec != 'aac':
        return f'other codec: {codec or "unknown"}'
    where = ' (a sync-convert-cache mirror)' if current_mirror else ''
    if 'lavf' in enc.lower() or 'lavc' in enc.lower():
        gen = 'converted: ffmpeg-native AAC' + where
        if sr and sr != 44100:
            gen += f', {sr} Hz pass-through'
        return gen
    if sr and sr != 44100:
        return f'AAC at {sr} Hz (not the 44.1k cap: pre-v2 recipe or not ours)'
    avg, mx = dev.get('esdsAvgBitrate'), dev.get('esdsMaxBitrate')
    mode = ''
    if avg is not None and mx is not None:
        mode = ' CBR-like (esds avg≈max)' if avg and mx and abs(avg - mx) <= max(avg, mx) * 0.1 else f' VBR-like (esds avg {avg}, max {mx})'
    if current_mirror:
        return 'converted: afconvert AAC-LC' + where + mode
    return "not converted: the library's own AAC, copied as is" + (f' (encoder {enc})' if enc else '') + mode


# ── Library + cache lookup ──────────────────────────────────────────────────

def load_library():
    for p in LIBRARY_JSONS:
        try:
            with open(p) as f:
                d = json.load(f)
            return (d.get('tracks') if isinstance(d, dict) else d) or [], p
        except (OSError, ValueError):
            continue
    return [], None


def fold(s):
    return ' '.join(str(s or '').casefold().split())


def find_master(t, lib):
    hits = [x for x in lib if fold(x.get('title')) == fold(t.get('title')) and fold(x.get('artist')) == fold(t.get('artist'))]
    if len(hits) > 1:
        same_album = [x for x in hits if fold(x.get('album')) == fold(t.get('album'))]
        hits = same_album or hits
    if not hits:
        return None, None
    row = hits[0]
    rel = str(row.get('path') or '').replace(':', '/').lstrip('/')
    for root in LIBRARY_ROOTS:
        abs_path = os.path.join(root, rel)
        if os.path.lexists(abs_path):
            return row, abs_path
    return row, None


def cache_index():
    idx = {}
    try:
        for name in os.listdir(CACHE_DIR):
            p = os.path.join(CACHE_DIR, name)
            try:
                idx.setdefault(os.path.getsize(p), []).append(p)
            except OSError:
                pass
    except OSError:
        pass
    return idx


def keyed_mirrors(master_path):
    found = []
    for tok in AAC_TOKENS:
        for kb in KBPS:
            h = hashlib.sha1(f'{master_path}|{kb}|{tok}'.encode()).hexdigest()[:16]
            p = os.path.join(CACHE_DIR, h + '.m4a')
            if os.path.exists(p):
                found.append({'path': p, 'key': f'{kb}k {tok}'})
    for kb in KBPS:
        h = hashlib.sha1(f'{master_path}|{kb}|mp3-lame-cbr-44100-2-v1'.encode()).hexdigest()[:16]
        p = os.path.join(CACHE_DIR, h + '.mp3')
        if os.path.exists(p):
            found.append({'path': p, 'key': f'{kb}k mp3-lame-cbr-44100-2-v1'})
    h = hashlib.sha1(f'{master_path}|ipod-alac-16-44100-v1'.encode()).hexdigest()[:16]
    p = os.path.join(CACHE_DIR, h + '.m4a')
    if os.path.exists(p):
        found.append({'path': p, 'key': 'ipod-alac-16-44100-v1'})
    return found


# ── Report ──────────────────────────────────────────────────────────────────

def stamp_mismatches(t, dev):
    out = []
    if dev.get('size') is not None and t['fileSize'] != dev['size']:
        out.append(f"fileSize DB {t['fileSize']} vs file {dev['size']}")
    if dev.get('sampleRate') and t['sampleRate'] != dev['sampleRate']:
        out.append(f"sampleRate DB {t['sampleRate']} vs file {dev['sampleRate']}")
    real_kbps = None
    if dev.get('streamBitrate'):
        real_kbps = round(dev['streamBitrate'] / 1000)
    elif dev.get('formatBitrate'):
        real_kbps = round(dev['formatBitrate'] / 1000)
    if real_kbps and abs(t['bitrate'] - real_kbps) > max(8, real_kbps * 0.1):
        out.append(f"bitrate DB {t['bitrate']} vs file ~{real_kbps}")
    if dev.get('durationMs') and abs(t['durationMs'] - dev['durationMs']) > 1500:
        out.append(f"duration DB {t['durationMs']} ms vs file {dev['durationMs']} ms")
    if t.get('mediaType') not in (None, 1):
        out.append(f"mediatype {t['mediaType']}")
    return out


def device_file(mount, t):
    rel = str(t.get('path') or '').replace(':', '/').lstrip('/')
    return os.path.join(mount, rel) if rel else None


def fmt_probe(label, p):
    if not p:
        return f'  {label}: —'
    if p.get('error'):
        return f"  {label}: {p.get('path')}\n      ERROR {p['error']}"
    lines = [f"  {label}: {p.get('path')}"]
    lines.append(f"      codec {p.get('codec')} {p.get('profile') or ''} · {p.get('sampleRate')} Hz · {p.get('channels')} ch · bits {p.get('bitsPerSample') or '-'}")
    lines.append(f"      bitrate stream {p.get('streamBitrate')} / format {p.get('formatBitrate')} · afinfo {p.get('afinfoBitrate') or '-'}")
    if 'esdsAvgBitrate' in p:
        lines.append(f"      esds max {p.get('esdsMaxBitrate')} avg {p.get('esdsAvgBitrate')} · brand {p.get('brand')}")
    if p.get('packets'):
        k = p['packets']
        lines.append(f"      packets n={k['n']} size min {k['min']} max {k['max']} mean {k['mean']} stdev {k['stdev']}")
    lines.append(f"      encoder {p.get('encoder') or '(none)'} · duration {p.get('durationMs')} ms · size {p.get('size')}")
    if p.get('sha256'):
        lines.append(f"      sha256 {p['sha256']}")
    return '\n'.join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--mount', required=True)
    ap.add_argument('--summary', action='store_true')
    ap.add_argument('--match', action='append', default=[])
    ap.add_argument('--json')
    a = ap.parse_args()

    db_path = os.path.join(a.mount, 'iPod_Control', 'iTunes', 'iTunesDB')
    tracks = parse_itunesdb(db_path)
    print(f'iTunesDB {db_path}: {len(tracks)} songs')
    result = {'mount': a.mount, 'db': db_path, 'summary': [], 'detail': []}

    if a.summary:
        sizes = cache_index()
        gens = {}
        bad = 0
        for t in tracks:
            p = device_file(a.mount, t)
            dev = probe(p) if p else {}
            g = generation(dev, dev.get('size') in sizes)
            gens[g] = gens.get(g, 0) + 1
            mm = stamp_mismatches(t, dev)
            bad += 1 if mm else 0
            result['summary'].append({'db': t, 'file': dev, 'generation': g, 'mismatches': mm})
            flag = ' ✗ ' + '; '.join(mm) if mm else ''
            print(f"{t.get('artist', '')[:22]:22} | {t.get('title', '')[:34]:34} | {dev.get('codec')} {dev.get('sampleRate')} | DB {t['sampleRate']} Hz {t['bitrate']}k | {g[:40]}{flag}")
        print('\nGenerations on the device:')
        for g, n in sorted(gens.items(), key=lambda x: -x[1]):
            print(f'  {n:4}  {g}')
        print(f'Songs whose DB stamps disagree with their file: {bad} of {len(tracks)}')

    if a.match:
        lib, lib_path = load_library()
        print(f'library: {lib_path} ({len(lib)} rows)')
        idx = cache_index()
        wanted = [m.casefold() for m in a.match]
        for t in tracks:
            hay = fold(t.get('title')) + ' ' + fold(t.get('artist'))
            if not any(w in hay for w in wanted):
                continue
            print('\n' + '═' * 78)
            print(f"{t.get('artist')} — {t.get('title')}  [{t.get('album')}]")
            print(f"  iTunesDB mhit @0x{t['dbOffset']:x}: marker {t['marker']!r} · fileSize {t['fileSize']} · duration {t['durationMs']} ms · bitrate {t['bitrate']} · sampleRate {t['sampleRate']} · mediatype {t['mediaType']} · {t.get('path')}")
            p = device_file(a.mount, t)
            dev = probe(p, packets=True) if p else {}
            if dev.get('size') is not None:
                dev['sha256'] = sha256(p)
            print(fmt_probe('ON DEVICE', dev))
            row, master_path = find_master(t, lib)
            master = None
            if row is None:
                print('  MASTER: no library row with this title + artist')
            elif master_path is None:
                print(f"  MASTER: library row id {row.get('id')} path {row.get('path')}: no file under {LIBRARY_ROOTS}")
            elif os.path.islink(master_path) and os.path.getsize(os.path.realpath(master_path)) == 0:
                print(f'  MASTER: {master_path} is a link to the empty offload file (the audio is on homemini only)')
            else:
                master = probe(master_path)
                print(fmt_probe('MASTER', master))
            mirrors = []
            if master_path:
                for m in keyed_mirrors(master_path):
                    mp = probe(m['path'], packets=True)
                    mp['key'] = m['key']
                    mp['sha256'] = sha256(m['path'])
                    mirrors.append(mp)
            same_size = [x for x in idx.get(dev.get('size'), []) if x not in {m['path'] for m in mirrors}]
            for x in same_size:
                mp = probe(x)
                mp['key'] = 'same size as the device file (key unknown: staged path?)'
                mp['sha256'] = sha256(x)
                mirrors.append(mp)
            if not mirrors:
                print('  MIRROR: none in sync-convert-cache (by key, or by the device file\'s size)')
            for mp in mirrors:
                print(fmt_probe(f"MIRROR [{mp['key']}]", mp))
            identical = [mp['path'] for mp in mirrors if dev.get('sha256') and mp.get('sha256') == dev['sha256']]
            if identical:
                verdict = f'byte-identical to {identical[0]} (transfer exonerated for this file)'
            elif mirrors:
                verdict = 'differs from every mirror found'
            else:
                verdict = 'no mirror to compare'
            print(f'  DEVICE vs MIRROR: {verdict}')
            if master and dev.get('durationMs') and master.get('durationMs'):
                print(f"  DURATION device {dev['durationMs']} ms vs master {master['durationMs']} ms (Δ {dev['durationMs'] - master['durationMs']} ms)")
            mm = stamp_mismatches(t, dev)
            print('  DB STAMPS vs FILE: ' + ('match' if not mm else '; '.join(mm)))
            print('  GENERATION: ' + generation(dev, bool(identical)))
            result['detail'].append({'db': t, 'device': dev, 'master': master, 'masterRow': {k: row.get(k) for k in ('id', 'path', 'codec', 'sampleRate', 'bitRate', 'fileSize', 'duration')} if row else None, 'mirrors': mirrors, 'identicalTo': identical, 'mismatches': mm, 'generation': generation(dev, bool(identical))})

    if a.json:
        with open(a.json, 'w') as f:
            json.dump(result, f, indent=1, default=str)
        print(f'\nJSON: {a.json}')


if __name__ == '__main__':
    main()
