# Nightly brain-eval — 2026-10-24

**Outcome: IDLE (7th consecutive idle night) — baselines only, nothing applied, brain untouched.**

## Pre-flight

- brain-trainer finished 02:07 EDT (log dated today): **+44 tracks enriched**
  (library 11,935 → 11,965; embeddings.bin → 12,152 vectors, mood-index.bin
  → 11,965), a **mood-index prune of 14 orphan vectors** (11,935 → 11,921,
  logged, undo copy at `mood-index.bin.prune.bak`), plus another 150-track
  lyrics-meaning catch-up re-embed (4th consecutive night, same OLD-code
  path — expected, logged writer).
- Files stable ~58 min before snapshot. Snapshot `/tmp/brain-snap-20261024`
  sha-verified against the NAS before and after copy:
  - embeddings.bin `c52de8fe3f56…` (harness brain_id `5ac582f8a00c`)
  - mood-index.bin `4aa016238b80…` (harness mood_id `9ce998a9ff48`)
  - carried library.json, metadata-overrides.json, artist-members.json,
    lyrics.json, brain-descriptors.json.
- Both shas changed vs 10-23 (prior emb `a77e68ca8390…`, mood `6a080575d963…`)
  — fully accounted for by tonight's trainer run (adds + prune + meaning
  re-embeds). No unlogged writer event.
- Worktree at brain-eval `2ed8b70` (local branch was one commit behind origin
  — fast-forwarded before running); audio fusion OFF as always on homemini
  (mood-only routing both rulers — comparable night to night).

## Pick

`pick_experiment.py pick` → **IDLE**. E1 bare backlog = 0 (all 44 new adds
were enriched same-night); E2 genre-tag churn 21/11,550 (0.18%, needs >1%).
Auto lane and Jake lane both empty.

## Baselines

**v1 (B1-20261024):** retrieval 0.813 / grounding 1.000 / overall 0.906 —
10th consecutive night at 0.810–0.813 / 1.000 / 0.905–0.906. Routes: 8 mood /
7 main.

**v3 (B3-20261024, primary source bridge):** headline **0.798** (prev 0.797,
Δ +0.001 — inside the 0.797–0.803 post-E3 band). Groups: artist 0.963 ·
umbrella_family 0.909 · leaf 0.834 · family_decade 0.869 · tempo_family 0.507
· vibe 0.707. Routes: main 29 / mood 94 / mood+lexicon 1 / main+decade 30.

**Grounding 0.950 (19/20) — tonight's flake is `v3-grd-14`, a NEW probe;
grd-16 held.** raw_excerpt shows the identical mechanical signature diagnosed
on 10-22: model behavior CORRECT (cited 4 real tracks — Sparta / Foo
Fighters), but the reply was fenced in ```json AND had unescaped inner quotes
around a track title ("Split Lip") in the `answer` prose. **This proves the
flake is a formatting CLASS, not a grd-16 quirk** — any probe whose answer
quotes a track title can fire it. Now 4 flake nights of the last 10 (10-14 /
10-18 / 10-22 / 10-24) across two probes.
`PROPOSAL-grd16-fenced-json-parse.md` updated with the new evidence; option
(a) tolerant parse in scorecard.py still recommended, still Jake's call.
(IDLE night, so the 0.950 blocked nothing — but on a candidate night this
class is the main apply-risk.)

## Probe movement vs 10-23 (7 of 174 rows)

Small and **bidirectional** — normal pool churn for a +44-add / 14-prune
night, NOT the one-sided add-wave signature of 10-23:

- down 1 slot: v3-leaf-01 (1.00→0.96), v3-leaf-42 (0.92→0.88),
  v3-leaf-30 (0.36→0.32)
- up 1 slot: v3-umb-04 (0.72→0.76), v3-vibe-prod-003 (0.24→0.28),
  v3-vibe-ret-014 (0.267→0.300)
- plus the grd-14 formatting flake (1→0, transport not brain).

**Sentinels:** `v3-vibe-prod-006` HELD at 0.64 — it did not slide a second
time after its first-ever move on 10-23, so no vibe-drift call tonight (the
re-watch condition — a further slide on a <~30-add night — stays armed;
tonight's 44 adds wouldn't have qualified as low-churn anyway). `v3-leaf-20`
held 0.92. Vibe group recovered 0.700 → 0.707.

## Standing items (unchanged)

- tempo_family 0.507 (main-idx diag 0.107) — the known gap, no queued remedy;
  needs a new Jake-approved hypothesis.
- grd-14/16 fenced-JSON parser fix — Jake lane, proposal updated tonight.
- E3 undo still on NAS: `mood-index.bin.pre-E3-20261014` (028b02ea0e93).

## Applied

Nothing. No candidate was built; the NAS brain was not written.
