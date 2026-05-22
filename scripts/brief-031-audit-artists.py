#!/usr/bin/env python3
"""Brief 031 Phase 1 — read-only audit of artist variants + collab candidates.

Output:
  Dr. Claude/031-artist-variants-audit.md  — human-readable summary
  Dr. Claude/031-decisions.json            — pre-filled decisions template
  Dr. Claude/031-audit-state.json          — library.json mtime + hash
                                              for Phase 3's gate

Read-only — does NOT modify library.json. Safe to run with JakeTunes up.

Normalization rule (per Brief 031 Decision 2):
  1. Strip whitespace
  2. casefold (Unicode-aware lowercase)
  3. Strip diacritics via NFD decompose + drop combining marks
  4. Remove punctuation: - . ' , ; / ( ) [ ] ! ?
  5. Collapse whitespace
  KEEP leading "The" — do NOT strip it (reviewer can override per case).

Collab delimiters (per Brief 031 Decision 3):
  feat. / ft. / featuring / vs. / x (space-surrounded) / & / and
  NOT comma (too high false-positive rate).
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import unicodedata
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

LIBRARY = os.path.expanduser('~/Library/Application Support/JakeTunes/library.json')
REPO_DR_CLAUDE = Path(__file__).resolve().parent.parent / 'Dr. Claude'
AUDIT_MD = REPO_DR_CLAUDE / '031-artist-variants-audit.md'
DECISIONS = REPO_DR_CLAUDE / '031-decisions.json'
AUDIT_STATE = REPO_DR_CLAUDE / '031-audit-state.json'

PUNCTUATION_PATTERN = re.compile(r"[-.',;/()\[\]!?]")

# Word-boundary collab delimiters, case-insensitive.
# 'x' must be surrounded by whitespace so it doesn't match names containing x.
# '&' must be surrounded by whitespace so it doesn't match e.g. an HTML entity.
COLLAB_DELIMITERS = [
    r'\bfeat\.?\b',
    r'\bft\.?\b',
    r'\bfeaturing\b',
    r'\bvs\.?\b',
    r'(?<=\s)x(?=\s)',
    r'\s+&\s+',
    r'\band\b',
]
COLLAB_PATTERN = re.compile('|'.join(COLLAB_DELIMITERS), re.IGNORECASE)


def normalize_artist(s: str) -> str:
    s = s.strip()
    s = s.casefold()
    s = unicodedata.normalize('NFD', s)
    s = ''.join(c for c in s if unicodedata.category(c) != 'Mn')
    s = PUNCTUATION_PATTERN.sub(' ', s)
    s = re.sub(r'\s+', ' ', s).strip()
    return s


def split_collab(s: str) -> list[str]:
    parts = COLLAB_PATTERN.split(s)
    # Strip whitespace AND leading/trailing punctuation. The delimiter
    # regex `\bfeat\.?\b` matches "feat" but the optional period after
    # may not be consumed (because \b doesn't match between `.` and
    # space). That leaves a stray "." at the start of the next half,
    # which would otherwise read as `". Pharrell Williams"`. Same for
    # any comma left behind when we deliberately don't split on commas.
    cleaned: list[str] = []
    for p in parts:
        p = p.strip().strip('.,;:').strip()
        if p:
            cleaned.append(p)
    return cleaned


def looks_like_collab(s: str) -> bool:
    return bool(COLLAB_PATTERN.search(s))


def main() -> int:
    # ── 1. Read library + capture state for Phase 3's gate ──────────────
    if not os.path.exists(LIBRARY):
        print(f'ERROR: library.json not found at {LIBRARY}', file=sys.stderr)
        return 1
    with open(LIBRARY, 'rb') as f:
        raw = f.read()
    sha256 = hashlib.sha256(raw).hexdigest()
    mtime = os.stat(LIBRARY).st_mtime
    mtime_iso = datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat()

    lib = json.loads(raw.decode('utf-8'))
    tracks = lib.get('tracks', [])

    # ── 2. Count raw artist strings ────────────────────────────────────
    raw_counts: dict[str, int] = defaultdict(int)
    for t in tracks:
        a = (t.get('artist') or '').strip()
        if not a:
            continue
        raw_counts[a] += 1

    # ── 3. Group by normalized key ─────────────────────────────────────
    # normalized_key -> {raw_variant_string: track_count}
    groups: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for raw_artist, count in raw_counts.items():
        key = normalize_artist(raw_artist)
        if not key:
            continue
        groups[key][raw_artist] += count

    # Default-canonical map (for the audit's pre-fill + collab half-resolution).
    # Most-used variant; alphabetical tiebreak.
    norm_to_default_canonical: dict[str, str] = {}
    for key, variants in groups.items():
        sorted_variants = sorted(variants.items(), key=lambda kv: (-kv[1], kv[0]))
        norm_to_default_canonical[key] = sorted_variants[0][0]

    # ── 4. Variant groups (normalized key with 2+ distinct raw variants) ────
    variant_groups: dict[str, dict] = {}
    for key, variants in groups.items():
        if len(variants) < 2:
            continue
        sorted_variants = sorted(variants.items(), key=lambda kv: (-kv[1], kv[0]))
        total = sum(v for _, v in sorted_variants)
        variant_groups[key] = {
            'canonical': sorted_variants[0][0],
            'variants': [v for v, _ in sorted_variants],
            'variantCounts': dict(sorted_variants),
            'trackCount': total,
            'notes': '',
        }

    # ── 5. Collab candidates ───────────────────────────────────────────
    # Condition 2 interpretation: skip if the full normalized form is a
    # variant-group key (i.e., a recognized multi-variant artist whose
    # natural-spelling string happens to contain a delimiter — e.g., a
    # band whose name has "&" in it). Strings whose normalized form has
    # only one variant don't get this protection and remain eligible for
    # collab detection.
    collab_candidates: dict[str, dict] = {}
    collab_edge_cases: list[tuple[str, dict]] = []

    for raw_artist in raw_counts.keys():
        if not looks_like_collab(raw_artist):
            continue
        norm_full = normalize_artist(raw_artist)
        # Condition 2 — full string is itself a recognized multi-variant artist
        if norm_full in variant_groups:
            continue
        halves = split_collab(raw_artist)
        if len(halves) < 2:
            continue
        # Resolve each half against the canonical map
        normalized_halves = [normalize_artist(h) for h in halves]
        canonical_matches: list[tuple[str, str | None]] = []
        for half, nh in zip(halves, normalized_halves):
            canonical_matches.append((half, norm_to_default_canonical.get(nh)))
        n_matched = sum(1 for _, c in canonical_matches if c is not None)
        if n_matched == 0:
            continue
        track_count = raw_counts[raw_artist]
        suggested_split = [c if c else h for (h, c) in canonical_matches]
        entry = {
            'split': suggested_split,
            'rawHalves': halves,
            'trackCount': track_count,
            'matchedHalves': n_matched,
            'totalHalves': len(halves),
            'notes': '',
        }
        if n_matched == len(halves):
            collab_candidates[raw_artist] = entry
        else:
            collab_edge_cases.append((raw_artist, entry))

    # ── 6. Write audit-state.json ──────────────────────────────────────
    REPO_DR_CLAUDE.mkdir(parents=True, exist_ok=True)
    audit_state = {
        'generatedAt': datetime.now(timezone.utc).isoformat(),
        'sourceLibraryPath': LIBRARY,
        'sourceLibraryHash': sha256,
        'sourceLibraryMtime': mtime_iso,
        'sourceLibraryMtimeRaw': mtime,
        'trackCount': len(tracks),
        'distinctArtistStrings': len(raw_counts),
        'variantGroupCount': len(variant_groups),
        'collabCandidateCount': len(collab_candidates),
        'edgeCaseCount': len(collab_edge_cases),
    }
    AUDIT_STATE.write_text(json.dumps(audit_state, indent=2) + '\n')

    # ── 7. Write decisions.json (pre-filled template) ───────────────────
    decisions = {
        'approved': False,
        'generatedAt': audit_state['generatedAt'],
        'sourceLibraryHash': sha256,
        'sourceLibraryMtime': mtime_iso,
        'note': (
            'Brief 031 Phase 2 — review and edit, then set "approved": true. '
            'Phase 3 reads only `approved`, `variants[*].canonical`, `collabs[*].split`. '
            'Set canonical to null to skip a variant group. '
            'Remove a collab entry or set its split to null to skip splitting it. '
            'Add entries for partial-match edge cases (see audit.md) if you want them split.'
        ),
        'variants': {
            k: {
                'canonical': g['canonical'],
                'variants': g['variants'],
                'variantCounts': g['variantCounts'],
                'trackCount': g['trackCount'],
                'notes': g['notes'],
            }
            for k, g in sorted(variant_groups.items(), key=lambda kv: (-kv[1]['trackCount'], kv[0]))
        },
        'collabs': {
            raw: {
                'split': c['split'],
                'trackCount': c['trackCount'],
                'notes': c['notes'],
            }
            for raw, c in sorted(collab_candidates.items(), key=lambda kv: (-kv[1]['trackCount'], kv[0]))
        },
    }
    DECISIONS.write_text(json.dumps(decisions, indent=2) + '\n')

    # ── 8. Write audit.md (human-readable summary) ─────────────────────
    total_variant_strings = sum(len(g['variants']) for g in variant_groups.values())
    total_consolidated_tracks = sum(g['trackCount'] for g in variant_groups.values())
    md: list[str] = []
    md.append('# Brief 031 — Artist Variants Audit')
    md.append('')
    md.append(f'**Generated:** {audit_state["generatedAt"]}')
    md.append(f'**Source:** `{LIBRARY}`')
    md.append(f'**mtime:** {mtime_iso}')
    md.append(f'**sha256:** `{sha256}`')
    md.append('')
    md.append(f'**Total tracks:** {len(tracks):,}')
    md.append(f'**Total distinct artist strings:** {len(raw_counts):,}')
    md.append(f'**Variant groups:** {len(variant_groups):,} ({total_variant_strings:,} variant strings collapse to {len(variant_groups):,} canonical, covering {total_consolidated_tracks:,} tracks)')
    md.append(f'**Collab candidates (all halves matched):** {len(collab_candidates):,} distinct strings')
    md.append(f'**Edge cases (partial-match collabs):** {len(collab_edge_cases):,} distinct strings')
    md.append('')
    md.append('---')
    md.append('')

    # Variant groups, sorted by track count desc
    md.append(f'## Variant Groups')
    md.append('')
    if not variant_groups:
        md.append('(none — every distinct artist string is already canonical)')
        md.append('')
    else:
        sorted_groups = sorted(variant_groups.items(), key=lambda kv: (-kv[1]['trackCount'], kv[0]))
        for key, g in sorted_groups:
            md.append(f'### `{key}` ({len(g["variants"])} variants, {g["trackCount"]} tracks total)')
            for v in g['variants']:
                marker = ' — **DEFAULT CANONICAL**' if v == g['canonical'] else ''
                md.append(f'- `{v}` ({g["variantCounts"][v]} tracks){marker}')
            md.append('')

    # Collab candidates, sorted by track count desc
    md.append(f'## Collab Candidates (all halves matched canonical artists)')
    md.append('')
    if not collab_candidates:
        md.append('(none)')
        md.append('')
    else:
        sorted_collabs = sorted(collab_candidates.items(), key=lambda kv: (-kv[1]['trackCount'], kv[0]))
        for raw, c in sorted_collabs:
            md.append(f'### `{raw}` ({c["trackCount"]} tracks)')
            md.append(f'- Suggested split: `{c["split"]}`')
            md.append(f'- All {c["matchedHalves"]}/{c["totalHalves"]} halves match existing canonical artists ✓')
            md.append('')

    # Edge cases (partial-match collabs) — informational only, NOT in decisions.json
    if collab_edge_cases:
        md.append(f'## Edge Cases — Partial-Half Matches (review carefully; NOT pre-filled in decisions.json)')
        md.append('')
        for raw, c in sorted(collab_edge_cases, key=lambda kv: (-kv[1]['trackCount'], kv[0])):
            md.append(f'### `{raw}` ({c["trackCount"]} tracks)')
            md.append(f'- Suggested split: `{c["split"]}` ({c["matchedHalves"]}/{c["totalHalves"]} halves match canonical)')
            md.append(f'- Likely a real collab where one side is a less-prolific artist.')
            md.append(f'- To split: manually add an entry under `collabs` in decisions.json with the desired split.')
            md.append(f'- To leave alone: do nothing.')
            md.append('')

    md.append('---')
    md.append('')
    md.append('## Decisions Template')
    md.append('')
    md.append('A pre-filled `031-decisions.json` has been written to `Dr. Claude/`.')
    md.append('')
    md.append('To approve and apply:')
    md.append('')
    md.append('1. Open `Dr. Claude/031-decisions.json` in your editor.')
    md.append('2. For each variant group, confirm the `canonical` choice. Edit if the default (most-used) isn\'t right. Set `canonical: null` to skip the group entirely.')
    md.append('3. For each collab, confirm the `split` array. Edit values or set `split: null` to skip splitting. Remove the entry to skip entirely.')
    md.append('4. Add edge-case collabs if you want them split (copy the suggested format from above).')
    md.append('5. Set top-level `"approved": true` and save.')
    md.append('6. Quit JakeTunes (`osascript -e \'quit app "JakeTunes"\'`).')
    md.append('7. Run Phase 3: `python3 scripts/brief-031-apply-decisions.py`.')
    md.append('')

    AUDIT_MD.write_text('\n'.join(md) + '\n')

    # ── 9. Console summary ─────────────────────────────────────────────
    print(f'Brief 031 Phase 1 audit complete.')
    print(f'  Tracks scanned:                       {len(tracks):>6,}')
    print(f'  Distinct artist strings:              {len(raw_counts):>6,}')
    print(f'  Variant groups:                       {len(variant_groups):>6,}  ({total_variant_strings:,} variants → {len(variant_groups):,} canonical)')
    print(f'  Collab candidates (full match):       {len(collab_candidates):>6,}')
    print(f'  Edge cases (partial-match collabs):   {len(collab_edge_cases):>6,}')
    print(f'')
    print(f'  Written:')
    print(f'    {AUDIT_MD}')
    print(f'    {DECISIONS}')
    print(f'    {AUDIT_STATE}')
    print(f'')
    print(f'Next: review Dr. Claude/031-decisions.json, edit canonical/split as')
    print(f'needed, set "approved": true, then run Phase 3.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
