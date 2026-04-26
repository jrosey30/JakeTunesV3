"""
Read embedded tags (title / artist / album / albumartist / duration) from
audio files, in batch. The sync-to-iPod flow uses this to verify that a
library entry actually matches the audio at a given path *before* it
accepts a smart-match rewrite — so you can no longer end up with "Beatles
Sgt Pepper" linked to Pink Floyd's The Wall because both happened to
share a filename.

Usage:
  tag_reader.py                            # read JSON list of paths from stdin
  tag_reader.py /path/to/one.m4a ...       # read one-or-more paths from argv

Output: JSON list, one object per input path, in order:
  {
    "path": "...",
    "ok": true|false,
    "title": "...", "artist": "...", "album": "...", "albumartist": "...",
    "duration_ms": 12345,           # integer milliseconds, 0 if unknown
    "sample_rate": 44100,           # Hz, 0 if unknown
    "bit_depth": 16,                # bits, 0 if unknown
    "codec": "alac"|"aac"|"mp3"|"flac"|"pcm"|"",
    "error": "..."                  # only if ok=false
  }

Keeping this pure-stdlib-plus-mutagen keeps it fast: we can scan 4,000
files in a few seconds, which is what the sync verifier and the repair
pass both need.
"""

import json
import os
import sys

import mutagen
from mutagen.mp3 import MP3
from mutagen.mp4 import MP4
from mutagen.flac import FLAC


def _s(v):
    """Collapse mutagen's list-of-strings to a single string."""
    if v is None:
        return ''
    if isinstance(v, list):
        if not v:
            return ''
        v = v[0]
    if isinstance(v, bytes):
        try:
            return v.decode('utf-8', errors='replace')
        except Exception:
            return ''
    return str(v)


def read_tags(path):
    """Return a dict describing what's in the file. Never raises."""
    out = {
        'path': path,
        'ok': False,
        'title': '', 'artist': '', 'album': '', 'albumartist': '',
        'duration_ms': 0,
        'sample_rate': 0, 'bit_depth': 0, 'codec': '',
    }
    try:
        if not os.path.isfile(path):
            out['error'] = 'missing'
            return out

        ext = os.path.splitext(path)[1].lower()
        f = None
        codec = ''

        if ext in ('.m4a', '.mp4', '.alac', '.aac'):
            f = MP4(path)
            # MP4 atom codec lives in the info. ALAC files have codec='alac',
            # AAC have codec='mp4a'/'aac'. mutagen exposes it differently per
            # version — fall back to extension-based labeling.
            c = getattr(f.info, 'codec', '') or ''
            if 'alac' in c.lower(): codec = 'alac'
            elif 'mp4a' in c.lower() or 'aac' in c.lower(): codec = 'aac'
            else: codec = c or ('alac' if ext == '.alac' else 'm4a')
            out['title']       = _s(f.tags.get('\xa9nam')) if f.tags else ''
            out['artist']      = _s(f.tags.get('\xa9ART')) if f.tags else ''
            out['album']       = _s(f.tags.get('\xa9alb')) if f.tags else ''
            out['albumartist'] = _s(f.tags.get('aART'))    if f.tags else ''
        elif ext == '.mp3':
            f = MP3(path)
            codec = 'mp3'
            # EasyID3 tag access through the underlying tags
            try:
                from mutagen.easyid3 import EasyID3
                e = EasyID3(path)
                out['title']       = _s(e.get('title'))
                out['artist']      = _s(e.get('artist'))
                out['album']       = _s(e.get('album'))
                out['albumartist'] = _s(e.get('albumartist'))
            except Exception:
                pass
        elif ext == '.flac':
            f = FLAC(path)
            codec = 'flac'
            out['title']       = _s(f.get('title'))
            out['artist']      = _s(f.get('artist'))
            out['album']       = _s(f.get('album'))
            out['albumartist'] = _s(f.get('albumartist'))
        elif ext in ('.aiff', '.aif', '.wav'):
            f = mutagen.File(path)
            codec = 'pcm'
            if f is not None and f.tags is not None:
                out['title']       = _s(f.tags.get('TIT2') or f.tags.get('title'))
                out['artist']      = _s(f.tags.get('TPE1') or f.tags.get('artist'))
                out['album']       = _s(f.tags.get('TALB') or f.tags.get('album'))
                out['albumartist'] = _s(f.tags.get('TPE2') or f.tags.get('albumartist'))
        else:
            f = mutagen.File(path)
            if f is None:
                out['error'] = 'unsupported'
                return out
            codec = (getattr(f.info, 'codec', '') or ext.lstrip('.')).lower()
            if f.tags is not None:
                out['title']       = _s(f.tags.get('title'))
                out['artist']      = _s(f.tags.get('artist'))
                out['album']       = _s(f.tags.get('album'))
                out['albumartist'] = _s(f.tags.get('albumartist'))

        if f is not None and f.info is not None:
            try:
                out['duration_ms'] = int(round((f.info.length or 0) * 1000))
            except Exception:
                out['duration_ms'] = 0
            out['sample_rate'] = int(getattr(f.info, 'sample_rate', 0) or 0)
            out['bit_depth']   = int(getattr(f.info, 'bits_per_sample', 0) or 0)

        out['codec'] = codec
        out['ok'] = True
        return out
    except Exception as e:  # noqa: BLE001
        out['error'] = f'{type(e).__name__}: {e}'
        return out


def main():
    if len(sys.argv) >= 2:
        paths = sys.argv[1:]
    else:
        try:
            paths = json.load(sys.stdin)
        except Exception as e:  # noqa: BLE001
            print(f'bad stdin: {e}', file=sys.stderr)
            sys.exit(2)
        if not isinstance(paths, list):
            print('stdin must be a JSON array of paths', file=sys.stderr)
            sys.exit(2)

    results = [read_tags(p) for p in paths]
    json.dump(results, sys.stdout, ensure_ascii=False)


if __name__ == '__main__':
    main()
