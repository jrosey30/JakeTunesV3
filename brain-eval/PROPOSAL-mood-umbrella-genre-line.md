# PROPOSAL: mood genre line carries leaf + family/umbrella names

**Status:** OPEN (filed 2026-10-13, from the E3 rejection) — Jake-gated
(trainer `moodText()` + app `buildMoodText()` twin change).

## What happened (E3, 2026-10-13)

First night with the bare cohort at 0 (PR #105's budget run described all
328 backlog tracks on 10-12 23:29), so the 10-12 sequencing rule fired: E3
rebuilt the mood index on a scratch copy via trainer `--rebuild-mood-index`
(11,577 vectors, taxonomy-era genre lines). Dual-run result:

- v3 mean per-probe Δ **+0.111**, 90% CI [+0.079, +0.143] — a huge average win
- **leaf group 0.518 → 0.854** (+0.34): genre-name queries finally land on
  the mood path the router sends them to
- vibe 0.711 → 0.752, tempo_family 0.475 → 0.500
- **BUT gate exit 1 (REJECTED, discarded):**
  - umbrella_family **0.913 → 0.880** (−0.033 > the 0.01 limit): "pop music"
    0.80→0.44, "pop songs" 0.52→0.24, "jazz and world music" 0.76→0.56
  - candidate grounding **0.95** (v3-grd-11: one fabricated + one
    misattributed citation off the shifted retrieval context)
  - v1 bar: worst per-probe mood Δ ret-004 **−0.25** (ret-006 −0.16)

## Mechanism

The old mood texts (built pre-taxonomy, ≤10-11) carry coarse tags ("Pop",
"Rap"). The rebuild wrote fine leaves ("Synthpop", "Midwest Rap", …), so
umbrella/family-level query tokens literally left the mood texts — the exact
mirror of the leaf-group win. The 10-12 main-index refresh didn't hit this
because main's plain text is only one retrieval surface for those queries
(and v1 ret-006/011 were recalibrated to leaves); the mood texts serve the
vibe/umbrella queries directly.

## The fix (Jake-gated twin change)

Make the mood text's genre line carry the leaf AND its family/umbrella from
the genre vocab, e.g. `genre: Synthpop (Pop)` or `genre: Midwest Rap (Rap /
Hip-Hop)`:

- `scripts/brain-trainer.mjs` `moodText()` ⚠️ TWIN of
- `src/main/ai/mood-index.ts` `buildMoodText()`

Leaf→family→umbrella already exists in `src/common/genre-vocab.ts` +
`genre-iceberg.ts` (the same mapping `export_vocab.py` snapshots).

## Pricing protocol (pre-registered, scratch-only)

1. Patch `moodText()` on a scratch checkout (or apply the same line-shape in
   a one-off rebuild tool); trainer `--rebuild-mood-index` on a copy of the
   night's snapshot; restore the snapshot `embeddings.bin` (mood only).
2. Dual run vs that night's B1/B3. **Numbers to beat (from tonight):**
   - v3 mean Δ ≥ +0.005 with CI lower bound > 0 (expect ≈ +0.11 if the
     umbrella loss is repaired)
   - umbrella_family ≥ baseline − 0.01 (tonight's failure: −0.033)
   - leaf ≥ 0.80 via the production path (tonight's candidate: 0.854)
   - grounding 1.000, v1 worst per-probe mood Δ ≥ 0 (ret-004 is the canary)
3. If it passes, Jake ships the twins; the nightly's E3-shaped rebuild then
   re-runs through the normal gate (requeue with this proposal's numbers as
   the NEW hypothesis).

## Cost

One `--rebuild-mood-index` ≈ 11.6k embeds ≈ $0.01 + ~90 s; two LLM eval runs.
Nothing was applied tonight; the live mood index still speaks the coarse
tags, which costs leaf-genre queries ~0.34 recall on the production path —
the single largest measured headroom in the current brain.
