# Nightly brain-eval — 2026-11-02

**Outcome: IDLE (16th consecutive) — baselines only, nothing applied, live brain untouched by this job.**

## Pre-flight
- brain-trainer completed 02:03:42 EST (log 07:03:42Z): meaning catch-up 29, then +57 enriched
  (every add same-night). Brain now 12,364/12,364 tracks, embeddings.bin 12,555 vectors,
  mood-index 12,364 vectors, 107 orphan descriptors.
- Purity gate passed: candidate 0.9077 vs previous 0.9077, regression 0.0000. The level recovered
  from last night's 0.8878 back to the 0.907 band — consistent with the daytime-adds bounce pattern.
- Brain shas changed vs 11-01 — **fully accounted**: one **logged mood-index prune by the redescribe
  job at 00:00** (12,308 → 12,307, track id 13612, ledgered in brain-prune-ledger.jsonl, undo at
  `mood-index.bin.prune.bak`) plus trainer +57 (12,307 + 57 = 12,364 ✓; emb 12,498 + 57 = 12,555 ✓).
  No unlogged writer events.
- Snapshot `/tmp/brain-snap-20261102` sha-verified before/after copy (7/7 incl. aux: artist-members,
  metadata-overrides, lyrics); NAS stable ≥1h before copy and unchanged across the copy
  (emb `5c0854e1…`, mood `6366e075…`).
- Early-promotion tripwire clean: live emb/mood mtimes 02:03, before the 02:30 line.

## Baselines (snapshot, bridge = production path)
- **v1** (`B1-20261102`): retrieval **0.813** / grounding **1.000** / overall **0.906** — in the
  confirmed normal band (0.810–0.816 / 1.000 / 0.905–0.908, now ×19). Routes 8 mood / 7 main, unchanged.
- **v3** (`B3-20261102`): headline **0.796**, grounding **0.950** — one flake, **v3-grd-14
  unparseable**: raw_excerpt shows a correct-looking answer wrapped in a ```json fence (Sparta /
  Future Leaders of the World / Visitor Coach — plausible on-predicate cites), i.e. the EXACT
  transport/formatting failure diagnosed 10-22 and covered by PROPOSAL-grd16-fenced-json-parse.md.
  Not fabrication. Flake tally **7 of 19** (grd-16 ×3, grd-14 ×3, grd-12 ×1). Primary source bridge;
  routes identical 29 main / 94 mood / 1 mood+lexicon / 30 main+decade, zero per-probe route changes.
  - Groups: artist 0.963 · umbrella_family 0.913 · leaf 0.840 · family_decade 0.873 ·
    tempo_family **0.490** · vibe 0.695.
- Movers vs B3-20261101: **2/154** — v3-fdec-18 0.40→0.36 (−0.04), v3-leaf-24 0.92→0.96 (+0.04).
  Balanced add-churn, in-band; second-quietest night on record.
- Sentinels: vibe-prod-006 **held 0.68**; leaf-20 **held 0.88**.
- **tempo_family 0.490 — HELD second night** (the four-night slide stays paused). Still the top open
  quality item; a remedy needs a new Jake-approved hypothesis (tempo in mood text, or a bpm-aware
  rerank term).

## Queue
- `pick_experiment.py pick` → **IDLE**. E1 bare backlog = 0 (adds enriched same-night again);
  E2 genre-tag churn 22/11,550 = **0.19%** (needs >1%). Jake lane empty. Pick row in the ledger.

## Bridge / ruler
- main-src advanced fb354460 → **a86a8ff3** (PR #314: Recently Added/Played to 100, live Recently
  Played, TikTok/Bandcamp/Savant auto playlists). **Zero `src/main/ai` diff**; genre-vocab/iceberg
  untouched — vocab staleness unchanged (Plunderphonics + 2 legacy tags, in-run guard passes).
  The vocab re-export + ruler regen remains Jake's call.

## Redescribe job (observation only — not this job's lane)
- Full speed again: counter restarted at 0/**6,606 remaining** (was "1,350/8,971" at this hour
  last night — it drained ~2,365 on 11-01, the counter restates the remaining pool each run).
  1,000/6,606 by 02:58 EST, 1 fail, ~10.7s/track; only the one 2×2-minute yield pair while the
  trainer ran at 02:00. At this pace ≈ **3 more nights** to drain.
- Staged-only + the one logged window-start prune (above) — exactly the expected writer behavior.
- Gemma4 promotion still waits on Jake queueing it when staging completes; pre-flight watch unchanged
  (emb/mood mtimes after 02:30 = promotion ran early → stop; the 00:00 prune exempt with its log line).

## Open Jake items (unchanged)
grd-16/grd-14 fenced-JSON parser proposal (tonight's grd-14 is a third data point for it) ·
grd-12 legacy-tag re-tag (laptop overrides) · tempo_family hypothesis · gemma4 promotion queue
item · Plunderphonics vocab re-export.

Applied: **nothing**. Rejected: n/a (no item ran).
