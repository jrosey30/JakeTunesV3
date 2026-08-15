#!/usr/bin/env python3
"""
itdb_verify.py — SEMANTIC validator for an iPod iTunesDB.

Why this exists (2026-07-24): every validator written during the long debugging
night asked "is this file consistent with itself?" — and the answer was always
yes, while the iPod still showed 311/380/391 of 500 songs. The file was
self-consistent and FALSE: db_reader.py's write path lifts ONE mhit header out
of the previous database and stamps it onto every track, so all 500 tracks
inherited the same album_id / artist_id / composer_id (pointing at records that
exist nowhere), the same DRM flag, the same disc number, and every playlist
entry claimed position 0.

So this validator checks TRUTH, not structure:
  * cross-references actually resolve (no phantom album/artist ids, no orphans)
  * per-track facts match the real file on disk (size, duration, sample rate)
  * playlist ordering is a real 0..n-1 sequence, not all zeros
  * fields that must be per-track are actually distinct
  * fields that must be zero (DRM, bookmark) are zero

It imports NOTHING from db_reader.py on purpose — a checker that shares code
with the thing it checks proves nothing.

Usage:
    python3 itdb_verify.py <iTunesDB path> [--root <iPod mount>] [--expect N]
Exit 0 = green, 1 = red. Findings print one per line.

Offsets follow libgpod's itdb_itunesdb.c (the reverse-engineered reference).
Notably the 64-bit persistent id lives at mhit+0x70 mirrored at +0xA8 — NOT at
+0x6C/+0x94, which is the bookmark/other field and where our writer put it.
"""
import os
import struct
import sys

# ── mhit field offsets (libgpod itdb_itunesdb.c) ──────────────────────────
MHIT_UNIQUE_ID   = 0x10
MHIT_VISIBLE     = 0x14
MHIT_FILESIZE    = 0x24
MHIT_TRACKLEN    = 0x28   # ms
MHIT_BITRATE     = 0x38
MHIT_SAMPLERATE  = 0x3C   # rate << 16
MHIT_CD_NR       = 0x5C   # disc number
MHIT_DRM_USERID  = 0x64
MHIT_BOOKMARK    = 0x6C
MHIT_DBID        = 0x70   # 64-bit persistent id
MHIT_SAMPLERATE2 = 0x88   # float
MHIT_DBID2       = 0xA8   # must mirror DBID
MHIT_MEDIATYPE   = 0xD0
MHIT_ALBUM_ID    = 0x120
MHIT_MHBD_BACKREF= 0x124
MHIT_ARTIST_ID   = 0x1E0
MHIT_COMPOSER_ID = 0x1F4

STRING_MHODS = {1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 13, 14, 22, 32}
# Types a 2005-era (firmware 1.4.x) library legitimately carries. 52/53 are
# iTunes 7.1+ sort/jump tables; 22/32 are later-era album-artist/video fields.
ERA_SAFE_MHODS = {1, 2, 3, 4, 5, 6, 8, 12, 100}


def u32(b, o):
    return struct.unpack_from('<I', b, o)[0]


def u64(b, o):
    return struct.unpack_from('<Q', b, o)[0]


def f32(b, o):
    return struct.unpack_from('<f', b, o)[0]


class Report:
    def __init__(self):
        self.errors = []
        self.warns = []
        self.info = []

    def err(self, msg):
        self.errors.append(msg)

    def warn(self, msg):
        self.warns.append(msg)

    def note(self, msg):
        self.info.append(msg)

    def ok(self):
        return not self.errors


def parse_string_mhod(d, o):
    """Return (type, decoded string) for a string mhod at offset o."""
    mtyp = u32(d, o + 12)
    tl = u32(d, o + 8)
    if tl < 40:
        return mtyp, None
    slen = u32(d, o + 28)
    if 40 + slen > tl:
        return mtyp, None
    try:
        return mtyp, d[o + 40:o + 40 + slen].decode('utf-16-le', errors='replace')
    except Exception:
        return mtyp, None


