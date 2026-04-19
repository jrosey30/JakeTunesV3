"""
Write ID3 / MP4 tags into an audio file after it's been encoded.

Usage: tag_writer.py <path>
  Reads JSON from stdin of the form:
    { "title":..., "artist":..., "album":..., "albumArtist":...,
      "genre":..., "year":..., "trackNumber":..., "trackCount":...,
      "discNumber":..., "discCount":...,
      "uuid": "...optional stable UUID..." }
  Empty / missing fields are skipped. Writes in-place.

We call this from Node (src/main/platform.ts) right after afconvert/ffmpeg
emits the output file, so every ripped or imported track ends up
self-identifying — even if the JakeTunes library.json is later lost.
"""
import json
import sys
import os

import mutagen
from mutagen.easyid3 import EasyID3
from mutagen.easymp4 import EasyMP4
from mutagen.mp3 import MP3
from mutagen.mp4 import MP4
from mutagen.flac import FLAC


def _first_nonempty(payload, *keys):
    for k in keys:
        v = payload.get(k)
        if v not in (None, '', 0):
            return v
    return None


def _write_pair(f, key, num, count):
    """Write track/disc number+count as 'N/M' or just 'N'."""
    try:
        n = int(num or 0)
    except (TypeError, ValueError):
        n = 0
    try:
        c = int(count or 0)
    except (TypeError, ValueError):
        c = 0
    if n <= 0:
        return
    f[key] = [f"{n}/{c}"] if c > 0 else [str(n)]


def tag_file(path, payload):
    ext = os.path.splitext(path)[1].lower()

    if ext == '.mp3':
        try:
            f = EasyID3(path)
        except Exception:
            f = MP3(path)
            f.add_tags()
            f = EasyID3(path)
        _apply_easy(f, payload)
        # UUID lives in a custom TXXX frame on MP3 (EasyID3 doesn't expose it)
        uid = payload.get('uuid')
        if uid:
            # Use the full ID3 frame interface for TXXX
            from mutagen.id3 import ID3, TXXX
            tags = ID3(path)
            tags.delall('TXXX:JAKETUNES_UUID')
            tags.add(TXXX(encoding=3, desc='JAKETUNES_UUID', text=uid))
            tags.save(path)
            return
        f.save()
        return

    if ext in ('.m4a', '.mp4', '.alac'):
        try:
            f = EasyMP4(path)
        except Exception:
            mp4 = MP4(path)
            mp4.save()
            f = EasyMP4(path)
        _apply_easy(f, payload)
        uid = payload.get('uuid')
        if uid:
            mp4 = MP4(path)
            mp4['----:com.jaketunes:uuid'] = [uid.encode('utf-8')]
            mp4.save()
            return
        f.save()
        return

    if ext == '.flac':
        f = FLAC(path)
        _apply_flac(f, payload)
        f.save()
        return

    # .aiff / .wav — mutagen support is limited; skip silently.


def _apply_easy(f, p):
    """Apply payload to an Easy* mutagen file."""
    if p.get('title'):       f['title']       = [str(p['title'])]
    if p.get('artist'):      f['artist']      = [str(p['artist'])]
    if p.get('album'):       f['album']       = [str(p['album'])]
    if p.get('albumArtist'): f['albumartist'] = [str(p['albumArtist'])]
    if p.get('genre'):       f['genre']       = [str(p['genre'])]
    year = p.get('year')
    if year and str(year).strip():
        f['date'] = [str(year)]
    _write_pair(f, 'tracknumber', p.get('trackNumber'), p.get('trackCount'))
    _write_pair(f, 'discnumber',  p.get('discNumber'),  p.get('discCount'))


def _apply_flac(f, p):
    """Apply payload to a FLAC file (uses Vorbis-comment keys)."""
    for src, dst in [
        ('title', 'title'), ('artist', 'artist'), ('album', 'album'),
        ('albumArtist', 'albumartist'), ('genre', 'genre'),
    ]:
        v = p.get(src)
        if v:
            f[dst] = [str(v)]
    year = p.get('year')
    if year:
        f['date'] = [str(year)]
    # FLAC uses separate tracknumber + tracktotal
    tn = p.get('trackNumber'); tc = p.get('trackCount')
    if tn:
        f['tracknumber'] = [str(tn)]
        if tc:
            f['tracktotal'] = [str(tc)]
    dn = p.get('discNumber'); dc = p.get('discCount')
    if dn:
        f['discnumber'] = [str(dn)]
        if dc:
            f['disctotal'] = [str(dc)]
    uid = p.get('uuid')
    if uid:
        f['jaketunes_uuid'] = [uid]


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('Usage: tag_writer.py <audio-file>', file=sys.stderr)
        sys.exit(1)
    path = sys.argv[1]
    if not os.path.isfile(path):
        print(f'Not a file: {path}', file=sys.stderr)
        sys.exit(1)
    payload = json.load(sys.stdin)
    tag_file(path, payload)
    print('ok')
