# Nightly brain-eval — 2026-11-23 (homemini, 03:05 launchd)

**Outcome: IDLE (38th) — baselines only, nothing applied, brain untouched.**
Queue: auto lane empty (E1 bare=0; E2 genre-tag churn 24/11,547 = 0.21%, need >1%),
jake lane empty → `pick` returned IDLE (ledger `picked` event 03:06:33).
The gemma4 promotion pricing item (TOP Jake ask) is STILL NOT QUEUED.

## Pre-flight
- brain-trainer (23:40 EST slot) finished 23:51:34 EST Nov 22: +161 enriched
  (biggest wave since the slot moved), brain 14,727/14,727, embeddings.bin
  14,948 vectors, mood-index 14,727 vectors, purity gate ok (0.8629 vs 0.8619,
  regression −0.0010 ≤ 0.02). Mood prune −1 (id 14086, 14,567 → 14,566 before
  the nightly adds) — LOGGED in brain-prune-ledger.jsonl at 04:40:15Z = normal
  trainer-time write; writer rule clean, no unlogged writes.
- NAS mtimes embeddings.bin 23:51:30 / mood-index.bin 23:51:34 (Nov 22 EST) —
  trainer slot, stable ≥3h before measurement. No post-02:30 writes.
- Snapshot `/tmp/brain-snap-20261123`, sha-verified pre/post on all 7 files
  (emb c12cf4ffcf62, mood 3f77275c9a9a, library 589e5c8c2375 = 14,727 tracks,
  + descriptors/artist-members/metadata-overrides/lyrics). No torn reads.
- End-of-run re-verify: NAS emb/mood shas and mtimes UNCHANGED since snapshot.

## Scores (harness brain_id c12cf4ffcf62 / mood_id 3f77275c9a9a)
- **v1 (B1-20261123): retrieval 0.808 / grounding 0.900 as printed — true
  grounding 1.000, true overall ≈0.904.** Two movers after 8 identical nights:
  - ret-011 0.52 → 0.48 — one slot of churn from the +161 wave; retrieval
    0.811 → 0.808 stays inside the historic 0.804–0.816 band (memory already
    recommends re-centering ~0.804–0.811). Not a watch.
  - **grd-005 1.00 → 0.00 (`unparseable/no-LLM`) — the FLAKE CLASS CROSSED TO
    v1 for the first time** (v1 grounding had been 1.000 ×8). Read-only ×3
    forensic on the exact rebuilt context parsed **6/6** (3× claude-haiku-4-5 —
    which wrapped its JSON in ```-fences every time and the v1 fence-strip
    handled it — plus 3× sonnet, unfenced; 5 real Nirvana tracks each). The v1
    path persisted NO raw reply (the 10-19 v3 raw_excerpt fix was never
    mirrored), so tonight's zero can't be proven dropped-call vs bad-reply —
    most consistent with a transient API failure. All traps clean; routes
    8 mood / 7 main unchanged.
- **v3 (B3-20261123): headline 0.778** — 20th night in the ~0.78 band. Primary
  source **bridge**; routes main 29 / mood 94 / mood+lexicon 1 / main+decade 30 —
  identical. v3 grounding **0.950 = grd-15 trap ONLY, zero parser flakes**
  (last night's v3-grd-05 flake recovered to 1.00 — the flake hopped rulers,
  which fits stochastic formatting/transport, not drift). grd-15 APPLY-BLOCKER
  stands. Flake tally now 6 nights / 4 probes / both rulers.
- Groups: artist 0.963 / umbrella 0.909 / leaf 0.842 / family_decade 0.879 /
  tempo_family **0.422** / vibe 0.651 — only tempo_family moved beyond churn
  (0.435 → 0.422, see movers).
- main-src 5afffcf4 = origin/main HEAD, unchanged — stability baseline held.
- vocab ruler_check 33/14,727 unresolved = 0.22% — pass (threshold 0.5%).
  qvec 348 cached / 0 fresh (frozen ruler intact).

## Movers — v3 13/174 net +0.73 (retrieval-only 12, net −0.27: the +161 wave)
- **v3-tempo-13 0.20 → 0.08 (−0.12) — NEW single-night watch**, the only mover
  beyond the ±0.04 churn class. Third tempo probe to slide this month
  (tempo-10 0.48→0.16 DECIDED REAL, tempo-11 now 0.04, tempo-15 0.20) —
  more evidence for the standing tempo_family hypothesis (Jake ask #4).
- v3-grd-05 0.00 → 1.00 — last night's parser flake recovered, as predicted.
- fam-15 0.28 → 0.36 (+0.08) — recovery to its pre-11-21 neighborhood.
- ±0.03–0.04 churn: leaf-20 0.76 / leaf-34 0.36 / leaf-30 0.32 / tempo-11 0.04 /
  tempo-15 0.20 / fdec-18 0.32 / vibe-ret-013 0.83 / vibe-ret-014 0.27 /
  leaf-45 0.84 / umb-05 0.40.
- Standing items all held: tempo-10 0.16 / leaf-41 1.00 / leaf-14 0.80 /
  fam-17 0.88 / leaf-29 0.48 / tempo-12 0.04 / vibe-prod-006 0.68 / leaf-12 0.52 /
  leaf-38 0.72 / tempo-16 0.20 / leaf-03 0.52 / leaf-33 0.68.

## Harness fix (this commit, score-neutral)
run_eval.py's v1 grounding now mirrors the 10-19 v3 diagnostic: a dropped call
records `no-LLM (call returned nothing)`, a bad reply records `unparseable
(reply was not JSON)` + a 400-char `raw_excerpt` in score_rows. No score math
touched; 48/48 harness tests pass. Evidence + fix noted in
PROPOSAL-grd16-fenced-json-parse.md (the parser decision itself remains
Jake's call — option (a) still recommended).

## Open Jake asks (order unchanged)
1. **gemma4 promotion pricing queue item — TOP ASK, STILL NOT QUEUED**: whole
   library staged on prompt v3 / gemma4:12b; NO `--promote-next` until the
   dual-run gate prices the candidate mood index.
2. grd-15 trap reword (apply-blocker; PROPOSAL-grd15-trap-staleness-colloquial-dance.md).
3. Fenced-JSON/tolerant-parse decision (PROPOSAL-grd16 — NEW evidence tonight:
   the class crossed to v1; v1 logging gap closed in this commit).
4. tempo_family 0.422 hypothesis (tempo-13 slid tonight; tempo-10 confirmation
   already folded in).
5. grd-12 legacy-tag + Plunderphonics vocab re-export.
