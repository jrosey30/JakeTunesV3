# Nightly brain-eval — 2026-11-24 (homemini, 03:05 launchd)

**Outcome: IDLE (39th) — baselines only, nothing applied, brain untouched.**
Queue: auto lane empty (E1 bare=0; E2 genre-tag churn 24/11,547 = 0.21%, need >1%),
jake lane empty → `pick` returned IDLE (ledger `picked` event 03:06:38).
The gemma4 promotion pricing item (TOP Jake ask) is STILL NOT QUEUED.

## Pre-flight
- brain-trainer (23:40 EST slot) finished 23:43:52 EST Nov 23: +32 enriched
  (small wave after yesterday's +161), brain 14,759/14,759, embeddings.bin
  14,980 vectors, mood-index 14,759 vectors, purity gate ok (0.8860 vs 0.8860,
  regression 0.0000 ≤ 0.02). NO mood prune tonight — clean; writer rule clean,
  no unlogged writes.
- NAS mtimes embeddings.bin / mood-index.bin both 23:43 (Nov 23 EST) — trainer
  slot, stable ≥3h before measurement. No post-02:30 writes.
- Snapshot `/tmp/brain-snap-20261124`, sha-verified pre/post on all 7 files
  (emb 6b8711e2473d, mood 6ab64231a006, library 9176536a475f = 14,759 tracks,
  + descriptors/artist-members/metadata-overrides/lyrics). No torn reads.
- End-of-run re-verify: NAS emb/mood shas UNCHANGED since snapshot.

## Scores (harness brain_id 6b8711e2473d / mood_id 6ab64231a006)
- **v1 (B1-20261124): retrieval 0.808 / grounding 1.000 / overall 0.904.**
  Sole mover: **grd-005 RECOVERED 0.00 → 1.00** (5 real tracks cited, clean
  parse) — last night's first-ever v1 flake was transient, exactly as the ×3
  forensic predicted (dropped call / transient API failure, not drift). With
  the new raw_excerpt persistence now live on v1, any future flake is
  diagnosable from the row. Retrieval probes IDENTICAL to last night
  (ret-011 held 0.48, ret-015 0.90, traps clean); routes 8 mood / 7 main
  unchanged.
- **v3 (B3-20261124): headline 0.777** — 21st night in the ~0.78 band. Primary
  source **bridge**; routes main 29 / mood 94 / mood+lexicon 1 /
  main+decade 30 — identical. v3 grounding **0.950 = grd-15 trap ONLY, zero
  parser flakes** (cited 3 on the trap; APPLY-BLOCKER stands). Flake tally
  unchanged: 6 nights / 4 probes / both rulers, all transient.
- Groups: artist 0.963 / umbrella 0.909 / leaf 0.840 / family_decade 0.877 /
  tempo_family 0.422 / vibe 0.651 — no group moved beyond churn.
- main-src 5afffcf4 = origin/main HEAD, unchanged — stability baseline held.
- vocab ruler_check 33/14,761 unresolved = 0.22% — pass (threshold 0.5%).

## Movers — v3 3/174 net −0.12 (second-quietest night on record)
All three are single-slot −0.04 churn, no new watches:
- v3-fdec-10 1.00 → 0.96 (first move; plain churn)
- v3-leaf-33 0.68 → 0.64 (already on the churn list, bounced 0.68 last night)
- v3-leaf-34 0.36 → 0.32 (already on the churn list)

## Watch: tempo-13 CLOSED (settled)
tempo-13 slid 0.20 → 0.08 on 11-23 and **HELD 0.08 tonight** — settled ×2 at
0.08, closing per the fam-17/leaf-14 precedent: re-center at 0.08, re-open if
it drops below 0.08. The underlying tempo_family gap (0.422, group floor-ish)
remains Jake ask #4 — this close does not resolve it, it just stops treating
a settled probe as news.

ALL other standing items held exactly: tempo-10 0.16 / leaf-41 1.00 /
leaf-14 0.80 / fam-17 0.88 / fam-15 0.36 / leaf-29 0.48 / tempo-12 0.04 /
vibe-prod-006 0.68 / leaf-12 0.52 / leaf-38 0.72 / tempo-16 0.20 /
leaf-03 0.52 / leaf-20 0.76 / leaf-30 0.32 / tempo-11 0.04 / tempo-15 0.20 /
fdec-18 0.32 / vibe-ret-013 0.83 / vibe-ret-014 0.27 / leaf-45 0.84 /
umb-05 0.40.

## Applied / rejected
Nothing applied, nothing rejected — IDLE night, no candidate was built.
Both rulers ran on the production path (bridge); the dual-run gate was not
invoked.

## Open Jake asks (order unchanged)
1. **gemma4 promotion pricing item — STILL NOT QUEUED** (whole library staged
   on gemma4:12b prompt v3; NO --promote-next until priced).
2. grd-15 trap reword (apply-blocker — keeps v3 grounding pinned at 0.950).
3. Fenced-json parser hardening (PROPOSAL-grd16; class has appeared on both
   rulers, logging gaps now closed on both).
4. tempo_family 0.422 (tempo-13 now settled at 0.08; the group needs a real
   idea, not a watch).
5. grd-12 legacy-tag + Plunderphonics vocab re-export.
