# Nightly brain exercise — 2026-08-16 (homemini)

**Brain untouched.** embeddings.bin sha `9d99fbd31a5a` (9,543 vectors) and
mood-index.bin sha `fc678ab43a1f` identical before and after; both last written
by brain-trainer at 02:01, verified stable before measuring and unchanged after.

## Pipeline

brain-trainer ran clean at 02:00 (+50 enriched → 9,257/9,507; descriptor backlog
250, draining at 50/night). No mid-write races; measured the canonical NAS brain.

## Baseline (run_eval, JT_STATE_DIR=NAS)

**retrieval 0.754 / grounding 1.000 / overall 0.877** — per-probe identical to
08-15 (ret-014 0.20, ret-015 0.50 = documented wobble band). Encoding-v2 normal.

## Router-truth: THIRD identical point

diag_ret011_012 router emulation: **router-truth 0.821** — exactly matching
08-11 and 08-15 while the identity-only ruler wobbled 0.756→0.791→0.754→0.754
over the same window. Production retrieval is flat-line stable; the eval wobble
is entirely a ruler property. This is now three-for-three evidence for **P1
(router-aware eval)**, still awaiting Jake.

## Tonight's experiment: taste-weight drift check → PROPOSAL, bar met

New bounded read-only experiment (`taste_weight_drift.py`): do the deployed
tasteScore `W` constants (learned 2026-06-30 on ~8.1k tracks) still hold on
today's 9,507-track library with 6+ weeks more plays/stars?

**No — they've drifted by a tightly-measured margin.** Deployed constants score
0.7818 held-out; re-learned candidate constants score **0.8084 (paired +0.0266,
SE 0.0019, t=+14.2)**, recovering the full refit ceiling. Survived both
pre-registered robustness checks: repeats-split derivation (+0.0268) and the
symmetric-task check that rules out the dateAdded-cutoff artifact (+0.0207,
t=+12.1). Headline drift: **recency's sign FLIPPED** (−0.554 → +0.629 —
Jake's recent rotation now predicts his stars; independently confirmed on the
symmetric task), album weight softened 8.6→6.3, genre halved, decade still noise.

**Not applied** — it's a code change to both tasteScore twins (backend +
desktop, desktop needs a laptop rebuild), so per the nightly convention it's
gated: **PROPOSAL-taste-weights-refresh.md** has the exact verified constants,
behavioral tradeoff (mildly strengthens the recently-played tilt in mixes),
exact undo, and repro commands.

## Standing items

- P1 / P2 / P3 unchanged, awaiting Jake (P1 now has 3 identical router-truth points).
- Skips ~520/1000 — stays closed.
- 329 stale NAS tmps unchanged, no new litter tonight.
- New standing observation: frozen taste constants decay ~0.02 AUC / ~6 weeks;
  a monthly read-only drift re-run is cheap insurance (noted in the proposal).

## Files

`taste_weight_drift.py` (main experiment, pre-registered bar in-file),
`taste_drift_check_symmetric.py`, `taste_drift_verify_rounded.py`,
`PROPOSAL-taste-weights-refresh.md`, +1 score_log row.
