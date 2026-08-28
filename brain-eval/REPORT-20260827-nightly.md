# Nightly brain exercise — 2026-08-27 (~03:05)

## Outcome: (c) ABORTED MID-RUN — repair NOT applied
The session died after committing the reconstruct fix to the working tree but
before the recipe re-run. No backup `.pre-repair-20260827` exists on the NAS;
the live mood-index kept the 7th-clobber damage all day. The 2026-08-28 run
picked this up (found the stranded worktree, committed this work) and completed
the repair — see REPORT-20260828-nightly.md. Net effect of this night: the
reconstruct blind spot (override-only bpm/key) is permanently fixed; the brain
itself was untouched (read-only run).

## Infrastructure failures found and fixed BEFORE any brain work (three, stacked)
1. **node was dead machine-wide.** The Aug-26 morning `brew` upgrade rebuilt
   simdutf (9.1.0, libsimdutf.35) but left `merve 1.2.2_1` linked against the
   deleted `libsimdutf.34` — every `node` launch dyld-aborted (SIGABRT). The
   2:00 AM brain-trainer died before its first log line (only a dyld spew in
   the log; launchd last-exit −6). Fix: `brew upgrade merve` (pulled the `_2`
   rebuild; node also moved 26.0.0 → 26.7.0 as its dependent). Verified:
   `node --version` clean.
2. **launchd + new node binary = TCC wedge on the NAS.** After the fix, the
   launchd-spawned trainer hung FOREVER inside a kernel `open()` on
   /Volumes/JakeShared (sampled twice, same stack: uv_fs_open → __open, 0%
   CPU, no fds on the share) while the same reads from my TCC-granted shell
   were instant. The replaced node binary lost its Network Volumes
   authorization (same TCC blindness family as the 08-25 mount-keeper
   incident). Killed two wedged instances (both pre-write — nothing written,
   verified), ran the trainer manually with the plist's exact env.
   **⚠️ TOMORROW'S 2 AM RUN WILL WEDGE AGAIN until node is re-granted Network
   Volumes access (needs Jake at the GUI — check for a pending TCC prompt).**
   Failure mode is safe (hangs before opening anything for write) but the
   trainer will silently not run.
3. **Repo `.venv` broken** (dangling python symlink after the same brew storm)
   — used a fresh throwaway venv instead, per standard practice.

## Pipeline state
- brain-trainer (manual, plist env): clean finish 07:13:20Z — +50 enriched,
  brain 9701/9791, embeddings.bin 9901 vectors, mood-index 9900.
- Import day: library 9783 → 9791 (+8; incl. a 10-track Parcels album add).
- embeddings.bin structurally sound: 9901 vecs dim 1536, 0 dup groups, 110
  orphan vectors (known-benign hygiene class, measured 0.000 effect 08-10).
- Skips: **712/1000** (was 674).

## Pre-check (standard, before any paid measurement)
mood-index: **orphans=109, dup_groups=57** (healthy 0/1) → **CLOBBER, 7th
event**, 7/7 import days. Root cause unchanged (autoBackupStateToNas whole-map
replay of the app's stale LOCAL mood-index — REPORT-20260820).
PROPOSAL-mood-import-clobber remains the TOP ask.

## Recipe fidelity gate — NEW failure mode found, root-caused, and FIXED
First run of repair_20260827.py ABORTED at the fidelity gate (40/50): all ten
misses were the fresh Parcels tracks (ids 10842–10851), stored vectors carry
real tempo+key (teb 72.9–161.9) but library.json has bpm/key = null.
Grounded root cause: their analysis lives ONLY in metadata-overrides.json
(`fields.bpm/keyRoot/keyMode/camelotKey`, laptop-authored Aug 26 ~14:36) —
the trainer applies overrides before embedding; mood_texts_reconstruct.mjs
never did. Tonight is the first night the trainer-fresh cohort contained
override-only-bpm tracks, so the gate finally caught the blind spot.
Fix (committed): mood_texts_reconstruct.mjs now extracts the trainer's own
`applyMetadataOverrides` + `NUMERIC_OVERRIDE_FIELDS` from source (same
no-hand-port twin rule as moodText) and applies them before building texts.
Verification: reconstruction now logs `applied 9757, skipped 34 stale` —
byte-identical counts to the trainer's own log line — and 10842 rebuilds with
tempo 130/F major/camelot 7B exactly as embedded.

## Recipe re-run (repair_20260827.py)
(pending)

## Prove (frozen 15-probe ruler, production-router emulation)
(pending)

## Applied
(pending)

## Counters
- Clobber events: **7** (every import day). Escalated proposal unchanged.
