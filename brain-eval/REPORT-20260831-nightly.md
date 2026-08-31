# Nightly brain exercise — 2026-08-31 (~03:05)

## Outcome: (a) PROVEN IMPROVEMENT APPLIED — 10th-clobber repair, strict bars PASS
Router-truth 0.738 → **0.833** (+0.095, meets the ≥0.83 post-repair band
strictly). Worst per-probe candidate-vs-current mood delta **+0.00** (no
regression anywhere; the recurring ret-015 Angel Du$t artifact did NOT fire —
0.73→0.80, an improvement). Live index back to **0 orphans / 0 dup groups**.
Third consecutive night needing no bar adjudication.

## Pipeline state (all green)
- brain-trainer: clean launchd run 06:00:07–06:00:46Z; +14 enriched
  (import day: library 9,838 → **9,852**). Enrichment stays complete
  (9,852/9,852). embeddings.bin 9,975 vecs. No ETIMEDOUT, no TCC wedge
  (4th consecutive clean launchd night).
- Brain files mtime-stable ~64 min before snapshot; snapshot
  /tmp/brain-snap-20260831 sha-verified ×3 against live before copy AND
  copy-verified (embeddings a7f52ab5822f, mood-index 05da172d1b1b);
  re-verified unchanged at apply (mood sha exact + embeddings size
  61326312 / mtime 1788156043 gates passed).
- Anthropic key probed with 1 token (200) BEFORE the paid grounding run.

## Pre-check (standard, before paid measurement)
mood-index: **orphans=122, dup_groups=61 (391 tracks)** — healthy is 0/0.
10th clobber event, ten-for-ten on import days.

## Recipe (repair_20260831.py, read-only phase)
- Reconstruction (mood_texts_reconstruct.mjs on the committed production
  trainer 753e46c): 9,852 rows; overrides line `applied 9811, skipped 38
  stale` byte-identical to tonight's trainer log.
- **Fidelity gate: HYBRID (first use)** — only 14 trainer-fresh vectors
  tonight (+14 imports; the fresh-50 cohort can't fill now that the backlog
  is done), so the cohort = 14 fresh + 36 aged never-repaired
  trainer-authored vectors (desc at < 08-16, excluded all prior
  repair_*_ids.json ids; 8,781 eligible). **50/50 ≥0.98 (min cos 0.9972).**
  This is the documented 08-24 aged-cohort fallback, strengthened by
  keeping the fresh vectors that validate the current trainer source.
- 1,057 suspects re-embedded from intended text (median cos 0.815, max
  0.909 — clean gap below 0.98), 0 excluded by the refined tempo-view rule,
  122 orphans pruned → candidate 9,852 vecs == library.

## Prove (frozen 15-probe ruler, production-router emulation)
- router-truth: current 0.738 → candidate **0.833** (+0.095)
- Biggest per-probe gains: ret-012 0.30→1.00, ret-004 0.00→0.50,
  ret-007 0.52→1.00, ret-011 0.48→0.88, ret-006 0.16→0.48, ret-008 0.68→1.00.
- Watched genre probes back at the healthy fingerprint: ret-007 1.00,
  ret-008 1.00, ret-011 0.88, ret-012 1.00.
- Worst per-probe delta +0.00. **BARS: PASS** (strict — rt ≥0.83 AND no
  mood-probe regression).

## Applied (apply_20260831.py — gated, backed up, atomic)
- Pre-apply gates passed: live mood-index sha 05da172d1b1b = measured
  snapshot; embeddings.bin size/mtime unchanged (hard ABORT gates).
- **Backup:** `mood-index.bin.pre-repair-20260831` (sha-verified 05da172d1b1b)
- Applied via temp + atomic rename; round-trip verified
  (sha ff3ecaf45d01, 9,852 vecs, dim 1536).
- **Post-apply live health: 0 orphans, 0 dup groups, 9,852 == library.**
- **Undo:** `cp /Volumes/JakeShared/JakeTunesState/mood-index.bin.pre-repair-20260831
  /Volumes/JakeShared/JakeTunesState/mood-index.bin`

## run_eval (post-apply, frozen snapshot)
- retrieval **0.748** (mechanical, in the 0.744–0.757 band; the identity-path
  eval stays blind to the mood repair — P1 router-aware-eval proposal stands)
- grounding **1.000** (10/10 incl. all 4 traps)
- overall **0.874** · one row appended to score_log.jsonl.

## Counters / watch
- Clobber events: **10** (recurrence log updated in the proposal).
  Root-cause fix (drop mood-index from autoBackupStateToNas + fix the app's
  stale local copy — PROPOSAL-mood-import-clobber fixes 4/5) remains the TOP
  ask — tonight cost ~1,057 re-embeds (~$0.15); even +14 imports replay the
  whole stale map.
- Skips: **718/1000** (no new since 08-29; signal stays closed to ~1k).
- ETIMEDOUT + TCC watches: CLEARED (4th consecutive clean launchd night).
- NEW STANDING NOTE: on any import night smaller than ~50, use the hybrid
  fidelity cohort from repair_20260831.py (fresh + aged top-up) — the
  fresh-only gate can no longer reach its 20-vector minimum on such nights.
- Taste-weight drift re-run due ~09-16 (monthly cadence, 08-16 finding).
- embeddings.bin untouched. No experiments beyond the proven recipe tonight.
