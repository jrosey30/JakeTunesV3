# Nightly brain exercise — 2026-09-14 (homemini)

**Outcome: (b) — nothing beat baseline, nothing changed; brain untouched
(shas verified before + after). All open levers remain Jake-gated proposals.**

## State / coordination

- brain-trainer clean (launchd, 06:00:03–06:01:54Z): +50 enriched, brain
  10,529/10,877, embeddings.bin 10,896 vectors, 500 tempo catch-up, 56 orphan
  descriptors (steady). Brain mtimes = trainer-done time (02:01 EDT) — no
  post-trainer writer (09-04 replay class absent).
- Snapshot /tmp/brain-snap-20260914, sha-verified ×3 before copy:
  embeddings `caf441b61dff68d30f90ee52d1fbd8a01ac5b8c1`,
  mood `732bead20795c87ef5a2ecf01497342b85c97ab4`. Re-verified UNCHANGED
  (sha + size + mtime) at end of night — brain untouched.

## Pre-check (clobber fingerprint)

18 orphans / 5 dup groups — byte-identical benign id list to 09-08→09-13
(11338–11349 block + the 6 same-day-deleted ids). **No clobber; 10th
consecutive import day without one** (luck not fix — replay writer unfixed,
PROPOSAL-mood-import-clobber fixes 4/5 still TOP ask). Embeddings orphans
steady at 152. Library 10,877 (+0 — fully quiet day).

## Baseline (frozen snapshot; 1-token Anthropic probe 200 first)

retrieval **0.749** / grounding **1.000** (traps 4/4) / overall **0.875** — v2
band. Router-truth **0.813** — one-slot wobble on the predicted plateau
(0.819→0.819→0.816→0.816→0.813), mood-routed shifts within noise.

`exp_20260914_sag_decomp.py` (6th series point): orphan component **+0.011**
(series 0.013/0.013/0.011/0.011/0.011/0.011 — **six-point-proven floor tax**,
worst per-probe delta +0.00 again); un-enriched **+0.007** (flat vs 09-13;
stale mood cohort still EXACTLY 215 = queue-locked, **5th night**); S2 ceiling
0.830 healthy. Model unchanged: rt pinned ~0.813–0.819 until the queue reaches
the 215 cohort or a trainer-side orphan prune lands (+0.011, Jake-gated).

## Backlog / watchlist

- Enrichment backlog **398→348** (fourth consecutive drain night, −50 on a
  +0-import day; ~7 quiet nights to clear).
- Watchlist 33/34 (11467–11499+454) STILL te=False after a 10th 500-re-encode
  night; queue position ~4,488 ≈ **8 nights** (10th data point appended to
  PROPOSAL-tempo-catchup-queue-order).

## Tonight's verification: deployed taste `W` lockstep (proposal premise guard)

PROPOSAL-taste-weights-refresh-v4.md (filed 09-13) targets the exact shipped
v4 constants, and the deployed `W` has moved silently once before — so tonight
re-diffed all three surfaces: `src/renderer/utils/tasteScore.ts` (V3),
`~/JakeTunesMobile/backend/src/util/tasteScore.ts`, AND the compiled
`backend/dist/util/tasteScore.js` actually serving the phone. All three carry
the identical v4 line (`bias -6.529 … intensity 4.65`) = the proposal's
"current" block verbatim. **Premise intact; proposal stands as written.**

## Skips

Gate unchanged: ~3k merged skips (~mid-Oct), v4 verbatim re-run only.

## Score log

One run_eval row appended (retrieval 0.749 / grounding 1.000 / overall 0.875).
