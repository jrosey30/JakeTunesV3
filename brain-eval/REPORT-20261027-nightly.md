# Nightly brain-eval — 2026-10-27

**Outcome: IDLE (10th consecutive idle night) — baselines only, nothing applied, brain untouched.**

## Pre-flight

- brain-trainer finished 02:06 EDT (log dated today): **+14 tracks enriched**
  (library 11,982 → 11,996; embeddings.bin → 12,183 vectors, mood-index.bin
  → 11,996), plus a lyrics-meaning catch-up of **124** re-embeds — the FIRST
  night below the 150 cap after six consecutive nights of exactly 150. The
  trainer's own backlog query found only 124 tracks with lyrics but no
  meaning and processed all of them, which reads as the drain being nearly
  exhausted — well ahead of the ~mid-Nov estimate (the 10-25 backlog count
  of ~3,199 evidently over-counted what the trainer's query actually
  selects, likely tracks whose lyrics aren't in lyrics.json). Observation
  only, no investigation: if tomorrow's catch-up line is 0 or small, the
  drain is done and the nightly mood-sha churn should shrink accordingly.
- Files stable ~59 min before snapshot. Snapshot `/tmp/brain-snap-20261027`
  sha-verified against the NAS before and after copy:
  - embeddings.bin `4be6973abce6…` (12,183 vec)
  - mood-index.bin `2c898295c698…` (11,996 vec)
  - carried library.json, metadata-overrides.json, artist-members.json,
    lyrics.json, brain-descriptors.json.
- Both shas changed vs 10-26 (prior emb `b20cf5256535…`, mood
  `ebc7703ee092…`) — fully accounted for by tonight's trainer run (+14 adds
  + 124 meaning re-embeds). No unlogged writer event.
- Fresh worktree at brain-eval tip `1622724` (matched origin). Audio fusion
  OFF as always on homemini (mood-only routing both rulers).
- Bridge main-src advanced to origin/main `722d52559221` (PRs #265
  ipod-pool-no-locks-pins + #266 card-names-never-reach-the-library merged
  since last night). Retrieval-neutral: v1 routes unchanged (8 mood /
  7 main), all main-routed v3 probes frozen; the only movers are mood-pool
  vibe probes + the grounding flake (see drift).

## Pick

`pick_experiment.py pick` → **IDLE**. E1 bare backlog = 0 (all 14 new adds
enriched same-night); E2 genre-tag churn 21/11,550 (0.18%, needs >1%).
Auto lane and Jake lane both empty.

## Baselines

**v1 (B1-20261027):** retrieval 0.813 / grounding 1.000 / overall 0.906 —
13th consecutive night at 0.810–0.813 / 1.000 / 0.905–0.906. Routes: 8 mood /
7 main (unchanged under main `722d525`). All 25 per-probe rows identical to
10-26.

**v3 (B3-20261027, primary source bridge):** headline **0.798**
(+0.001 vs 10-26, entirely the vibe group recovering). Groups: artist 0.963 ·
umbrella_family 0.909 · leaf 0.834 · family_decade 0.869 · tempo_family
0.507 · vibe 0.707. **Grounding 0.950 (19/20)** — the fenced-JSON flake
FIRED on grd-14; tally now 5 of the last 13 nights, class-wide,
intermittent (grd-16 ×3, grd-14 ×2). Routes: main 29 / mood 94 /
mood+lexicon 1 / main+decade 30 (the standing pattern).

## Per-probe drift vs 10-26

**3 of 174 rows moved:**

- `v3-grd-14` 1 → 0 — the known flake, PROVEN by raw_excerpt again tonight:
  reply opens with a ```json fence AND puts unescaped quotes around track
  titles inside the `answer` string. The cited tracks (Sparta, Foo Fighters)
  are real library tracks — transport/formatting, not fabrication. Fix
  remains Jake's call (`PROPOSAL-grd16-fenced-json-parse.md`).
- `v3-vibe-prod-002` 0.88 → 0.92 (+0.04) — recovered to its 10-25 value.
- `v3-vibe-ret-013` 0.90 → 0.933 (+0.033) — recovered to its 10-25 value.

Last night's two vibe dips bounced straight back, confirming the 10-26 read:
mood-pool boundary churn, not a slide. No watch opened.

- **Sentinel `v3-vibe-prod-006` held 0.64 a FOURTH straight night** — the
  10-23 re-watch stays resolved.
- `v3-leaf-20` held 0.92.
- Retrieval net: every one of the 154 retrieval probes is at or above its
  10-25 value; the only sub-1.000 bucket tonight is the grounding flake.

## Applied

Nothing. No candidate was built; the brain was not written.

## Standing items (unchanged)

- Jake lane: `PROPOSAL-grd16-fenced-json-parse.md` (tolerant parse in
  scorecard.py — fired again tonight; still the main apply-risk on future
  non-idle nights) and the tempo_family gap (0.507 primary / 0.107 main-idx
  diagnostic; needs a NEW Jake-approved hypothesis).
- Next non-idle trigger: >1% main-tag genre churn, a bare-descriptor
  backlog, or Jake queueing work.

## Shas (tonight)

- library `aa62db0a8bc6` · eval_set `c2d5e57c9f53` · vocab `3c6d2e22e73f`
- main-src `722d52559221` (origin/main, PRs #265/#266)
- embeddings.bin `4be6973abce6` (12,183 vec) · mood-index.bin `2c898295c698`
  (11,996 vec)
