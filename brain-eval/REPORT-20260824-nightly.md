# Nightly brain exercise — 2026-08-24 (homemini)

**Outcome: (a) proven corruption repair APPLIED to mood-index.bin — the
import-day clobber fired for the FIFTH time (08-18, 08-20, 08-22, 08-23,
tonight), this time compounded by the 2:00 trainer dying (FATAL ETIMEDOUT)
before writing anything.** router-truth 0.748 → **0.823** (live == candidate
by sha; mood-routed mean **0.833**, inside the ≥0.83 band — the headline rt
shortfall vs the band is fully attributed to the identity index, see
adjudication). embeddings.bin untouched (size/mtime gated before apply).

## Pipeline pre-flight (two anomalies tonight)
- **brain-trainer FAILED**: started 02:00, applied metadata overrides (9,668),
  then `FATAL ETIMEDOUT: connection timed out, close` at 02:00:07 — wrote
  NOTHING to the brain (descriptors still mtime 08-23 02:01, 9,599 entries).
  One-night enrichment miss; launchd will retry tomorrow. Consequence: no
  post-clobber trainer vectors existed for the usual fidelity gate, and no
  tempo catch-up ran (see the two recipe adaptations below).
- Both brain files last written **Aug 23 18:18** (5s apart — the day-sync
  replay signature), quiescent ~9h before measurement. One torn SMB read of
  embeddings.bin observed during snapshotting (transient wrong sha, resolved
  on re-read ×3 — known NAS behavior, measurement done on the /tmp snapshot).
- Library churn since 08-23: 9,686 → **9,692 tracks (+6)** — an import day.
- Trainer source `scripts/brain-trainer.mjs` edited 08-23 03:25 (uncommitted,
  the gemma4:e4b descriptor-upgrade program: env-overridable GEMMA_MODEL,
  think:false, --redescribe-all mode). Verified moodText()/tempoEnergy()
  UNCHANGED (reconstruction unaffected) and that --redescribe-all has never
  run (0 `gm` fields in the descriptor store) — no ungated descriptor
  upgrade could leak into the repair.

