#!/usr/bin/env python3
"""
Regression guard for the iTunesDB fields that decide whether a song APPEARS on
Jake's iPod mini.

Every assertion here was paid for with a real device regression. The 2026-07-24/25
session went 205 -> 118 -> 247 -> 250 songs on a 250-track sync purely by moving
these values around, and each wrong turn cost an hour of syncing and squinting at
a click wheel. If one of these breaks, songs vanish SILENTLY — no error, no log,
just a smaller number on the device. That is the failure mode these tests exist
to prevent.

Two classes of assertion:

  1. SPEC-CORRECT things that were simply never written (the playlist ordinal).
  2. EMPIRICAL things where this device DISAGREES with libgpod's reference spec.
     Those are marked ⚠️ and must not be "corrected" — doing exactly that is what
     took the count from 205 down to 118.

Run:  python3 core/tests/test_ipod_db_fields.py
"""
import os
import struct
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import db_reader  # noqa: E402

FAILURES = []
CHECKS = [0]


def check(label, cond, detail=''):
    CHECKS[0] += 1
    if cond:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label}  {detail}")
        FAILURES.append(label)


def u32(b, o):
    return struct.unpack_from('<I', b, o)[0]


def u64(b, o):
    return struct.unpack_from('<Q', b, o)[0]


# ── 1. Character folding — the last 3 missing songs ─────────────────────────
# A 250-track sync landed 247. The three missing tracks were the only ones whose
# titles contained a character above U+2000 (U+2019, curly apostrophe):
#   Drake "B's On The Table" / Beastie Boys "Something's Got To Give" /
#   Turnstile "SEEIN' STARS". This firmware drops such tracks silently.
def test_char_fold():
    print("\nfold_for_ipod — typographic Unicode this device rejects")
    f = db_reader.fold_for_ipod

    for real in ['B’s On The Table', 'Something’s Got To Give', 'SEEIN’ STARS']:
        out = f(real)
        check(f"folds the real offender {real[:22]!r}",
              all(ord(c) <= 0x7F for c in out), f"-> {out!r}")

    check("curly single quote -> ASCII apostrophe", f('don’t') == "don't")
    check("curly double quotes -> ASCII", f('“Hey”') == '"Hey"')
    check("en/em dash -> hyphen", f('A – B — C') == 'A - B - C')
    check("ellipsis -> three dots", f('wait…') == 'wait...')

    # Accents are deliberately PRESERVED — the device renders Latin-1 fine, and
    # folding them would mangle titles for no benefit.
    check("keeps Latin-1 accents (device renders them)", f('Café Tacvba') == 'Café Tacvba')
    check("keeps ó / í", f('Sigur Rós Höppipolla')[:9] == 'Sigur Rós')

    # Hebrew has no Latin NFKD form. Blanking it (2026-08-15) is how a
    # listable title becomes a skip. Keep the original when the map
    # would leave only whitespace.
    check("Hebrew is not blanked", f('דג').strip() == 'דג')
    check("Hebrew title stays non-empty", f('בלו בלו בלו').strip() != '')
    check("CJK is not blanked", f('東京 トラック').strip() != '')
    check("empty/None safe", f('') == '' and f(None) == '')


# ── 2. String mhods use the fold — except the file path ────────────────────
def test_string_mhod_folding():
    print("\nbuild_string_mhod — folds metadata, NEVER the path")
    title = db_reader.build_string_mhod(1, 'don’t')
    slen = u32(title, 28)
    s = title[40:40 + slen].decode('utf-16-le')
    check("title mhod is folded", s == "don't", f"-> {s!r}")

    # mhod type 2 is the file location: its bytes must match the real on-disk
    # name exactly, or the track becomes unplayable. Never fold it.
    path = ':iPod_Control:Music:F12:AB’CD.m4a'
    rec = db_reader.build_string_mhod(2, path)
    slen = u32(rec, 28)
    got = rec[40:40 + slen].decode('utf-16-le')
    check("PATH mhod is left byte-exact (never folded)", got == path, f"-> {got!r}")


