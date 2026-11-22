# Nightly brain-eval — 2026-11-22 (homemini, 03:05 launchd)

**Outcome: IDLE (37th) — baselines only, nothing applied, brain untouched.**
Queue: auto lane empty (E1 bare=0; E2 genre-tag churn 24/11,547 = 0.21%, need >1%),
jake lane empty → `pick` returned IDLE (ledger `picked` event 03:08:06).
The gemma4 promotion pricing item (TOP Jake ask) is STILL NOT QUEUED.

## Pre-flight
- brain-trainer (23:40 EST slot) finished 23:48:16 EST: +110 enriched, brain
  14,567/14,567, embeddings.bin 14,787 vectors, mood-index 14,567 vectors, purity
  gate ok (0.8969 vs 0.8969, regression 0.0000 ≤ 0.02). NO mood-prune line tonight
  (nothing removed — writer rule clean, no unlogged writes).
- NAS mtimes embeddings.bin 23:48:03 / mood-index.bin 23:48:16 (Nov 21 EST) —
  trainer slot, stable ≥3h before measurement. No post-02:30 writes.
- Redescribe job staged tonight's adds into `.next-v3.json` only (no brain race);
  the full library remains staged on gemma4:12b prompt v3 awaiting the PRICING
  item before any `--promote-next`.
- Snapshot `/tmp/brain-snap-20261122`, sha-verified pre/post on all 7 files
  (emb acef1e510a0a, mood 73b5c8f700bb, library 121145cfba94 = 14,567 tracks,
  + descriptors/artist-members/metadata-overrides/lyrics). No torn reads.
- End-of-run re-verify: NAS emb/mood shas and mtimes UNCHANGED since snapshot.

## Scores (harness brain_id acef1e510a0a / mood_id 73b5c8f700bb)
- **v1 (B1-20261122): retrieval 0.811 / grounding 1.000 / overall 0.906** —
  numerically identical **8th** night running (zero v1 movers; ret-015 held 0.90;
  all traps clean). Routes 8 mood / 7 main, unchanged.
- **v3 (B3-20261122): headline 0.780** — 19th night in the ~0.78 band. Primary
  source **bridge**; routes main 29 / mood 94 / mood+lexicon 1 / main+decade 30 —
  identical to 11-21.
- v3 grounding **0.900 = grd-15 trap + a grd-05 PARSER FLAKE** (first flake since
  10-24; tally now 5 flake nights). Forensic (read-only, from raw_excerpt): grd-05
  ("Which Van Halen tracks do I have?") returned CORRECT, valid JSON citing 5
  tracks — wrapped in ```json fences, which `parse_json_obj` rejects. All 5 cited
  tracks verified real + on-predicate against library.json (106 VH tracks), so the
  true grounding tonight is **0.950 = grd-15 trap only**, same as the standing
  state. Evidence appended to PROPOSAL-grd16-fenced-json-parse.md: a THIRD probe
  has now joined the class. grd-15 APPLY-BLOCKER stands.
- Groups: artist 0.963 / umbrella 0.902 / leaf 0.843 / family_decade 0.880 /
  tempo_family 0.435 / vibe 0.658 — all within single-slot churn of 11-21.
- main-src moved ae4e0969 → **5afffcf4** = origin/main HEAD (PR #469, iPod sync
  fix — nothing near retrieval); verified descendant of ae4e0969. v1 numerically
  identical + routes identical both rulers ⇒ retrieval-inert. 5afffcf4 = new
  stability baseline.
- vocab ruler_check 33/14,567 unresolved = 0.23% — pass (threshold 0.5%).

## Movers 1/174 (net −0.04) — quietest night on record
- v3-umb-02 1.00 → 0.96 — single-slot churn (±0.04 class), no watch opened.
- **v3-fam-17 watch CLOSED**: held 0.88 a 2nd night after the 11-21 drop from
  0.96 — settled re-center, same pattern as leaf-14. New level 0.88; re-open
  only if it falls below 0.88.
- Everything else identical, including all standing items: leaf-41 1.00 /
  leaf-14 0.80 / tempo-10 0.16 (no further slide) / leaf-29 0.48 / tempo-12 0.04 /
  vibe-prod-006 0.68 / leaf-12 0.52 / leaf-38 0.72 / fdec-18 0.36 / tempo-16 0.20 /
  leaf-03 0.52 / leaf-34 0.40 / leaf-45 0.80 / leaf-33 0.68.

## Open Jake asks (order unchanged from 11-21)
1. **gemma4 promotion pricing queue item — TOP ASK, STILL NOT QUEUED**: the whole
   library is staged on prompt v3 / gemma4:12b; nothing should `--promote-next`
   until the dual-run gate prices the candidate mood index.
2. grd-15 trap reword (apply-blocker; PROPOSAL-grd15-trap-staleness-colloquial-dance.md).
3. fenced-json parser proposal (PROPOSAL-grd16-fenced-json-parse.md) — **NEW
   EVIDENCE tonight**: grd-05 joined the flake class (3 probes, 5 nights).
4. tempo_family 0.435 hypothesis (tempo-10 held 0.16 tonight, no further slide).
5. grd-12 legacy-tag + Plunderphonics vocab re-export.

## Hygiene
- Worktree `/tmp/jt-braineval-20261122` from origin/brain-eval (f00cd6a4), removed
  after push. Snapshot kept in /tmp as day-of forensics.
- Foreground rule held (37th run since 10-15): every command ran to completion in
  this session; no background processes.
