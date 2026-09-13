#!/usr/bin/env python3
"""
Taste-weight DRIFT check, v4 model (nightly 2026-09-13) — READ-ONLY experiment.

The monthly drift re-run was due ~09-16 (last run 08-16). But the 08-16 script
(taste_weight_drift.py) measures the OLD 7-feature v2 constants, which are no
longer deployed: taste v4 shipped 2026-08-23 (JakeTunesMobile 7d8c29f, desktop
twin in lockstep — verified tonight) with a NEW 8th feature playINTENSITY
(log1p(plays)/monthsOwned, fallback 24 months, floor 1) and re-learned W:
  W = { bias -6.529, album 12.625, artist 1.892, genre -0.068,
        decade 0.285, plays -0.824, recency -0.191, intensity 4.65 }
This script is the SAME locked protocol as 08-16 with the v4 parameterization:

  Task rows: ★ tracks vs unstarred dateAdded<2026-05-25 (neg capped 1600, seed 42).
  Features: per-fold leak-safe smoothed (k=4) star-affinity for
    album/artist/genre/decade (unseen key → train-fold prior), playNorm =
    log1p(playCount)/playMax (playMax over FULL library, as deployed),
    recencyNorm = 1 − min(daysAgo,3650)/3650, intensity = log1p(playCount) /
    max(1, monthsOwned) (global features: no rating input → no leak).
  Folds: RepeatedStratifiedKFold(5x5, random_state=0), identical for all arms.
  Arm A: EXACT deployed v4 constants (fixed formula), held-out AUC per fold.
  Arm B: per-fold refit LogReg (C=0.2, balanced, raw features) — the ceiling.
  Arm C: candidate fixed constants = mean of arm-B coefficient vectors,
         evaluated exactly like A. Sanity split: constants from repeats 0-2,
         evaluated on repeats 3-4 only.

PRE-REGISTERED DECISION BAR (declared before running, same as 08-16):
  Propose (NOT apply — code change, both tasteScore twins + desktop rebuild =
  Jake's gate) new constants ONLY if paired mean(C−A) ≥ +0.005 AND ≥ 2·SE over
  the 25 folds AND the repeats-split sanity check agrees in sign.
  Otherwise: constants hold, change nothing.

Caveat carried from the v4 derivation: deployed W was re-derived on the
FULL-RATE basis for deployment parity, so arm A on leak-safe fold features is
the held-out measure of the deployed formula, comparable to the 0.8039/0.8096
lab numbers — not a claim about in-app scores. If the bar is ever crossed, the
PROPOSAL constants must be re-derived full-rate (the v4 pattern) before wiring.

Reads the frozen snapshot library.json via JT_STATE_DIR. Writes NOTHING.
"""
import json, os, sys, datetime
from collections import defaultdict
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import RepeatedStratifiedKFold
from sklearn.metrics import roc_auc_score

SD = os.environ.get("JT_STATE_DIR") or os.path.expanduser("~/Library/Application Support/JakeTunes")
LIB = os.path.join(SD, "library.json")

# EXACT deployed constants — backend/src/util/tasteScore.ts const W (v4, 7d8c29f 2026-08-23)
W_DEPLOYED = {"bias": -6.529, "album": 12.625, "artist": 1.892, "genre": -0.068,
              "decade": 0.285, "plays": -0.824, "recency": -0.191, "intensity": 4.65}
FEATS = ["album", "artist", "genre", "decade", "plays", "recency", "intensity"]

