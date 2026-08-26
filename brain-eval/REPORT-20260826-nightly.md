# Nightly brain exercise — 2026-08-26 (~03:05)

## Outcome: (a) proven improvement APPLIED — 6th mood-index clobber repaired

## Pipeline state
- brain-trainer finished clean 06:01Z (+50 enriched, brain 9654/9783, embeddings.bin
  9888 vectors). The 08-25 ETIMEDOUT/short-read failure did NOT recur — the
  mount-keeper patch held. WATCH CLEARED.
- Import day: library 9692 → 9783 (+91 tracks).
- embeddings.bin structurally sound (9888 vecs, dim 1536, 0 dup groups; 105
  orphan vectors = known-benign hygiene, measured 0.000 effect 08-10).

## Pre-check (standard, before any paid measurement)
mood-index: **orphans=104, dup_groups=60** (healthy = 0/1) → **CLOBBER, 6th event**,
6/6 import days. Root cause unchanged: autoBackupStateToNas whole-map replay of the
app's stale LOCAL mood-index (see REPORT-20260820). PROPOSAL-mood-import-clobber
remains the TOP ask.

## Recipe re-run (repair_20260826.py — 08-23 trainer-fresh gate + 08-24 refined tempo-view rule)
- Reconstruction from the live working-tree trainer (uncommitted diff touches only
  gemmaDescribe/--redescribe-all, NOT moodText/tempoEnergy — verified).
- Fidelity gate: **50/50** trainer-fresh vectors match reconstruction (min cos 0.9999).
- Suspects (stored ≠ intended, cos<0.98): **861** (larger than prior nights — the +91
  import-day replay). Excluded by tempo-view rule: 0. Orphans pruned: 104.
- Candidate: 9783 vecs.

## Prove (frozen 15-probe ruler, production-router emulation)
router-truth **0.744 → 0.826**; mood-routed portion **0.838** (≥0.83 band ✓).
Big real wins: ret-012 +0.70, ret-004 +0.50, ret-007 +0.48, ret-011 +0.40,
ret-006 +0.36, ret-008 +0.24; no real regressions.

Both raw BARS flags re-verified as the SAME known artifacts as 08-22/23/24:
1. ret-015 −0.03 = the Angel Du$t plain-"Rock"-tag proxy residual (diag_ret015_delta_0826:
   candidate swaps in repaired Bloodywood "Bekhauf" [Metal, counts] + Angel Du$t "DU$T"
   [aggressive but tagged Rock = documented proxy miss]). Repaired vectors are correct
   by construction.
2. rt 0.826 < 0.83 overall = identity-routed wobble (6 main-routed probes avg 0.808:
   ret-006 0.60, ret-012 identity 0.30), untouchable by a mood repair — same arithmetic
   that cleared the 08-24 apply (rt 0.823). Tonight sits inside the applied band
   0.823–0.837.

## Applied (apply_20260826.py)
- Pre-apply gates: live sha a723fe7c441d == measured snapshot; embeddings.bin
  size/mtime unchanged. PASS.
- Backup: `mood-index.bin.pre-repair-20260826` (sha-verified a723fe7c441d).
- Atomic temp+rename; post-write verify sha 8533a673a605, 9783 vecs, dim 1536. PASS.
- Post-apply live health: **orphans=0, dup_groups=0**.

**UNDO:** `cp /Volumes/JakeShared/JakeTunesState/mood-index.bin.pre-repair-20260826 /Volumes/JakeShared/JakeTunesState/mood-index.bin`

## Standard eval row (run_eval.py, applied brain)
retrieval 0.748 / grounding 1.000 / overall 0.874 — post-repair band (eval scores all
probes on the identity index; router-truth above is the production-faithful number).

## Counters
- Skips: **674/1000** (was 643) — still gathering toward the skip-signal retry bar.
- Clobber events: **6** (every import day). Escalated proposal unchanged.

## Not done (deliberately)
- No new experiment beyond the repair — the clobber repair was the night's one
  bounded, provable exercise; stacking a second change would break attribution.
- 329 stale .tmp files on the NAS state dir still need daytime cleanup (daytime task).
- Noted for Jake: trainer working tree carries the uncommitted gemma4:e4b
  `--redescribe-all` machinery (descriptor-upgrade program) — running fine as-is,
  but it's unversioned; worth committing on the V3 side.
