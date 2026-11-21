# Nightly brain-eval — 2026-11-21 (homemini, 03:05 launchd)

**Outcome: IDLE (36th) — baselines only, nothing applied, brain untouched.**
Queue: auto lane empty (E1 bare=0; E2 genre-tag churn 24/11,547 = 0.21%, need >1%),
jake lane empty → `pick` returned IDLE (ledger `picked` event 03:07:17).

## Pre-flight
- brain-trainer (23:40 EST slot) finished 23:48:17 EST: +114 enriched, brain
  14,457/14,457, embeddings.bin 14,677 vectors, mood-index 14,457 vectors, purity
  gate ok (0.8592 vs 0.8600, regression 0.0009 ≤ 0.02). Mood prune −1 (id 13540)
  **LOGGED** in brain-prune-ledger.jsonl — normal trainer-time write, writer rule clean.
- NAS mtimes embeddings.bin / mood-index.bin = Nov 20 23:48 — the rescheduled-trainer
  pattern, stable ≥3h before measurement. No post-02:30 writes.
- **REDESCRIBE PASS COMPLETE.** The 1,831-track backlog finished 11-20 04:30 EST
  (1831/1831, 0 fails), and tonight's run staged the 114 new adds too (00:18 EST,
  114/114, 0 fails) — all of it in `brain-descriptors.next-v3.json` only, no brain
  race. The trainer log now says: "Next: --mood-candidate, score it, then
  --promote-next." **The entire library is now staged for the gemma4:12b descriptor
  upgrade — the gemma4 promotion PRICING queue item (Jake ask #2, STILL NOT QUEUED)
  is now the live blocker: nothing should --promote-next until the dual-run gate
  prices the candidate mood index.** Escalating this ask above grd-15 in urgency
  ordering tonight (grd-15 blocks applies; the unpriced promotion risks an ungated
  brain swap, which is worse).
- Snapshot `/tmp/brain-snap-20261121`, sha-verified pre/post on all 7 files
  (emb 604dde4e8320, mood 62ef517f4b8b, library 83e6c2d177d6 = 14,457 tracks,
  + descriptors/artist-members/metadata-overrides/lyrics). No torn reads.
- End-of-run re-verify: NAS emb/mood shas and mtimes UNCHANGED since snapshot.

## Scores (harness brain_id 10541a5bea1f / mood_id 7cd792bb5c1d)
- **v1 (B1-20261121): retrieval 0.811 / grounding 1.000 / overall 0.906** —
  numerically identical **7th** night running (zero v1 movers; ret-015 held 0.90;
  all traps clean). Routes 8 mood / 7 main, unchanged.
- **v3 (B3-20261121): headline 0.781** — 18th night in the ~0.78 band. Primary
  source **bridge**; routes main 29 / mood 94 / mood+lexicon 1 / main+decade 30 —
  identical to 11-20.
- v3 grounding **0.950 = grd-15 trap ONLY** (deterministic colloquial-dance, cited 3).
  Zero parser flakes tonight → flake tally stays 16/36. APPLY-BLOCKER stands until
  Jake rewords the ruler (PROPOSAL-grd15-trap-staleness-colloquial-dance.md).
- Groups: artist 0.963 / umbrella 0.904 / leaf 0.843 / family_decade 0.880 /
  tempo_family 0.435 / vibe 0.658.
- main-src moved 89ebbf02 → **ae4e0969** — expected catch-up (11-20's report noted
  origin/main was already at ae4e0969). v1 numerically identical + routes identical
  on both rulers ⇒ retrieval-inert code motion. ae4e0969 = new stability baseline.
- vocab stale 24/11,547 = 0.21% — pass (threshold 0.5%).

## Movers 9/174 (net +0.39) — the +114 add wave landed WELL
- **v3-leaf-41 (Singer-Songwriter) WATCH CLEARED: 0.64 → 1.00** — full recovery,
  above its old standing level (0.72). The 11-20 drop was add-wave churn, and
  tonight's wave actually improved the probe. Standing watch item CLOSED at 1.00
  (re-open only if it falls below 0.72 again).
- **v3-leaf-14 (Disco House) held 0.80** (2nd night at 0.80 after 0.88) — reads as
  a settled re-center, not decay. Watch CLOSED as churn re-center; new level 0.80.
- **v3-tempo-10 0.20 → 0.16** — continues the already-DECIDED-REAL slide
  (0.48 → 0.24 → 0.20 → 0.16). Further confirmation for the tempo_family ask (#4);
  no new watch (item already adjudicated and folded in).
- v3-fam-17 0.96 → 0.88 — NEW single-night watch (umbrella_family).
- v3-leaf-02 0.48 → 0.44; v3-leaf-16 0.28 → 0.32; v3-leaf-33 0.64 → 0.68 (standing
  item ticked UP — level now 0.68); v3-leaf-49 0.96 → 1.00; v3-fam-15 0.24 → 0.28;
  v3-vibe-ret-014 0.27 → 0.30 (±0.04 churn).
- All other standing watch items held exactly: leaf-29 0.48 / tempo-12 0.04 /
  vibe-prod-006 0.68 / leaf-12 0.52 / leaf-38 0.72 / fdec-18 0.36 / tempo-16 0.20 /
  leaf-03 0.52 / leaf-34 0.40 / leaf-45 0.80.

## Open Jake asks (reordered tonight)
1. **gemma4 promotion pricing queue item — NOW THE TOP ASK** (was #2): the whole
   library is staged on prompt v3 / gemma4:12b and the trainer's own log is
   prompting toward `--promote-next`. Queue the pricing item (build
   `--mood-candidate` as a /tmp candidate, dual-run gate.py prices it) BEFORE any
   promotion. Until then: do not run `--promote-next`.
2. grd-15 trap reword (apply-blocker; PROPOSAL-grd15-trap-staleness-colloquial-dance.md).
3. fenced-json parser proposal (PROPOSAL-grd16-fenced-json-parse.md) — no new
   evidence (zero flakes tonight).
4. tempo_family 0.435 hypothesis (carries tempo-10, which slid again tonight).
5. grd-12 legacy-tag + Plunderphonics vocab re-export.

## Hygiene
- Worktree `/tmp/jt-braineval-20261121` from origin/brain-eval (b4fb4863), removed
  after push. Snapshot kept in /tmp as day-of forensics.
- Foreground rule held (36th run since 10-15): every command ran to completion in
  this session; no background processes.
