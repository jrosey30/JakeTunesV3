#!/usr/bin/env python3
"""Taste-model feature experiments — find what pushes the 5-fold CV AUC toward
0.70 so taste can be wired into recs. READ-ONLY: tries feature sets, prints AUC
for each. Honest by construction:
  - label = the STAR (rating>=1), same as taste-eval.py
  - content embedding = the brain's own signal-free vector (embeddings.bin:
    artist/title/album/genre/year + sound descriptor; NO rating/playcount)
  - engineered artist/genre/decade "star-propensity" features are computed
    PER TRAIN FOLD ONLY (a test track never sees its own fold's labels), so a
    high AUC reflects real predictive power, not leakage.
"""
import json, os, struct, hashlib, urllib.request
from collections import defaultdict
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import StratifiedKFold
from sklearn.metrics import roc_auc_score
from sklearn.preprocessing import StandardScaler
from sklearn.decomposition import PCA

SD = os.path.expanduser("~/Library/Application Support/JakeTunes")
ENVF = os.path.expanduser("~/JakeTunesV3/.env")
CACHE = os.path.join(SD, "taste-clean-embed-cache.json")

KEY = os.environ.get("OPENAI_API_KEY", "")
if not KEY and os.path.exists(ENVF):
    for line in open(ENVF):
        if line.startswith("OPENAI_API_KEY="):
            KEY = line.split("=", 1)[1].strip().strip("\"'")


def load_embeddings(path):
    blob = open(path, "rb").read()
    assert blob[:4] == b"EMBD", "bad embeddings.bin magic"
    dim = struct.unpack_from("<H", blob, 6)[0]
    count = struct.unpack_from("<I", blob, 8)[0]
    rec = 4 + dim * 4
    arr = np.frombuffer(blob[12:12 + count * rec], dtype=np.uint8).reshape(count, rec)
    ids = arr[:, :4].copy().view(np.uint32).reshape(count)
    vecs = arr[:, 4:].copy().view(np.float32).reshape(count, dim)
    return {int(ids[i]): vecs[i] for i in range(count)}


