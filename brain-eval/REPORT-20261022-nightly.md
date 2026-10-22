# Nightly brain-eval — 2026-10-22

**Outcome: IDLE (5th consecutive idle night) — baselines only, nothing applied, brain untouched.**

## Pre-flight

- brain-trainer finished 02:07 EDT (log dated today): +25 tracks enriched
  (embeddings.bin → 11,924 vectors, mood-index.bin → 11,751) plus another
  150-track lyrics-meaning catch-up re-embed on the mood index (same OLD-code
  path as 10-21, fired on the lyrics wave — expected, logged writer).
- Files stable ~58 min before snapshot. Snapshot `/tmp/brain-snap-20261022`
  sha-verified against the NAS before and after copy:
  - embeddings.bin `9901ffc69f9b…` (harness brain_id `0a832a547522`)
  - mood-index.bin `d47fc886882f…` (harness mood_id `f10eb842092b`)
  - carried library.json, metadata-overrides.json, artist-members.json, lyrics.json, brain-descriptors.json.
- Worktree at brain-eval `7690b71`; audio fusion OFF as always on homemini
  (mood-only routing both rulers — comparable night to night).

## Pick

`pick_experiment.py pick` → **IDLE**. E1 bare backlog = 0; E2 genre-tag churn
0/11,562 (0.00%, needs >1%). Auto lane and Jake lane both empty — as predicted
after PR #194 closed the ledger.

## Baselines

**v1 (B1-20261022):** retrieval 0.813 / grounding 1.000 / overall 0.906 —
exactly on the recent normals (8th consecutive night at 0.810–0.813 / 1.000).
Routes: 8 mood / 7 main.

**v3 (B3-20261022, primary source bridge):** headline **0.800** (prev 0.799).
Groups: artist 0.963 · umbrella_family 0.907 · leaf 0.839 · family_decade
0.871 · tempo_family 0.510 · vibe 0.711. Routes: main 29 / mood 94 /
mood+lexicon 1 / main+decade 30.

**Grounding 0.950 (19/20): grd-16 flaked again** — 3rd occurrence (10-14,
10-18, 10-22), reason `unparseable (reply was not JSON)`. PR #194's
raw_excerpt capture fired and **diagnosed it definitively**: the model
behaved CORRECTLY (cited zero tracks, refused the 1950s-hip-hop trap) but
wrapped the JSON in a markdown fence AND left unescaped double quotes around
a track title inside the answer string. Formatting failure, not fabrication.
Wrote **PROPOSAL-grd16-fenced-json-parse.md** (Jake lane: tolerant parse in
scorecard.py, recommended option (a)).

## Probe movement vs 10-21 (pool churn from +25 adds + 150 meaning re-embeds)

5/154 moved, net positive at headline:

- v3-vibe-prod-004: 0.600 → 0.720 (+0.120) — vibe group 0.699 → 0.711
- v3-leaf-32: 0.960 → 1.000 (+0.040)
- v3-fam-08: 1.000 → 0.960 (−0.040)
- v3-leaf-30: 0.440 → 0.360 (−0.080)
- v3-umb-04: 0.800 → 0.720 (−0.080)

The two vibe-slide sentinels (v3-leaf-20, v3-vibe-prod-006) did not move —
consistent with the 10-21 "pool churn, not drift" conclusion.

## Standing items

- Ruler fully fresh (no RULER STALE; 0 unresolved tags).
- tempo_family 0.510 remains the standing gap with no queued remedy (needs a
  new Jake-approved hypothesis).
- Sole open Jake items: grd-16 (now fully diagnosed — see the new proposal)
  and the tempo_family gap.
- Live brain sha change vs 10-21 (05418bb6 → 9901ffc6 etc.) is fully
  accounted for by tonight's trainer run. No unlogged writer events.

## Applied

Nothing. No candidate was built; the NAS brain was never written.
