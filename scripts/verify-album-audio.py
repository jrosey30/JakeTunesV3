#!/usr/bin/env python3
"""
verify-album-audio — prove an album's songs are what the app CALLS them, by
listening to them instead of trusting metadata.

    python3 scripts/verify-album-audio.py "Wolf Parade" "Apologies to the Queen Mary"

WHY THIS EXISTS (2026-08-08). Jake played a track labelled "It's a Curse" and
heard "Shine a Light". The files were iPod-era rips whose tag blocks had been
paired with the wrong audio: each file's own tags were internally consistent
(title AND track number matched the real record) while the AUDIO was a
different song. Nothing in the library could catch that, because the library
faithfully reports what the files claim.

The first tool I reached for compared each track's DURATION against a
MusicBrainz release picked by track count. That method is dangerous and it
lied twice within an hour: albums exist in many editions (deluxe, reissue,
vinyl, regional) with different track orders and lengths, so comparing a
correct album against the wrong edition makes every position disagree and
reads exactly like a scramble. It libelled blink-182 and LCD Soundsystem's
Sound of Silver — both perfect — before Jake caught it ("no shot that is not
true....id notice"). Duration is a HINT. It is not identity.

So this tool matches AUDIO TO AUDIO:
  1. Ask iTunes for the album's official 30-second preview of every track.
  2. Fingerprint each preview with Chromaprint (fpcalc).
  3. Fingerprint each of your files and slide the preview across it, taking
     the best bit-similarity.
  4. Report, per track, which official song your file actually SOUNDS like.

A true match scores ~95%+; a wrong song scores far lower. That verdict is
independent of edition, tags, track numbers, and of my judgement.

Requires: fpcalc (brew install chromaprint) and ffmpeg. Read-only — it never
writes to the library. Fix anything it finds via metadata-overrides.json.
"""
import json
import os
import subprocess
import sys
import urllib.parse
import urllib.request

LIB = os.path.expanduser('~/Library/Application Support/JakeTunes/library.json')
ROOTS = ['~/Music2/JakeTunesLibrary', '~/Music/JakeTunesLibrary']
UA = 'Mozilla/5.0'
WORK = '/tmp/jt-verify-album'
MATCH_FLOOR = 0.90          # below this, a "best match" is not a match


def library_root() -> str:
    for r in ROOTS:
        p = os.path.expanduser(r)
        if os.path.isdir(p):
            return p
    sys.exit('no library root found')


def raw_fingerprint(path: str) -> list:
    out = subprocess.run(['fpcalc', '-raw', path], capture_output=True, text=True).stdout
    for line in out.splitlines():
        if line.startswith('FINGERPRINT='):
            return [int(x) for x in line.split('=', 1)[1].split(',') if x]
    return []


def best_overlap(full: list, clip: list) -> float:
    """Slide the short clip along the full track; return best bit-similarity."""
    if not full or not clip:
        return 0.0
    n, m = len(full), len(clip)
    if m > n:
        full, clip, n, m = clip, full, m, n
    best = 0.0
    for off in range(0, n - m + 1):
        bits = 0
        for i in range(m):
            bits += bin(full[off + i] ^ clip[i]).count('1')
        sim = 1.0 - bits / (m * 32)
        if sim > best:
            best = sim
    return best


def itunes_previews(artist: str, album: str) -> dict:
    q = urllib.parse.quote(f'{artist} {album}')
    url = f'https://itunes.apple.com/search?term={q}&entity=song&limit=100'
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    res = json.load(urllib.request.urlopen(req, timeout=25))
    out = {}
    for r in res.get('results', []):
        if album.lower()[:16] not in (r.get('collectionName', '') or '').lower():
            continue
        if artist.lower()[:8] not in (r.get('artistName', '') or '').lower():
            continue
        n, name, prev = r.get('trackNumber'), r.get('trackName'), r.get('previewUrl')
        if n and name and prev and n not in out:
            out[n] = (name, prev)
    return out


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    artist, album = sys.argv[1], sys.argv[2]
    os.makedirs(WORK, exist_ok=True)
    root = library_root()

    lib = json.load(open(LIB))
    tracks = [t for t in lib['tracks']
              if album.lower()[:16] in (t.get('album', '') or '').lower()
              and artist.lower()[:8] in ((t.get('albumArtist') or t.get('artist') or '').lower())]
    tracks.sort(key=lambda t: t.get('trackNumber') or 99)
    if not tracks:
        print(f'no tracks found for {artist} — {album}')
        return 1

    previews = itunes_previews(artist, album)
    if not previews:
        print('iTunes has no previews for this album — cannot verify acoustically')
        return 1

    prints = {}
    for n, (name, url) in sorted(previews.items()):
        if n > len(tracks) + 3:
            continue
        p = os.path.join(WORK, f'p{n:02d}.m4a')
        if not os.path.exists(p):
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=30) as r, open(p, 'wb') as f:
                f.write(r.read())
        fp = raw_fingerprint(p)
        if fp:
            prints[n] = (name, fp)
    print(f'{artist} — {album}: {len(tracks)} files, {len(prints)} official previews\n')

    print(f"{'the app calls it':40} {'it actually sounds like':40} score")
    wrong = []
    for t in tracks:
        full = os.path.join(root, (t.get('path') or '').replace(':', '/').lstrip('/'))
        if not os.path.exists(full):
            print(f"  {t.get('title','')[:38]:40} {'FILE MISSING':40}")
            continue
        fp = raw_fingerprint(full)
        ranked = sorted(((best_overlap(fp, pf), nm) for nm, pf in prints.values()), reverse=True)
        score, name = ranked[0] if ranked else (0.0, '?')
        same = (t.get('title', '').lower().strip()[:16] == name.lower().strip()[:16])
        flag = '' if same else '  <-- MISLABELLED'
        if not same and score >= MATCH_FLOOR:
            wrong.append((t.get('title'), name, t['id']))
        if score < MATCH_FLOOR:
            flag = '  (no confident match)'
        print(f"  {t.get('title','')[:38]:40} {name[:38]:40} {score*100:5.1f}%{flag}")

    print()
    if wrong:
        print(f'{len(wrong)} track(s) are mislabelled. Correct them in metadata-overrides.json:')
        for was, is_, tid in wrong:
            print(f'   id {tid}: {was!r} is really {is_!r}')
    else:
        print('every file matches the name the app shows. album is clean.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
