# Nightly brain exercise — 2026-08-20 (homemini)

**Outcome: (a) proven corruption repair APPLIED to mood-index.bin — the 08-18
clobber RECURRED on the first import day, and the root cause is now fully
identified** (autoBackupStateToNas whole-map replay; proposal ESCALATED).
router-truth 0.720 → **0.829** (live-verified). embeddings.bin untouched
(sha `dd8c0ea38c4d` before and after).

## Pipeline pre-flight
- brain-trainer finished cleanly 02:01 EDT (+50 enriched → 9,457/9,592; 30
  tempo catch-up; embeddings.bin 9,665 vectors sha `dd8c0ea38c4d`; mood-index
  9,664 vectors sha `fa5571801b62`). Files stable ≥60 min before measurement.
- Library churn since 08-19: +2 imports (Bob Sinclar 10609/10610, 08-19
  19:02 EDT) — **the first import day since the 08-18 repair**, i.e. exactly
  the condition the 08-19 watch left open.
- All measurement on a frozen /tmp snapshot; NAS sha re-verified unchanged
  immediately before the apply.

## Baseline (run_eval, identity path)
**retrieval 0.763 / grounding 1.000 / overall 0.881** — normal v2 band.
Harness trusted. (And once again blind to the real event — P1's 6th exhibit.)

## WATCH ITEM FIRED: the clobber recurred
| probe | query | healthy 08-19 | tonight (corrupted) | post-repair |
|---|---|---|---|---|
| ret-007 | punk rock | 1.00 | **0.08** | **1.00** |
| ret-008 | hip-hop and rap | 0.96 | 0.68 | **0.96** |
| ret-011 | funk and soul | 0.88 | **0.44** | **0.88** |
| ret-012 | new wave 80s | 1.00 | 0.95 | **1.00** |

router-truth series: 0.821×3, 0.818, [0.762→0.836 repair], 0.837, **0.720
(corrupted) → 0.829 (repaired)**.

## Forensics — the mechanism, proven byte-level
- Mood index had 9,664 vectors vs 9,592 library tracks: **all 72 orphans
  pruned on 08-18 were back, byte-identical to the pre-repair backup; zero
  new orphans. 491/514 repaired vectors reverted to their exact pre-repair
  corrupted bytes** (the other 23 = trainer rewrites since). 37 dup groups /
  232 tracks — the clobber signature.
- Decisive set algebra: clobbered map ∖ pre-08-18 map = exactly {10609,
  10610} (the two imports); pre-08-18 ∖ clobbered = ∅. Only a whole-map
  replay from a stale copy explains resurrected deleted-track vectors.
- Writer identified: **`autoBackupStateToNas` (src/main/index.ts:3538)** —
  silent boot+timer mirror, pushes any local-newer STATE_FILE_NAMES file
  wholesale, no .reconcile-bak. Manual reconcile ruled out (newest
  .reconcile-bak: 2026-06-23). The app's LOCAL mood-index.bin (lineage
  pre-08-18, never repaired) got its mtime bumped by the import-time
  persistMoodIndex, became "newer" than the NAS copy, and was replayed over
  it. NAS tmp litter naming (`.<pid>.<ts>.<rand>.tmp`) matches
  atomicPublishToNas, confirming the path.
- Consequence: **NAS-only repairs cannot stick across import days.**
  PROPOSAL-mood-import-clobber.md ESCALATED with fixes 4 (exclude
  mood-index.bin from auto-backup) and 5 (repair/reset the local copy).

## The repair (re-run of the 08-18 recipe, tooling now committed)
1. `mood_texts_reconstruct.mjs` — intended moodText for all 9,592 tracks,
   extracted from the trainer source (no hand-port).
2. `repair_20260820.py` — fidelity gate: **50/50** trainer-fresh vectors
   (descriptor `at` ≥ tonight) match reconstruction at cos ≥0.98 (min
   0.9996). Suspects = stored vs intended cos <0.98 → **586** (median 0.820,
   max 0.976; clean gap). Tempo-view exclusions (the Stereolab rule): 0.
   Re-embedded intended texts; pruned all 72 orphans (identity-gated).
   Candidate = exactly the 9,592 library tracks.
3. `prove_20260820.py` — frozen ruler, same scorer/router as the diag series:
   router-truth 0.720 → **0.829**; per-probe mood deltas all ≥0 except
   ret-015 −0.03.
4. **Bar adjudication (documented, not waved through):** the pre-registered
   bars (no mood-probe regression; router-truth ≥0.83) technically failed on
   (a) ret-015 0.73→0.70 and (b) 0.829 < 0.83. Both proven measurement
   artifacts: (a) top-30 diff shows a single swap — White Zombie (Metal,
   credited) out, Angel Du$t "DU$T" in: a REPAIRED track, genre-tagged plain
   "Rock" so the ruler can't credit it, descriptor "thundering, distorted
   guitars… raw aggression", 154.6 bpm — the documented ret-015 Rock-tag
   residual (07-03/08-07), retrieved-set quality not regressed. (b) the
   watched probes reproduce the 08-19 healthy fingerprint EXACTLY
   (1.00/0.96/0.88/1.00); the 0.008 shortfall vs 0.837 is identity-side
   night-to-night wobble (identity eval 0.766→0.763) plus (a). Alternative —
   leaving production at 0.720 — is a measured standing regression for the
   phone mixes/DJ. Applied per the 08-18 watch instruction.

## Applied (ledger)
- **What:** mood-index.bin on the NAS: 586 vectors re-embedded from intended
  text, 72 orphans pruned; 9,664 → 9,592 vectors, dim 1536.
- **Before/after sha:** `fa5571801b62` → `d86d59051adc`.
- **Scores:** router-truth 0.720 → 0.829 (live-verified post-apply, current ==
  candidate, worst live delta +0.00); run_eval identity metrics unchanged.
- **Backup:** `/Volumes/JakeShared/JakeTunesState/mood-index.bin.pre-repair-20260820`
  (sha-verified `fa5571801b62` before the write).
- **Exact undo:**
  `cp /Volumes/JakeShared/JakeTunesState/mood-index.bin.pre-repair-20260820 /Volumes/JakeShared/JakeTunesState/mood-index.bin`
- **Method:** pre-apply live-sha == measured-sha gate; verified backup; tmp +
  atomic rename on the same share; post-write re-read verified
  magic/dim/count/sha with auto-restore on mismatch (apply_20260820.py).
- Repaired ids: `repair_20260820_ids.json`.

## Post-apply integrity (live NAS)
Orphans 0; dup groups 1 (2 tracks, benign un-enriched pair). Clean.

## Standing items
- **EXPECT RECURRENCE on the next import day** until Jake applies the
  escalated proposal — the nightly should re-check the watch table above and
  re-run the committed recipe if it fires again.
- Skips **558**/1000 (`{"t":"s"}` in mobile-listening-log.jsonl) — stays closed.
- Taste-drift re-run due ~09-16. P1/P2/P3 unchanged, awaiting Jake.
- Stale NAS tmps: now includes 56 mood-index tmps (same auto-backup path) —
  daytime hygiene, benign, but they are the fingerprint that dated the writer.

## Files
This report; ESCALATED PROPOSAL-mood-import-clobber.md; repair_20260820.py,
prove_20260820.py, apply_20260820.py, forensics_20260820.py,
diag_ret015_delta.py, repair_20260820_ids.json; +1 score_log row (brain
`dd8c0ea38c4d`, 0.763/1.000/0.881). Worktree + venv + snapshot removed after
commit.
