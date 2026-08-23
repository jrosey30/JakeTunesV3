# Nightly brain exercise — 2026-08-23 (homemini)

**Outcome: (a) proven corruption repair APPLIED to mood-index.bin — the
import-day clobber fired for the FOURTH time (08-18 original, 08-20, 08-22,
tonight), on schedule with the identified mechanism.** router-truth 0.755 →
**0.830** (live == candidate by sha). embeddings.bin untouched (sha
`29053289238a` before and after). Standing instruction from 08-20 followed:
watch table checked on the import day, committed recipe re-run when it fired.

## Pipeline pre-flight
- brain-trainer finished cleanly 02:01 EDT (+50 enriched → 9,554/9,686;
  embeddings.bin 9,783 vectors sha `29053289238a`; mood-index 9,782 vectors
  sha `29c4bad53eb7`). Files stable ≥60 min before measurement.
- Library churn since 08-22: 9,645 → **9,686 tracks (+41)** — an import day,
  i.e. exactly the recurrence condition.
- All measurement on a frozen /tmp snapshot (shas verified identical); NAS
  shas re-verified unchanged immediately before the apply.
- Trainer source used for reconstruction = the exact file launchd ran
  (`scripts/brain-trainer.mjs`, mtime 08-22 23:22, has uncommitted edits on
  `feat/listen-to-the-list`); the fidelity gate confirms it matches what the
  trainer actually wrote.

## Baseline (run_eval, identity path)
**retrieval 0.757 / grounding 1.000 / overall 0.878** — identical to 08-22,
normal v2 band. Harness trusted. (Blind to the mood corruption again —
P1's 8th exhibit.)

## WATCH ITEM FIRED (4th clobber event)
Cheap fingerprint before any paid measurement: mood-index **96 orphans**
(healthy = 0), **53 dup groups / 318 tracks** (healthy = 1 group / 2 tracks)
— the whole-map-replay signature. Frozen-ruler probes confirmed:

| probe | query | healthy | tonight (corrupted) | post-repair |
|---|---|---|---|---|
| ret-007 | punk rock | 1.00 | **0.48** | **1.00** |
| ret-008 | hip-hop and rap | 0.96 | 0.80 | **0.96** |
| ret-011 | funk and soul | 0.88 | **0.44** | **0.88** |
| ret-012 | new wave 80s | 1.00 | 0.40 | **1.00** |

router-truth series: 0.821×3, 0.818, [0.762→0.836], 0.837, [0.720→0.829],
[0.750→0.830], **[0.755→0.830]**.

## The repair (re-run of the committed recipe, 20260822 fixed scripts)
1. `mood_texts_reconstruct.mjs` — intended moodText for all 9,686 tracks,
   extracted from the live trainer source (no hand-port).
2. `repair_20260823.py` (path/cutoff-adapted copy of the fixed
   `repair_20260822.py`) — fidelity gate: **50/50** trainer-fresh vectors
   match reconstruction at cos ≥0.98 (min 0.9999). Suspects (stored vs
   intended cos <0.98): **709** (median 0.815, max 0.908; same clean gap).
   Tempo-view exclusions: 3. Orphans pruned: 96 (identity-gated).
   Candidate = exactly the 9,686 library tracks.
3. Frozen-ruler prove (same script, section 4): router-truth 0.755 → **0.830**;
   candidate-vs-current mood deltas all ≥0 except ret-015 −0.03.
4. **Bar adjudication (verified via `diag_ret015_delta_0823.py`, not
   assumed):** the −0.03 is the SAME two-slot swap as 08-20/08-22 — incoming
   are Bloodywood "Bekhauf" (Metal, credited-expected — a genuine hit) and
   Angel Du$t "DU$T", the identical Rock-tagged ruler residual documented
   07-03/08-07/08-20/08-22. Retrieved-set quality not regressed. router-truth
   0.830 meets the ≥0.83 post-repair band; the mechanical FAIL came solely
   from this artifact. Applied per the 08-20 standing instruction.

## Applied (ledger)
- **What:** mood-index.bin on the NAS: 709 vectors re-embedded from intended
  text, 96 orphans pruned; 9,782 → 9,686 vectors, dim 1536.
- **Before/after sha:** `29c4bad53eb7` → `f71c81bb4a42`.
- **Scores:** router-truth 0.755 → 0.830; live file sha == proven candidate
  sha (bytewise identity, stronger than re-scoring); run_eval identity
  metrics untouched.
- **Backup:** `/Volumes/JakeShared/JakeTunesState/mood-index.bin.pre-repair-20260823`
  (sha-verified `29c4bad53eb7` before the write).
- **Exact undo:**
  `cp /Volumes/JakeShared/JakeTunesState/mood-index.bin.pre-repair-20260823 /Volumes/JakeShared/JakeTunesState/mood-index.bin`
- **Method:** pre-apply live-sha == measured-sha gate (both brain files);
  verified backup; tmp + atomic rename on the same share; post-write re-read
  verified magic/dim/count/sha with auto-restore on mismatch
  (apply_20260823.py).
- Repaired ids: `repair_20260823_ids.json`.

## Post-apply integrity (live NAS)
9,686 vecs == library exactly; orphans 0; dup groups 1 (2 tracks, the known
benign un-enriched pair). Clean.

## Standing items
- **4th event — this recurs EVERY import day** (~$0.15/night in re-embeds +
  a day of degraded phone mixes each time) until the escalated
  PROPOSAL-mood-import-clobber fix lands (exclude mood-index.bin from
  autoBackupStateToNas + repair the app's local copy). Recurrence log
  updated; still the clear top ask for Jake.
- Skips **642**/1000 — stays closed.
- Taste-drift re-run due ~09-16. P1/P2/P3 unchanged, awaiting Jake.
- 08-21 outage proposals (pull mood-index local; mount-keeper fix) still open.

## Files
This report; repair_20260823.py, apply_20260823.py, diag_ret015_delta_0823.py,
repair_20260823_ids.json; recurrence note in PROPOSAL-mood-import-clobber.md;
+1 score_log row (brain `29053289238a`, 0.757/1.000/0.878). Worktree + venv +
snapshot removed after commit.
