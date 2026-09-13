"""Arm D supplement (2026-09-13): derive deployment-parity constants on the
FULL-RATE basis (affinities over the whole library, exactly what tasteScore
sees at runtime — the v4 derivation pattern), then evaluate those FIXED
constants on the SAME leak-safe 5x5 folds as the main drift script. Read-only."""
import json, os, datetime
from collections import defaultdict
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import RepeatedStratifiedKFold
from sklearn.metrics import roc_auc_score
import importlib.util
spec = importlib.util.spec_from_file_location("drift", os.path.join(os.path.dirname(os.path.abspath(__file__)), "taste_weight_drift_v4_20260913.py"))
D = importlib.util.module_from_spec(spec); spec.loader.exec_module.__self__ if False else None
# reuse the main script's helpers without running main()
exec(open("taste_weight_drift_v4_20260913.py").read().split('def main()')[0])

lib = json.load(open(LIB))["tracks"]
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

# FULL-RATE affinities: buildTasteProfile over the WHOLE library (runtime parity)
prior = float(np.mean([1 if starred(t) else 0 for t in lib]))
maps = {}
for name, keyf in (("album", k_album), ("artist", k_artist), ("genre", k_genre), ("decade", k_dec)):
    s, n = defaultdict(int), defaultdict(int)
    for t in lib:
        key = keyf(t); n[key] += 1
        if starred(t): s[key] += 1
    maps[name] = {k: (s[k] + 4 * prior) / (n[k] + 4) for k in n}
def g_feats(t):
    pl = np.log1p(float(t.get("playCount") or 0))
    play_norm = pl / play_max if play_max > 0 else 0.0
    lp = float(t.get("lastPlayedAt") or 0)
    days = (now_ms - lp) / 86400000 if lp > 0 else 3650.0
    recency = 1.0 - min(days, 3650.0) / 3650.0
    return play_norm, recency, pl / months_owned(t, now_ms)
Xfull = np.array([[maps["album"].get(k_album(t), prior), maps["artist"].get(k_artist(t), prior),
                   maps["genre"].get(k_genre(t), prior), maps["decade"].get(k_dec(t), prior),
                   *g_feats(t)] for t in tracks])
m = LogisticRegression(C=0.2, class_weight="balanced", max_iter=2000)
m.fit(Xfull, y)
W_FULL = dict(zip(["bias"] + FEATS, np.round(np.concatenate([m.intercept_, m.coef_[0]]), 3)))
print("full-rate-derived constants:", W_FULL)

# evaluate FIXED W_FULL + deployed on the identical leak-safe folds
G = np.array([g_feats(t) for t in tracks])
def fold_features(train_idx, all_idx):
    tr = [tracks[i] for i in train_idx]
    pr = float(np.mean([1 if starred(t) else 0 for t in tr]))
    mp = {}
    for name, keyf in (("album", k_album), ("artist", k_artist), ("genre", k_genre), ("decade", k_dec)):
        s, n = defaultdict(int), defaultdict(int)
        for t in tr:
            key = keyf(t); n[key] += 1
            if starred(t): s[key] += 1
        mp[name] = {k: (s[k] + 4 * pr) / (n[k] + 4) for k in n}
    return np.array([[mp["album"].get(k_album(tracks[i]), pr), mp["artist"].get(k_artist(tracks[i]), pr),
                      mp["genre"].get(k_genre(tracks[i]), pr), mp["decade"].get(k_dec(tracks[i]), pr),
                      G[i,0], G[i,1], G[i,2]] for i in all_idx])
def fixed_score(X, w):
    z = w["bias"] + sum(w[f] * X[:, j] for j, f in enumerate(FEATS))
    return 1.0 / (1.0 + np.exp(-z))
rskf = RepeatedStratifiedKFold(n_splits=5, n_repeats=5, random_state=0)
d_scores, a_scores = [], []
for tr_idx, te_idx in rskf.split(np.zeros(len(y)), y):
    Xte = fold_features(tr_idx, te_idx)
    d_scores.append(roc_auc_score(y[te_idx], fixed_score(Xte, W_FULL)))
    a_scores.append(roc_auc_score(y[te_idx], fixed_score(Xte, W_DEPLOYED)))
d_scores, a_scores = np.array(d_scores), np.array(a_scores)
diff = d_scores - a_scores
se = diff.std(ddof=1) / np.sqrt(len(diff))
print(f"Arm D full-rate fixed: AUC {d_scores.mean():.4f} ± {d_scores.std():.4f}")
print(f"Arm A deployed:        AUC {a_scores.mean():.4f}")
print(f"paired D−A: {diff.mean():+.4f}  SE {se:.4f}  t {diff.mean()/se:+.1f}")
