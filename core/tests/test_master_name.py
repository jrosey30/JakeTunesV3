#!/usr/bin/env python3
"""
The iPod's own name is the master playlist's title (Settings > About).

2026-11-07, Jake: "i actually want to name the actual ipod punkPod not just a
nickname. it shows up as JT Red". The writer used to put a fixed 'JakeTunes'
there; it now writes the name JakeTunes knows the iPod by (its marker), passed
in as `masterName`, and never keeps the template's old title.

Builds its own tiny template in a temp folder — never reads or writes an iPod.

Run:  python3 core/tests/test_master_name.py
"""
import os
import struct
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import db_reader  # noqa: E402

FAILURES = []


def check(label, cond, detail=''):
    print(f"  {'ok  ' if cond else 'FAIL'} {label}{'' if cond else '  ' + str(detail)}")
    if not cond:
        FAILURES.append(label)


def empty_template():
    mhlt = bytearray(92)
    struct.pack_into('<4sII', mhlt, 0, b'mhlt', 92, 0)
    mhsd = bytearray(96)
    struct.pack_into('<4sIII', mhsd, 0, b'mhsd', 96, 96 + len(mhlt), 1)
    mhbd = bytearray(104)
    struct.pack_into('<4sII', mhbd, 0, b'mhbd', 104, 104 + 96 + len(mhlt))
    struct.pack_into('<I', mhbd, 20, 1)
    return bytes(mhbd + mhsd + mhlt)


def tracks():
    return [{'id': 1, 'title': 'Song', 'artist': 'Band', 'album': 'A', 'genre': 'Rock',
             'path': ':iPod_Control:Music:F00:x.m4a', 'duration': 200000, 'codec': 'alac', 'fileSize': 1000}]


def write(d, template, out, **kw):
    db_reader.write_itunesdb(tracks(), [{'name': 'Top 1000', 'trackIds': [1]}], template, out, ipod_root=d, **kw)
    return db_reader.parse_master_name(out)


def main():
    print("\nmaster playlist title = the iPod's name")
    d = tempfile.mkdtemp(prefix='jt-master-name-')
    tpl = os.path.join(d, 'template')
    with open(tpl, 'wb') as f:
        f.write(empty_template())

    check("no name passed keeps the old fixed title", write(d, tpl, os.path.join(d, 'a')) == 'JakeTunes')
    check("the iPod's name is written as the master title", write(d, tpl, os.path.join(d, 'b'), master_name='punkPod') == 'punkPod')

    # A card whose catalog already says "JT Red": the template's title never survives.
    red = os.path.join(d, 'red')
    write(d, tpl, red, master_name='JT Red')
    check("a template titled 'JT Red' parses back as 'JT Red'", db_reader.parse_master_name(red) == 'JT Red')
    renamed = os.path.join(d, 'renamed')
    got = write(d, red, renamed, master_name='punkPod')
    check("rebuilt from that template, the title is the new name", got == 'punkPod', got)

    # Round trip: the rebuilt catalog, used as a template again, keeps the name
    # and its user playlists.
    again = os.path.join(d, 'again')
    got = write(d, renamed, again, master_name='punkPod')
    check("round trip keeps the name", got == 'punkPod', got)
    check("round trip keeps the track", len(db_reader.parse_tracks(again)) == 1)

    check("blank or whitespace names fall back", db_reader.master_playlist_name('   ') == 'JakeTunes')
    check("runs of spaces collapse", db_reader.master_playlist_name('  punk   Pod ') == 'punk Pod')
    check("non-strings fall back", db_reader.master_playlist_name(None) == 'JakeTunes')

    if FAILURES:
        print(f"\n{len(FAILURES)} FAILED: {FAILURES}")
        sys.exit(1)
    print("\nall master-name checks passed")


if __name__ == '__main__':
    main()
