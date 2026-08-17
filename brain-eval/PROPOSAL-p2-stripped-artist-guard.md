# PROPOSAL — P2 "the"-stripped artist guard, quantified (2026-08-17)

**Status: gated, awaiting Jake.** App code change (router in
`src/main/index.ts`), so outside nightly auto-apply scope. Nothing applied.

**Headline: the 08-11 one-liner is VETOED by its own audit — ship the S2
variant instead.** Same benefit, none of the newly-found hijack risk.

## What P2 fixes (now measured, 2026-08-17, 9,583-track library)

The router's `ragLibraryArtistSet` stores full normalized names
("the beatles"), so any "The X" band queried without "The" fails the artist
match and routes to the mood index. That's the wrong index for artist
queries by a huge margin:

- **146 library artists** are "The "-prefixed; 142 yield a valid stripped
  variant (len≥4, genre-word guard) → **140/142 bare-name queries**
  ("beatles tracks", "clash songs") currently misroute to mood and would
  flip to identity under P2.
- Scored sample, recall@20 of "\<x\> songs" vs that artist's tracks —
  identity vs mood: beach boys 1.00/0.55, beatles 1.00/0.70, chemical
  brothers 1.00/0.15, clash 1.00/**0.00**, flaming lips 0.95/0.05,
  notorious b.i.g. 1.00/0.15, postal service 1.00/**0.00**, velvet
  underground 0.90/0.25. **Mean +0.75 recall.**
- Eval router-truth: 0.818 → **0.838 (+0.020)**; only ret-002 flips
  (the intended one), no other probe changes route.

## What the audit found wrong with the naive version (new)

**57 of the 142 stripped variants are ordinary English words** (or plurals):
`beat, band, sleeping, cure, cars, doors, animals, zombies, faint, dare,
itch, rapture, shoes, twins, …` (full list in `p2_safe_variant_check.py`
output). A bare substring match on those hijacks vibe queries to the
identity index — measured on 12 realistic vibe queries, **naive P2
misroutes 10** ("music for sleeping" → artist:sleeping, "big band music" →
artist:band, "songs about cars" → artist:cars, "upbeat dance beat" →
artist:beat…). The mood index is the better index for exactly those
queries (eval: ret-013 1.00 vs 0.83, ret-015 0.73 vs 0.50, ret-014 0.30
vs 0.20), so each hijack is a real quality loss. Note the plural trap:
a singular-only dictionary check misses `cars/doors/animals/zombies`.

## Options (quantified, `p2_safe_variant_check.py`)

| rule | demo vibe hijacks | bare-name coverage | notes |
|---|---|---|---|
| naive (08-11) | **10/12** | 142/142 | vetoed |
| S1: skip dictionary-word variants | 0/12 | 85/142 | loses The Cure/Doors/Smiths/Killers/Strokes — the most bare-queried bands |
| **S2: dictionary-word variants match only on artist-intent templates** | **0/12** | **142/142** | recommended |

S2 rule: all 142 variants join the set, but a variant in the dictionary
risk class only matches when the normalized query **is** an artist-intent
template: `<x>`, `<x> songs|tracks|music`, `play [some] <x>`,
`songs|tracks|music by <x>`, `best <x> songs`. Flagship checks all pass:
"clash songs"/"cure songs"/"doors songs"/"smiths songs"/"police"/"killers
songs" → identity; "music for sleeping"/"big band music"/"songs about
cars" → mood. Non-dictionary variants (beatles, weeknd, fixx, "rolling
stones", …) keep plain substring matching — a vibe query containing
"rolling stones" *is* an artist query.

## Implementation sketch (desktop rebuild required)

In `ragLibraryArtistSet` (src/main/index.ts:11814): when `norm` starts
with `"the "`, also compute `v = norm.slice(4)`; if `v.length >= 4 &&
!GENRE_WORD_ARTISTS.has(v)`, add `v` to a second set `strippedRisky` if
`v` is in the bundled risk list (ship the 57-word list as a constant —
it's derived from the library, regenerate with `p2_safe_variant_check.py`)
else into the main set. In `pickRetrievalIndex`, match `strippedRisky`
members only against the template forms above. Keep the existing full-name
substring pass unchanged.

**Undo:** revert the commit; router returns to current behavior. No data
migration in either direction — this touches no state files.

## Repro

```bash
# worktree of brain-eval, .env copied in, venv with numpy
JT_STATE_DIR=<state> python p2_stripped_artist_audit.py   # benefit + risk discovery (embeds ~23 queries)
JT_STATE_DIR=<state> python p2_safe_variant_check.py      # S1/S2 comparison (no API calls)
```

Measured against brain sha `6bd4aa12e23b` (9,593 vectors), frozen NAS
snapshot, 2026-08-17 03:0x EDT.