# ── 3. Playlist ordinal — worth +42 songs ──────────────────────────────────
# build_order_mhod never wrote the ordinal at all, so every item in every
# playlist reported position 0 — the master library list had N songs all
# claiming one slot. Writing it took a 250-sync from 205 to 247.
def test_playlist_ordinal():
    print("\nbuild_order_mhod / build_mhip — the ordinal that was never written")
    rec = db_reader.build_order_mhod(7)
    check("type-100 mhod", rec[0:4] == b'mhod' and u32(rec, 12) == 100)
    check("ordinal written at +0x18", u32(rec, 0x18) == 7, f"-> {u32(rec, 0x18)}")
    check("ordinal 0 is representable", u32(db_reader.build_order_mhod(0), 0x18) == 0)

    mhip = db_reader.build_mhip(dbid=4242, position=5, timestamp_mac=0)
    check("mhip header", mhip[0:4] == b'mhip' and u32(mhip, 8) == 120)
    check("track ref at +0x18", u32(mhip, 0x18) == 4242)
    check("ordinal reaches the child mhod", u32(mhip, 76 + 0x18) == 5,
          f"-> {u32(mhip, 76 + 0x18)}")

    # Distinct ordinals across a run — the actual property the firmware needs.
    positions = [u32(db_reader.build_mhip(i + 100, i, 0), 76 + 0x18) for i in range(50)]
    check("50 items get 50 DISTINCT ordinals", len(set(positions)) == 50)
    check("ordinals ascend 0..n-1", positions == list(range(50)))


# ── 4. ⚠️ EMPIRICAL device values — do NOT "correct" these to spec ─────────
def test_empirical_device_fields():
    print("\n⚠️  empirical mhit fields — spec says otherwise, the DEVICE wins")
    MHIT_HLEN = 0x270
    template = bytearray(MHIT_HLEN)      # roomy classic-ish mhit header
    # A real template carries its own header_len at +4; build_mhit_record
    # reuses the template wholesale and only patches specific offsets, so an
    # all-zeros fixture would leave header_len = 0 and break any walk.
    struct.pack_into('<4s', template, 0, b'mhit')
    struct.pack_into('<I', template, 4, MHIT_HLEN)
    track = {
        'id': 1, 'title': 'x', 'artist': 'y', 'album': 'z', 'genre': 'g',
        'path': ':iPod_Control:Music:F00:AAAA.m4a', 'audioFingerprint': 'fp-1',
        'fileSize': 1000, 'duration': 200000,
    }
    rec = db_reader.build_mhit_record(track, 55, bytes(template), is_new=True)

    check("visible flag = 1 (+0x14)", u32(rec, 0x14) == 1)

    # 0x64: libgpod calls it drm_userid and would want 0. Zeroing it cost 132
    # tracks on 2026-07-24; the 2026-04-26 postmortem recovered 150 by forcing 1.
    check("⚠️ 0x64 == 1 (spec says drm_userid=0; device wants 1)",
          u32(rec, 0x64) == 1, f"-> {u32(rec, 0x64)}")

    # Persistent id: spec puts it at 0x70/0xA8. This firmware reads 0x6C —
    # moving it caused the ~140-track duplicate collapse twice.
    check("⚠️ persistent id present at 0x6C (spec says 0x70)",
          u64(rec, 0x6C) != 0, f"-> {u64(rec, 0x6C):#x}")

    # Distinctness is the whole point — a shared id collapses tracks.
    other = db_reader.build_mhit_record({**track, 'path': ':iPod_Control:Music:F00:BBBB.m4a',
                                         'audioFingerprint': 'fp-2'}, 56, bytes(template), is_new=True)
    check("persistent ids differ per track", u64(rec, 0x6C) != u64(other, 0x6C))
    check("same content -> same id (idempotent re-sync)",
          u64(rec, 0x6C) == u64(db_reader.build_mhit_record(track, 55, bytes(template), is_new=True), 0x6C))

    # mhod 32: spec calls it binary/video-only. Removing it cost 72 tracks.
    mhod_count = u32(rec, 0x0C)
    types = []
    q = u32(rec, 4)                      # mhods begin right after the header
    for _ in range(mhod_count):
        if rec[q:q + 4] != b'mhod':
            break
        types.append(u32(rec, q + 12))
        q += u32(rec, q + 8)
    check("⚠️ mhod type 32 emitted (spec says video-only; device needs it)",
          32 in types, f"types={types}")
    check("title/path/album/artist mhods present", {1, 2, 3, 4} <= set(types), f"types={types}")