def clean_embed(texts):
    """Embed taste-eval-style SIGNAL-FREE text (no ★/plays). Cached by text-hash
    so repeated experiment runs cost nothing."""
    cache = json.load(open(CACHE)) if os.path.exists(CACHE) else {}
    h = lambda s: hashlib.md5(s.encode()).hexdigest()
    todo = list(dict.fromkeys(t for t in texts if h(t) not in cache))
    for i in range(0, len(todo), 100):
        batch = todo[i:i + 100]
        body = json.dumps({"model": "text-embedding-3-small", "input": batch}).encode()
        req = urllib.request.Request("https://api.openai.com/v1/embeddings", body,
                                     {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
        for txt, d in zip(batch, json.loads(urllib.request.urlopen(req, timeout=60).read())["data"]):
            cache[h(txt)] = d["embedding"]
    json.dump(cache, open(CACHE, "w"))
    return np.array([cache[h(t)] for t in texts], dtype=np.float32)


def main():
    tracks = json.load(open(os.path.join(SD, "library.json")))["tracks"]
    emb = load_embeddings(os.path.join(SD, "embeddings.bin"))
    descp = os.path.join(SD, "brain-descriptors.json")
    desc = json.load(open(descp)) if os.path.exists(descp) else {}

    def has(t): return int(t.get("id", -1)) in emb
    def star(t): return (t.get("rating", 0) or 0) >= 1
    def old_unstar(t): return (t.get("rating", 0) or 0) == 0 and t.get("dateAdded", "") < "2026-05-25"
    def artist_of(t): return (t.get("albumArtist") or t.get("artist") or "?").strip().lower()
    def album_of(t): return ((t.get("albumArtist") or t.get("artist") or "?") + " ::: " + (t.get("album") or "?")).strip().lower()
    def genre_of(t): return (t.get("genre") or "?").strip().lower()
    def decade_of(t):
        try: return (int(t["year"]) // 10) * 10
        except Exception: return 0

    rng = np.random.default_rng(42)
    pos = [t for t in tracks if has(t) and star(t)]
    negall = [t for t in tracks if has(t) and old_unstar(t)]
    neg = list(rng.choice(negall, size=min(1600, len(negall)), replace=False))
    data = pos + list(neg)
    y = np.array([1] * len(pos) + [0] * len(neg))
    print(f"pos(starred)={len(pos)}  neg(old-unstarred)={len(neg)}  prior={y.mean():.3f}")

    Eleak = np.array([emb[int(t["id"])] for t in data], dtype=np.float32)  # has ★/plays — LEAKY

    def clean_text(t):
        s = [f"{t.get('artist') or '?'} — {t.get('title') or '?'}"]
        if t.get("album"): s.append(f"album: {t['album']}" + (f" ({t['year']})" if t.get("year") else ""))
        if t.get("genre"): s.append(f"genre: {t['genre']}")
        d = desc.get(str(t["id"]))
        if d and d.get("d"): s.append(f"sound and mood: {d['d']}")
        return "\n".join(s)
    print("embedding clean signal-free text (cached after first run)…")
    Eclean = clean_embed([clean_text(t) for t in data])

    artists = [artist_of(t) for t in data]
    albums = [album_of(t) for t in data]
    genres = [genre_of(t) for t in data]
    decades = [decade_of(t) for t in data]
    prior = float(y.mean())

    def make_rate(train_idx, keys, k=4.0):
        s, c = defaultdict(float), defaultdict(float)
        for i in train_idx:
            s[keys[i]] += y[i]; c[keys[i]] += 1
        return lambda key: (s.get(key, 0) + k * prior) / (c.get(key, 0) + k)

    def run(name, feat, clf_factory=None):
        skf = StratifiedKFold(5, shuffle=True, random_state=0)
        aucs = []
        for tr, te in skf.split(y, y):
            Xtr, Xte = feat(tr, te)
            sc = StandardScaler().fit(Xtr)
            clf = clf_factory() if clf_factory else LogisticRegression(C=0.2, class_weight="balanced", max_iter=4000)
            clf.fit(sc.transform(Xtr), y[tr])
            aucs.append(roc_auc_score(y[te], clf.predict_proba(sc.transform(Xte))[:, 1]))
        print(f"  {name:48s} AUC {np.mean(aucs):.3f} ± {np.std(aucs):.3f}")
        return np.mean(aucs)

    def f_clean(tr, te):
        return Eclean[tr], Eclean[te]

    def f_leak(tr, te):
        return Eleak[tr], Eleak[te]

    def f_artist(tr, te):
        ar = make_rate(tr, artists)
        col = lambda idx: np.array([[ar(artists[i])] for i in idx])
        return col(tr), col(te)

    def f_eng(tr, te):
        ar, gr, dr = make_rate(tr, artists), make_rate(tr, genres), make_rate(tr, decades)
        def cols(idx):
            return np.column_stack([
                [ar(artists[i]) for i in idx],
                [gr(genres[i]) for i in idx],
                [dr(decades[i]) for i in idx],
                [decades[i] / 2000.0 for i in idx],
            ])
        return cols(tr), cols(te)

    def f_album(tr, te):
        al = make_rate(tr, albums)
        col = lambda idx: np.array([[al(albums[i])] for i in idx])
        return col(tr), col(te)

    def f_eng2(tr, te):
        ar, al, gr, dr = (make_rate(tr, artists), make_rate(tr, albums),
                          make_rate(tr, genres), make_rate(tr, decades))
        def cols(idx):
            return np.column_stack([
                [ar(artists[i]) for i in idx],
                [al(albums[i]) for i in idx],
                [gr(genres[i]) for i in idx],
                [dr(decades[i]) for i in idx],
                [decades[i] / 2000.0 for i in idx],
            ])
        return cols(tr), cols(te)

    def f_combo(tr, te):
        pca = PCA(n_components=48, random_state=0).fit(Eclean[tr])
        Gtr, Gte = f_eng2(tr, te)
        return np.hstack([pca.transform(Eclean[tr]), Gtr]), np.hstack([pca.transform(Eclean[te]), Gte])

    from sklearn.ensemble import HistGradientBoostingClassifier
    gbm = lambda: HistGradientBoostingClassifier(max_depth=3, learning_rate=0.08,
                                                 max_iter=300, l2_regularization=1.0, random_state=0)

    print("== 5-fold CV AUC (0.50 random · 0.70 wire-in · 0.80 strong) ==")
    run("[LEAKY ref] brain embeddings.bin (contains the ★)", f_leak)
    run("content, CLEAN signal-free (taste-eval baseline)", f_clean)
    run("artist affinity ONLY (leak-safe)", f_artist)
    run("album affinity ONLY (leak-safe)", f_album)
    run("identity: artist+album+genre+decade", f_eng2)
    run("identity  [gradient boosting]", f_eng2, gbm)
    run("CLEAN content + identity  [logreg]", f_combo)
    run("CLEAN content + identity  [gradient boosting] <- best", f_combo, gbm)


if __name__ == "__main__":
    main()
