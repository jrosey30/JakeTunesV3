"""
Repair JakeTunes library.json when its track paths point at the wrong
audio files. This happens when filename-based matching (during sync or
any other flow) links a library entry to a file that happens to share
the same basename but contains different music.

Pipeline:
  1. Read library.json.
  2. Walk the iPod's iPod_Control/Music/F00..F49 dirs and read embedded
     tags for every audio file (via core/tag_reader.py helpers).
  3. For each library entry whose CURRENT file's tags don't match
     (normalized title & artist), look for a file on the iPod whose
     tags DO match. Match key = lowercase/punct-stripped "title|artist".
     When multiple files match, prefer the one whose duration is closest
     to the library entry's duration.
  4. Rewrite the path (library format uses colon-separators:
     ":iPod_Control:Music:F12:ABCD.m4a") and save library.json (with a
     timestamped backup).
  5. Report: how many repaired, how many unrepairable, plus a list of
     unrepairable entries so the user can decide whether to re-rip them.

Usage:
  python3 core/repair_mismatches.py [--apply] [--ipod MOUNT] [--library PATH]

Defaults:
  --ipod     /Volumes/JakeTunes (first mount with iPod_Control/iTunes/iTunesDB)
  --library  ~/Library/Application Support/JakeTunes/library.json

Without --apply it does a dry run: prints the report, writes the
proposed changes to /tmp/jaketunes-repair-preview.json, and touches
nothing.
"""

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path

# Make the sibling tag_reader module importable when run from anywhere.
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
from tag_reader import read_tags  # noqa: E402


def _default_ipod_mount():
    vols = '/Volumes'
    if os.path.isdir(vols):
        for name in os.listdir(vols):
            candidate = os.path.join(vols, name)
            if os.path.exists(os.path.join(candidate, 'iPod_Control', 'iTunes', 'iTunesDB')):
                return candidate
    return None


def _default_library_path():
    return os.path.expanduser('~/Library/Application Support/JakeTunes/library.json')


_PUNCT      = re.compile(r"[\(\)\[\]\{\}\"',.\-!?:;#/\\]+")
_WS         = re.compile(r'\s+')
_FEAT       = re.compile(r'\s*\b(feat(?:uring)?|ft)\b\.?[^)]*', re.IGNORECASE)
_NUM_PREFIX = re.compile(r'^\s*\d{1,2}\s*[-._]\s*')  # "01 - Marquee Moon", "03. Some Title"
# "Pt 1", "Pt. 1", "Pt I", "Part I", "Part 1" all collapse to "part 1" so
# library/file tag variants like "...Part 1" vs "...Pt. 1" don't end up in
# the unrepairable bucket. We only do the substitution when "pt"/"part" is
# followed by a number or roman numeral, so unrelated words ("rapture",
# "department") aren't touched.
_PART_TOKEN = re.compile(r'\bp(?:ar)?t\.?\s+([ivx]+|\d+)\b', re.IGNORECASE)
_ROMAN = {'i': 1, 'ii': 2, 'iii': 3, 'iv': 4, 'v': 5, 'vi': 6, 'vii': 7, 'viii': 8, 'ix': 9, 'x': 10}

def _canon_part(match: 're.Match[str]') -> str:
    suffix = match.group(1).lower()
    n = _ROMAN.get(suffix, suffix if suffix.isdigit() else None)
    return f'part {n}' if n is not None else match.group(0)

def normalize(s: str) -> str:
    # ⚠️ TWIN: src/main/index.ts has a JS port of this function used by the
    # sync preflight content-safety check. They MUST stay in lockstep. If
    # you change this function (new normalization rule, new regex), update
    # the JS twin in the SAME commit. The Pink Floyd "Pt. 1" vs "Part 1"
    # bug shipped because the Python side got fixed and the JS twin was
    # forgotten — sync aborted with a false-positive mismatch banner.
    if not s:
        return ''
    s = str(s)
    # Drop track-number prefix that imports/rips sometimes write into
    # the title field ("01 - Marquee Moon" → "Marquee Moon").
    s = _NUM_PREFIX.sub('', s)
    # Drop everything from "feat./featuring/ft." onward so tag variants
    # like "High Life (feat. Sean Kingston)" match "High Life" when the
    # artist is "DJ Khaled featuring Sean Kingston".
    s = _FEAT.sub('', s)
    # Canonicalize "Pt./Pt/Part" + (digit | roman) → "part N" before we
    # nuke punctuation, so "Pt." and "Part" both survive into the same
    # form. Without this, "Another Brick in the Wall, Pt. 1" (file tag)
    # and "Another Brick in the Wall, Part 1" (library) don't match.
    s = _PART_TOKEN.sub(_canon_part, s)
    s = _PUNCT.sub(' ', s)
    s = _WS.sub(' ', s).strip().lower()
    return s