def test_ipod_artist_sort_and_album_index():
    print("\nipod artist sort — Music > Artists A–Z (activity-sync first-seen bug)")
    k = db_reader.ipod_artist_sort_key
    check("The Beatles files under B", k('The Beatles') == 'beatles')
    check("A Tribe Called Quest files under T", k('A Tribe Called Quest') == 'tribe called quest')
    check("sortArtist wins", k('The Beatles', 'Beatles') == 'beatles')
    check("label strips The", db_reader.ipod_artist_sort_label('The Beatles') == 'Beatles')
    check("_fold still keeps The (mhod52 must not use artist-sort)",
          db_reader._fold('The Beatles').startswith('the '))

    tuples = db_reader.album_tuples_for_itunesdb([
        {'artist': 'The Strokes', 'album': 'Is This It', 'albumArtist': 'The Strokes'},
        {'artist': 'Daft Punk', 'album': 'Discovery', 'albumArtist': 'Daft Punk'},
        {'artist': 'The Beatles', 'album': 'Abbey Road', 'albumArtist': 'The Beatles'},
        {'artist': 'The Beatles', 'album': 'Help!', 'albumArtist': 'The Beatles'},
        {'artist': 'A Tribe Called Quest', 'album': 'The Low End Theory',
         'albumArtist': 'A Tribe Called Quest'},
        {'artist': 'Pink Floyd', 'album': 'The Dark Side of the Moon',
         'albumArtist': 'Pink Floyd'},
    ])
    albums = [t[2] for t in tuples]
    check("mhia album list is A–Z by album title (The/A/An stripped)",
          albums == ['Abbey Road', 'The Dark Side of the Moon', 'Discovery', 'Help!',
                     'Is This It', 'The Low End Theory'],
          f"-> {albums}")
    check("sortAlbum wins for mhia album order",
          db_reader.album_tuples_for_itunesdb([
              {'artist': 'Z', 'album': 'Zebra', 'albumArtist': 'Z', 'sortAlbum': 'Apple'},
              {'artist': 'A', 'album': 'Banana', 'albumArtist': 'A'},
          ])[0][2] == 'Zebra')

    MHIT_HLEN = 0x270
    template = bytearray(MHIT_HLEN)
    struct.pack_into('<4s', template, 0, b'mhit')
    struct.pack_into('<I', template, 4, MHIT_HLEN)
    rec = db_reader.build_mhit_record(
        {'id': 1, 'title': 'Come Together', 'artist': 'The Beatles', 'album': 'Abbey Road',
         'genre': 'Rock', 'path': ':iPod_Control:Music:F00:AAAA.m4a',
         'audioFingerprint': 'fp-beatles', 'fileSize': 1000, 'duration': 200000},
        55, bytes(template), is_new=True)
    mhod_count = u32(rec, 0x0C)
    q = u32(rec, 4)
    strs = {}
    for _ in range(mhod_count):
        if rec[q:q + 4] != b'mhod':
            break
        mtyp = u32(rec, q + 12)
        slen = u32(rec, q + 28)
        if slen and 40 + slen <= u32(rec, q + 8):
            strs[mtyp] = rec[q + 40:q + 40 + slen].decode('utf-16-le')
        q += u32(rec, q + 8)
    check("mhod 4 display artist keeps The", strs.get(4) == 'The Beatles')
    check("mhod 22 sort-artist is Beatles", strs.get(22) == 'Beatles', f"-> {strs.get(22)!r}")


