"""
Re-encode ALAC audio files to a format the iPod Classic can actually
decode. The iPod Classic's ALAC decoder maxes out at 16 bits per sample
and 48 kHz; anything higher (24-bit or 32-bit high-res rips, 96/192 kHz
audiophile masters) silently skips during playback. The app's transcoder
already down-mixes these for JakeTunes itself, so they sound fine in the
macOS player — but on the iPod they just don't play, which presents as
"some Jorge Ben songs skip" and a track-count mismatch between library
and iPod.

Pipeline:
  1. Scan a directory tree (default: the local JakeTunes mirror at
     ~/Music2/JakeTunesLibrary/iPod_Control/Music).
  2. ffprobe every audio file to read codec, bit depth, sample rate.
  3. Re-encode any incompatible file with `afconvert` (macOS native):
       16-bit / 44.1 kHz ALAC
     preserving embedded tags via a tag-copy step.
  4. Write a report to /tmp/jaketunes-alac-compat-report.json.

Flags:
  --apply           actually re-encode (default is dry-run inventory)
  --root DIR        override the scan root
  --limit N         only process the first N incompatible files (for testing)

Designed so the user can run it, sync the iPod again, and all 479
previously-skipping tracks now play on the hardware.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
from tag_reader import read_tags  # noqa: E402


DEFAULT_ROOT = os.path.expanduser('~/Music2/JakeTunesLibrary/iPod_Control/Music')
FALLBACK_ROOT = os.path.expanduser('~/Music/JakeTunesLibrary/iPod_Control/Music')


def walk_audio(root: str):
    for base, _dirs, files in os.walk(root):
        for fn in files:
            lo = fn.lower()
            if lo.endswith(('.m4a', '.alac', '.aac', '.mp3', '.flac', '.aif', '.aiff', '.wav')):
                yield os.path.join(base, fn)


def needs_reencode(tags: dict) -> bool:
    """iPod Classic rejects ALAC with bit_depth > 16 OR sample_rate > 48000."""
    if not tags.get('ok'):
        return False
    codec = (tags.get('codec') or '').lower()
    if codec != 'alac':
        return False
    bd = int(tags.get('bit_depth') or 0)
    sr = int(tags.get('sample_rate') or 0)
    return bd > 16 or sr > 48000


def reencode_alac(src: str) -> tuple[bool, str]:
    """Re-encode an ALAC file to 16-bit / 44.1 kHz ALAC in place using a
    two-step pipeline:

        ffmpeg  (down-sample + strip to 16-bit PCM WAV)
          ↓
        afconvert  (PCM WAV → ALAC, Apple's canonical encoder)

    The one-step ffmpeg-direct-to-ALAC approach was subtly broken:
    ffmpeg's ALAC encoder stamps the container as 16-bit but writes
    32-bit audio frames internally, which the iPod Classic's hardware
    ALAC decoder chokes on — the file plays as a "scratched CD" with
    profuse skipping even though ffprobe reads it as 16-bit/44.1kHz.

    afconvert is Apple's own ALAC encoder and produces bit-for-bit
    iPod-compatible output. Feeding it a plain 16-bit PCM WAV
    guarantees the output really is 16-bit end-to-end.
    """
    src_dir = os.path.dirname(src)
    with tempfile.NamedTemporaryFile(suffix='.wav', dir=src_dir, delete=False) as wav_tmp:
        wav_path = wav_tmp.name
    with tempfile.NamedTemporaryFile(suffix='.m4a', dir=src_dir, delete=False) as alac_tmp:
        alac_path = alac_tmp.name

    orig = read_tags(src)
    target_sr = 44100 if int(orig.get('sample_rate') or 0) > 48000 else int(orig.get('sample_rate') or 44100)

    # Step 1: ffmpeg → 16-bit WAV
    wav_args = [
        'ffmpeg', '-y', '-i', src,
        '-map', '0:a:0',
        '-sample_fmt', 's16',
        '-ar', str(target_sr),
        '-f', 'wav',
        '-loglevel', 'error',
        wav_path,
    ]
    try:
        r = subprocess.run(wav_args, capture_output=True, timeout=600)
        if r.returncode != 0:
            for p in (wav_path, alac_path):
                try: os.unlink(p)
                except OSError: pass
            return False, f'ffmpeg wav exit {r.returncode}: {r.stderr.decode(errors="replace")[:200]}'
    except subprocess.TimeoutExpired:
        for p in (wav_path, alac_path):
            try: os.unlink(p)
            except OSError: pass
        return False, 'ffmpeg timeout'
    except FileNotFoundError:
        for p in (wav_path, alac_path):
            try: os.unlink(p)
            except OSError: pass
        return False, 'ffmpeg not installed (brew install ffmpeg)'

    # Step 2: afconvert → ALAC
    af_args = ['afconvert', '-f', 'm4af', '-d', 'alac', wav_path, alac_path]
    try:
        r = subprocess.run(af_args, capture_output=True, timeout=600)
        if r.returncode != 0:
            for p in (wav_path, alac_path):
                try: os.unlink(p)
                except OSError: pass
            return False, f'afconvert exit {r.returncode}: {r.stderr.decode(errors="replace")[:200]}'
    except subprocess.TimeoutExpired:
        for p in (wav_path, alac_path):
            try: os.unlink(p)
            except OSError: pass
        return False, 'afconvert timeout'
    finally:
        try: os.unlink(wav_path)
        except OSError: pass

    # Copy tags (afconvert doesn't). Use tag_writer since this is our
    # existing, tested path.
    try:
        payload = {
            'title':       orig.get('title', ''),
            'artist':      orig.get('artist', ''),
            'album':       orig.get('album', ''),
            'albumArtist': orig.get('albumartist', ''),
        }
        subprocess.run(
            ['python3', os.path.join(_HERE, 'tag_writer.py'), alac_path],
            input=json.dumps(payload).encode(),
            capture_output=True, timeout=30,
        )
    except Exception:  # noqa: BLE001
        pass

    # Verify the new file is actually 16-bit / ≤48kHz before swapping.
    new_tags = read_tags(alac_path)
    if new_tags.get('ok'):
        bd = int(new_tags.get('bit_depth') or 0)
        sr = int(new_tags.get('sample_rate') or 0)
        if bd > 16 or sr > 48000:
            try: os.unlink(alac_path)
            except OSError: pass
            return False, f'output still incompatible: {bd}-bit {sr}Hz'

    try:
        os.replace(alac_path, src)
    except OSError as e:
        try: os.unlink(alac_path)
        except OSError: pass
        return False, f'replace failed: {e}'
    return True, 'ok'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true',
                    help='actually re-encode files (default: dry-run inventory only)')
    ap.add_argument('--root', default=None, help='override the scan root')
    ap.add_argument('--limit', type=int, default=0,
                    help='only process the first N incompatible files (0 = all)')
    args = ap.parse_args()

    root = args.root or (DEFAULT_ROOT if os.path.isdir(DEFAULT_ROOT) else FALLBACK_ROOT)
    if not os.path.isdir(root):
        print(f'No scan root found. Checked:\n  {DEFAULT_ROOT}\n  {FALLBACK_ROOT}', file=sys.stderr)
        sys.exit(2)
    print(f'Scan root: {root}')

    print('Indexing files...', flush=True)
    paths = list(walk_audio(root))
    print(f'Found {len(paths)} audio files. Reading tags...', flush=True)

    needs = []
    scanned = 0
    t0 = time.time()
    for p in paths:
        scanned += 1
        if scanned % 500 == 0:
            print(f'  ...{scanned}/{len(paths)} ({time.time()-t0:.1f}s)', flush=True)
        tg = read_tags(p)
        if needs_reencode(tg):
            needs.append({
                'path': p,
                'codec': tg.get('codec'),
                'bit_depth': tg.get('bit_depth'),
                'sample_rate': tg.get('sample_rate'),
                'duration_ms': tg.get('duration_ms'),
                'title': tg.get('title'), 'artist': tg.get('artist'),
            })
    print(f'Scanned {scanned} files in {time.time()-t0:.1f}s. {len(needs)} need re-encoding.')

    report = {
        'scan_root': root,
        'scanned': scanned,
        'incompatible': len(needs),
        'samples': needs[:20],
        'timestamp': datetime.now().isoformat(),
    }
    with open('/tmp/jaketunes-alac-compat-report.json', 'w') as fh:
        json.dump({**report, 'all': needs}, fh, indent=2)
    print('Inventory written to /tmp/jaketunes-alac-compat-report.json')

    if not needs:
        print('Nothing to do — all ALAC files are iPod-compatible.')
        return
    if not args.apply:
        print('\nFirst 10 incompatible files:')
        for n in needs[:10]:
            print(f'  {n["bit_depth"]:2d}-bit / {n["sample_rate"]:>6d} Hz  {n["artist"][:20]:<20} {n["title"][:40]}')
        print(f'\n(+{len(needs)-10} more)' if len(needs) > 10 else '')
        print('\nDry run only — re-run with --apply to re-encode.')
        return

    todo = needs if args.limit == 0 else needs[:args.limit]
    print(f'\nRe-encoding {len(todo)} files to 16-bit / 44.1 kHz ALAC...\n')
    ok = 0
    failed = []
    t0 = time.time()
    for i, n in enumerate(todo, 1):
        p = n['path']
        print(f'  [{i}/{len(todo)}] {os.path.basename(p)} … ', end='', flush=True)
        success, reason = reencode_alac(p)
        if success:
            ok += 1
            print('OK')
        else:
            failed.append({'path': p, 'error': reason})
            print(f'FAILED ({reason})')
    dt = time.time() - t0
    print(f'\nDone in {dt:.1f}s. {ok}/{len(todo)} re-encoded.')
    if failed:
        print(f'{len(failed)} failures — see /tmp/jaketunes-alac-compat-report.json')
        report['failed'] = failed
    with open('/tmp/jaketunes-alac-compat-report.json', 'w') as fh:
        json.dump({**report, 'all': needs, 'failed': failed}, fh, indent=2)


if __name__ == '__main__':
    main()
