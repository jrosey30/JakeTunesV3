# Nightly brain exercise — 2026-09-02 (~03:05)

## Outcome: (a) PROVEN IMPROVEMENT APPLIED — 12th-clobber repair, strict bars PASS
Router-truth 0.735 → **0.841** (+0.106, meets the ≥0.83 post-repair band
strictly and ties the 09-01 post-repair high). Worst per-probe
candidate-vs-current mood delta **+0.00** (no regression anywhere; the
recurring ret-015 Angel Du$t artifact did NOT fire — 0.73→0.80). Live index
back to **0 orphans / 0 dup groups**. Fifth consecutive night needing no
bar adjudication.

## Pipeline state (all green)
- brain-trainer: clean launchd run 06:00:05–06:08:15Z; +50 enriched
  (import day: library 9,925 → **9,968**, +43) PLUS a 150-track meaning
  catch-up (embeddings.bin only). Backlog 9,950/9,968 — remaining 18
  drain on the next nightly-50. embeddings.bin 10,094 vecs. 6th
  consecutive clean launchd night — ETIMEDOUT + TCC watches stay cleared.
- Verified before gating: the meaning catch-up path sets `desc[id].m`
  but never bumps `at`, so the fresh fidelity cohort stayed exactly
  tonight's 50 nightly-enriched tracks (no cohort pollution).
- Brain files mtime-stable ~57 min before snapshot; snapshot
  /tmp/brain-snap-20260902 sha-verified ×3 against live before copy AND
  copy-verified (embeddings 34911e5d2d6b, mood-index e138d74cb342);
  re-verified unchanged at apply (mood sha exact + embeddings size
  62057924 / mtime 1788329291 hard-abort gates passed).
- Anthropic key probed with 1 token (200) BEFORE the paid grounding run.
- Trainer source committed + unmodified (753e46c per git status) —
  reconstruction ran against the exact production trainer.

## Pre-check (standard, before paid measurement)
mood-index: **orphans=124, dup_groups=62 (404 tracks)** — healthy is 0/0.
12th clobber event, twelve-for-twelve on import days.

## Recipe (repair_20260902.py, read-only phase)
- Reconstruction (mood_texts_reconstruct.mjs on committed trainer 753e46c):
  9,968 rows; overrides line `applied 9918, skipped 47 stale`
  byte-identical to tonight's trainer log.
- **Fidelity gate: 50/50 trainer-fresh, min cos 0.9999** — the +43-import
  night filled the fresh cohort completely (nightly-50 batch), no aged
  top-up needed.
- 1,121 suspects re-embedded from intended text (median cos 0.812, max
  0.909 — clean gap below 0.98), 0 excluded by the refined tempo-view rule,
  124 orphans pruned → candidate 9,968 vecs == library.

## Prove (frozen 15-probe ruler, production-router emulation)
- router-truth: current 0.735 → candidate **0.841** (+0.106)
- Biggest per-probe gains (mood side): ret-012 0.30→1.00, ret-007
  0.52→1.00, ret-011 0.48→0.92, ret-004 0.00→0.50, ret-006 0.16→0.44,
  ret-008 0.72→1.00, ret-013 0.80→1.00, ret-009 0.92→1.00.
- Watched genre probes at/above the healthy fingerprint: ret-007 1.00,
  ret-008 1.00, ret-011 0.92, ret-012 1.00.
- Worst per-probe delta +0.00. **BARS: PASS** (strict — rt ≥0.83 AND no
  mood-probe regression; no adjudication needed).

## Applied (apply_20260902.py — gated, backed up, atomic)
- Pre-apply gates passed: live mood-index sha e138d74cb342 = measured
  snapshot; embeddings.bin size/mtime unchanged (hard ABORT gates,
  updated to tonight's measured values per the 09-01 ops rule).
- **Backup:** `mood-index.bin.pre-repair-20260902` (sha-verified e138d74cb342)
- Applied via temp + atomic rename; round-trip verified
  (sha 287727f1bc7f, 9,968 vecs, dim 1536).
- **Post-apply live health: 0 orphans, 0 dup groups, 9,968 == library.**
- **Undo:** `cp /Volumes/JakeShared/JakeTunesState/mood-index.bin.pre-repair-20260902
  /Volumes/JakeShared/JakeTunesState/mood-index.bin`

## run_eval (post-apply, frozen snapshot)
- retrieval **0.754** (mechanical, inside the 0.744–0.766 v2 band; the
  identity-path eval stays blind to the mood repair — P1
  router-aware-eval proposal stands, 12th exhibit)
- grounding **1.000** (10/10 incl. all 4 traps; key probed first)
- overall **0.877** · one row appended to score_log.jsonl
  (brain_id 34911e5d2d6b, 10,094 vectors).

## Counters / watch
- Clobber events: **12** (recurrence log updated in the proposal).
  Root-cause fix (drop mood-index from autoBackupStateToNas + fix the app's
  stale local copy — PROPOSAL-mood-import-clobber fixes 4/5) remains the TOP
  ask — tonight cost ~1,121 re-embeds; the suspect count grows ~+50 per
  event because each replay re-clobbers the same stale map plus the new
  import wave.
- Skips: **741/1000** (+8 since 09-01; signal stays closed to ~1k).
- NAS tmp litter: **404 → 4** — the stale `*.tmp` pile was cleaned during
  the day (pending ask resolved; not by tonight's run). Remaining 4 are
  fresh Sep 1 daytime accrual (mixtapes-ai + library.json), benign.
  Several hidden `.mixtapes.json.*` dotfile tmps from early Aug remain.
- Taste-weight drift re-run due ~09-16 (monthly cadence, 08-16 finding).
- embeddings.bin untouched. No experiments beyond the proven recipe tonight.
