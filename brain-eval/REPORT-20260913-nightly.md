# Nightly brain exercise — 2026-09-13 (homemini)

**Outcome: (b)+(c) — brain untouched; monthly taste-drift re-run CROSSED its
pre-registered bar → new gated proposal (PROPOSAL-taste-weights-refresh-v4.md).
Nothing auto-applied (constants live in app code = Jake's lane).**

## State / coordination

- brain-trainer clean (launchd, 06:00:01–06:01:42Z): +50 enriched, brain
  10,479/10,877, embeddings.bin 10,846 vectors, 500 tempo catch-up, 56 orphan
  descriptors (steady).
- Snapshot /tmp/brain-snap-20260913, sha-verified ×3 before copy:
  embeddings `489a4068709863e8177e47efb8d3e5a76930249f`,
  mood `f87f9e2dc5c7cf366aa0d3a3e20285c3f5011de0`. Re-verified UNCHANGED
  (sha + size + mtime 02:01) at end of night — brain untouched.

## Pre-check (clobber fingerprint)

18 orphans / 5 dup groups — byte-identical benign id list to 09-08→09-12
(11338–11349 block + the 6 same-day-deleted ids). **No clobber; 9th consecutive
import day without one** (clobber 15/23; luck not fix — replay writer unfixed,
PROPOSAL-mood-import-clobber fixes 4/5 still TOP ask). Embeddings orphans steady
at 152. Library 10,877 (+1 — quiet day).

## Baseline (frozen snapshot; 1-token Anthropic probe 200 first)

retrieval **0.752** / grounding **1.000** (traps 4/4) / overall **0.876** — v2
band. Router-truth **0.816** — flat on the predicted plateau
(0.805→0.819→0.819→0.816→0.816).

`exp_20260913_sag_decomp.py` (5th series point): orphan component **+0.011**
(series 0.013/0.013/0.011/0.011/0.011 — five-point-proven floor tax, worst
per-probe delta +0.00 again); un-enriched **+0.007** (0.022→0.011→0.009→0.009→
0.007, self-heal on schedule; stale mood cohort still EXACTLY 215 = queue-locked,
4th night); S2 ceiling 0.834 healthy. Confirms the 09-12 model: rt pinned
~0.816–0.819 until the queue reaches the 215 cohort or a trainer-side orphan
prune lands.

## Backlog / watchlist

- Enrichment backlog **447→398** (third real drain night, −49 on a +1-import
  day; ~8 quiet nights to clear).
- Watchlist 33/34 (11467–11499+454) STILL te=False after a 9th 500-re-encode
  night; queue position ~4,988 ≈ **9 nights** (9th data point for
  PROPOSAL-tempo-catchup-queue-order).

## Tonight's experiment: monthly taste-weight drift re-run (v4 model)

Due ~09-16 (last 08-16); ran tonight on the quiet night. **Discovery first: the
committed drift script measures the pre-v4 constants — taste v4 shipped 08-23
(JakeTunesMobile 7d8c29f + desktop twin, verified in lockstep tonight: identical
`W` + intensity feature), so the check was rebuilt for the v4 parameterization**
(`taste_weight_drift_v4_20260913.py`, same locked protocol, bar pre-registered
in-file before running).

Results (1,376 ★ vs 1,600 unstarred-old, 5×5 folds, leak-safe):

| arm | AUC |
|---|---|
| deployed v4 `W` | 0.8133 ± 0.0140 |
| refit ceiling | 0.8202 |
| leak-safe candidate | 0.8207 (C−A +0.0074, t +6.1) |
| **full-rate candidate (deployment parity)** | **0.8216 (D−A +0.0083, SE 0.0013, t +6.4)** |

Bar (Δ≥+0.005 AND ≥2·SE AND repeats-split agrees, split +0.0064): **CROSSED** →
**PROPOSAL-taste-weights-refresh-v4.md** (exact wire-in constants, undo, tradeoff:
album weight halved, artist doubled, recency sign-flipped positive again). Old
PROPOSAL-taste-weights-refresh.md marked SUPERSEDED (its target constants died
with the v4 deploy). Second drift data point: +0.027/6wk, now +0.008/3wk —
roughly tracks library growth; nightly re-derivation (constants as data) noted
as a future design ask.

## Skips

Not the night's focus; gate is ~3k merged (~mid-Oct), v4 verbatim re-run only.

## Score log

One run_eval row appended (retrieval 0.752 / grounding 1.000 / overall 0.876).
