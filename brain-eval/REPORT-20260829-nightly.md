# Nightly brain exercise — 2026-08-29 (~03:05)

## Outcome: (a) PROVEN IMPROVEMENT APPLIED — 8th-clobber repair, strict bars PASS
Router-truth 0.756 → **0.833** (meets the ≥0.83 post-repair band strictly —
no precedent-based judgment needed tonight, unlike 08-24/26/28). Worst
per-probe candidate-vs-current mood delta **+0.00** (no regression anywhere,
including ret-015 — the recurring Angel Du$t artifact did NOT fire this
time, 0.80→0.80). Live index back to **0 orphans / 0 dup groups**.

## Pipeline state (all green)
- brain-trainer: clean launchd run 06:00:06–06:01:44Z; +50 enriched, brain
  9801/9806, embeddings.bin 9929 vecs, mood-index 9928. No ETIMEDOUT, no
  TCC wedge — both watches stay clear.
- Import day: library 9,791 → **9,806 (+15)** → clobber expected and found.
- Brain files mtime-stable 65 min before snapshot; snapshot
  /tmp/brain-snap-20260829 sha-verified against live (embeddings af736587…,
  mood-index 24f5245a…) before measuring; re-verified unchanged at apply.
- Session pickup: the stranded 08-23 descriptor-upgrade diff on
  `scripts/brain-trainer.mjs` (GEMMA_MODEL override + --redescribe-all) was
  STILL uncommitted in the main repo — committed verbatim as **753e46c** on
  `feat/listen-to-the-list` (it has been the production trainer for 6 nights).

## Pre-check (standard, before paid measurement)
mood-index: **orphans=122, dup_groups=62 (393 tracks)** — healthy is 0/≤1.
8th clobber event, eight-for-eight on import days.

## Recipe (repair_20260829.py, read-only phase)
- Reconstruction (mood_texts_reconstruct.mjs on tonight's committed trainer):
  9,806 rows; overrides line `applied 9768, skipped 38 stale` byte-identical
  to tonight's trainer log.
- **Fidelity gate: 50/50 trainer-fresh vectors ≥0.98 (min cos 0.9996).**
- 970 suspects re-embedded from intended text (median cos 0.813), 0 excluded
  by the tempo-view rule, 122 orphans pruned → candidate 9,806 vecs.

## Prove (frozen 15-probe ruler, production-router emulation)
- router-truth: current 0.756 → candidate **0.833** (+0.077)
- Biggest per-probe gains: ret-012 0.30→1.00, ret-007 0.52→1.00,
  ret-004 0.00→0.50, ret-011 0.48→0.88, ret-006 0.16→0.48.
- Worst per-probe delta +0.00. **BARS: PASS** (strict — rt ≥0.83 AND no
  mood-probe regression).

## Applied (apply_20260829.py — gated, backed up, atomic)
- Pre-apply gates passed: live mood-index sha 24f5245aeae4 = measured
  snapshot; embeddings.bin size 61043504 / mtime 1787983300 unchanged.
- **Backup:** `mood-index.bin.pre-repair-20260829` (sha-verified 24f5245aeae4)
- Applied via temp + atomic rename; round-trip verified
  (sha 1b8bb90b0083, 9,806 vecs, dim 1536).
- **Post-apply live health: 0 orphans, 0 dup groups.**
- **Undo:** `cp /Volumes/JakeShared/JakeTunesState/mood-index.bin.pre-repair-20260829
  /Volumes/JakeShared/JakeTunesState/mood-index.bin`

## run_eval — GROUNDING IS BACK (Jake topped up the Anthropic key)
1-token probe returned 200 before spending; full eval run post-apply:
- retrieval **0.748** (mechanical, in the recent 0.748–0.757 band; this eval
  scores the identity-heavy path and is blind to the mood repair — see the
  P1 router-aware-eval proposal)
- grounding **1.000** (10/10 incl. all 4 traps) — first real grounding
  reading since 08-26; the 08-27/08-28 0.000 rows are confirmed billing
  artifacts, ignore them.
- overall **0.874** · one row appended to score_log.jsonl.

## Counters / watch
- Clobber events: **8** (recurrence log updated in the proposal). Root-cause
  fix (drop mood-index from autoBackupStateToNas + fix the app's local copy)
  remains the TOP ask — every import day costs ~$0.15 of re-embeds and a day
  of degraded mood routing until repaired.
- Skips: **718/1000** (signal stays closed until ~1k).
- ETIMEDOUT + TCC watches: CLEARED (2nd consecutive clean launchd night).
- embeddings.bin untouched. No experiments beyond the proven recipe tonight.