def k_artist(t): return (t.get("albumArtist") or t.get("artist") or "?").strip().lower()
def k_album(t):  return ((t.get("albumArtist") or t.get("artist") or "?") + " ::: " + (t.get("album") or "?")).strip().lower()
def k_genre(t):  return (t.get("genre") or "?").strip().lower()
def k_dec(t):
    try:
        y = int(t["year"])
        return (y // 10) * 10 if y > 0 else 0
    except Exception:
        return 0

def months_owned(t, now_ms):
    da = t.get("dateAdded") or ""
    if not da:
        return 24.0
    try:
        ms = datetime.datetime.fromisoformat(str(da).replace("Z", "+00:00")).timestamp() * 1000
    except Exception:
        return 24.0
    return max(1.0, (now_ms - ms) / (30 * 86400000))

def main():
    lib = json.load(open(LIB))["tracks"]
    print(f"library: {len(lib)} tracks  ({LIB})")

    play_max = max((np.log1p(float(t.get("playCount") or 0)) for t in lib), default=0.0)
    now_ms = int(datetime.datetime.now().timestamp() * 1000)

    def starred(t): return (t.get("rating", 0) or 0) >= 1
    def unstarred_old(t): return (t.get("rating", 0) or 0) == 0 and t.get("dateAdded", "") < "2026-05-25"
    pos = [t for t in lib if (t.get("artist") or t.get("title")) and starred(t)]
    neg = [t for t in lib if (t.get("artist") or t.get("title")) and unstarred_old(t)]
    rng = np.random.default_rng(42)
    neg = list(rng.choice(neg, size=min(1600, len(neg)), replace=False))
    tracks = pos + neg
    y = np.array([1] * len(pos) + [0] * len(neg))
    print(f"task rows: {len(pos)} starred vs {len(neg)} unstarred-old")

    # global (rating-free) behavior features, computed once
    def g_feats(t):
        pl = np.log1p(float(t.get("playCount") or 0))
        play_norm = pl / play_max if play_max > 0 else 0.0
        lp = float(t.get("lastPlayedAt") or 0)
        days = (now_ms - lp) / 86400000 if lp > 0 else 3650.0
        recency = 1.0 - min(days, 3650.0) / 3650.0
        intensity = pl / months_owned(t, now_ms)
        return play_norm, recency, intensity
    G = np.array([g_feats(t) for t in tracks])

    def fold_features(train_idx, all_idx):
        """Leak-safe: affinities from TRAIN fold rows only (k=4 smoothing)."""
        tr = [tracks[i] for i in train_idx]
        prior = float(np.mean([1 if starred(t) else 0 for t in tr]))
        maps = {}
        for name, keyf in (("album", k_album), ("artist", k_artist), ("genre", k_genre), ("decade", k_dec)):
            s, n = defaultdict(int), defaultdict(int)
            for t in tr:
                key = keyf(t)
                n[key] += 1
                if starred(t): s[key] += 1
            maps[name] = {k: (s[k] + 4 * prior) / (n[k] + 4) for k in n}
        rows = []
        for i in all_idx:
            t = tracks[i]
            rows.append([
                maps["album"].get(k_album(t), prior),
                maps["artist"].get(k_artist(t), prior),
                maps["genre"].get(k_genre(t), prior),
                maps["decade"].get(k_dec(t), prior),
                G[i, 0], G[i, 1], G[i, 2],
            ])
        return np.array(rows)

    def fixed_score(X, w):
        z = w["bias"] + sum(w[f] * X[:, j] for j, f in enumerate(FEATS))
        return 1.0 / (1.0 + np.exp(-z))

    rskf = RepeatedStratifiedKFold(n_splits=5, n_repeats=5, random_state=0)
    a_scores, b_scores, coefs, folds = [], [], [], []
    for tr_idx, te_idx in rskf.split(np.zeros(len(y)), y):
        Xtr = fold_features(tr_idx, tr_idx)
        Xte = fold_features(tr_idx, te_idx)
        a_scores.append(roc_auc_score(y[te_idx], fixed_score(Xte, W_DEPLOYED)))
        m = LogisticRegression(C=0.2, class_weight="balanced", max_iter=2000)
        m.fit(Xtr, y[tr_idx])
        b_scores.append(roc_auc_score(y[te_idx], m.predict_proba(Xte)[:, 1]))
        coefs.append(np.concatenate([m.intercept_, m.coef_[0]]))
        folds.append((tr_idx, te_idx))
    a_scores, b_scores = np.array(a_scores), np.array(b_scores)
    print(f"\nArm A deployed v4 W:   AUC {a_scores.mean():.4f} ± {a_scores.std():.4f}")
    print(f"Arm B per-fold refit:  AUC {b_scores.mean():.4f} ± {b_scores.std():.4f}  (ceiling)")

    cand_vec = np.mean(coefs, axis=0)
    W_CAND = dict(zip(["bias"] + FEATS, np.round(cand_vec, 3)))
    print(f"candidate constants (mean of refits): {W_CAND}")

    c_scores = []
    for tr_idx, te_idx in folds:
        Xte = fold_features(tr_idx, te_idx)
        c_scores.append(roc_auc_score(y[te_idx], fixed_score(Xte, W_CAND)))
    c_scores = np.array(c_scores)
    diff = c_scores - a_scores
    se = diff.std(ddof=1) / np.sqrt(len(diff))
    t = diff.mean() / se if se > 0 else float("inf")
    print(f"Arm C candidate fixed: AUC {c_scores.mean():.4f} ± {c_scores.std():.4f}")
    print(f"paired C−A: {diff.mean():+.4f}  SE {se:.4f}  t {t:+.1f}")

    # repeats-split sanity: constants from repeats 0-2 fits, eval on repeats 3-4
    n_per = 5
    early = np.mean([coefs[i] for i in range(0, 3 * n_per)], axis=0)
    W_EARLY = dict(zip(["bias"] + FEATS, early))
    s_a, s_c = [], []
    for i in range(3 * n_per, 5 * n_per):
        tr_idx, te_idx = folds[i]
        Xte = fold_features(tr_idx, te_idx)
        s_a.append(roc_auc_score(y[te_idx], fixed_score(Xte, W_DEPLOYED)))
        s_c.append(roc_auc_score(y[te_idx], fixed_score(Xte, W_EARLY)))
    split_delta = np.mean(s_c) - np.mean(s_a)
    print(f"repeats-split sanity (early-derived vs deployed on late repeats): {split_delta:+.4f}")

    bar = diff.mean() >= 0.005 and t >= 2.0 and diff.mean() >= 2 * se and split_delta > 0
    print(f"\nPRE-REGISTERED BAR (Δ≥+0.005 AND ≥2·SE AND split agrees): {'CROSSED — write PROPOSAL (Jake-gated)' if bar else 'NOT crossed — deployed v4 constants HOLD, change nothing'}")

if __name__ == "__main__":
    main()
