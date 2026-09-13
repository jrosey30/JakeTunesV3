# PROPOSAL — refresh the taste v4 `W` constants (drift re-run, 2026-09-13)

**Status: PROPOSED, awaiting Jake. Nothing applied — this is a code change to both
tasteScore twins (needs desktop rebuild), so it's outside the nightly auto-apply lane.**

Supersedes the drift half of PROPOSAL-taste-weights-refresh.md (whose 08-16 constants
were themselves superseded by the taste v4 deploy on 08-23).

## Finding

The monthly taste-drift re-run (due ~09-16, run 09-13) found the **v4 constants
deployed 2026-08-23 (JakeTunesMobile 7d8c29f + desktop twin, verified in lockstep
tonight) have already drifted** on the 10,877-track library — the September import
wave (~+1,270 tracks in 3 weeks, plus new stars/plays) reshaped the affinity
landscape.

Protocol: the locked taste-eval shape — task rows ★1,376 vs 1,600 unstarred-old
(dateAdded < 2026-05-25, seed 42), RepeatedStratifiedKFold(5×5, rs=0), leak-safe
per-fold smoothed affinities (k=4), global behavior features (playNorm, recencyNorm,
intensity = log1p(plays)/monthsOwned exactly as `tasteScore.ts` computes it).
Scripts: `taste_weight_drift_v4_20260913.py` + `drift_v4_armD_fullrate_20260913.py`
(both committed; read-only, ran on the frozen 09-13 snapshot).

| arm | held-out AUC |
|---|---|
| A — deployed v4 constants (exact shipped `W`) | **0.8133 ± 0.0140** |
| B — per-fold refit ceiling | 0.8202 ± 0.0129 |
| C — leak-safe candidate (mean of refits) | 0.8207 ± 0.0128 |
| D — **full-rate-derived candidate (deployment parity — the wire-in set)** | **0.8216 ± 0.0127** |

- Paired **D−A = +0.0083 (SE 0.0013, t = +6.4)** on identical folds; C−A = +0.0074
  (t = +6.1). Pre-registered bar (declared in-script before running: Δ≥+0.005 AND
  ≥2·SE AND repeats-split sanity agrees) — **CROSSED**; split sanity +0.0064.
- The candidate reaches the refit ceiling — linear model saturated, nothing beyond a
  constants swap to chase.

## The change (one `const W` line, in BOTH twins)

`~/JakeTunesMobile/backend/src/util/tasteScore.ts` and
`src/renderer/utils/tasteScore.ts` (JakeTunesV3), same line each:

```ts
// current (v4, 2026-08-23):
const W = { bias: -6.529, album: 12.625, artist: 1.892, genre: -0.068, decade: 0.285, plays: -0.824, recency: -0.191, intensity: 4.65 }
// proposed (v4.1, derived 2026-09-13, full-rate basis = deployment parity, LogReg C=0.2 balanced):
const W = { bias: -2.283, album: 6.563, artist: 3.833, genre: 0.377, decade: 0.114, plays: 0.136, recency: 0.687, intensity: 1.556 }
```

Feature set unchanged — no code beyond the constants. Deploy = commit both twins,
push JakeTunesMobile main (auto-deploys), desktop ships next build.

## What the shifts say

- **album 12.6 → 6.6, artist 1.9 → 3.8**: the wave added many albums with scattered
  stars, so per-album affinity got noisier while per-artist signal firmed up.
- **recency −0.19 → +0.69**: recently-played tilts predictive again (same sign-flip
  the 08-16 run caught before v4 re-flipped it — this coefficient genuinely follows
  Jake's current listening mode; it is the least stable weight).
- **intensity 4.65 → 1.56, plays −0.82 → +0.14**: intensity still carries the
  behavior signal, just less extreme once 3 more weeks of ownership-age accrued.

## Tradeoff / risk

Mildly strengthens artist-level and recent-rotation tilt in mixes/DJ sets, softens
whole-album tilt. All ranking-only (mixes, DJ candidate pools, Songs You'd Star) —
no data writes, fully reversible.

## Undo

Revert the `const W` line in both twins to the current values above; redeploy.

## Standing lesson (second data point)

Frozen constants decayed +0.027 in 6 weeks (06-30→08-16) and now +0.008 in 3 weeks
(08-23→09-13) — drift is roughly proportional to library growth, and the September
wave was big. The monthly read-only drift re-run stays cheap insurance; if Jake
wants, a trainer-side nightly re-derivation (constants as data, not code) would end
the decay class permanently — that's a separate design ask.
