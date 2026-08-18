# Nightly brain exercise — 2026-08-18 (homemini)

**Outcome: (a) proven corruption repair APPLIED to mood-index.bin.**
router-truth 0.762 → **0.836** on the live NAS files, zero regressions.
embeddings.bin untouched (sha `0f0e53b57e63` before and after).

## Pipeline pre-flight
- brain-trainer finished cleanly 02:01 EDT (+50 enriched → 9,357/9,590;
  embeddings.bin 9,663 vectors). Files stable ≥64 min before measurement;
  library.json last written 00:02 (before the trainer) and stable throughout.
- All measurement on a frozen /tmp snapshot; NAS mtime+size+sha re-verified
  unchanged immediately before the apply.

## Baseline
**retrieval 0.763 / grounding 1.000 / overall 0.882** — normal band, slightly
above 08-17 (0.752) from enrichment draining. Self-test fired. Harness trusted.

## The anomaly: router-truth 0.818 → 0.759 (largest move ever recorded)
The stable series (0.821 × 3, 0.818) collapsed overnight. Per-probe: the
genre-flavored mood probes cratered — ret-007 "punk rock" 1.00→0.52,
ret-008 "hip-hop and rap" 0.84→0.68, ret-011 "funk and soul" 0.84→0.48,
ret-012 "new wave 80s" mood 1.00→0.45 — while pure-vibe probes (ret-013/14/15)
held exactly. Identity index: healthy, zero duplicates.

## Root cause (proven, read-only forensics)
- The mood index gained +69 vectors overnight (9,593→9,662) while the library
  netted +7 tracks (~70 added, ~63 removed in daytime churn — orphans 10→73).
- **228 tracks in 39 groups share byte-identical mood vectors.** Fingerprint:
  cos(stored, embed("genre: Rap")) = **1.0000** for the rap group; same for
  "genre: Rock" etc. Their mood text had collapsed to the bare genre line.
- These tracks (added 08-09..08-16: Migos, Akon, Jungle, Dido, Hoobastank…)
  HAVE descriptors and bpm today — the trainer enriched them on prior nights —
  so their rich vectors existed and were **clobbered by a stale daytime write**.
  Writer: the app's import-time embed (buildMoodText runs before bpm analysis /
  without descriptors) + the day sync carrying the stale map over the NAS copy.
  The mobile backend never writes mood-index; the trainer wrote only 50 tonight
  (verified by .bak diff). JakeTunes.app is live on homemini (pid 26783).
- Since the nightly-50 only visits *un-enriched* tracks, these clobbered
  vectors would NEVER self-heal.
- 44 of the duplicate vectors are **orphans** (imported-then-deleted ids
  10570–10599) — pure poison: they can never resolve to a real track, and they
  owned the ENTIRE top-25 for "hip-hop and rap" mid-repair.

## The bounded repair (one change, grounded, reversible)
1. Reconstructed each suspect track's intended moodText with an exact port of
   the trainer's algorithm (descriptor from brain-descriptors.json + tempo/key
   from library.json + genre — all grounded, nothing invented).
   Port fidelity gate: all 50 vectors the trainer wrote tonight must match my
   reconstruction at cos ≥ 0.98 → 49/50 did; the 1 miss (10606 Stereolab) was
   a post-trainer bpm churn (teb 152.3 recorded, library bpm now null) →
   **excluded** by rule: never repair where my tempo view is poorer than the
   trainer's.
2. Repair set: 514 in-library tracks where cos(stored, intended) < 0.98
   (median 0.814, max 0.908 — clean gap, no borderline cases). Re-embedded
   intended texts; swapped into a candidate index.
3. Prune: removed all 72 orphan mood vectors (identity-gated: id ∉ library.json;
   fully reversible via backup). Candidate = exactly the 9,590 library tracks.
4. **Proof on the frozen ruler:** identity-only 0.763 unchanged (by
   construction); router-truth 0.762 → **0.836**; worst per-probe mood delta
   **+0.00** (no regression anywhere); the candidate's mood column reproduces
   the known-good 08-11 fingerprint (ret-007 1.00, ret-011 0.84, ret-012 1.00,
   ret-013 1.00, ret-014 0.30, ret-015 0.73) with ret-004/006/008 above it.

## Applied (ledger)
- **What:** mood-index.bin on the NAS: 514 vectors re-embedded from intended
  text, 72 orphan vectors pruned; 9,662 → 9,590 vectors, dim 1536.
- **Before/after sha:** `0092e5827429` → `e5198f2c3122`.
- **Scores:** router-truth 0.762 → 0.836 (live-verified post-apply);
  run_eval retrieval/grounding/overall 0.763/1.000/0.882 unchanged.
- **Backup:** `/Volumes/JakeShared/JakeTunesState/mood-index.bin.pre-repair-20260818`
  (sha-verified `0092e5827429` before the write; trainer's own .bak untouched).
- **Exact undo:**
  `cp /Volumes/JakeShared/JakeTunesState/mood-index.bin.pre-repair-20260818 /Volumes/JakeShared/JakeTunesState/mood-index.bin`
- **Method:** temp file + atomic rename in the same dir; post-write re-read
  verified magic/dim/count/sha; embeddings.bin untouched (mtime+size verified).
- Repaired ids committed as `repair_20260818_ids.json`.
- Apply-with-app-running rationale: the mood index is *designed* for external
  nightly writers while the app runs (mtime-tracked cache in mood-index.ts);
  tonight's trainer write with the same app running stuck (verified). No
  imports occur at 3 AM. Laptop-era "app quit" gate applies to library.json
  flows, not this file.

## WATCH ITEM for tomorrow's nightly (me) + root-cause ask (Jake)
- **If genre-probe mood scores collapse again**, the daytime clobber recurred —
  re-run this repair (script pattern in this report) and escalate.
- **Gated proposal for Jake (app code, not my lane):**
  → `PROPOSAL-mood-import-clobber.md` — import-time mood embeds write bare
  "genre: X" texts and can clobber enriched vectors; orphan vectors are never
  pruned. Fix at the writer (respect descriptors/bpm-pending, or defer new-track
  mood vectors to the trainer) + prune orphans in the trainer.

## Standing items
- P1 router-aware eval: tonight is the definitive exhibit — run_eval read
  0.763 "normal" while production had silently lost 0.06; the eval was BLIND
  to a real production regression. 5th router-truth point.
- P2 (S2 variant), P3, taste-weights refresh: unchanged, awaiting Jake.
- Skips 529/1000 — stays closed. Taste-drift re-run due ~09-16.
- 329 stale NAS tmps + now 73 identity-index orphans: daytime hygiene, benign.

## Files
This report, `PROPOSAL-mood-import-clobber.md`, `repair_20260818_ids.json`,
+2 baseline score_log rows. Worktree + venv + /tmp snapshot removed after commit.
