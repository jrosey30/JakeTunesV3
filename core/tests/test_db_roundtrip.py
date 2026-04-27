"""
Round-trip invariance harness for db_reader.write_itunesdb (4.0 §B-prime).

Premise: read an iTunesDB → write it back via our writer → byte-diff
+ semantic-diff against the original. The bytes that differ AFTER
write are exactly the fields our writer changed. Anything we touched
that we DIDN'T mean to touch is a bug. Anything we *meant* to touch
should be inside one of the documented allowed regions below.

This is the "rigor by invariance" approach for the iTunesDB sync —
since we have no clean iTunes-written reference DB on this machine,
we instead lock down our own writer's behavior and detect any future
silent drift.

Usage (no test framework needed; run as a script):

    python3 core/tests/test_db_roundtrip.py <path-to-iTunesDB>

Reports:
  - byte-diff count and run map
  - semantic field-level drift (title, artist, persistent dbid, etc.)
  - playlist preservation
  - ENFORCEMENT: per-mhit header byte audit. If write_itunesdb modifies
    any mhit-header byte outside the documented MHIT_TOUCHED_OFFSETS
    set, the test FAILS. This is the regression net for accidental
    field drift.

Exit code:
  0 — semantic round-trip is clean AND every mhit-header diff is
      inside an allowed region.
  1 — semantic drift, OR an mhit-header byte changed outside the
      allowed region (the writer started touching something it
      shouldn't be).
"""
from __future__ import annotations

import os
import struct
import sys
import tempfile
from pathlib import Path
from typing import Iterable

# Allow running this file directly without installing the package.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from db_reader import parse_tracks, parse_playlists, write_itunesdb  # noqa: E402


# ── mhit header offsets the writer is INTENTIONALLY allowed to modify ──
#
# Each entry: (offset_within_mhit, byte_size, label, justification).
# build_mhit_record in db_reader.py writes these specific offsets;
# any mhit-header byte that differs after a round-trip but isn't in
# this set is a writer bug.
#
# Adding a new entry here MUST come with the corresponding
# struct.pack_into(...) call in build_mhit_record, AND a comment
# block in db_reader explaining the field's purpose.
MHIT_TOUCHED_OFFSETS: list[tuple[int, int, str, str]] = [
    (0x08, 4, "total_len",            "Recomputed when mhod payload size shifts on rebuild"),
    (0x0C, 4, "mhod_count",           "Recomputed from the new mhod child set"),
    (0x10, 4, "unique_id (32-bit)",   "Track id; reset deterministically per track"),
    (0x14, 4, "visible flag",         "Always set to 1 (visible)"),
    (0x18, 4, "codec marker",         "Set on new tracks only; preserved on round-trip"),
    (0x1C, 4, "codec sub-type",       "Set on new tracks only"),
    (0x20, 4, "date_created",         "Set on new tracks only"),
    (0x24, 4, "file_size",            "Pulled from track metadata"),
    (0x28, 4, "duration_ms",          "Pulled from track metadata"),
    (0x2C, 4, "track_number",         "Pulled from track metadata"),
    (0x30, 4, "track_count",          "Pulled from track metadata"),
    (0x34, 4, "year",                 "Pulled from track metadata"),
    (0x50, 4, "play_count",           "Pulled from track metadata"),
    (0x58, 4, "date_modified",        "Set on new tracks only"),
    (0x64, 4, "mediaKind",            "Forced to 1 — see 2026-04-26 postmortem"),
    (0x68, 4, "date_added",           "Set on new tracks only"),
    (0x6C, 8, "persistent_dbid",      "Per-track 64-bit; commit c0db845"),
    (0x94, 8, "persistent_dbid_bkup", "Backup of 0x6C; commit c0db845"),
]


def hex_offset(o: int) -> str:
    return f"0x{o:08x}"


# ── iTunesDB structural walker ──
#
# Used by the enforcer to locate every mhit's header range so we can
# audit "what bytes did the writer touch INSIDE the header" without
# polluting the result with allowed mhod-payload churn.

