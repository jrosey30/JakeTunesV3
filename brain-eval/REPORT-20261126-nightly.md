# Nightly brain-eval — 2026-11-26 (homemini)

**Outcome: IDLE (41st consecutive) — baselines only, nothing applied, brain untouched.**

## Pre-flight
- brain-trainer finished 23:42 EST (log dated 2026-11-26T04:42Z): +2 enriched, brain now
  14,789/14,789; purity gate 0.8809 vs 0.8809, regression 0.0000; mood-index +2 (14,789 total).
  No prune. embeddings.bin/mood-index.bin mtimes 23:41/23:42 — well before the 02:30
  early-promotion cutoff; stable >3 h before measurement.
- Snapshot `/tmp/brain-snap-20261126` (7 files incl. artist-members / metadata-overrides /
  lyrics), sha-verified against NAS before AND after copy:
  - embeddings.bin `e568ff1b36f8` (15,010 vectors)
  - mood-index.bin `ddbcc4af067e` (14,789 vectors)
  - library.json `0ae26ea22785` (14,789 tracks)
- Worktree `/tmp/jt-braineval-20261126` from origin/brain-eval (147ff577), .env copied.

## Pick
`pick_experiment.py pick` → **IDLE** — E1 bare mood vectors = 0; E2 genre-tag churn
24/11,545 = 0.21% (need >1%). Queue remains fully drained both lanes. Ledger 'picked'
event committed.

## v1 (B1-20261126)
**retrieval 0.808 / grounding 1.000 / overall 0.904** — exact recent normals.
- Sole mover vs 11-25: **grd-005 recovered 0→1** — confirms last night's flake was the
  proven transient double-emission/truncation parser class (PROPOSAL-grd16), not drift.
  Zero flakes tonight; flake tally stays 7 nights / 4 probes / both rulers, all parser/API,
  zero fabrication.
- Retrieval probes IDENTICAL to 11-25 (ret-011 0.48, ret-015 0.90, traps clean). Routes 8/7.

## v3 (B3-20261126)
**headline 0.779** (23rd consecutive night ~0.78); **grounding 0.950 = grd-15 trap only**
(cited 3 on the colloquial-dance trap — the known apply-blocker, Jake ask #2); zero v3
parser flakes. Primary source **bridge**; routes identical 29/94/1/30.
- Groups: artist 0.963 / umbrella 0.909 / leaf 0.841 / family_decade 0.877 /
  tempo_family 0.427 / vibe 0.658.
- Movers vs 11-25: **1/174, net +0.04** — quietest night on record:
  v3-leaf-20 0.76→0.80 (single slot, inside its known ±0.04 churn band).
- tempo-13 HELD 0.08 (watch stays CLOSED; re-open <0.08). tempo_family 0.427 gap remains
  Jake ask #4.

## main-src benign-check
origin/main advanced **e8597fdd → 46aaf42e** (genres The-sort + sidebar-order merges).
Benign: routes identical on both rulers (8/7 and 29/94/1/30), every retrieval probe
identical except the leaf-20 single-slot churn. **46aaf42e = new stability baseline.**

## Applied / rejected
Nothing applied, nothing rejected — IDLE night, no candidate built, NAS brain bytes
untouched (sha re-verified unchanged at end of run).

## Standing Jake asks (unchanged order)
1. gemma4 promotion pricing item — **STILL NOT QUEUED (TOP ask)**
2. grd-15 trap reword (apply-blocker)
3. fenced-json parser fix (root cause PROVEN 11-25; raw_decode recommendation in
   PROPOSAL-grd16)
4. tempo_family 0.427
5. grd-12 legacy-tag + Plunderphonics vocab re-export
