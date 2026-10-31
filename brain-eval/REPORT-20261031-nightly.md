# Nightly brain-eval — 2026-10-31

**Outcome: IDLE (14th consecutive) — baselines only, nothing applied, live brain untouched by this job.**

## Pre-flight
- brain-trainer completed 02:03:59 EDT: +74 enriched (every add same-night), meaning catch-up 15,
  purity gate passed (0.9068 vs 0.9068, regression 0.0000 ≤ 0.02). Brain now 12,284/12,284 tracks,
  embeddings.bin 12,473 vectors, mood-index 12,284 vectors (headers verified against logs).
- Brain shas changed vs 10-30 — **fully accounted**: trainer (+74 adds, 15 meaning re-embeds) plus one
  **logged mood-index prune by the redescribe job at 00:00 EDT** (12,212 → 12,210, two departed tracks,
  undo at `mood-index.bin.prune.bak`; 12,210 + 74 = 12,284 ✓). Not an unlogged writer event, but note:
  the redescribe job is now a second (logged, same-binary) mood-index writer at window start.
- Snapshot `/tmp/brain-snap-20261031` sha-verified before/after copy; NAS stable during copy and
  **unchanged end-to-end** (emb `881f5a15…`, mood `56df4a31…` identical at measurement and at session end).
- Early-promotion tripwire clean: live emb/mood mtimes 02:03, before the 02:30 line.

## Baselines (snapshot, bridge = production path)
- **v1** (`B1-20261031`): retrieval **0.813** / grounding **1.000** / overall **0.906** — in the
  confirmed normal band (0.810–0.816 / 1.000 / 0.905–0.908, now ×17). Routes 8 mood / 7 main, unchanged.
- **v3** (`B3-20261031`): headline **0.796**, **grounding 1.000 (20/20) — fully clean, no flake**
  (flake tally stays 6 of 17 nights). Primary source bridge; routes identical 29 main / 94 mood /
  1 mood+lexicon / 30 main+decade.
  - Groups: artist 0.963 · umbrella_family 0.913 · leaf 0.839 · family_decade 0.875 ·
    tempo_family **0.490** · vibe 0.695.
- Movers vs B3-20261030: **13/174** — 12 retrieval probes all ±0.04 (fdec-24 +0.12), balanced 8 up / 5 down,
  classic add-churn from +74 adds; plus grd-12 0→1 (consistent with its 10-30 diagnosis: a data-artifact
  flake that fires only when the model happens to cite the legacy-tagged track). Zero route changes.
- Sentinels: vibe-prod-006 **held 0.68**; leaf-20 **held 0.88**.
- **tempo_family 0.495 → 0.490 — FOURTH consecutive add-night drop** (0.507 → 0.497 → 0.495 → 0.490),
  from tempo-13 (0.32→0.28) and tempo-15 (0.24→0.20). Clearly directional. Still NO queued remedy —
  a fix needs a new Jake-approved hypothesis (tempo in mood text, or a bpm-aware rerank term).
  This is now the top open quality item.

## Queue
- `pick_experiment.py pick` → **IDLE**. E1 bare backlog = 0 (adds enriched same-night again);
  E2 genre-tag churn 22/11,550 = **0.19%** (needs >1%). Jake lane empty. Ledger row recorded.

## Bridge / ruler
- main-src advanced 3de5c49 → **b49da6c0** (PRs #302–#310: album credits/personnel, jewel case,
  pause-for-calls, install gate). **Zero `src/main/ai` diff**; genre-vocab/iceberg untouched —
  vocab staleness unchanged from 10-30 (Plunderphonics + 2 legacy tags, in-run guard passes at ~0.27%).
  The vocab re-export + ruler regen remains Jake's call.

## Redescribe job (observation only — not this job's lane)
- **Staged-only confirmed**: all writes to `brain-descriptors.next.json` (mtime moving through the
  session); live descriptors/emb untouched after the trainer (the 00:00 mood prune above is its only
  live write, logged with an undo copy).
- **Campaign reset to prompt v2 / gemma4:12b**: tonight's window opened with "10,160 track(s) need
  gemma4:12b descriptors from prompt v2 (1,288 staged by an older prompt go first)". The staged count
  holding at 3,399 vs 10-30 is the old-prompt redo overwriting entries in place, not a stall bug.
- **Throughput flag for Jake**: music streamed through the backend from ~01:39 EDT onward and the job
  yields (model unloaded, 2-min recheck) whenever that's true — 54 yield loops tonight, only ~450 tracks
  done, pace readout inflated to ~61h. If overnight streaming is now routine, the 00:00–06:00 window
  (final PR #295 state; the 08:15 end was reverted in-branch by 310a116) will take weeks to drain.
  Options are Jake's: widen the window, relax the yield rule, or accept the pace.
- Gemma4 promotion still waits on Jake queueing it when staging completes; pre-flight watch unchanged
  (emb/mood mtimes after 02:30 = promotion ran early → stop).

## Open Jake items (unchanged)
grd-16 fenced-JSON parser proposal · grd-12 legacy-tag re-tag (laptop overrides) · tempo_family
directional drop (no hypothesis queued) · gemma4 promotion queue item · Plunderphonics vocab re-export.

Applied: **nothing**. Rejected: n/a (no item ran).
