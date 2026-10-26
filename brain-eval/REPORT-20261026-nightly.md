# Nightly brain-eval — 2026-10-26

**Outcome: IDLE (9th consecutive idle night) — baselines only, nothing applied, brain untouched.**

## Pre-flight

- brain-trainer finished 02:06 EDT (log dated today): **+16 tracks enriched**
  (library 11,966 → 11,982; embeddings.bin → 12,169 vectors, mood-index.bin
  → 11,982), plus another 150-track lyrics-meaning catch-up re-embed —
  **6th consecutive night of exactly 150** (the measured capped drain,
  ~3,050 backlog remaining; benign, do not re-investigate).
- Files stable ~59 min before snapshot. Snapshot `/tmp/brain-snap-20261026`
  sha-verified against the NAS before and after copy:
  - embeddings.bin `b20cf5256535…`
  - mood-index.bin `ebc7703ee092…`
  - carried library.json (`f30776cd1bff…`), metadata-overrides.json,
    artist-members.json, lyrics.json, brain-descriptors.json.
- Both shas changed vs 10-25 (prior emb `fd9c814bd489…`, mood
  `d592cabaa4d9…`) — fully accounted for by tonight's trainer run (+16 adds
  + 150 meaning re-embeds). No unlogged writer event.
- Fresh worktree at brain-eval tip `4cb343b` (matched origin). Audio fusion
  OFF as always on homemini (mood-only routing both rulers).
- Bridge main-src advanced to origin/main `ac2fd621bdeb` (PRs #263
  top1000-love-signal + #264 sidebar-justification-months merged since last
  night). Retrieval-neutral: v1 routes unchanged (8 mood / 7 main), all 144
  non-vibe v3 probes bit-identical, and the only movers are mood-pool vibe
  probes explained by tonight's brain churn (see drift).

## Pick

`pick_experiment.py pick` → **IDLE**. E1 bare backlog = 0 (all 16 new adds
enriched same-night); E2 genre-tag churn 21/11,550 (0.18%, needs >1%).
Auto lane and Jake lane both empty.

## Baselines

**v1 (B1-20261026):** retrieval 0.813 / grounding 1.000 / overall 0.906 —
12th consecutive night at 0.810–0.813 / 1.000 / 0.905–0.906. Routes: 8 mood /
7 main (unchanged under main `ac2fd62`).

**v3 (B3-20261026, primary source bridge):** headline **0.797**
(−0.001 vs 10-25, entirely the vibe group). Groups: artist 0.963 ·
umbrella_family 0.909 · leaf 0.834 · family_decade 0.869 · tempo_family
0.507 · vibe 0.700. **Grounding 20/20 (1.000)** — the fenced-JSON flake did
NOT fire; tally stays 4 of the last 12 nights, class-wide, intermittent.
Routes: main 29 / mood 94 / mood+lexicon 1 / main+decade 30 (the standing
pattern).

## Per-probe drift vs 10-25

**2 of 174 rows moved**, both vibe, both small slot losses on the mood path:

- `v3-vibe-prod-002` 0.92 → 0.88 (−0.04)
- `v3-vibe-ret-013` 0.933 → 0.90 (−0.033)

Together they are exactly the vibe −0.007 and the headline −0.001. Plausible
pool churn: tonight's mood index gained 16 new vectors and re-embedded 150
tracks with new meaning lines — a few boundary slots shuffle. Not a code
effect: a bridge/main change would show on main-routed probes, and all of
those are frozen. No watch opened — single-night sub-0.05 moves on vibe
probes are within the churn band this series has seen all month.

- **Sentinel `v3-vibe-prod-006` held 0.64 a THIRD straight night** — the
  10-23 re-watch stays resolved.
- `v3-leaf-20` held 0.92; `v3-umb-04` held 0.76.
- v1: all 25 rows unchanged (grounding 10/10 both nights).

## Applied

Nothing. No candidate was built; the brain was not written.

## Standing items (unchanged)

- Jake lane: `PROPOSAL-grd16-fenced-json-parse.md` (tolerant parse in
  scorecard.py — the main apply-risk on future non-idle nights) and the
  tempo_family gap (0.507 primary / 0.107 main-idx diagnostic; needs a NEW
  Jake-approved hypothesis).
- Next non-idle trigger: >1% main-tag genre churn, a bare-descriptor
  backlog, or Jake queueing work.

## Shas (tonight)

- library `f30776cd1bff` · eval_set `c2d5e57c9f53` · vocab `3c6d2e22e73f`
- main-src `ac2fd621bdebd19a253e00630109e941f455bfc7`
- embeddings.bin `b20cf5256535` (12,169 vec) · mood-index.bin `ebc7703ee092`
  (11,982 vec)
