#!/usr/bin/env python3
"""Taste model v2 — does adding SKIPS (per-artist skip-rate + skipped tracks as
hard negatives) + BEHAVIOR (playCount, recency) push the identity model past
0.78, and what's the LOCKED number (repeated 5x5 CV → mean ± std)? READ-ONLY.

Leakage discipline: artist/album/genre/decade AFFINITY is derived from the STAR
label, so it's computed per-train-fold. skip-rate / playCount / recency come from
LISTENING behavior (not the label), so they're global features — no leak.
playCount caveat: it's ~circular for stars (you play what you star) + is 0 for
unrated/new tracks, so it helps library-RANKING, not cold-start. Reported, flagged.
"""
import json, os, datetime
from collections import defaultdict
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import RepeatedStratifiedKFold
from sklearn.metrics import roc_auc_score
from sklearn.preprocessing import StandardScaler

SD = os.path.expanduser("~/Library/Application Support/JakeTunes")
NOW_MS = int(datetime.datetime.now().timestamp() * 1000)


def norm(s): return (s or "").strip().lower()


def main():
    tracks = json.load(open(SD + "/library.json"))["tracks"]
    prof = json.load(open(SD + "/listener-profile.json"))
    events = [json.loads(l) for l in open(SD + "/listening-log.jsonl") if l.strip()]

    skipped = defaultdict(int)
    for e in events:
        if e.get("t") == "s":
            skipped[(norm(e.get("ar")), norm(e.get("ti")))] += 1
    aPlays = {norm(k): v for k, v in prof.get("artistPlays", {}).items()}
    aSkips = {norm(k): v for k, v in prof.get("artistSkips", {}).items()}

    def skipRate(artist):
        a = norm(artist); p = aPlays.get(a, 0); s = aSkips.get(a, 0)
        return (s + 0.5) / (p + s + 2)   # smoothed dislike rate

    def star(t): return (t.get("rating", 0) or 0) >= 1
    def old_unstar(t): return (t.get("rating", 0) or 0) == 0 and t.get("dateAdded", "") < "2026-05-25"
    def tkey(t): return (norm(t.get("artist")), norm(t.get("title")))
    def is_skipped(t): return skipped.get(tkey(t), 0) > 0
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

    rng = np.random.default_rng(42)
    pos = [t for t in tracks if star(t)]
    old_neg = [t for t in tracks if old_unstar(t)]
    skip_neg = [t for t in tracks if is_skipped(t) and not star(t)]
    print(f"pos(starred)={len(pos)}  old_unstarred={len(old_neg)}  skipped-not-starred={len(skip_neg)}")

    def build(with_skip_negs):
        if with_skip_negs:
            fill = [t for t in old_neg if not is_skipped(t)]
            neg = list(skip_neg) + list(rng.choice(fill, size=max(0, min(1600 - len(skip_neg), len(fill))), replace=False))
        else:
            neg = list(rng.choice(old_neg, size=min(1600, len(old_neg)), replace=False))
        data = list(pos) + list(neg)
        y = np.array([1] * len(pos) + [0] * len(neg))
        return data, y

    def make_rate(y, idx, keys, prior, k=4.0):
        s, c = defaultdict(float), defaultdict(float)
        for i in idx: s[keys[i]] += y[i]; c[keys[i]] += 1
        return lambda key: (s.get(key, 0) + k * prior) / (c.get(key, 0) + k)

    def run(name, data, y, cols, repeats=5):
        arts = [artist_of(t) for t in data]; albs = [album_of(t) for t in data]
        gens = [genre_of(t) for t in data]; decs = [decade_of(t) for t in data]
        srate = np.array([skipRate(t.get("artist")) for t in data])
        plays = np.array([np.log1p(plays_of(t)) for t in data])
        rec = np.array([recency(t) / 3650.0 for t in data])
        prior = float(y.mean())
        aucs = []
        for tr, te in RepeatedStratifiedKFold(n_splits=5, n_repeats=repeats, random_state=0).split(y, y):
            ar = make_rate(y, tr, arts, prior); al = make_rate(y, tr, albs, prior)
            gr = make_rate(y, tr, gens, prior); dr = make_rate(y, tr, decs, prior)
            def feats(idx):
                base = np.column_stack([
                    [ar(arts[i]) for i in idx], [al(albs[i]) for i in idx],
                    [gr(gens[i]) for i in idx], [dr(decs[i]) for i in idx],
                ])
                extra = []
                if "skip" in cols: extra.append(srate[idx])
                if "plays" in cols: extra.append(plays[idx])
                if "rec" in cols: extra.append(rec[idx])
                return np.column_stack([base] + extra) if extra else base
            sc = StandardScaler().fit(feats(tr))
            clf = LogisticRegression(C=0.2, class_weight="balanced", max_iter=4000).fit(sc.transform(feats(tr)), y[tr])
            aucs.append(roc_auc_score(y[te], clf.predict_proba(sc.transform(feats(te)))[:, 1]))
        print(f"  {name:46s} AUC {np.mean(aucs):.3f} ± {np.std(aucs):.3f}  (n={len(aucs)})")
        return np.mean(aucs)

    print("\n== negatives = old-unstarred (current eval's set) · repeated 5x5 CV ==")
    d, y = build(False)
    run("identity (locked baseline)", d, y, set())
    run("identity + skip-rate", d, y, {"skip"})
    run("identity + behavior (plays,recency)", d, y, {"plays", "rec"})
    run("identity + skip-rate + behavior", d, y, {"skip", "plays", "rec"})
    print("\n== negatives = skipped (hard) + old-unstarred ==")
    d2, y2 = build(True)
    run("identity + skip-rate + behavior", d2, y2, {"skip", "plays", "rec"})
    run("identity + skip-rate only", d2, y2, {"skip"})


if __name__ == "__main__":
    main()
