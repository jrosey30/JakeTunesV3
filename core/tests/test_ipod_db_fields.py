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

    # Anything still exotic must not survive as >U+00FF.
    check("transliterates CJK/exotic away", all(ord(c) <= 0xFF for c in f('東京 トラック')))
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


def main():
    print("iPod iTunesDB field regression guard")
    print("=" * 62)
    test_char_fold()
    test_string_mhod_folding()
    test_playlist_ordinal()
    test_empirical_device_fields()
    print("=" * 62)
    if FAILURES:
        print(f"FAILED {len(FAILURES)}/{CHECKS[0]}: {FAILURES}")
        return 1
    print(f"PASSED {CHECKS[0]}/{CHECKS[0]} checks")
    return 0


if __name__ == '__main__':
    sys.exit(main())