def find_mhit_headers(buf: bytes) -> list[tuple[int, int]]:
    """Scan an iTunesDB byte buffer and return [(mhit_start, mhit_hlen)]
    pairs for every mhit in the type-1 section. Returns [] if the file
    is malformed."""
    if len(buf) < 24 or buf[:4] != b'mhbd':
        return []
    mhbd_hlen = struct.unpack_from('<I', buf, 4)[0]
    num_children = struct.unpack_from('<I', buf, 20)[0]

    # Walk mhsd sections to find type-1 (tracks).
    sec_pos = mhbd_hlen
    type1: tuple[int, int, int] | None = None
    for _ in range(num_children):
        if sec_pos >= len(buf) - 16:
            break
        if buf[sec_pos:sec_pos + 4] != b'mhsd':
            break
        sec_hlen = struct.unpack_from('<I', buf, sec_pos + 4)[0]
        sec_total = struct.unpack_from('<I', buf, sec_pos + 8)[0]
        sec_typ = struct.unpack_from('<I', buf, sec_pos + 12)[0]
        if sec_typ == 1:
            type1 = (sec_pos, sec_hlen, sec_total)
            break
        sec_pos += sec_total
    if not type1:
        return []
    sec_start, sec_hlen, _ = type1

    mhlt_pos = sec_start + sec_hlen
    if buf[mhlt_pos:mhlt_pos + 4] != b'mhlt':
        return []
    mhlt_hlen = struct.unpack_from('<I', buf, mhlt_pos + 4)[0]
    track_count = struct.unpack_from('<I', buf, mhlt_pos + 8)[0]

    headers: list[tuple[int, int]] = []
    p = mhlt_pos + mhlt_hlen
    for _ in range(track_count):
        if p >= len(buf) - 4 or buf[p:p + 4] != b'mhit':
            break
        mhit_hlen = struct.unpack_from('<I', buf, p + 4)[0]
        mhit_total = struct.unpack_from('<I', buf, p + 8)[0]
        headers.append((p, mhit_hlen))
        p += mhit_total
    return headers


def mhit_unique_id(buf: bytes, mhit_pos: int) -> int:
    return struct.unpack_from('<I', buf, mhit_pos + 0x10)[0]


def audit_mhit_headers(
    original: bytes, rewritten: bytes
) -> tuple[int, list[str]]:
    """Audit every mhit header byte-by-byte. Bytes that differ MUST
    fall within one of the MHIT_TOUCHED_OFFSETS ranges; otherwise
    the writer touched a field it wasn't supposed to and we surface
    that as an error.

    Returns (audited_track_count, list_of_violation_messages)."""
    in_headers  = find_mhit_headers(original)
    out_headers = find_mhit_headers(rewritten)
    if not in_headers or not out_headers:
        return 0, ["audit failed: couldn't locate mhit headers in one or both files"]

    # Map by unique_id so we compare matching tracks even if section
    # ordering shifted.
    in_by_id  = {mhit_unique_id(original, p): (p, hl) for p, hl in in_headers}
    out_by_id = {mhit_unique_id(rewritten, p): (p, hl) for p, hl in out_headers}

    common_ids = set(in_by_id) & set(out_by_id)
    only_in    = set(in_by_id)  - common_ids
    only_out   = set(out_by_id) - common_ids
    violations: list[str] = []
    if only_in:
        violations.append(f"{len(only_in)} mhit unique_ids present in input but missing from output")
    if only_out:
        violations.append(f"{len(only_out)} mhit unique_ids present in output but not input")

    # Build a quick allowed-offset bitmap for the mhit header.
    # Headers are typically 0xB8 / 184 bytes; we cover up to 0x100
    # to be safe.
    HEADER_MAX = 0x100
    allowed = bytearray(HEADER_MAX)
    for off, size, _label, _why in MHIT_TOUCHED_OFFSETS:
        for i in range(size):
            if 0 <= off + i < HEADER_MAX:
                allowed[off + i] = 1

    # Compare each common track's mhit header bytes. Any byte that
    # differs and is NOT in the allowed bitmap is a violation.
    bad_tracks: dict[int, list[int]] = {}  # offset → count of tracks that drifted at this offset
    for uid in common_ids:
        in_pos,  in_hlen  = in_by_id[uid]
        out_pos, out_hlen = out_by_id[uid]
        # Header lengths SHOULD match (writer reuses the input header).
        if in_hlen != out_hlen:
            violations.append(
                f"mhit header length differs for track id {uid}: "
                f"input {in_hlen} bytes, output {out_hlen} bytes"
            )
            continue
        for off in range(min(in_hlen, HEADER_MAX)):
            if original[in_pos + off] != rewritten[out_pos + off] and not allowed[off]:
                bad_tracks.setdefault(off, []).append(uid)

    if bad_tracks:
        violations.append(
            f"writer modified mhit-header bytes OUTSIDE the documented "
            f"MHIT_TOUCHED_OFFSETS allowlist:"
        )
        for off in sorted(bad_tracks.keys()):
            uids = bad_tracks[off]
            violations.append(
                f"    offset 0x{off:02X} drifted on {len(uids)} of {len(common_ids)} tracks "
                f"(first track id: {uids[0]})"
            )

    return len(common_ids), violations