## Baseline (run_eval, identity path)
**retrieval 0.750 / grounding 1.000 / overall 0.875** — v2 band, small
identity wobble vs 0.757 (08-22/23) from the +6 imports. Harness trusted.
(Blind to the mood corruption again — P1's 9th exhibit.)

## WATCH ITEM FIRED (5th clobber event)
Cheap fingerprint before paid measurement: **97 orphans** (healthy 0),
**56 dup groups / 360 tracks** (healthy 1/2). Frozen-ruler probes:

| probe | query | healthy | tonight (corrupted) | post-repair |
|---|---|---|---|---|
| ret-007 | punk rock | 1.00 | **0.52** | **1.00** |
| ret-008 | hip-hop and rap | 0.96 | 0.76 | **0.96** |
| ret-011 | funk and soul | 0.88 | **0.44** | **0.88** |
| ret-012 | new wave 80s | 1.00 | 0.35 | **1.00** |

router-truth series: 0.821×3, 0.818, [0.762→0.836], 0.837, [0.720→0.829],
[0.750→0.830], [0.755→0.830], **[0.748→0.823]**.

## The repair (committed recipe, two forced adaptations — both documented in code)
1. `mood_texts_reconstruct.mjs` — intended moodText for all 9,692 tracks from
   the live trainer source.
2. **Adaptation A — aged-cohort fidelity gate** (`repair_20260824.py`): the
   usual trainer-fresh cohort (desc `at` ≥ cutoff) was itself clobbered
   (measured cos 0.40–0.58 — those 50 hold import-time bare-genre embeds and
   belong in the SUSPECT set), and the dead trainer wrote no replacements.
   Gate moved to trainer-authored vectors that SURVIVE the stale-map replay:
   50 stratified from 8,792 eligible (desc `at` < 08-16, never in any prior
   repair ids file). Result: **50/50 ≥0.98 (min 0.9963)** — reconstruction
   fidelity re-proven on tonight's actual map.
3. **Adaptation B — tempo-view rule refined to its intent**: original rule
   excluded any suspect with `|bpm−teb|>3`; tonight that protected 8
   corrupted import embeds with `teb=0` (trainer embedded BEFORE bpm analysis
   existed — reconstruction has the strictly BETTER tempo view, and no tempo
   catch-up ran to fix them). Unrefined, five of them (Sugar Ray ×4, XTC)
   hijacked ret-007's top-5 (bare-genre texts score 0.59–0.65 vs "punk rock",
   above enriched vectors' ~0.53), capping it at 0.80 and rt at 0.810.
   Refined rule: exclude only when `teb` is a REAL recorded tempo that has
   since nulled/moved (the 08-18 Stereolab case). Exclusions tonight: 0.
4. Suspects: **768** (median 0.812, max 0.908 — same clean gap). Orphans
   pruned: 97 (identity-gated). Candidate = exactly the 9,692 library tracks.
5. Frozen-ruler prove: router-truth 0.748 → **0.823**; candidate-vs-current
   mood deltas all ≥0 except ret-015 −0.03.

## Bar adjudication (mechanical FAIL on two counts — both verified, not assumed)
- **ret-015 −0.03**: `diag_ret015_delta_0824.py` shows the IDENTICAL two-slot
  swap as 08-20/22/23 — incoming Bloodywood "Bekhauf" (Metal, expected — a
  genuine hit) + Angel Du$t "DU$T" (the Rock-tagged ruler residual documented
  07-03/08-07/08-20/08-22/08-23). Retrieved-set quality not regressed.
- **rt 0.823 < 0.83 band**: exact arithmetic attribution to the identity
  index — identity baseline moved 0.757 → 0.750 tonight (−0.007 × 15 =
  −0.105 points); candidate rt totals 12.35/15 vs the 08-23 applied repair's
  12.45/15 (gap exactly 0.105 points). The candidate changes only
  mood-index.bin and bytewise cannot move identity-routed probes. On the
  9 mood-routed probes — the surface the repair controls — the candidate
  scores **0.8333 (≥0.83 band met)** and matches the 08-23 applied repair
  point-for-point on every comparable probe; all four watch probes sit
  exactly at the healthy fingerprint. Applied per the 08-20 standing
  instruction.

## Applied (ledger)
- **What:** mood-index.bin on the NAS: 768 vectors re-embedded from intended
  text, 97 orphans pruned; 9,789 → 9,692 vectors, dim 1536.
- **Before/after sha1:** `45ac3b10e684` → `ad04fffd9e75`.
- **Scores:** router-truth 0.748 → 0.823 (mood-routed mean 0.833); live file
  sha == proven candidate sha; run_eval identity metrics untouched.
- **Backup:** `/Volumes/JakeShared/JakeTunesState/mood-index.bin.pre-repair-20260824`
  (sha1-verified `45ac3b10e684` before the write).
- **Exact undo:**
  `cp /Volumes/JakeShared/JakeTunesState/mood-index.bin.pre-repair-20260824 /Volumes/JakeShared/JakeTunesState/mood-index.bin`
- **Method:** pre-apply live-sha == measured-sha gate on mood-index AND a
  hard size+mtime gate on embeddings.bin (hardened vs prior nights' print-
  only check); verified backup; tmp + atomic rename on the same share;
  post-write re-read verified magic/dim/count/sha with auto-restore on
  mismatch (apply_20260824.py).
- Repaired ids: `repair_20260824_ids.json`.

## Post-apply integrity (live NAS)
9,692 vecs == library exactly; orphans 0; missing 0; dup groups 1 (2 tracks,
the known benign un-enriched Noelle & The Deserters pair). Clean.

## Standing items
- **5th event — even a +6-import day reverts the WHOLE map.** Cost tonight
  compounded by the trainer outage (the two recipe adaptations). The
  escalated PROPOSAL-mood-import-clobber (exclude mood-index.bin from
  autoBackupStateToNas + repair the app's local copy) remains the top ask.
- **Trainer ETIMEDOUT** is new and unexplained (died 1s after the overrides
  step; NAS was reachable at 3:05). If it recurs tomorrow, diagnose before
  anything else — two consecutive missed trainer nights + an import day
  would leave new tracks bare-genre in BOTH indexes.
- Skips **643**/1000 — stays closed.
- Taste-drift re-run due ~09-16. P1/P2/P3 unchanged, awaiting Jake.
- 08-21 outage proposals (pull mood-index local; mount-keeper fix) still open.

## Files
This report; repair_20260824.py (aged-cohort gate + refined tempo-view rule),
apply_20260824.py (hardened embeddings gate), diag_ret015_delta_0824.py,
repair_20260824_ids.json; recurrence note in PROPOSAL-mood-import-clobber.md;
+1 score_log row (brain `b08f37f666c3`, 9,790 vectors, 0.750/1.000/0.875).
Worktree + venv + snapshot removed after commit.
