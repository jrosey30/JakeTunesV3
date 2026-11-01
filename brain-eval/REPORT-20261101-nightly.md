# Nightly brain-eval — 2026-11-01

**Outcome: IDLE (15th consecutive) — baselines only, nothing applied, live brain untouched by this job.**

## Pre-flight
- brain-trainer completed 02:01:37 EST (DST fall-back night; log 07:01:37Z): +25 enriched (every add
  same-night, no meaning catch-up line tonight). Brain now 12,308/12,308 tracks, embeddings.bin
  12,498 vectors, mood-index 12,308 vectors.
- Purity gate passed: candidate 0.8878 vs previous 0.8868, regression −0.0010 (an improvement).
  Note the LEVEL moved 0.9068 → ~0.887 between nights — consistent with the +24 daytime adds landing
  un-enriched before the trainer ran (the level has bounced in this band before: 0.8989 → 0.9068 → 0.8878);
  gate healthy, not a flag.
- Brain shas changed vs 10-31 — **fully accounted**: one **logged mood-index prune by the redescribe
  job at 00:00** (12,284 → 12,283, track id 13584, ledgered in brain-prune-ledger.jsonl, undo at
  `mood-index.bin.prune.bak`) plus trainer +25 (12,283 + 25 = 12,308 ✓; emb 12,473 + 25 = 12,498 ✓).
  No unlogged writer events.
- Snapshot `/tmp/brain-snap-20261101` sha-verified before/after copy (7/7 incl. aux: artist-members,
  metadata-overrides, lyrics); NAS stable during copy and **unchanged end-to-end**
  (emb `ea21bfa2…`, mood `40bee336…` identical at measurement and at session end).
- Early-promotion tripwire clean: live emb/mood mtimes 02:01, before the 02:30 line.
- One transient network blip: the first v3 run died mid-grounding on `No route to host` to the
  Claude API (no partial rows written); connectivity returned within a minute, clean retry succeeded.

## Baselines (snapshot, bridge = production path)
- **v1** (`B1-20261101`): retrieval **0.813** / grounding **1.000** / overall **0.906** — in the
  confirmed normal band (0.810–0.816 / 1.000 / 0.905–0.908, now ×18). Routes 8 mood / 7 main, unchanged.
- **v3** (`B3-20261101`): headline **0.796**, **grounding 1.000 (20/20) — second consecutive fully
  clean night** (flake tally stays 6 of 18). Primary source bridge; routes identical
  29 main / 94 mood / 1 mood+lexicon / 30 main+decade, zero per-probe route changes.
  - Groups: artist 0.963 · umbrella_family 0.913 · leaf 0.839 · family_decade 0.875 ·
    tempo_family **0.490** · vibe 0.695.
- Movers vs B3-20261031: **ZERO — 0/174 probes moved.** The +25 adds landed outside every probe's
  top-k. Quietest night on record.
- Sentinels: vibe-prod-006 **held 0.68**; leaf-20 **held 0.88**.
- **tempo_family 0.490 — HELD. The four-night slide (0.507 → 0.497 → 0.495 → 0.490) did NOT
  continue**; tempo-13 flat 0.28, tempo-15 flat 0.20. Still the top open quality item (a remedy
  needs a new Jake-approved hypothesis: tempo in mood text, or a bpm-aware rerank term), but the
  directional pressure paused tonight.

## Queue
- `pick_experiment.py pick` → **IDLE**. E1 bare backlog = 0 (adds enriched same-night again);
  E2 genre-tag churn 22/11,550 = **0.19%** (needs >1%). Jake lane empty. Pick row in the ledger.

## Bridge / ruler
- main-src advanced b49da6c0 → **fb354460** (PRs #311–#313: import blank-disc tag, audio-log unload
  placeholder, seam shared-state snapshot). **Zero `src/main/ai` diff**; genre-vocab/iceberg untouched —
  vocab staleness unchanged (Plunderphonics + 2 legacy tags, in-run guard passes). The vocab
  re-export + ruler regen remains Jake's call.

## Redescribe job (observation only — not this job's lane)
- **Running at FULL SPEED tonight** — no overnight streaming, so no yield loops (only the one
  2-minute yield while the trainer ran at 02:00). 1,350/8,971 done by 03:00 EST, 0 fails,
  ~10.7s/track. At this pace a window drains ~1,700–2,000 tracks/night → roughly **4–5 more nights**
  to finish, vs the ~61h readout from last night's streaming-throttled run. The 10-31 throughput
  flag eases if this holds; no decision needed from Jake yet.
- Staged-only + the one logged window-start prune (above) — exactly the expected writer behavior.
- Gemma4 promotion still waits on Jake queueing it when staging completes; pre-flight watch unchanged
  (emb/mood mtimes after 02:30 = promotion ran early → stop; the 00:00 prune exempt with its log line).

## Open Jake items (unchanged)
grd-16 fenced-JSON parser proposal · grd-12 legacy-tag re-tag (laptop overrides) · tempo_family
hypothesis (pressure paused tonight but trend intact) · gemma4 promotion queue item ·
Plunderphonics vocab re-export.

Applied: **nothing**. Rejected: n/a (no item ran).
