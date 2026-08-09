#!/usr/bin/env python3
"""Taste model v3 — the "differently-shaped skip feature" follow-up queued by the
2026-08-08 nightly report. Per-ARTIST skip-rate was refuted (+0.0004 AUC, closed).
This tests PER-TRACK skip shape on top of the production formulation
(identity + plays + recency, tasteScore.ts):

  B  + track_skips     log1p(count of skip events for THIS track)
  C  + skip_recency    days since THIS track was last skipped (3650 = never)
  D  + early/late      skips split at pct<=5 (skip-immediately vs listened-then-
                       skipped); pct exists on skips since 2026-07-01 (295/497),
                       86% of which are pct<=5 — the late arm is thin, reported anyway
  E  + all of the above

READ-ONLY. Reads a frozen snapshot via JT_STATE_DIR (never the live state dir).
Paired per-fold design: every arm scores the SAME 50 folds (10 repeats x 5 splits)
as production, so deltas are per-fold paired with a t-stat, matching the method
that closed the skip-rate question.

Leakage discipline (same as v2): affinity rates are computed per-train-fold from
the star label; skip/play/recency features come from listening BEHAVIOR, so they
are global features — no label leak. Same playCount circularity caveat applies
to skips: you don't re-skip what you star, so this measures library-RANKING
value, not cold-start.
"""
import json, os, datetime
from collections import defaultdict
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import RepeatedStratifiedKFold
from sklearn.metrics import roc_auc_score
from sklearn.preprocessing import StandardScaler

SD = os.environ.get("JT_STATE_DIR") or os.path.expanduser("~/Library/Application Support/JakeTunes")
NOW_MS = int(datetime.datetime.now().timestamp() * 1000)


def norm(s): return (s or "").strip().lower()


def main():
    tracks = json.load(open(SD + "/library.json"))["tracks"]
    events = [json.loads(l) for l in open(SD + "/listening-log.jsonl") if l.strip()]

    skip_n = defaultdict(int)       # (artist,title) -> total skips
    skip_early = defaultdict(int)   # pct<=5 (skip-immediately)
    skip_late = defaultdict(int)    # pct>5 (listened, then skipped)
    skip_last = {}                  # (artist,title) -> last skip ts (ms)
    for e in events:
        if e.get("t") != "s":
            continue
        k = (norm(e.get("ar")), norm(e.get("ti")))
        skip_n[k] += 1
        ts = datetime.datetime.fromisoformat(e["ts"].replace("Z", "+00:00")).timestamp() * 1000
        skip_last[k] = max(skip_last.get(k, 0), ts)
        if "pct" in e:
            if e["pct"] <= 5: skip_early[k] += 1
            else: skip_late[k] += 1

    def star(t): return (t.get("rating", 0) or 0) >= 1
    def old_unstar(t): return (t.get("rating", 0) or 0) == 0 and t.get("dateAdded", "") < "2026-05-25"
    def tkey(t): return (norm(t.get("artist")), norm(t.get("title")))
    def artist_of(t): return norm(t.get("albumArtist") or t.get("artist") or "?")
    def album_of(t): return norm((t.get("albumArtist") or t.get("artist") or "?") + " ::: " + (t.get("album") or "?"))
    def genre_of(t): return norm(t.get("genre") or "?")
    def decade_of(t):
        try: return (int(t["year"]) // 10) * 10
        except Exception: return 0
    def plays_of(t): return float(t.get("playCount") or 0)
    def recency(t):
        lp = t.get("lastPlayedAt") or 0
        return 3650.0 if not lp else min(3650.0, (NOW_MS - lp) / 86400000.0)
    def skip_rec(t):
        ls = skip_last.get(tkey(t), 0)
        return 3650.0 if not ls else min(3650.0, (NOW_MS - ls) / 86400000.0)

    rng = np.random.default_rng(42)
    pos = [t for t in tracks if star(t)]
    old_neg = [t for t in tracks if old_unstar(t)]
    neg = list(rng.choice(old_neg, size=min(1600, len(old_neg)), replace=False))
    data = list(pos) + list(neg)
    y = np.array([1] * len(pos) + [0] * len(neg))
    n_skipped_in_task = sum(1 for t in data if skip_n.get(tkey(t), 0) > 0)
    print(f"pos(starred)={len(pos)}  old_unstarred_pool={len(old_neg)}  task_n={len(data)}  "
          f"task rows with >=1 skip={n_skipped_in_task}")

    arts = [artist_of(t) for t in data]; albs = [album_of(t) for t in data]
    gens = [genre_of(t) for t in data]; decs = [decade_of(t) for t in data]
    plays = np.array([np.log1p(plays_of(t)) for t in data])
    rec = np.array([recency(t) / 3650.0 for t in data])
    tsk = np.array([np.log1p(skip_n.get(tkey(t), 0)) for t in data])
    srec = np.array([skip_rec(t) / 3650.0 for t in data])
    esk = np.array([np.log1p(skip_early.get(tkey(t), 0)) for t in data])
    lsk = np.array([np.log1p(skip_late.get(tkey(t), 0)) for t in data])
    prior = float(y.mean())

    def make_rate(y, idx, keys, k=4.0):
        s, c = defaultdict(float), defaultdict(float)
        for i in idx: s[keys[i]] += y[i]; c[keys[i]] += 1
        return lambda key: (s.get(key, 0) + k * prior) / (c.get(key, 0) + k)

    EXTRA = {"tsk": tsk, "srec": srec, "esk": esk, "lsk": lsk}

    def fold_auc(tr, te, cols):
        ar = make_rate(y, tr, arts); al = make_rate(y, tr, albs)
        gr = make_rate(y, tr, gens); dr = make_rate(y, tr, decs)
        def feats(idx):
            base = np.column_stack([
                [ar(arts[i]) for i in idx], [al(albs[i]) for i in idx],
                [gr(gens[i]) for i in idx], [dr(decs[i]) for i in idx],
                plays[idx], rec[idx],
            ])
            extra = [EXTRA[c][idx] for c in cols]
            return np.column_stack([base] + extra) if extra else base
        sc = StandardScaler().fit(feats(tr))
        clf = LogisticRegression(C=0.2, class_weight="balanced", max_iter=4000).fit(sc.transform(feats(tr)), y[tr])
        return roc_auc_score(y[te], clf.predict_proba(sc.transform(feats(te)))[:, 1])

    ARMS = [
        ("A production: identity+plays+rec", []),
        ("B + track_skips", ["tsk"]),
        ("C + skip_recency", ["srec"]),
        ("D + early/late skip split", ["esk", "lsk"]),
        ("E + all skip-shape", ["tsk", "srec", "esk", "lsk"]),
    ]
    folds = list(RepeatedStratifiedKFold(n_splits=5, n_repeats=10, random_state=0).split(y, y))
    per_arm = {}
    for name, cols in ARMS:
        aucs = np.array([fold_auc(tr, te, cols) for tr, te in folds])
        per_arm[name] = aucs
        print(f"  {name:38s} AUC {aucs.mean():.4f} ± {aucs.std():.4f}  (n={len(aucs)} folds)")

    base = per_arm[ARMS[0][0]]
    print("\npaired per-fold vs production (same 50 folds):")
    for name, _ in ARMS[1:]:
        d = per_arm[name] - base
        t = d.mean() / (d.std(ddof=1) / np.sqrt(len(d))) if d.std(ddof=1) > 0 else float("inf")
        print(f"  {name:38s} Δ = {d.mean():+.4f} ± {d.std():.4f}   t = {t:.2f}   folds improved: {(d > 0).sum()}/{len(d)}")


if __name__ == "__main__":
    main()