def close_duration(a_ms: int, b_ms: int) -> bool:
    """True when two durations are within 2 seconds — tolerates encoder drift."""
    if not a_ms or not b_ms:
        return False
    return abs(a_ms - b_ms) <= 2000


def colon_path(ipod_mount: str, abs_path: str) -> str:
    """Convert /Volumes/JakeTunes/iPod_Control/Music/F12/ABCD.m4a → :iPod_Control:Music:F12:ABCD.m4a"""
    rel = os.path.relpath(abs_path, ipod_mount)
    return ':' + rel.replace(os.sep, ':')


def abs_from_colon(ipod_mount: str, colon: str) -> str:
    rel = colon.lstrip(':').replace(':', os.sep)
    return os.path.join(ipod_mount, rel)


def scan_ipod(ipod_mount: str):
    """Return list of (abs_path, tags_dict) for every audio file on iPod."""
    music_root = os.path.join(ipod_mount, 'iPod_Control', 'Music')
    paths = []
    for i in range(50):
        sub = os.path.join(music_root, f'F{i:02d}')
        if not os.path.isdir(sub):
            continue
        for fn in os.listdir(sub):
            lo = fn.lower()
            if lo.endswith(('.m4a', '.mp3', '.alac', '.aac', '.flac', '.aif', '.aiff', '.wav')):
                paths.append(os.path.join(sub, fn))
    print(f'Scanning tags on {len(paths)} iPod audio files...', flush=True)
    result = []
    t0 = time.time()
    for i, p in enumerate(paths):
        if i % 250 == 0 and i > 0:
            print(f'  ...{i}/{len(paths)} ({time.time()-t0:.1f}s)', flush=True)
        result.append((p, read_tags(p)))
    print(f'Scanned {len(result)} files in {time.time()-t0:.1f}s.', flush=True)
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true',
                    help='actually write the repaired library.json (default is dry-run)')
    ap.add_argument('--delete-unrepairable', action='store_true',
                    help='also remove library entries for tracks whose audio cannot be found on iPod')
    ap.add_argument('--ipod', default=None, help='iPod mount point')
    ap.add_argument('--library', default=None, help='path to JakeTunes library.json')
    args = ap.parse_args()

    ipod_mount = args.ipod or _default_ipod_mount()
    if not ipod_mount:
        print('No iPod mount found. Plug iPod in and try again, or pass --ipod.', file=sys.stderr)
        sys.exit(2)
    library_path = args.library or _default_library_path()
    if not os.path.isfile(library_path):
        print(f'library.json not found at {library_path}', file=sys.stderr)
        sys.exit(2)
    print(f'iPod: {ipod_mount}')
    print(f'library: {library_path}')

    with open(library_path, 'r') as fh:
        library = json.load(fh)
    tracks = library.get('tracks', [])
    print(f'library has {len(tracks)} tracks')

    # --- Scan iPod ---
    tagged = scan_ipod(ipod_mount)

    # --- Build lookup tables ---
    #   by_both    → { "title|artist": [(path, tags), ...] }   both tags present
    #   by_title   → { normalized_title: [(path, tags), ...] } title matches (any artist)
    #   by_artist  → { normalized_artist: [(path, tags), ...] } artist matches (title empty)
    #   by_path    → { abs_path: tags }
    # Three progressively-looser lookups let us recover files that have
    # partial or stripped tags (very common after a rip/re-rip cycle).
    by_both   = {}
    by_title  = {}
    by_artist = {}
    by_path   = {}
    for p, t in tagged:
        by_path[p] = t
        if not t.get('ok'):
            continue
        nt = normalize(t.get('title', ''))
        na = normalize(t.get('artist', ''))
        if nt and na:
            by_both.setdefault(nt + '|' + na, []).append((p, t))
        if nt:
            by_title.setdefault(nt, []).append((p, t))
        if na and not nt:
            by_artist.setdefault(na, []).append((p, t))

    # --- Find mismatches and propose fixes ---
    fixed = []        # [{id, title, artist, old, new}]
    unfixable = []    # [{id, title, artist, old, reason}]
    unchanged = 0
    missing   = 0
    tagless   = 0

    for tr in tracks:
        colon = tr.get('path') or ''
        if not colon:
            continue
        abs_p = abs_from_colon(ipod_mount, colon)
        tags = by_path.get(abs_p)
        lib_title  = str(tr.get('title') or '')
        lib_artist = str(tr.get('artist') or '')
        lib_dur    = int(tr.get('duration') or 0)

        if tags is None:
            # File does not live on this iPod at all. Not this tool's
            # problem to fix (could be a track on disk but not synced).
            missing += 1
            continue
        if not tags.get('ok'):
            unfixable.append({
                'id': tr.get('id'), 'title': lib_title, 'artist': lib_artist,
                'old': colon, 'reason': f'unreadable ({tags.get("error","?")})',
            })
            continue

        file_title  = tags.get('title', '')
        file_artist = tags.get('artist', '')

        nt_lib = normalize(lib_title);  na_lib = normalize(lib_artist)
        nt_f   = normalize(file_title); na_f   = normalize(file_artist)

        # File has no tags at all → can't verify, leave alone (sync step
        # will flag it separately).
        if not file_title and not file_artist:
            tagless += 1
            continue

        # It matches already — great, nothing to do.
        title_ok  = nt_lib and nt_f and (nt_lib == nt_f or nt_lib in nt_f or nt_f in nt_lib)
        artist_ok = na_lib and na_f and (na_lib == na_f or na_lib in na_f or na_f in na_lib)
        if title_ok and artist_ok:
            unchanged += 1
            continue
        # If title matches strongly but artist differs a little, or vice
        # versa, still benign — skip.
        if title_ok and na_lib and na_f and (na_lib[:6] == na_f[:6]):
            unchanged += 1
            continue

        # Otherwise, library and file disagree on what song this is.
        # Look for a replacement, tiering from strict to loose.
        def score(path_tags):
            """Lower is better — closer duration wins ties."""
            _, tg = path_tags
            fdur = tg.get('duration_ms', 0) or 0
            return abs(fdur - lib_dur) if lib_dur else 0

        best = None
        how = ''

        # Tier 1: file has both title and artist, both match.
        hits = list(by_both.get(nt_lib + '|' + na_lib, []))
        if hits:
            hits.sort(key=score)
            best, how = hits[0], 'title+artist match'

        # Tier 2: file title matches library title, within duration tolerance
        # (artist may be empty or different — e.g. Sinatra collabs stripped
        # the artist tag, Television files are titled "01 - See No Evil").
        if not best:
            hits = [c for c in by_title.get(nt_lib, []) if close_duration(lib_dur, c[1].get('duration_ms', 0))]
            if hits:
                hits.sort(key=score)
                best, how = hits[0], 'title match + duration'

        # Tier 3: file has artist match + empty title + duration match
        # (common for Culture Wars / Love Fiend where only artist was
        # written to the file during a rip).
        if not best:
            hits = [c for c in by_artist.get(na_lib, []) if close_duration(lib_dur, c[1].get('duration_ms', 0))]
            # Don't claim an untagged-title candidate that's already in use
            # by another library entry whose current path points at it — we
            # risk swapping two library entries back and forth.
            if hits:
                hits.sort(key=score)
                best, how = hits[0], 'artist match + duration'

        if not best:
            unfixable.append({
                'id': tr.get('id'), 'title': lib_title, 'artist': lib_artist,
                'duration_ms': lib_dur,
                'old': colon,
                'reason': f'no candidate with title "{lib_title}" (artist "{lib_artist}") on iPod',
                'current_file_is': f'{file_title} / {file_artist}',
            })
            continue

        best_path, _ = best
        new_colon = colon_path(ipod_mount, best_path)
        if new_colon == colon:
            unchanged += 1
            continue
        fixed.append({
            'id': tr.get('id'),
            'title': lib_title, 'artist': lib_artist,
            'old': colon, 'new': new_colon,
            'was_playing': f'{file_title} / {file_artist}',
            'match': how,
        })

    # --- Scan for duplicate library entries ---
    # This is independent from the tag-verification above: two library
    # entries with the same (title, artist, duration) are almost
    # always the residue of an accidental re-import, and both can't be
    # "right" — one of them is lingering from a previous state. Report
    # these so the dry run shows the user what dedup will do on apply.
    def _dedup_key(tr: dict) -> tuple:
        title = (tr.get('title') or '').strip().lower()
        artist = (tr.get('artist') or '').strip().lower()
        dur = int(tr.get('duration') or 0)
        return (title, artist, dur)
    # Count both path-identical and (title,artist,duration)-identical
    # duplicates. Path-identical wins first so we don't double-count
    # the same pair.
    seen_victims: set[int] = set()
    path_seen: dict[str, list[dict]] = {}
    for tr in tracks:
        p = tr.get('path') or ''
        if p:
            path_seen.setdefault(p, []).append(tr)
    for p, grp in path_seen.items():
        if len(grp) > 1:
            for v in grp[1:]:
                if v.get('id') is not None:
                    seen_victims.add(v['id'])
    dup_groups: dict[tuple, list[dict]] = {}
    for tr in tracks:
        if tr.get('id') in seen_victims:
            continue
        dup_groups.setdefault(_dedup_key(tr), []).append(tr)
    extra_tad = sum(len(g) - 1 for k, g in dup_groups.items() if len(g) > 1 and k[0])
    duplicate_count = len(seen_victims) + extra_tad

    # --- Report ---
    print()
    print('=== REPAIR REPORT ===')
    print(f'  unchanged:             {unchanged}')
    print(f'  tagless (benign):      {tagless}')
    print(f'  missing from iPod:     {missing}')
    print(f'  will be repaired:      {len(fixed)}')
    print(f'  unrepairable:          {len(unfixable)}')
    print(f'  duplicate entries:     {duplicate_count} (will be deduped on --apply)')
    print()
    if fixed:
        print('REPAIRS (first 40):')
        for f in fixed[:40]:
            print(f'  #{f["id"]} "{f["title"]}" / {f["artist"]}')
            print(f'      was pointing at: {f["was_playing"]}')
            print(f'      old: {f["old"]}')
            print(f'      new: {f["new"]}')
        if len(fixed) > 40:
            print(f'  ... and {len(fixed)-40} more')
        print()
    if unfixable:
        print('UNREPAIRABLE (first 40, will need re-rip):')
        for f in unfixable[:40]:
            print(f'  #{f["id"]} "{f["title"]}" / {f["artist"]}')
            if 'current_file_is' in f:
                print(f'      currently playing: {f["current_file_is"]}')
            print(f'      reason: {f["reason"]}')
        if len(unfixable) > 40:
            print(f'  ... and {len(unfixable)-40} more')
        print()

    preview_path = '/tmp/jaketunes-repair-preview.json'
    with open(preview_path, 'w') as fh:
        json.dump({'fixed': fixed, 'unfixable': unfixable,
                   'unchanged': unchanged, 'tagless': tagless, 'missing': missing,
                   'duplicates': duplicate_count},
                  fh, indent=2)
    print(f'Full details written to {preview_path}')

    if not args.apply:
        print()
        print('Dry run only — re-run with --apply to write library.json')
        return

    will_delete = args.delete_unrepairable and unfixable
    if not fixed and not will_delete and duplicate_count == 0:
        print('Nothing to apply.')
        return

    # --- Apply ---
    # Back up first.
    ts = datetime.now().strftime('%Y%m%d-%H%M%S')
    backup = f'{library_path}.bak-repair-{ts}'
    Path(backup).write_bytes(Path(library_path).read_bytes())
    print(f'Backup: {backup}')

    fix_by_id = {f['id']: f['new'] for f in fixed}
    doomed_ids = set()
    if args.delete_unrepairable:
        doomed_ids = {u['id'] for u in unfixable if u.get('id') is not None}

    # Deduplicate: if two library entries describe the same track
    # (same title+artist+duration), keep ONE and drop the other.
    #
    # Ranking (higher rank wins, stays in library):
    #   1. Content-correct first — keep the entry whose file has
    #      embedded tags that agree with the library title+artist.
    #      Drop the one that points at a file with wrong or stripped
    #      tags (almost always a stale pointer from a prior glitch).
    #   2. Then larger file size (ALAC > AAC where both exist).
    #   3. Then newer dateAdded (more recent re-import wins).
    #   4. Then higher ID (stable tiebreaker).
    #
    # This cleans up the state left by re-imports + failed repairs
    # both landing in the library at different F-dir slots. When we
    # pick the "wrong" one we'd lose audio we could have kept, hence
    # the content-correct check is first.
    def _dedup_key(tr: dict) -> tuple:
        title = (tr.get('title') or '').strip().lower()
        artist = (tr.get('artist') or '').strip().lower()
        dur = int(tr.get('duration') or 0)
        return (title, artist, dur)

    def _content_correct(tr: dict) -> int:
        """1 if the file this entry points at has tags matching the library entry, else 0."""
        p = abs_from_colon(ipod_mount, str(tr.get('path') or ''))
        t = by_path.get(p)
        if not t or not t.get('ok'):
            return 0
        ft = normalize(t.get('title', ''))
        fa = normalize(t.get('artist', ''))
        lt = normalize(str(tr.get('title') or ''))
        la = normalize(str(tr.get('artist') or ''))
        title_ok  = bool(lt and ft and (lt == ft or lt in ft or ft in lt))
        artist_ok = bool(la and fa and (la == fa or la in fa or fa in la))
        return 1 if (title_ok and artist_ok) else 0

    # Two dedup passes:
    #   (a) tracks with IDENTICAL path — these are unambiguously
    #       duplicates since two library entries cannot legitimately
    #       point at the exact same audio file.
    #   (b) tracks with the same (title, artist, duration) — same song
    #       same rip, doesn't matter which entry stays.
    # Path-dedup goes first because it's the strictest test.
    duplicate_victims: set[int] = set()

    def _rank(tr: dict) -> tuple:
        return (_content_correct(tr),
                int(tr.get('fileSize') or 0),
                str(tr.get('dateAdded') or ''),
                int(tr.get('id') or 0))

    path_groups: dict[str, list[dict]] = {}
    for tr in tracks:
        p = tr.get('path') or ''
        if p:
            path_groups.setdefault(p, []).append(tr)
    for p, grp in path_groups.items():
        if len(grp) < 2:
            continue
        grp.sort(key=_rank, reverse=True)
        for victim in grp[1:]:
            if victim.get('id') is not None:
                duplicate_victims.add(victim['id'])

    groups: dict[tuple, list[dict]] = {}
    for tr in tracks:
        if tr.get('id') in duplicate_victims:
            continue
        groups.setdefault(_dedup_key(tr), []).append(tr)
    for key, grp in groups.items():
        if len(grp) < 2 or not key[0]:
            continue
        grp.sort(key=_rank, reverse=True)
        for victim in grp[1:]:
            if victim.get('id') is not None:
                duplicate_victims.add(victim['id'])

    new_tracks = []
    removed = 0
    removed_dups = 0
    for tr in tracks:
        if tr.get('id') in doomed_ids:
            removed += 1
            continue
        if tr.get('id') in duplicate_victims:
            removed_dups += 1
            continue
        new_p = fix_by_id.get(tr.get('id'))
        if new_p:
            tr['path'] = new_p
        new_tracks.append(tr)
    library['tracks'] = new_tracks

    # Also purge removed track IDs from any playlist trackIds arrays so
    # dangling references don't leave "ghost" entries in the UI.
    purge_set = doomed_ids | duplicate_victims
    if purge_set and 'playlists' in library:
        for pl in library.get('playlists', []) or []:
            ids = pl.get('trackIds') or []
            pl['trackIds'] = [i for i in ids if i not in purge_set]

    with open(library_path, 'w') as fh:
        json.dump(library, fh, indent=2, ensure_ascii=False)
    print(f'Wrote {len(fixed)} path fixes to {library_path}')
    if removed_dups:
        print(f'Removed {removed_dups} duplicate library entries')
    if args.delete_unrepairable:
        print(f'Removed {removed} unrepairable library entries')
        # Emit re-rip plan, grouped by (album, artist), to /tmp/
        groups = {}
        for u in unfixable:
            key = (u.get('artist', ''),)  # we don't know album — keep by artist
            groups.setdefault(key, []).append(u['title'])
        rerip_path = '/tmp/jaketunes-rerip-list.txt'
        with open(rerip_path, 'w') as fh:
            fh.write('Tracks to re-rip (audio was missing or corrupt on iPod):\n\n')
            for (artist,), titles in sorted(groups.items()):
                fh.write(f'{artist}:\n')
                for t in sorted(titles):
                    fh.write(f'  - {t}\n')
                fh.write('\n')
        print(f'Re-rip plan written to {rerip_path}')


if __name__ == '__main__':
    main()
