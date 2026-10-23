# Nightly brain-eval — 2026-10-23

**Outcome: IDLE (6th consecutive idle night) — baselines only, nothing applied, brain untouched.**

## Pre-flight

- brain-trainer finished 02:11 EDT (log dated today): **+184 tracks enriched**
  — the biggest add wave of this idle stretch (library 11,751 → 11,935;
  embeddings.bin → 12,108 vectors, mood-index.bin → 11,935) — plus another
  150-track lyrics-meaning catch-up re-embed on the mood index (same OLD-code
  path as 10-21/10-22, fired on the continuing lyrics wave — expected, logged
  writer).
- Files stable ~54 min before snapshot. Snapshot `/tmp/brain-snap-20261023`
  sha-verified against the NAS before and after copy:
  - embeddings.bin `a77e68ca8390…` (harness brain_id `aa11f21e35b9`)
  - mood-index.bin `6a080575d963…` (harness mood_id `6935ff83eac4`)
  - carried library.json, metadata-overrides.json, artist-members.json,
    lyrics.json, brain-descriptors.json.
- Both shas changed vs 10-22 (prior emb `9901ffc69f9b…`, mood `d47fc886882f…`)
  — fully accounted for by tonight's trainer run. No unlogged writer event.
- Worktree at brain-eval `48b33bd`; audio fusion OFF as always on homemini
  (mood-only routing both rulers — comparable night to night).

## Pick

`pick_experiment.py pick` → **IDLE**. E1 bare backlog = 0 (all 184 new adds
were enriched same-night); E2 genre-tag churn 21/11,562 (0.18%, needs >1%).
Auto lane and Jake lane both empty.

## Baselines

**v1 (B1-20261023):** retrieval 0.813 / grounding 1.000 / overall 0.906 —
9th consecutive night at 0.810–0.813 / 1.000 / 0.905–0.906. Routes: 8 mood /
7 main.

**v3 (B3-20261023, primary source bridge):** headline **0.797** (prev 0.800,
Δ −0.003 on the largest add wave of the stretch — still inside the 0.797–0.803
post-E3 band). Groups: artist 0.963 · umbrella_family 0.907 · leaf 0.836 ·
family_decade 0.869 · tempo_family 0.507 · vibe 0.700. Routes: main 29 /
mood 94 / mood+lexicon 1 / main+decade 30.

**Grounding 1.000 (20/20) — grd-16 did NOT flake tonight.** The flake
(10-14 / 10-18 / 10-22, diagnosed 10-22 as fenced-JSON + unescaped quotes)
remains intermittent model-formatting behavior; the tolerant-parse fix is
still waiting on Jake (`PROPOSAL-grd16-fenced-json-parse.md`). Tonight is a
reminder it's a coin-flip, not a steady state — a future candidate night that
draws the flake still blocks an apply on the grounding=1.000 gate.

## Probe movement vs 10-22 (pool churn from +184 adds + 150 meaning re-embeds)

9/174 rows moved. One is grd-16 recovering (0 → 1, above). The 8 retrieval
moves are each exactly one slot DOWN, no gains:

- v3-leaf-36: 0.680 → 0.600 (−0.080)
- v3-leaf-43: 0.920 → 0.880 (−0.040)
- v3-tempo-03: 0.520 → 0.480 (−0.040)
- v3-vibe-prod-003: 0.280 → 0.240 (−0.040)
- v3-vibe-prod-006: 0.680 → 0.640 (−0.040) ← slide sentinel, see below
- v3-leaf-47: 0.440 → 0.400 (−0.040)
- v3-fdec-17: 0.840 → 0.800 (−0.040)
- v3-vibe-ret-014: 0.300 → 0.267 (−0.033)

All-drops-no-gains is the expected signature of a large add wave: 184 new
tracks enter the candidate pools and displace answer-key tracks by one rank,
while brand-new adds can't appear in any frozen answer key. Churn, not drift.

**Sentinel note:** v3-leaf-20 held (0.92). v3-vibe-prod-006 lost one slot
(0.68 → 0.64) — its first move since the sentinels were declared steady. It
coincides with the largest add wave of the stretch, so pool churn is the
parsimonious read; but if it slides again on a LOW-churn night (<~30 adds),
treat it as real vibe drift, not churn.

## Standing items

- Ruler fully fresh (no RULER STALE; vocab resolved cleanly).
- tempo_family 0.507 (main-idx diag 0.107) remains the standing gap with no
  queued remedy (needs a new Jake-approved hypothesis).
- Not a re-tag wave (0.18% tag churn), so no migration-matrix check needed.
- E3 win still holding on the production path; v3 band 0.797–0.803 across
  add-churn nights.

## Changes applied

None. The brain was not written. NAS shas at end of session unchanged from
snapshot (`a77e68ca8390…` / `6a080575d963…`).
