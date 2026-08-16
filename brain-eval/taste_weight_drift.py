#!/usr/bin/env python3
"""
Taste-weight DRIFT check (nightly 2026-08-16) — READ-ONLY experiment.

Question: the deployed tasteScore constants (W block, learned 2026-06-30 on a
~8.1k-track library) are 6+ weeks old; the library is now ~9.5k with new plays
and stars. Do the shipped constants still hold, or would re-learned constants
beat them held-out?

Method (mirrors the LOCKED taste-eval.py protocol + the 06-30 derivation):
  Task rows: ★ tracks vs unstarred dateAdded<2026-05-25 (neg capped 1600, seed 42).
  Features: EXACTLY the deployed parameterization from tasteScore.ts —
    per-fold leak-safe smoothed (k=4) star-affinity for album/artist/genre/decade
    (unseen key → prior), playNorm = log1p(playCount)/playMax (playMax over the
    FULL library, as deployed), recencyNorm = 1 − min(daysAgo,3650)/3650.
  Folds: RepeatedStratifiedKFold(5x5, random_state=0) — identical folds for all arms.
  Arm A: EXACT deployed constants W (fixed formula), held-out AUC per fold.
  Arm B: per-fold refit LogReg (C=0.2, balanced, raw features) — the ceiling.
  Arm C: candidate fixed constants = mean of arm-B coefficient vectors,
         evaluated exactly like A. Sanity split: constants from repeats 0-2's
         fits, evaluated on repeats 3-4 only (derivation-clean check).

PRE-REGISTERED DECISION BAR (declared before running):
  Propose (NOT apply — code change, twins + desktop rebuild = Jake's gate) new
  constants ONLY if paired mean(C−A) ≥ +0.005 AND ≥ 2·SE over the 25 folds AND
  the repeats-split sanity check agrees in sign. Otherwise: constants hold,
  change nothing.

Reads NAS library.json via JT_STATE_DIR. Writes NOTHING outside stdout.
"""
import json, os, sys, datetime
from collections import defaultdict
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import RepeatedStratifiedKFold
from sklearn.metrics import roc_auc_score

SD = os.environ.get("JT_STATE_DIR") or os.path.expanduser("~/Library/Application Support/JakeTunes")
LIB = os.path.join(SD, "library.json")

# EXACT deployed constants — backend/src/util/tasteScore.ts `const W` (2026-06-30, f499b4c)
W_DEPLOYED = {"bias": -4.455, "album": 8.636, "artist": 3.79, "genre": 0.989,
              "decade": -0.164, "plays": 0.81, "recency": -0.554}