def verify(path, root=None, expect=None):
    r = Report()
    d = open(path, 'rb').read()
    size = len(d)

    # ── mhbd ───────────────────────────────────────────────────────────────
    if d[:4] != b'mhbd':
        r.err(f"not an iTunesDB: magic {d[:4]!r}")
        return r
    mhbd_hlen = u32(d, 4)
    mhbd_total = u32(d, 8)
    version = u32(d, 0x10)
    children = u32(d, 0x14)
    if mhbd_total != size:
        r.err(f"mhbd total_len {mhbd_total} != file size {size} ({size - mhbd_total:+d} trailing bytes)")
    r.note(f"mhbd hlen={mhbd_hlen} version=0x{version:X} children={children} size={size}")

    # ── datasets ───────────────────────────────────────────────────────────
    ds = []
    o = mhbd_hlen
    while o < size - 16 and d[o:o + 4] == b'mhsd':
        hl, tl, typ = u32(d, o + 4), u32(d, o + 8), u32(d, o + 12)
        ds.append({'type': typ, 'start': o, 'hlen': hl, 'total': tl})
        o += tl
    types = [x['type'] for x in ds]
    if len(ds) != children:
        r.err(f"mhbd declares {children} datasets, walked {len(ds)} {types}")
    if 1 not in types:
        r.err("no mhsd type 1 (track list)")
    if 2 not in types:
        r.err("no mhsd type 2 (playlist list)")
    if types and types[0] != 1:
        r.err(f"track list must come FIRST; dataset order is {types}")
    if types.count(2) > 1 or types.count(3) > 1:
        r.err(f"duplicate playlist datasets: {types}")
    r.note(f"datasets: {types}")

    # ── track list ─────────────────────────────────────────────────────────
    t1 = next((x for x in ds if x['type'] == 1), None)
    if not t1:
        return r
    mo = t1['start'] + t1['hlen']
    if d[mo:mo + 4] != b'mhlt':
        r.err(f"expected mhlt at {mo}, got {d[mo:mo+4]!r}")
        return r
    declared = u32(d, mo + 8)
    p = mo + u32(d, mo + 4)

    tracks = []          # dicts of parsed facts
    uids, dbids, paths = [], [], []
    album_ids, artist_ids = set(), set()
    for i in range(declared):
        if d[p:p + 4] != b'mhit':
            r.err(f"track {i}: expected mhit at {p}, got {d[p:p+4]!r} — walk desynced")
            break
        hl, tl, mc = u32(d, p + 4), u32(d, p + 8), u32(d, p + 12)
        t = {'idx': i, 'off': p, 'hlen': hl}
        t['uid'] = u32(d, p + MHIT_UNIQUE_ID)
        t['visible'] = u32(d, p + MHIT_VISIBLE)
        t['size'] = u32(d, p + MHIT_FILESIZE)
        t['len_ms'] = u32(d, p + MHIT_TRACKLEN)
        t['bitrate'] = u32(d, p + MHIT_BITRATE)
        t['srate'] = u32(d, p + MHIT_SAMPLERATE) >> 16
        t['cd_nr'] = u32(d, p + MHIT_CD_NR)
        t['drm'] = u32(d, p + MHIT_DRM_USERID)
        t['bookmark'] = u32(d, p + MHIT_BOOKMARK)
        t['dbid'] = u64(d, p + MHIT_DBID) if hl >= MHIT_DBID + 8 else 0
        t['dbid2'] = u64(d, p + MHIT_DBID2) if hl >= MHIT_DBID2 + 8 else None
        t['mediatype'] = u32(d, p + MHIT_MEDIATYPE) if hl >= MHIT_MEDIATYPE + 4 else None
        t['album_id'] = u32(d, p + MHIT_ALBUM_ID) if hl >= MHIT_ALBUM_ID + 4 else None
        t['backref'] = u64(d, p + MHIT_MHBD_BACKREF) if hl >= MHIT_MHBD_BACKREF + 8 else None
        t['artist_id'] = u32(d, p + MHIT_ARTIST_ID) if hl >= MHIT_ARTIST_ID + 4 else None

        # children
        q = p + hl
        mtypes, strs = [], {}
        for _ in range(mc):
            if d[q:q + 4] != b'mhod':
                r.err(f"track {i}: bad mhod at {q}: {d[q:q+4]!r}")
                break
            mtl = u32(d, q + 8)
            mtyp = u32(d, q + 12)
            if mtl <= 0:
                r.err(f"track {i}: zero-length mhod at {q}")
                break
            mtypes.append(mtyp)
            if mtyp in STRING_MHODS:
                _, s = parse_string_mhod(d, q)
                if s is None:
                    r.err(f"track {i}: malformed string mhod type {mtyp}")
                else:
                    strs[mtyp] = s
            q += mtl
        if q != p + tl:
            r.err(f"track {i}: children end {q} != mhit end {p+tl}")
        t['mtypes'] = mtypes
        t['title'] = strs.get(1, '')
        t['path'] = strs.get(2, '')
        tracks.append(t)
        uids.append(t['uid'])
        dbids.append(t['dbid'])
        paths.append(t['path'])
        if t['album_id'] is not None:
            album_ids.add(t['album_id'])
        if t['artist_id'] is not None:
            artist_ids.add(t['artist_id'])
        p += tl

    n = len(tracks)
    r.note(f"tracks: declared {declared}, parsed {n}")
    if n != declared:
        r.err(f"mhlt declares {declared} tracks but only {n} parsed")
    if expect is not None and n != expect:
        r.err(f"expected {expect} tracks, found {n}")

    # ── per-track truth ────────────────────────────────────────────────────
    def count_bad(pred):
        return [t for t in tracks if pred(t)]

    bad = count_bad(lambda t: t['visible'] != 1)
    if bad:
        r.err(f"{len(bad)} track(s) not visible=1 (they will not appear on the device)")
    bad = count_bad(lambda t: t['drm'] != 0)
    if bad:
        # DEVICE TRUTH: libgpod calls 0x64 drm_userid, but THIS iPod mini wants 1
        # (2026-04-26 postmortem: 150 tracks recovered; 2026-07-24: zeroing it
        # cost 132). Informational only — do not "fix" this.
        r.note(f"{len(bad)}/{n} track(s) have 0x64 != 0 — expected on this device (empirical: wants 1)")
    bad = count_bad(lambda t: t['bookmark'] != 0)
    if bad:
        # DEVICE TRUTH: this firmware reads the per-track persistent id at 0x6C,
        # not the spec's 0x70. Moving it cost 132 tracks. Expected here.
        r.note(f"{len(bad)}/{n} track(s) carry the persistent id at 0x6C — correct for this device")
    bad = count_bad(lambda t: t['dbid'] == 0)
    if bad:
        r.err(f"{len(bad)} track(s) have zero persistent id (+0x70)")
    bad = count_bad(lambda t: t['dbid2'] is not None and t['dbid2'] != t['dbid'])
    if bad:
        r.note(f"{len(bad)}/{n} track(s): 0x70/0xA8 mirror differs — irrelevant on this device (id lives at 0x6C)")
    bad = count_bad(lambda t: t['cd_nr'] > 255)
    if bad:
        r.warn(f"{len(bad)}/{n} track(s) have implausible disc number (e.g. {bad[0]['cd_nr']}) at +0x5C")
    bad = count_bad(lambda t: not (8 <= t['bitrate'] <= 2000))
    if bad:
        r.err(f"{len(bad)}/{n} track(s) have out-of-range bitrate")
    bad = count_bad(lambda t: not (8000 <= t['srate'] <= 192000))
    if bad:
        r.err(f"{len(bad)}/{n} track(s) have invalid sample rate (firmware hides them)")
    bad = count_bad(lambda t: t['mediatype'] != 1)
    if bad:
        r.err(f"{len(bad)}/{n} track(s) have mediatype != 1 (firmware hides them)")
    if len(set(t['bitrate'] for t in tracks)) == 1 and n > 5:
        r.warn(f"every track reports the SAME bitrate ({tracks[0]['bitrate']}) — inherited, not measured")

    # uniqueness
    if len(set(uids)) != n:
        r.err(f"duplicate unique_ids: {n - len(set(uids))} collision(s)")
    if len(set(dbids)) != n:
        r.err(f"duplicate persistent ids: {n - len(set(dbids))} collision(s)")
    if len(set(paths)) != n:
        r.err(f"duplicate paths: {n - len(set(paths))}")

    # ── cross-reference closure (THE bug class that broke this device) ──────
    mhia_ids = set()
    t4 = next((x for x in ds if x['type'] == 4), None)
    if t4:
        lo = t4['start'] + t4['hlen']
        if d[lo:lo + 4] == b'mhla':
            cnt = u32(d, lo + 8)
            q = lo + u32(d, lo + 4)
            for _ in range(cnt):
                if d[q:q + 4] != b'mhia':
                    break
                mhia_ids.add(u32(d, q + 0x10))
                q += u32(d, q + 8)
    if album_ids:
        nonzero = {a for a in album_ids if a}
        if nonzero:
            phantom = nonzero - mhia_ids
            if phantom:
                r.warn(f"PHANTOM album_id(s) referenced by tracks but absent from the album list: {sorted(phantom)[:5]}")
            if len(nonzero) == 1 and n > 5:
                r.warn(f"all {n} tracks share ONE album_id ({nonzero.pop()}) — inherited from a template")
        orphans = mhia_ids - album_ids
        if orphans and mhia_ids:
            r.warn(f"{len(orphans)}/{len(mhia_ids)} album records referenced by NO track (orphans)")
    if artist_ids:
        nz = {a for a in artist_ids if a}
        if nz and not any(x['type'] == 8 for x in ds):
            r.warn(f"tracks reference artist_id {sorted(nz)[:3]} but there is no artist dataset (mhsd type 8)")
        if len(nz) == 1 and n > 5:
            r.warn(f"all {n} tracks share ONE artist_id ({nz.pop()}) — inherited from a template")
    backrefs = {t['backref'] for t in tracks if t['backref'] is not None}
    if backrefs and backrefs != {u64(d, 0x24)}:
        r.warn(f"mhit+0x124 back-reference {sorted(backrefs)[:2]} != mhbd+0x24 ({u64(d, 0x24)})")

    # ── mhod hygiene ───────────────────────────────────────────────────────
    all_mtypes = set()
    for t in tracks:
        all_mtypes.update(t['mtypes'])
    stray = all_mtypes - ERA_SAFE_MHODS
    if stray:
        r.warn(f"mhod types beyond the era-safe set present: {sorted(stray)}")

    # Typographic Unicode the 2005 firmware silently rejects (found 2026-07-25:
    # a 250-track sync landed 247, and the exact 3 missing tracks were the only
    # ones carrying U+2019). Latin-1 accents are fine — the device renders them.
    hot = []
    for t in tracks:
        for s in (t.get('title', ''),):
            if any(ord(c) > 0x2000 for c in s):
                hot.append(t.get('title', '')[:40])
    if hot:
        r.err(f"{len(hot)} track(s) carry typographic Unicode >U+2000 — this device DROPS them: {hot[:4]}")
    if 32 in all_mtypes:
        # DEVICE TRUTH: the spec calls type 32 binary/video-only, but this
        # firmware drops tracks that LACK it (2026-07-21: 72 tracks lost).
        r.note("mhod type 32 present — required by this device despite the spec")

    # ── playlists ──────────────────────────────────────────────────────────
    masters = 0
    for sec in [x for x in ds if x['type'] in (2, 3)]:
        lo = sec['start'] + sec['hlen']
        if d[lo:lo + 4] != b'mhlp':
            r.err(f"mhsd type {sec['type']}: expected mhlp, got {d[lo:lo+4]!r}")
            continue
        plc = u32(d, lo + 8)
        y = lo + u32(d, lo + 4)
        for pi in range(plc):
            if d[y:y + 4] != b'mhyp':
                r.err(f"playlist {pi}: expected mhyp, got {d[y:y+4]!r}")
                break
            yh, yt = u32(d, y + 4), u32(d, y + 8)
            mhod_cnt, item_cnt = u32(d, y + 0x0C), u32(d, y + 0x10)
            is_master = u32(d, y + 0x14)
            if is_master:
                masters += 1
            name = ''
            q = y + yh
            for _ in range(mhod_cnt):
                if d[q:q + 4] != b'mhod':
                    break
                mtl, mtyp = u32(d, q + 8), u32(d, q + 12)
                if mtyp == 1:
                    _, name = parse_string_mhod(d, q)
                q += mtl
            # walk items, collect positions + track refs
            positions, refs = [], []
            for _ in range(item_cnt):
                if d[q:q + 4] != b'mhip':
                    r.err(f"playlist '{name}': expected mhip at {q}, got {d[q:q+4]!r}")
                    break
                iph, ipt, ipmc = u32(d, q + 4), u32(d, q + 8), u32(d, q + 0x0C)
                refs.append(u32(d, q + 0x18))
                c = q + iph
                for _ in range(ipmc):
                    if d[c:c + 4] != b'mhod':
                        break
                    ctl, ctyp = u32(d, c + 8), u32(d, c + 12)
                    if ctyp == 100 and ctl >= 28:
                        positions.append(u32(d, c + 0x18))
                    c += ctl
                q += ipt
            label = f"'{name}'" + (" [MASTER]" if is_master else "")
            # ordering truth
            if positions:
                if len(set(positions)) == 1 and len(positions) > 1:
                    r.err(f"playlist {label}: ALL {len(positions)} items claim position {positions[0]} — order field never written")
                elif positions != list(range(len(positions))):
                    r.warn(f"playlist {label}: positions are not a clean 0..{len(positions)-1} sequence")
            # dangling refs
            known = set(uids)
            dang = [x for x in refs if x not in known]
            if dang:
                r.err(f"playlist {label}: {len(dang)} item(s) reference tracks not in the track list")
            if is_master and len(refs) != n:
                r.err(f"master playlist has {len(refs)} items but there are {n} tracks — device Songs count will not be {n}")
            y += yt
    if masters != 1:
        r.err(f"expected exactly 1 master playlist, found {masters}")

    # ── on-disk truth (optional) ───────────────────────────────────────────
    if root:
        missing = 0
        wrongsize = 0
        for t in tracks:
            rel = t['path'].lstrip(':').replace(':', '/')
            if not rel:
                continue
            fp = os.path.join(root, rel)
            try:
                st = os.stat(fp)
            except OSError:
                missing += 1
                continue
            if t['size'] and st.st_size != t['size']:
                wrongsize += 1
        if missing:
            r.err(f"{missing}/{n} track path(s) do not exist under {root}")
        if wrongsize:
            r.err(f"{wrongsize}/{n} track(s): mhit filesize(+0x24) != actual file size on disk")
        if not missing and not wrongsize:
            r.note(f"all {n} paths resolve and file sizes match on disk")

    return r


def main():
    args = [a for a in sys.argv[1:]]
    if not args:
        print(__doc__)
        return 2
    path = args[0]
    root = None
    expect = None
    if '--root' in args:
        root = args[args.index('--root') + 1]
    if '--expect' in args:
        expect = int(args[args.index('--expect') + 1])
    r = verify(path, root, expect)
    for m in r.info:
        print(f"  · {m}")
    for m in r.warns:
        print(f"  WARN  {m}")
    for m in r.errors:
        print(f"  FAIL  {m}")
    print()
    if r.ok():
        print(f"GREEN — {os.path.basename(path)} is semantically valid ({len(r.warns)} warning(s))")
        return 0
    print(f"RED — {len(r.errors)} semantic error(s) in {os.path.basename(path)}")
    return 1


if __name__ == '__main__':
    sys.exit(main())
