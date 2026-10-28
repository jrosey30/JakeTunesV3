# Nightly brain-eval — 2026-10-28

**Outcome: IDLE (11th consecutive idle night) — baselines only, nothing applied, brain untouched.**

## Pre-flight

- brain-trainer finished 02:02 EDT (log dated today): **+66 tracks enriched**
  — the biggest add night in weeks (library 11,996 → 12,062; embeddings.bin
  → 12,249 vectors, mood-index.bin → 12,062), plus a lyrics-meaning
  catch-up of just **6** re-embeds. The meaning drain is effectively DONE:
  150 ×6 nights → 124 (10-27) → 6 (tonight). Expect ~0 from here and the
  nightly mood-sha churn to shrink to adds-only. (The 10-25 backlog count
  of ~3,199 is confirmed dead as a predictor — do not cite it.)
- Files stable ~63 min before snapshot. Snapshot `/tmp/brain-snap-20261028`
  sha-verified against the NAS before and after copy:
  - embeddings.bin `097a9dbc5355…` (12,249 vec)
  - mood-index.bin `2f41a8ee06d6…` (12,062 vec)
  - carried library.json, metadata-overrides.json, artist-members.json,
    lyrics.json, brain-descriptors.json.
- Both shas changed vs 10-27 (prior emb `4be6973abce6…`, mood
  `2c898295c698…`) — fully accounted for by tonight's trainer run (+66 adds
  + 6 meaning re-embeds). No unlogged writer event.
- Fresh worktree at brain-eval tip `fb14b1f` (matched origin). Audio fusion
  OFF as always on homemini (mood-only routing both rulers).
- Bridge main-src advanced to origin/main `667ac01fcafe` (PRs #274–#283
  merged since last night: taste-engine quiz-judge gates + shadow
  candidate #12, lyrics.ovh fallback, Overlooked-page removal, album page
  direction D, NAS LAN-mount fix, enrichment keep-awake). Retrieval-neutral
  by inspection AND by measurement: the only `src/main/ai/` change in the
  whole advance is a comment-line twin-pointer fix in `embeddings.ts`
  (rag.ts → embeddingsBlob.ts path); v1 routes unchanged (8 mood / 7 main),
  v3 route mix identical (29 main / 94 mood / 1 mood+lexicon /
  30 main+decade).

## Pick

`pick_experiment.py pick` → **IDLE**. E1 bare backlog = 0 (all 66 new adds
enriched same-night — the biggest single-night test of same-night
enrichment yet, passed cleanly); E2 genre-tag churn 21/11,550 (0.18%,
needs >1%). Auto lane and Jake lane both empty.

## Baselines (the night's only measurement)

| ruler | headline | detail |
|---|---|---|
| v1 | **0.906** | retrieval 0.813 / grounding 1.000 — inside the confirmed normal band (0.810–0.813 / 1.000 / 0.905–0.906, now ×14 nights 10-15..28) |
| v3 | **0.799** | artist 0.963 / umbrella_family 0.913 / leaf 0.836 / family_decade 0.869 / tempo_family 0.507 / vibe 0.707; grounding **1.000 (20/20)**; primary source bridge |

E3 win still holding: v3 0.797–0.803 ×14 nights across add-churn.

## Drift vs 10-27 (8 of 174 rows moved)

- **grd-14 RECOVERED 0 → 1** — the fenced-JSON flake did NOT fire tonight.
  Class tally stands at 5 of 14 nights (grd-16 ×3, grd-14 ×2). The
  tolerant-parse proposal (`PROPOSAL-grd16-fenced-json-parse.md`) remains
  the open Jake-lane remedy.
- Seven retrieval rows moved, all small and mixed-direction, all in the
  leaf/umbrella groups — classic add-pool churn from tonight's +66:
  leaf-13 0.84→0.80, leaf-14 0.68→0.84, leaf-16 0.32→0.28,
  leaf-30 0.32→0.28, leaf-31 0.68→0.72, leaf-36 0.60→0.64,
  umb-04 0.76→0.84. Net effect: leaf +0.002, umbrella +0.004,
  headline 0.798 → 0.799. No row crossed a watch threshold; no new watch.
- Sentinels: **vibe-prod-006 HELD 0.64 a 5th straight night** (10-23
  re-watch stays resolved); **leaf-20 held 0.92**.

## Applied

Nothing. IDLE night — no candidate was built, no gate was run, the NAS
brain was never written. Backups unchanged (E3 undo still
`mood-index.bin.pre-E3-20261014`, sha `028b02ea0e93…`).

## Standing items for Jake (unchanged)

1. `PROPOSAL-grd16-fenced-json-parse.md` — tolerant parse in scorecard.py
   (option a). Still the main apply-risk on future non-idle nights: a
   flake night reads grounding 0.95 and blocks any candidate.
2. tempo_family 0.507 (main-idx diag 0.107) — standing gap, no queued
   remedy; needs a new Jake-approved hypothesis (tempo in mood text, or a
   bpm-aware rerank term).

## Next nights

Queue fully drained — IDLE until >1% main-tag churn, a bare backlog, or
Jake queues work. With the meaning drain done, expect mood-sha changes to
track adds only; an unexplained mood sha change is now a *stronger* signal
of an unlogged writer.