def _sample_music_tracks():
    return [
        {'id': 1, 'title': 'The End', 'artist': 'The Doors', 'album': 'The Doors',
         'genre': 'Rock', 'sortArtist': 'Doors'},
        {'id': 2, 'title': 'Taste', 'artist': 'Sabrina Carpenter', 'album': 'Short n\' Sweet',
         'genre': 'Pop'},
        {'id': 3, 'title': 'Come Together', 'artist': 'The Beatles', 'album': 'Abbey Road',
         'genre': 'Rock', 'sortArtist': 'Beatles'},
        {'id': 4, 'title': 'One More Time', 'artist': 'Daft Punk', 'album': 'Discovery',
         'genre': 'Electronic'},
        {'id': 5, 'title': 'Excursions', 'artist': 'A Tribe Called Quest',
         'album': 'The Low End Theory', 'genre': 'Hip-Hop'},
        {'id': 6, 'title': 'Time', 'artist': 'Pink Floyd', 'album': 'The Dark Side of the Moon',
         'genre': 'Rock'},
        {'id': 7, 'title': 'Tiësto', 'artist': 'Tiësto', 'album': 'In My Memory',
         'genre': 'Electronic'},
    ]


def test_music_menu_sort_indexes():
    print("\nMusic menus — Songs / Albums / Genres type-52 + mhia / genre A–Z")
    check("partial template still emits Songs+Genres+Albums+Artists keys",
          db_reader.music_menu_sort_keys([4, 18]) == [3, 4, 5, 7, 18],
          f"-> {db_reader.music_menu_sort_keys([4, 18])}")
    check("empty template uses defaults with 3/4/5/7 first",
          db_reader.music_menu_sort_keys([])[:4] == [3, 4, 5, 7])
    check("already-complete template keeps extras after required",
          db_reader.music_menu_sort_keys([3, 4, 5, 7, 18, 35, 36]) == [3, 4, 5, 7, 18, 35, 36])

    tracks = _sample_music_tracks()

    # Songs — type-52 key 7 is firmware _fold. "The End" stays under T
    # (after Taste), never article-stripped to E. That's the Mini 1.4.1
    # discard rule.
    titles = [tracks[i]['title'] for i in db_reader._sort_indices(tracks, 7)]
    check("Songs type-52 is firmware-fold title A–Z (The stays under T)",
          titles == ['Come Together', 'Excursions', 'One More Time', 'Taste',
                     'The End', 'Tiësto', 'Time'],
          f"-> {titles}")
    check("Songs _fold('The End') starts with the (not end)",
          db_reader._fold('The End').startswith('the '))

    titled = [
        {'title': 'Zebra', 'sortTitle': 'Apple'},
        {'title': 'Banana'},
    ]
    check("Songs prefers sortTitle as _fold input",
          [titled[i]['title'] for i in db_reader._sort_indices(titled, 7)] == ['Zebra', 'Banana'])

    # Albums — type-52 key 3 is _fold (The Dark Side under T, not D).
    albums = [tracks[i]['album'] for i in db_reader._sort_indices(tracks, 3)]
    # unique consecutive for the assertion of fold order
    seen = []
    for a in albums:
        if a not in seen:
            seen.append(a)
    check("Albums type-52 is firmware-fold (The Dark Side under T, not D)",
          seen == ['Abbey Road', 'Discovery', 'In My Memory', 'Short n\' Sweet',
                   'The Dark Side of the Moon', 'The Doors', 'The Low End Theory'],
          f"-> {seen}")
    check("Albums _fold keeps leading The",
          db_reader._fold('The Dark Side of the Moon').startswith('the '))
    folded_albums = [
        {'album': 'Zebra', 'sortAlbum': 'Apple', 'discNumber': 1, 'trackNumber': 1},
        {'album': 'Banana', 'discNumber': 1, 'trackNumber': 1},
    ]
    check("Albums prefers sortAlbum as _fold input",
          [folded_albums[i]['album'] for i in db_reader._sort_indices(folded_albums, 3)]
          == ['Zebra', 'Banana'])

    # Artists type-52 key 4 MUST fold display artist, not stamped sortArtist.
    # "The Beatles" / sortArtist Beatles → 'the beatles', or firmware drops Songs.
    artist_idx = db_reader._sort_indices(tracks, 4)
    artist_folds = [db_reader._fold(tracks[i]['artist']) for i in artist_idx]
    check("Artists type-52 folds display artist (The Beatles under T)",
          artist_folds == sorted(artist_folds), f"-> {artist_folds}")
    check("Artists type-52 does not use stamped sortArtist Beatles",
          db_reader._fold(tracks[2]['sortArtist']) == 'beatles'
          and db_reader._fold(tracks[2]['artist']).startswith('the '))

    # Genres — type-52 key 5 + unique list.
    genres = [tracks[i]['genre'] for i in db_reader._sort_indices(tracks, 5)]
    first = []
    for g in genres:
        if g not in first:
            first.append(g)
    check("Genres type-52 first-seen is A–Z by _fold(genre)",
          first == ['Electronic', 'Hip-Hop', 'Pop', 'Rock'], f"-> {first}")
    check("unique_genre_names_az matches type-52 genre order",
          db_reader.unique_genre_names_az(tracks) == ['Electronic', 'Hip-Hop', 'Pop', 'Rock'])

    # Accent fold still lives in type-52 (the Songs-vanished bug).
    check("type-52 folds ë→e so Tiësto sits with T, not after Tz",
          db_reader._fold('Tiësto') == 'tiesto')


