# PROPOSAL — refresh the tasteScore `W` constants (taste-weight drift, 2026-08-16)

**Status: PROPOSED, awaiting Jake. Nothing applied — this is a code change to both
tasteScore twins (needs desktop rebuild), so it's outside the nightly auto-apply lane.**

## Finding

The deployed `W` block (learned 2026-06-30 on ~8.1k tracks, commit f499b4c) has
measurably drifted. On today's 9,507-track library (★1,202 vs 1,600 unstarred-old,
the locked taste-eval protocol, RepeatedStratifiedKFold 5×5 rs=0, leak-safe
per-fold affinities):

| arm | held-out AUC |
|---|---|
| A — deployed constants (exact shipped `W`) | **0.7818 ± 0.0183** |
| B — per-fold refit ceiling | 0.8079 ± 0.0148 |
| C — candidate constants (below, exact rounded values verified) | **0.8084 ± 0.0146** |

Paired C−A = **+0.0266 (SE 0.0019, t = +14.2)** on identical folds. The candidate
recovers the entire refit ceiling — the linear model is saturated; nothing more to
squeeze from these features.

Robustness (both pre-registered before running):
- **Repeats-split sanity**: constants derived from CV repeats 0–2 only, evaluated on
  repeats 3–4 → C−A **+0.0268** (same magnitude, derivation-clean).
- **Symmetric-task check** (`taste_drift_check_symmetric.py`): the task's positives
  include post-2026-05-25 stars while negatives are all old adds — recency could
  proxy "recently added". Restricting BOTH classes to old adds (★806 vs 1,600):
  C−A **+0.0207 (t = +12.1)**, and the symmetric refit independently learns
  recency POSITIVE (+0.38). The drift is real taste behavior, not cutoff artifact.

## What drifted (the interesting part)

```
              deployed   candidate
album          +8.636     +6.275     still dominant, but less extreme
artist         +3.790     +3.493     ~same
genre          +0.989     +0.548     halved
decade         -0.164     +0.060     ~noise either way (as documented)
plays          +0.810     +0.525     softened
recency        -0.554     +0.629     ★ SIGN FLIP — recent plays now PREDICT stars
bias           -4.455     -4.816
```

The June model said "recently played ⇒ slightly LESS likely starred"; three more
months of listening says the opposite. Jake's recent rotation now tracks what he
stars. Behavioral consequence if shipped: mixes / DJ sets / "Songs You'd Star"
will tilt a bit toward recently-played tracks — that's what the data says his
stars do, but it mildly strengthens the "more of what I just played" loop. Worth
knowing before saying yes.

## Exact change (if approved)

In BOTH twins — `backend/src/util/tasteScore.ts` (JakeTunesMobile) and
`src/renderer/utils/tasteScore.ts` (JakeTunesV3), same `const W` block, lockstep:

```ts
const W = { bias: -4.816, album: 6.275, artist: 3.493, genre: 0.548, decade: 0.060, plays: 0.525, recency: 0.629 }
```

(These exact rounded values are what was verified at 0.8084 — not the unrounded means.)

Then: commit both repos → `ssh jakerosenbaumnas@homemini 'cd ~/JakeTunesMobile && git pull && ./deploy/install-on-mini.sh'` → desktop twin ships on the next laptop build.

## Exact undo

Restore the current block in both twins and redeploy the same way:

```ts
const W = { bias: -4.455, album: 8.636, artist: 3.79, genre: 0.989, decade: -0.164, plays: 0.81, recency: -0.554 }
```

## Reproduce

`JT_STATE_DIR=/Volumes/JakeShared/JakeTunesState python taste_weight_drift.py`
(+ `taste_drift_check_symmetric.py`, `taste_drift_verify_rounded.py`). Read-only;
reads NAS library.json only.

## Maintenance note

Constants learned once and frozen decay ~0.02 AUC per ~6 weeks of listening.
If approved, consider re-running this drift check every month or two (it's cheap
and read-only) rather than waiting for another nightly to trip over it.
