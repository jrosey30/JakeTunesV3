"""
Round-trip invariance harness for db_reader.write_itunesdb (4.0 §B-prime).

Premise: read an iTunesDB → write it back via our writer → byte-diff
+ semantic-diff against the original. The bytes that differ AFTER
write are exactly the fields our writer changed. Anything we touched
that we DIDN'T mean to touch is a bug. Anything we *meant* to touch
should be in the EXPECTED_DELTA_REGIONS allowlist with a justification.

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
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path
from typing import Iterable

# Allow running this file directly without installing the package.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from db_reader import parse_tracks, parse_playlists, write_itunesdb  # noqa: E402


# ── Allowlist: byte regions our writer is INTENDED to overwrite ──
#
# Each entry: (description, predicate(offset) -> bool). On a round-
# trip these regions are *expected* to differ from the input — they
# encode JakeTunes' deterministic iTunesDB rebuild rules, not raw
# pass-through.
#
# Reviewers: when adding to this list, include the postmortem or
# commit ref that justified the change. If a delta shows up in the
# output that ISN'T allow-listed here, the writer drifted silently
# and that's the bug.
EXPECTED_DELTA_REGIONS: list[tuple[str, str]] = [
    ("mhbd header — total length / version / counts may shift if mhsd sections grow", "mhbd"),
    ("mhsd-4 (album list) — fully rebuilt from current library data per commit f5d8ad0", "mhsd-4"),
    ("mhit 0x64 — mediaKind forced to 1 to keep the iPod's Songs view inclusive", "0x64"),
    ("mhit 0x6C/0x94 — persistent 64-bit dbid derived from (audioFingerprint|path) per commit c0db845", "0x6C"),
    # Additional intentional rewrites get appended here as we audit.
]


def hex_offset(o: int) -> str:
    return f"0x{o:08x}"


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

    # 5. Allowlist summary (informational — we don't enforce yet, just
    # remind the operator of the intentional changes the writer makes.)
    print()
    print("== Allowlisted intentional rewrites ==")
    for desc, _key in EXPECTED_DELTA_REGIONS:
        print(f"  • {desc}")

    # Cleanup
    try:
        os.unlink(out_path)
    except OSError:
        pass

    # Exit code: 0 if semantic diff is empty, 1 otherwise. Byte diff is
    # informational — the writer is intentionally not a byte-preserver
    # (see allowlist), so byte-identity is not a pass condition.
    return 0 if (not track_msgs and not playlist_msgs) else 1


if __name__ == '__main__':
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} <path-to-iTunesDB>", file=sys.stderr)
        sys.exit(2)
    sys.exit(run(sys.argv[1]))