def test_codec_marker_never_defaults_to_mp3():
    print("\ncodec marker — unknown ext / FLAC / leftover MP3 template")
    MHIT_HLEN = 0x270
    template = bytearray(MHIT_HLEN)
    struct.pack_into('<4s', template, 0, b'mhit')
    struct.pack_into('<I', template, 4, MHIT_HLEN)
    struct.pack_into('<4s', template, 0x18, b'MP3 ')  # poisoned template

    def marker_of(path, codec, is_new):
        rec = db_reader.build_mhit_record(
            {'id': 1, 'title': 'x', 'artist': 'y', 'album': 'z', 'genre': 'g',
             'path': path, 'codec': codec, 'audioFingerprint': path,
             'fileSize': 1000, 'duration': 200000},
            55, bytes(template), is_new=is_new)
        return rec[0x18:0x1C]

    check("unknown FAT temp + ALAC → M4A (not MP3)",
          marker_of(':F00:x.0i4zLU', 'alac', True) == b'M4A ')
    check("existing mhit with leftover MP3 template still rewritten to M4A",
          marker_of(':F00:x.m4a', 'alac', False) == b'M4A ')
    check("FLAC path is never stamped FLAC",
          marker_of(':F10:imported_9860.flac', 'flac', True) == b'M4A ')
    check("real mp3 still MP3",
          marker_of(':F00:x.mp3', 'mp3', True) == b'MP3 ')
    check("codec_marker_for_track default is M4A",
          db_reader.codec_marker_for_track({'path': ':F00:x.fQMz7S', 'codec': 'alac'}) == b'M4A ')


def main():
    print("iPod iTunesDB field regression guard")
    print("=" * 62)
    test_char_fold()
    test_string_mhod_folding()
    test_playlist_ordinal()
    test_empirical_device_fields()
    test_ipod_artist_sort_and_album_index()
    test_music_menu_sort_indexes()
    test_codec_marker_never_defaults_to_mp3()
    print("=" * 62)
    if FAILURES:
        print(f"FAILED {len(FAILURES)}/{CHECKS[0]}: {FAILURES}")
        return 1
    print(f"PASSED {CHECKS[0]}/{CHECKS[0]} checks")
    return 0


if __name__ == '__main__':
    sys.exit(main())
