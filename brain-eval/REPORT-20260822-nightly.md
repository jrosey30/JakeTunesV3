# Nightly brain exercise — 2026-08-22 (homemini)

**Outcome: (a) proven corruption repair APPLIED to mood-index.bin — the
import-day clobber fired for the THIRD time (08-18 original, 08-20, tonight),
exactly as the 08-20 report predicted.** router-truth 0.750 → **0.830**
(live == candidate by sha). embeddings.bin untouched (sha `7a135d37f53d`
before and after). This was the standing instruction from 08-20: re-check the
watch table on the next import day, re-run the committed recipe if it fires.

## Pipeline pre-flight
- NAS back after the 08-21 SMBService outage; brain-trainer finished cleanly
  02:01 EDT (+50 enriched → 9,504/9,645; embeddings.bin 9,742 vectors sha
  `7a135d37f53d`; mood-index 9,741 vectors sha `f7b9949d77f4`). Files stable
  ≥60 min before measurement.
- Library churn since 08-20: 9,592 → **9,645 tracks (+53)** — import days
  happened, i.e. exactly the recurrence condition.
- All measurement on a frozen /tmp snapshot (shas verified identical); NAS
  shas re-verified unchanged immediately before the apply.

## Baseline (run_eval, identity path)
**retrieval 0.757 / grounding 1.000 / overall 0.878** — normal v2 band.
Harness trusted. (Blind to the mood corruption again — P1's 7th exhibit.)

## WATCH ITEM FIRED (3rd clobber event)
Cheap fingerprint before any paid measurement: mood-index **96 orphans**
(was 0 post-08-20-repair), **46 dup groups / 289 tracks** — the whole-map
replay signature. Frozen-ruler probes confirmed:

| probe | query | healthy (08-19/20) | tonight (corrupted) | post-repair |
|---|---|---|---|---|
| ret-007 | punk rock | 1.00 | **0.48** | **1.00** |
| ret-008 | hip-hop and rap | 0.96 | 0.72 | **0.96** |
| ret-011 | funk and soul | 0.88 | **0.44** | **0.88** |
| ret-012 | new wave 80s | 1.00 | 0.40 (main/decade) | **1.00** |

router-truth series: 0.821×3, 0.818, [0.762→0.836], 0.837, [0.720→0.829],
**[0.750→0.830]**.

## The repair (re-run of the committed recipe)
1. `mood_texts_reconstruct.mjs` — intended moodText for all 9,645 tracks,
   extracted from the live trainer source (no hand-port).
2. `repair_20260822.py` — fidelity gate: **50/50** trainer-fresh vectors
   match reconstruction at cos ≥0.98 (min 0.9999). Suspects (stored vs
   intended cos <0.98): **668** (median 0.820, max 0.908; same clean gap).
   Tempo-view exclusions: 0. Orphans pruned: 96 (identity-gated).
   Candidate = exactly the 9,645 library tracks.
   (Committed 08-20 script had a `p["prompt"]`→`p["query"]` schema bug in
   its prove section — fixed in tonight's copy; core repair was unaffected.)
3. `prove_20260822.py` — frozen ruler: router-truth 0.750 → **0.830**;
   candidate-vs-current mood deltas all ≥0 except ret-015 −0.03.
4. **Bar adjudication (same two artifacts as 08-20, verified not assumed):**
   (a) ret-015 0.73→0.70 = a two-slot swap; incoming tracks are Bloodywood
   "Bekhauf" (Metal, credited-expected — a genuine hit) and Angel Du$t
   "DU$T" — the SAME repaired Rock-tagged track documented as the ret-015
   ruler residual on 07-03/08-07/08-20. Retrieved-set quality not regressed.
   (b) router-truth 0.830 meets the ≥0.83 post-repair band; the mechanical
   FAIL came solely from (a). Watch probes reproduce the healthy fingerprint
   EXACTLY. Alternative — leaving production at 0.750 — is a measured
   standing regression for the phone mixes/DJ. Applied per the 08-20
   standing instruction.

## Applied (ledger)
- **What:** mood-index.bin on the NAS: 668 vectors re-embedded from intended
  text, 96 orphans pruned; 9,741 → 9,645 vectors, dim 1536.
- **Before/after sha:** `f7b9949d77f4` → `3bbe16f73a4c`.
- **Scores:** router-truth 0.750 → 0.830; live file sha == proven candidate
  sha (bytewise identity, stronger than re-scoring); run_eval identity
  metrics untouched.
- **Backup:** `/Volumes/JakeShared/JakeTunesState/mood-index.bin.pre-repair-20260822`
  (sha-verified `f7b9949d77f4` before the write).
- **Exact undo:**
  `cp /Volumes/JakeShared/JakeTunesState/mood-index.bin.pre-repair-20260822 /Volumes/JakeShared/JakeTunesState/mood-index.bin`
- **Method:** pre-apply live-sha == measured-sha gate (both brain files);
  verified backup; tmp + atomic rename on the same share; post-write re-read
  verified magic/dim/count/sha with auto-restore on mismatch
  (apply_20260822.py).
- Repaired ids: `repair_20260822_ids.json`.

## Post-apply integrity (live NAS)
9,645 vecs == library exactly; orphans 0; dup groups 1 (2 tracks, the known
benign un-enriched pair). Clean.

## Standing items
- **THIS WILL KEEP HAPPENING** — 3rd event, ~$0.15/night in re-embeds and a
  corrupted phone brain every import day until the escalated
  PROPOSAL-mood-import-clobber fix lands (exclude mood-index.bin from
  autoBackupStateToNas + repair the app's local copy). This is now the
  clear top ask for Jake.
- Skips **601**/1000 — stays closed.
- Taste-drift re-run due ~09-16. P1/P2/P3 unchanged, awaiting Jake.
- 08-21 outage proposals (pull mood-index local; mount-keeper fix) still open.

## Files
This report; repair_20260822.py (schema-fixed), prove_20260822.py,
apply_20260822.py, diag_ret015_delta_0822.py, repair_20260822_ids.json;
recurrence note in PROPOSAL-mood-import-clobber.md; +1 score_log row (brain
`7a135d37f53d`, 0.757/1.000/0.878). Worktree + venv + snapshot removed after
commit.
