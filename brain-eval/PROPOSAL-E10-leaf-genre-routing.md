# PROPOSAL — E10: leaf-genre queries → main index (PRICED 2026-10-16, recommend CLOSE)

**Status: priced and refuted on the current brain. Recommendation: close E10; do not ship the router change.**

## The idea (from the 10-12 scorecard, PR #106)
On 10-12 a query naming a leaf genre ("Garage Punk", "Midwest Rap") scored
0.428 on the production path but 0.784 on the main index — the router was
sending genre-name queries to the mood path, where genre names carried little
signal. E10 proposed: route (or fuse toward) the main index when the query
names a vocab leaf/family.

## Why the premise is gone
E3 (applied 10-14) put the umbrella/genre line into the mood text. On tonight's
brain the production path scores **leaf 0.843** vs the main index's **0.784** —
the mood path now *beats* the main index on leaf queries. The gap E10 was
written against no longer exists.

## What was measured (2026-10-16, homemini, snapshot of the 11,600-track brain)
Scratch copy of origin/main's `src/` (bridge tree `69c1e5e7e5e7`) with one
router change in `pickRetrievalIndex` (src/main/ai/rag-retrieval.ts): after the
decade and artist checks, a query containing a vocab leaf name (word-boundary,
case-insensitive, `GENRES` from `src/common/genre-vocab.ts`) routes `main`.
This is the *favorable* core case — family-name routing was not separately run
because the family-shaped groups already show the main index far behind
(umbrella_family main-idx 0.742 vs production 0.913; tempo_family 0.110 vs
0.510), so it is strictly worse.

Runs: `B3NL-20261016` (baseline) vs `C3NL-E10-20261016` (candidate), both
v3 `--no-llm` through the production bridge on the same snapshot;
`gate.py --v3-only` → `/tmp/gate-E10-20261016.json` (copy in ledger E10 entry).

| group | baseline | candidate | Δ |
|---|---|---|---|
| artist | 0.963 | 0.963 | 0 |
| umbrella_family | 0.913 | 0.887 | **−0.026** |
| leaf | 0.843 | 0.865 | +0.022 |
| family_decade | 0.872 | 0.872 | 0 |
| tempo_family | 0.510 | 0.260 | **−0.250** |
| vibe | 0.719 | 0.751 | +0.032 |
| **headline** | **0.803** | **0.766** | **−0.037** |

Gate: mean per-probe Δ −0.0200 (need ≥ +0.005), CI90 [−0.0431, +0.0029],
worst group −0.250. FAIL on every retrieval check.

Routes swung main 29 → 105, mood 94 → 18: genre words appear in far more than
leaf-shaped queries, so the match hijacks tempo- and vibe-qualified queries
("fast punk" −0.56, "fast-paced rock songs" −0.72) onto the tempo-blind main
index. Even inside the leaf group, 17 of 50 probes dropped — post-E3, the mood
index is the better home for many leaf genres ("Funk Rock songs" −0.44,
"Southern Rap songs" −0.36). The wins concentrate in electronic leaves the
mood text still under-serves ("Electro House" +0.56, "Techno" +0.48,
"Instrumental Hip-Hop" +0.44).

## Recommendation
1. **Close E10.** The hypothesis was correct on 10-12 and E3 solved it by
   fixing the index text instead of the route. Re-routing now strictly loses.
2. The real remaining gap is **tempo_family 0.510** (main-idx diag 0.110) —
   that is E7 territory (tempo signal in the mood text), not routing.
3. Small grounded observation, not a queue item: a handful of electronic
   leaf names ("Electro House", "Techno", "Big Beat") still score much better
   on the main index. If anything, that argues for checking how those genres
   render in the mood-text genre line — an E3-style text fix, never a route fix.
