# Nightly brain exercise — 2026-09-01 (~03:05)

## Outcome: (a) PROVEN IMPROVEMENT APPLIED — 11th-clobber repair, strict bars PASS
Router-truth 0.747 → **0.841** (+0.094, meets the ≥0.83 post-repair band
strictly — and a new post-repair high; the prior best applied level was
0.833). Worst per-probe candidate-vs-current mood delta **+0.00** (no
regression anywhere; the recurring ret-015 Angel Du$t artifact did NOT fire —
0.73→0.80). Live index back to **0 orphans / 0 dup groups**. Fourth
consecutive night needing no bar adjudication.

## Pipeline state (all green)
- brain-trainer: clean launchd run 06:00:06–06:01:45Z; +50 enriched
  (import day: library 9,852 → **9,925**, +73). Enrichment backlog
  reopened slightly by the import wave (9,900/9,925 — the remaining 25
  drain on the next nightly-50). embeddings.bin 10,050 vecs.
  5th consecutive clean launchd night — ETIMEDOUT + TCC watches stay
  cleared.
- Brain files mtime-stable ~64 min before snapshot; snapshot
  /tmp/brain-snap-20260901 sha-verified ×3 against live before copy AND
  copy-verified (embeddings 0ba0513b744a, mood-index d0a18a0f4809);
  re-verified unchanged at apply (mood sha exact + embeddings size
  61787412 / mtime 1788242502 hard-abort gates passed).
- Anthropic key probed with 1 token (200) BEFORE the paid grounding run.
- Trainer source committed + unmodified (753e46c) — reconstruction ran
  against the exact production trainer.

## Pre-check (standard, before paid measurement)
mood-index: **orphans=124, dup_groups=61 (394 tracks)** — healthy is 0/0.
11th clobber event, eleven-for-eleven on import days.

## Recipe (repair_20260901.py, read-only phase)
- Reconstruction (mood_texts_reconstruct.mjs on committed trainer 753e46c):
  9,925 rows; overrides line `applied 9882, skipped 40 stale`
  byte-identical to tonight's trainer log.
- **Fidelity gate: 50/50 trainer-fresh, min cos 0.9987** — the +73-import
  night filled the fresh cohort completely (first time since the backlog
  closed; no aged top-up needed). Gate numbers replayed read-only via
  gate_only_20260901.py after a truncated terminal capture ate the
  original gate lines — the repair itself ran the gate inline and passed
  (it aborts otherwise).
- 1,072 suspects re-embedded from intended text (median cos 0.814, max
  0.908 — clean gap below 0.98), 0 excluded by the refined tempo-view rule,
  124 orphans pruned → candidate 9,925 vecs == library.

## Prove (frozen 15-probe ruler, production-router emulation)
- router-truth: current 0.747 → candidate **0.841** (+0.094)
- Biggest per-probe gains (mood side): ret-012 0.30→1.00, ret-007
  0.52→1.00, ret-011 0.48→0.88, ret-004 0.00→0.50, ret-006 0.16→0.48,
  ret-008 0.72→1.00, ret-013 0.90→1.00, ret-009 0.92→1.00.
- Watched genre probes at/above the healthy fingerprint: ret-007 1.00,
  ret-008 1.00, ret-011 0.88, ret-012 1.00.
- The 0.841 (vs the usual 0.833) is honest ruler variance in the good
  direction: ret-009 and ret-013 both landed 1.00 on the candidate.
  Mood-routed mean 0.849.
- Worst per-probe delta +0.00. **BARS: PASS** (strict — rt ≥0.83 AND no
  mood-probe regression; no adjudication needed).

## Applied (apply_20260901.py — gated, backed up, atomic)
- Pre-apply gates passed: live mood-index sha d0a18a0f4809 = measured
  snapshot; embeddings.bin size/mtime unchanged (hard ABORT gates).
- **Backup:** `mood-index.bin.pre-repair-20260901` (sha-verified d0a18a0f4809)
- Applied via temp + atomic rename; round-trip verified
  (sha 1d65f9117f8b, 9,925 vecs, dim 1536).
- **Post-apply live health: 0 orphans, 0 dup groups, 9,925 == library.**
- **Undo:** `cp /Volumes/JakeShared/JakeTunesState/mood-index.bin.pre-repair-20260901
  /Volumes/JakeShared/JakeTunesState/mood-index.bin`

## run_eval (post-apply, frozen snapshot)
- retrieval **0.762** (mechanical, top of the 0.744–0.766 v2 band; the
  identity-path eval stays blind to the mood repair — P1
  router-aware-eval proposal stands, 11th exhibit)
- grounding **1.000** (10/10 incl. all 4 traps; key probed first)
- overall **0.881** · one row appended to score_log.jsonl
  (brain_id 0ba0513b744a, 10,050 vectors).

## Counters / watch
- Clobber events: **11** (recurrence log updated in the proposal).
  Root-cause fix (drop mood-index from autoBackupStateToNas + fix the app's
  stale local copy — PROPOSAL-mood-import-clobber fixes 4/5) remains the TOP
  ask — tonight cost ~1,072 re-embeds; every import day replays the whole
  stale map.
- Skips: **733/1000** (+15 since 08-29; signal stays closed to ~1k).
- NAS tmp litter: **404** stale `*.tmp` (was 329 on the standing count) —
  slow daytime accrual continues (newest Aug 31 20:52 mixtapes-ai + an
  Aug 31 12:23 mood-index tmp), NOTHING written tonight; still awaiting
  the daytime cleanup + retrying-writer hunt. Not a storm.
- Taste-weight drift re-run due ~09-16 (monthly cadence, 08-16 finding).
- embeddings.bin untouched. No experiments beyond the proven recipe tonight.
