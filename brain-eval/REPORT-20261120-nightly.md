# Nightly brain-eval — 2026-11-20 (homemini, 03:05 launchd)

**Outcome: IDLE (35th) — baselines only, nothing applied, brain untouched.**
Queue: auto lane empty (E1 bare=0; E2 genre-tag churn 24/11,547 = 0.21%, need >1%),
jake lane empty → `pick` returned IDLE (ledger `picked` event 03:09:50).

## Pre-flight
- brain-trainer (rescheduled 23:40 EST slot) finished 23:46:49 EST: +41 enriched,
  brain 14,344/14,344, embeddings.bin 14,563 vectors, mood-index 14,344 vectors,
  purity gate ok (0.8715, regression 0.0000). Mood prune −3 (ids 13589/13903/13966)
  **LOGGED** in brain-prune-ledger.jsonl — normal trainer-time write, writer rule clean.
- NAS mtimes embeddings.bin / mood-index.bin = Nov 19 23:46 — matches the
  rescheduled-trainer pattern, stable ≥3h before measurement. No post-02:30 writes.
- Redescribe pass mid-run during the session (1,200/1,831, 0 fails, ~9.1s/track,
  ~1.6h left at 03:02 EST) — writes only `.next*.json`, no brain race. NOTE: the
  denominator moved 4,093 → 1,831 since 11-19 (pass progressed/renumbered; 0 fails).
- Snapshot `/tmp/brain-snap-20261120`, sha-verified pre/post on all 7 files
  (emb c17753db423d, mood 709688c2e5e4, library 491fd8856b61 = 14,344 tracks,
  + descriptors/artist-members/metadata-overrides/lyrics).
- End-of-run re-verify: NAS emb/mood shas and mtimes UNCHANGED since snapshot.

## Scores (harness brain_id a17422684e6d / mood_id 3487cca4a0e2)
- **v1 (B1-20261120): retrieval 0.811 / grounding 1.000 / overall 0.906** —
  numerically identical 6th night running (zero v1 movers; ret-015 held 0.90; all
  traps clean). Routes 8 mood / 7 main, unchanged.
- **v3 (B3-20261120): headline 0.779** — 17th night in the ~0.78 band
  (re-center confirmed). Primary source **bridge**; routes main 29 / mood 94 /
  mood+lexicon 1 / main+decade 30 — identical to 11-19.
- v3 grounding **0.950 = grd-15 trap ONLY** (deterministic colloquial-dance, cited 3).
  Zero parser flakes tonight → flake tally stays 16/35. APPLY-BLOCKER stands until
  Jake rewords the ruler (PROPOSAL-grd15-trap-staleness-colloquial-dance.md).
- Groups: artist 0.963 / umbrella 0.907 / leaf 0.834 / family_decade 0.880 /
  tempo_family 0.438 / vibe 0.655.
- main-src moved 6d5e8ce8 → **89ebbf02** (origin/main advanced, PR #436 lineage;
  89ebbf02 is a descendant of 6d5e8ce8). v1 numerically identical + routes identical
  on both rulers ⇒ retrieval-inert code motion. 89ebbf02 = new stability baseline.
  (origin/main is already further at ae4e0969; the bridge used the local checkout.)

## Movers 5/174 (net −0.20) — small reshuffle from the +41 add wave
- **v3-tempo-10 WATCH DECIDED: REAL, not churn.** 0.48 (11-18) → 0.24 (11-19) →
  **0.20 tonight** — no recovery after the +146 country/folk wave reshuffled the
  mood top-25 ("slow, mellow country and folk songs", family + bpm≤85, expected ~46).
  Watch CLOSED with verdict: real regression, folded into the standing
  **tempo_family open quality item** (0.438 group mean — still the top gap; needs a
  Jake-approved hypothesis: tempo in mood text, or bpm-aware rerank). No queue item
  opened per the one-item rule.
- v3-leaf-14 (Disco House) 0.88 → 0.80 — new, single-night, watch.
- v3-leaf-41 (Singer-Songwriter) 0.72 → 0.64 — standing watch item's first move;
  new watch level 0.64.
- v3-leaf-34 0.44 → 0.40; v3-leaf-45 0.76 → 0.80 (±0.04 churn).
- All other standing watch items held exactly: leaf-33 0.64 / leaf-29 0.48 /
  tempo-12 0.04 / vibe-prod-006 0.68 / leaf-12 0.52 / leaf-38 0.72 / fdec-18 0.36 /
  tempo-16 0.20 / leaf-03 0.52 / fdec-02 1.00 / fdec-03 0.52 / tempo-01 0.76.

## Applied / rejected
Nothing applied, nothing rejected — IDLE. Brain files untouched (verified by sha).

## Open Jake asks (unchanged order)
1. grd-15 trap reword (apply-blocker).
2. gemma4 promotion PRICING queue item — still not queued; queue it before any
   `--promote-next` so the dual-run gate prices the gemma4 mood index first.
3. Fenced-json parser proposal (grd-16 et al.) — no new evidence tonight.
4. tempo_family 0.44 hypothesis (now carries the tempo-10 confirmation).
5. grd-12 legacy-tag proposal; Plunderphonics vocab re-export (stale 0.21%, pass).