def byte_diff_runs(a: bytes, b: bytes, max_runs: int = 30) -> list[tuple[int, int]]:
    """Return runs of differing byte offsets (start_inclusive, end_inclusive)."""
    runs: list[tuple[int, int]] = []
    n = min(len(a), len(b))
    i = 0
    while i < n:
        if a[i] != b[i]:
            j = i
            while j < n and a[j] != b[j]:
                j += 1
            runs.append((i, j - 1))
            if len(runs) >= max_runs:
                # Note the truncation in the caller's report; keep going
                # so total-count is meaningful, but cap stored runs.
                pass
            i = j
        else:
            i += 1
    return runs


def total_diff_bytes(a: bytes, b: bytes) -> int:
    n = min(len(a), len(b))
    return sum(1 for i in range(n) if a[i] != b[i]) + abs(len(a) - len(b))


# ── Semantic comparison helpers ──

TRACK_FIELDS = (
    'title', 'artist', 'album', 'albumArtist', 'genre',
    'year', 'duration', 'trackNumber', 'trackCount',
    'discNumber', 'discCount', 'fileSize', 'rating',
    'playCount',
)


def semantic_track_diff(before: list[dict], after: list[dict]) -> list[str]:
    """Compare two parsed track lists. Returns list of human-readable
    drift messages. Empty list means no drift."""
    msgs: list[str] = []
    if len(before) != len(after):
        msgs.append(f"track count drift: {len(before)} → {len(after)}")

    by_path_b = {t.get('path'): t for t in before if t.get('path')}
    by_path_a = {t.get('path'): t for t in after  if t.get('path')}

    only_b = set(by_path_b) - set(by_path_a)
    only_a = set(by_path_a) - set(by_path_b)
    if only_b:
        msgs.append(f"{len(only_b)} tracks present in input but missing from output")
        for p in list(only_b)[:5]:
            msgs.append(f"    missing: {p!r}")
    if only_a:
        msgs.append(f"{len(only_a)} tracks present in output but not input")
        for p in list(only_a)[:5]:
            msgs.append(f"    extra:   {p!r}")

    drifted_count = 0
    sample_msgs: list[str] = []
    for path in set(by_path_b) & set(by_path_a):
        b, a = by_path_b[path], by_path_a[path]
        for f in TRACK_FIELDS:
            if b.get(f) != a.get(f):
                drifted_count += 1
                if len(sample_msgs) < 10:
                    sample_msgs.append(
                        f"    {f!r} on {path!r}: {b.get(f)!r} → {a.get(f)!r}"
                    )
    if drifted_count:
        msgs.append(f"{drifted_count} field drifts across tracks (first 10):")
        msgs.extend(sample_msgs)
    return msgs


def semantic_playlist_diff(before: Iterable[dict], after: Iterable[dict]) -> list[str]:
    msgs: list[str] = []
    b_list = list(before)
    a_list = list(after)
    b_names = sorted(p.get('name', '') for p in b_list)
    a_names = sorted(p.get('name', '') for p in a_list)
    if b_names != a_names:
        msgs.append(f"playlist names drift:\n    input:  {b_names}\n    output: {a_names}")
        return msgs
    by_name_b = {p['name']: p for p in b_list}
    by_name_a = {p['name']: p for p in a_list}
    for name in by_name_b:
        b_ids = list(by_name_b[name].get('trackIds', []))
        a_ids = list(by_name_a[name].get('trackIds', []))
        if b_ids != a_ids:
            msgs.append(
                f"playlist {name!r} track ordering differs "
                f"({len(b_ids)} → {len(a_ids)} entries)"
            )
    return msgs