def k_artist(t): return (t.get("albumArtist") or t.get("artist") or "?").strip().lower()
def k_album(t):  return ((t.get("albumArtist") or t.get("artist") or "?") + " ::: " + (t.get("album") or "?")).strip().lower()
def k_genre(t):  return (t.get("genre") or "?").strip().lower()
def k_dec(t):
    try:
        y = int(t["year"])
        return (y // 10) * 10 if y > 0 else 0
    except Exception:
        return 0

def main():
    lib = json.load(open(LIB))["tracks"]
    print(f"library: {len(lib)} tracks  ({LIB})")

    # playMax over the FULL library, exactly as buildTasteProfile does
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
    prior = float(y.mean())
    print(f"task rows: ★{len(pos)} vs {len(neg)} unstarred-old  (prior {prior:.3f})")

    arts = [k_artist(t) for t in tracks]; albs = [k_album(t) for t in tracks]
    gens = [k_genre(t) for t in tracks]; decs = [k_dec(t) for t in tracks]
    play_norm = np.array([(np.log1p(float(t.get("playCount") or 0)) / play_max) if play_max > 0 else 0.0 for t in tracks])
    rec_norm = np.array([1.0 - (min((now_ms - lp) / 86400000.0, 3650.0) if (lp := (t.get("lastPlayedAt") or 0)) > 0 else 3650.0) / 3650.0
                         for t in tracks])

    def rate(idx, keys, kk=4.0):
        s, c = defaultdict(float), defaultdict(float)
        for i in idx: s[keys[i]] += y[i]; c[keys[i]] += 1
        return lambda key: (s.get(key, 0) + kk * prior) / (c.get(key, 0) + kk)

    ORDER = ["album", "artist", "genre", "decade", "plays", "recency"]

    def feats(idx, ar, al, gr, dr):
        return np.column_stack([[al(albs[i]) for i in idx], [ar(arts[i]) for i in idx],
                                [gr(gens[i]) for i in idx], [dr(decs[i]) for i in idx],
                                play_norm[idx], rec_norm[idx]])

    def fixed_auc(Xte, yte, w):
        z = (w["bias"] + Xte[:, 0] * w["album"] + Xte[:, 1] * w["artist"] + Xte[:, 2] * w["genre"]
             + Xte[:, 3] * w["decade"] + Xte[:, 4] * w["plays"] + Xte[:, 5] * w["recency"])
        return roc_auc_score(yte, z)

    folds = list(RepeatedStratifiedKFold(n_splits=5, n_repeats=5, random_state=0).split(y, y))
    a_aucs, b_aucs, coefs = [], [], []
    cached = []  # (Xte, yte) per fold so arm C reuses identical features
    for tr, te in folds:
        ar, al, gr, dr = rate(tr, arts), rate(tr, albs), rate(tr, gens), rate(tr, decs)
        Xtr, Xte = feats(tr, ar, al, gr, dr), feats(te, ar, al, gr, dr)
        cached.append((Xte, y[te]))
        a_aucs.append(fixed_auc(Xte, y[te], W_DEPLOYED))
        clf = LogisticRegression(C=0.2, class_weight="balanced", max_iter=4000).fit(Xtr, y[tr])
        b_aucs.append(roc_auc_score(y[te], clf.decision_function(Xte)))
        coefs.append(np.concatenate([clf.coef_[0], clf.intercept_]))

    coefs = np.array(coefs)
    mean_c = coefs.mean(axis=0)
    W_CAND = dict(zip(ORDER, mean_c[:6])); W_CAND["bias"] = mean_c[6]
    c_aucs = [fixed_auc(Xte, yte, W_CAND) for Xte, yte in cached]

    # sanity split: constants from repeats 0-2 (folds 0..14), evaluate on repeats 3-4 (folds 15..24)
    mean_c_early = coefs[:15].mean(axis=0)
    W_EARLY = dict(zip(ORDER, mean_c_early[:6])); W_EARLY["bias"] = mean_c_early[6]
    a_late = a_aucs[15:]
    c_late = [fixed_auc(Xte, yte, W_EARLY) for Xte, yte in cached[15:]]

    a_aucs, b_aucs, c_aucs = map(np.array, (a_aucs, b_aucs, c_aucs))
    d_ca = c_aucs - a_aucs
    se = d_ca.std(ddof=1) / np.sqrt(len(d_ca))
    d_late = np.array(c_late) - np.array(a_late)

    print(f"\nA deployed-constants AUC : {a_aucs.mean():.4f} ± {a_aucs.std():.4f}")
    print(f"B refit-per-fold ceiling : {b_aucs.mean():.4f} ± {b_aucs.std():.4f}")
    print(f"C candidate constants    : {c_aucs.mean():.4f} ± {c_aucs.std():.4f}")
    print(f"paired C−A               : {d_ca.mean():+.4f} ± {d_ca.std(ddof=1):.4f}  (SE {se:.4f}, t {d_ca.mean()/se if se else 0:+.2f})")
    print(f"sanity (early→late reps) : C−A {d_late.mean():+.4f} on held-out repeats")
    print(f"candidate W: " + ", ".join(f"{k} {W_CAND[k]:+.3f}" for k in ORDER + ["bias"]))
    print(f"deployed  W: " + ", ".join(f"{k} {W_DEPLOYED[k]:+.3f}" for k in ORDER + ["bias"]))

    bar = d_ca.mean() >= 0.005 and (se > 0 and d_ca.mean() >= 2 * se) and d_late.mean() > 0
    print(f"\nBAR (propose only): mean≥+0.005 AND ≥2·SE AND sanity-sign → {'MET — write proposal' if bar else 'NOT MET — deployed constants hold, change nothing'}")

if __name__ == "__main__":
    main()
