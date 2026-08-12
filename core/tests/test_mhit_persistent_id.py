"""
Activity sync wipe+rebuild stamps the first mhit as a template onto every
is_new track. Persistent ids must be unique at BOTH empirical (0x6C/0x94) and
libgpod (0x70/0xA8) slots — otherwise the Mini collapses the new songs and a
500-track ALAC set shows ~100 in Music > Songs.
"""
from __future__ import annotations

import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from db_reader import build_mhit_record  # noqa: E402


def _hdr(hlen: int = 0xF4) -> bytearray:
    h = bytearray(hlen)
    struct.pack_into('<4s', h, 0, b'mhit')
    struct.pack_into('<I', h, 4, hlen)
    # Poison the template's persistent-id slots the way a real first-mhit does:
    # one shared value every is_new track would inherit if we forgot to rewrite.
    poison = 0x4310E86A00000000 | 0x8000000000000000
    if hlen >= 0x6C + 8:
        struct.pack_into('<Q', h, 0x6C, poison)
    if hlen >= 0x70 + 8:
        struct.pack_into('<Q', h, 0x70, poison)
    if hlen >= 0x94 + 8:
        struct.pack_into('<Q', h, 0x94, poison)
    if hlen >= 0xA8 + 8:
        struct.pack_into('<Q', h, 0xA8, poison)
    return h


def _ids(rec: bytes) -> dict[str, int]:
    # Header length is at +4; persistent fields live in the header.
    return {
        '6c': struct.unpack_from('<Q', rec, 0x6C)[0],
        '70': struct.unpack_from('<Q', rec, 0x70)[0],
        '94': struct.unpack_from('<Q', rec, 0x94)[0],
        'a8': struct.unpack_from('<Q', rec, 0xA8)[0],
    }


def test_is_new_tracks_get_unique_persistent_ids_at_empirical_pair():
    template = _hdr()
    tracks = [
        {'id': 1, 'title': 'One', 'artist': 'A', 'path': ':iPod_Control:Music:F00:AAAA.m4a',
         'fileSize': 1_000_000, 'duration': 180_000, 'audioFingerprint': 'fp1'},
        {'id': 2, 'title': 'Two', 'artist': 'B', 'path': ':iPod_Control:Music:F01:BBBB.m4a',
         'fileSize': 1_100_000, 'duration': 200_000, 'audioFingerprint': 'fp2'},
        {'id': 3, 'title': 'Three', 'artist': 'C', 'path': ':iPod_Control:Music:F02:CCCC.m4a',
         'fileSize': 1_200_000, 'duration': 210_000, 'audioFingerprint': 'fp3'},
    ]
    seen: set[int] = set()
    for i, t in enumerate(tracks):
        rec = build_mhit_record(t, dbid=1000 + i, template_header=bytearray(template), is_new=True)
        ids = _ids(rec)
        assert ids['6c'] == ids['94'], ids
        assert ids['6c'] & 0x8000000000000000, 'iTunes convention: MSB set'
        assert ids['6c'] not in seen, f'collapsed at 0x6C: {ids["6c"]:x}'
        seen.add(ids['6c'])
        # 0xA8 mirrors when the header is long enough; 0x70 must NOT be a
        # second 8-byte pack — it overlaps 0x6C.
        if ids['a8'] != 0:
            assert ids['a8'] == ids['6c'], ids
    assert len(seen) == 3


def test_short_template_grows_for_empirical_pair_and_mediatype():
    short = _hdr(0x9C)
    t = {'id': 9, 'title': 'X', 'artist': 'Y', 'path': ':iPod_Control:Music:F00:ZZZZ.m4a',
         'fileSize': 500_000, 'duration': 120_000, 'audioFingerprint': 'fpZ'}
    rec = build_mhit_record(t, dbid=42, template_header=short, is_new=True)
    hlen = struct.unpack_from('<I', rec, 4)[0]
    assert hlen >= 0xD0 + 4
    ids = _ids(rec)
    assert ids['6c'] == ids['94']
    assert struct.unpack_from('<I', rec, 0xD0)[0] == 1
    assert struct.unpack_from('<I', rec, 0x3C)[0] == (44100 << 16)


if __name__ == '__main__':
    test_is_new_tracks_get_unique_persistent_ids_at_empirical_pair()
    test_short_template_grows_for_empirical_pair_and_mediatype()
    print('ok')