# ── Main ──

def run(reference_path: str) -> int:
    ref = Path(reference_path)
    if not ref.is_file():
        print(f"ERROR: {ref} is not a file", file=sys.stderr)
        return 2

    print(f"Round-trip test against: {ref}")
    print(f"Reference size:         {ref.stat().st_size:,} bytes")

    # 1. Parse the reference.
    tracks  = parse_tracks(str(ref))
    playlists = parse_playlists(str(ref), tracks)
    print(f"Parsed:  {len(tracks)} tracks, {len(playlists)} playlists")

    # 2. Write it back via our writer, with the reference as template.
    out_path = tempfile.mktemp(suffix='.iTunesDB.roundtrip')
    write_itunesdb(tracks, playlists, str(ref), out_path)
    out_size = os.path.getsize(out_path)
    print(f"Rewritten: {out_size:,} bytes ({out_size - ref.stat().st_size:+,} delta)")

    with open(ref, 'rb') as f:
        original = f.read()
    with open(out_path, 'rb') as f:
        rewritten = f.read()

    # 3. Byte diff.
    print()
    print("== Byte diff ==")
    if original == rewritten:
        print("✓ Byte-identical round-trip")
    else:
        differ = total_diff_bytes(original, rewritten)
        print(f"✗ {differ:,} differing bytes ({differ * 100 / max(1, len(original)):.2f}% of input)")
        runs = byte_diff_runs(original, rewritten)
        print(f"  {len(runs)} contiguous diff runs (showing first 30):")
        for s, e in runs[:30]:
            print(f"    {hex_offset(s)} – {hex_offset(e)}  ({e - s + 1} bytes)")

    # 4. Semantic diff.
    print()
    print("== Semantic diff (parse(input) vs parse(output)) ==")
    tracks_after  = parse_tracks(out_path)
    playlists_after = parse_playlists(out_path, tracks_after)
    track_msgs    = semantic_track_diff(tracks, tracks_after)
    playlist_msgs = semantic_playlist_diff(playlists, playlists_after)
    if not track_msgs and not playlist_msgs:
        print("✓ No semantic drift")
    else:
        for m in track_msgs + playlist_msgs:
            print(f"  {m}")

    # 5. Per-mhit header audit (the enforcer). For every track that
    # appears in both files, compare the header bytes against the
    # MHIT_TOUCHED_OFFSETS allowlist. Any byte that differs outside
    # those documented offsets means the writer is silently touching
    # a field it shouldn't be.
    print()
    print("== mhit header audit ==")
    audited_count, violations = audit_mhit_headers(original, rewritten)
    if not violations:
        print(f"✓ {audited_count} mhit headers — every byte that differs "
              f"falls inside the documented MHIT_TOUCHED_OFFSETS allowlist")
    else:
        print(f"✗ {audited_count} mhit headers audited — {len(violations)} violations:")
        for v in violations:
            print(f"  {v}")

    # 6. Allowlist summary
    print()
    print("== mhit-header writer allowlist (in db_reader.build_mhit_record) ==")
    for off, size, label, why in MHIT_TOUCHED_OFFSETS:
        print(f"  0x{off:02X} ({size}b)  {label:24s}  — {why}")

    # Cleanup
    try:
        os.unlink(out_path)
    except OSError:
        pass

    # Exit code:
    #   0 — semantic round-trip clean AND no violations of the mhit
    #       header allowlist
    #   1 — anything else (semantic drift OR an out-of-allowlist byte
    #       changed)
    semantic_ok = not track_msgs and not playlist_msgs
    audit_ok    = not violations
    return 0 if (semantic_ok and audit_ok) else 1


if __name__ == '__main__':
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} <path-to-iTunesDB>", file=sys.stderr)
        sys.exit(2)
    sys.exit(run(sys.argv[1]))
