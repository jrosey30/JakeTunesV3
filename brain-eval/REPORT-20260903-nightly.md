# Nightly brain exercise — 2026-09-03 (~03:05)

## Outcome: (a) PROVEN IMPROVEMENT APPLIED — 13th-clobber repair, strict bars PASS
Router-truth 0.736 → **0.844** (+0.108, meets the ≥0.83 post-repair band
strictly and sets a NEW post-repair high, above 09-01/09-02's 0.841 —
ret-008 joined the 1.00 club alongside ret-007/012/013). Worst per-probe
candidate-vs-current mood delta **+0.00** (no regression anywhere; the
recurring ret-015 Angel Du$t artifact did NOT fire — 0.73→0.80). Live index
back to **0 orphans / 0 dup groups**. Sixth consecutive night needing no
bar adjudication.

## Pipeline state (all green)
- brain-trainer: clean launchd run 06:00:03–06:07:50Z; +35 enriched
  (import day: library 9,968 → **9,985**, +17) plus a 150-track meaning
  catch-up (embeddings.bin only; sets desc.m, never bumps `at` — no
  fidelity-cohort pollution, verified 09-02). **Backlog fully drained:
  9,985/9,985 enriched.** embeddings.bin 10,112 vecs. 7th consecutive
  clean launchd night — ETIMEDOUT + TCC watches stay cleared.
- Brain files mtime-stable ~58 min before snapshot; snapshot
  /tmp/brain-snap-20260903 sha-verified ×3 against live before copy AND
  copy-verified (embeddings d6c7a8b25aaa, mood-index 646db49a35d8);
  re-verified unchanged at apply (mood sha exact + embeddings size
  62168588 / mtime 1788415664 hard-abort gates passed).
- Anthropic key probed with 1 token (200) BEFORE the paid grounding run.
- Trainer source committed + unmodified (753e46c per git status) —
  reconstruction ran against the exact production trainer.

## Pre-check (standard, before paid measurement)
mood-index: **orphans=125, dup_groups=62 (405 tracks)** — healthy is 0/0.
13th clobber event, thirteen-for-thirteen on import days.
(embeddings.bin: 127 orphans, 0 dups — the known benign identity-side
litter, not the clobber signature.)

## Recipe (repair_20260903.py, read-only phase)
- Reconstruction (mood_texts_reconstruct.mjs on committed trainer 753e46c):
  9,985 rows; overrides line `applied 9930, skipped 52 stale`
  byte-identical to tonight's trainer log.
- **Fidelity gate: HYBRID 50/50, min cos 0.9958** — only +17 imports →
  35 trainer-fresh vectors, topped up with 15 aged never-repaired
  (8,781 eligible), per the 08-31 small-import-night variant.
- 1,169 suspects re-embedded from intended text (median cos 0.812, max
  0.909 — clean gap below 0.98), 0 excluded by the refined tempo-view rule,
  125 orphans pruned → candidate 9,985 vecs == library.

## Prove (frozen 15-probe ruler, production-router emulation)
- router-truth: current 0.736 → candidate **0.844** (+0.108)
- Biggest per-probe gains (mood side): ret-012 0.30→1.00, ret-007
  0.52→1.00, ret-011 0.48→0.92, ret-004 0.00→0.50, ret-008 0.64→1.00,
  ret-006 0.20→0.44, ret-013 0.83→1.00, ret-009 0.92→1.00.
- Watched genre probes at/above the healthy fingerprint: ret-007 1.00,
  ret-008 1.00, ret-011 0.92, ret-012 1.00.
- Worst per-probe delta +0.00. **BARS: PASS** (strict — rt ≥0.83 AND no
  mood-probe regression; no adjudication needed).

## Applied (apply_20260903.py — gated, backed up, atomic)
- Pre-apply gates passed: live mood-index sha 646db49a35d8 = measured
  snapshot; embeddings.bin size/mtime unchanged (hard ABORT gates,
  updated to tonight's measured values per the 09-01 ops rule).
- **Backup:** `mood-index.bin.pre-repair-20260903` (sha-verified 646db49a35d8)
- Applied via temp + atomic rename; round-trip verified
  (sha d10530843de2, 9,985 vecs, dim 1536).
- **Post-apply live health: 0 orphans, 0 dup groups, 9,985 == library.**
- **Undo:** `cp /Volumes/JakeShared/JakeTunesState/mood-index.bin.pre-repair-20260903
  /Volumes/JakeShared/JakeTunesState/mood-index.bin`

## run_eval (post-apply, frozen snapshot)
- retrieval **0.755** (mechanical, inside the 0.744–0.766 v2 band; the
  identity-path eval stays blind to the mood repair — P1
  router-aware-eval proposal stands, 13th exhibit)
- grounding **1.000** (10/10 incl. all 4 traps; key probed first)
- overall **0.877** · one row appended to score_log.jsonl
  (brain_id d6c7a8b25aaa, 10,112 vectors).

## Counters / watch
- Clobber events: **13** (recurrence log updated in the proposal).
  Root-cause fix (drop mood-index from autoBackupStateToNas + fix the app's
  stale local copy — PROPOSAL-mood-import-clobber fixes 4/5) remains the TOP
  ask — tonight cost ~1,169 re-embeds; even a +17-import day reverts the
  whole map.
- Skips: **779/1000** (+38 since 09-02; signal stays closed to ~1k —
  fastest weekly accrual yet, the 1k re-test may arrive within ~6 weeks).
- NAS tmp litter: steady at 4 (the Sep-1 accrual; benign, no new tonight).
- Taste-drift monthly re-run due ~09-16.
