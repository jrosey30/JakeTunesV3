#!/usr/bin/env python3
"""Taste model v4 — the 1,000-skip re-test gated by the 08-08/08-09 nightly closures.

Gate history: per-ARTIST skip-rate refuted at 493 skips (+0.0004 AUC, t=3.11,
practically zero); per-TRACK shapes refuted at ~643 (-0.0003..-0.0005). Both
closed with "don't re-run until ~1,000 skips." The live counter
(mobile-listening-log.jsonl) crossed 1,000 on 2026-09-07 (1,007), so this is
the pre-registered re-test — NOT a new fishing expedition.

Corpus = desktop listening-log.jsonl (static since 05-25, pre-mobile era,
610 skips) + mobile-listening-log.jsonl (1,007 skips); the two are disjoint
time ranges (desktop ends 05-25, mobile starts 08-07) so a plain merge does
not double-count. 1,617 skip events total.

Arms (paired per-fold on the SAME 50 folds as production, matching v2/v3):
  A  production: identity affinities + plays + recency  (tasteScore.ts shape)
  B  + track_skips      log1p(skips of THIS track)
  C  + skip_recency     days since THIS track last skipped
  D  + early/late       split at pct<=5
  E  + all track shapes
  F  + artist_skip_rate skips_a/(plays_a+skips_a), smoothed — the v2 formulation
  G  + everything (E+F)

PRE-REGISTERED BAR (set before running): an arm graduates to a PROPOSAL only if
paired Δ >= +0.005 (10x the prior noise floor) AND t >= 3. Anything smaller —
positive, negative, or "statistically detectable but tiny" — re-closes the skip
question until a real correction/thumbs-down control exists.

READ-ONLY. Reads the frozen snapshot via JT_STATE_DIR. Writes nothing.
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
    events = []
    for fn in ("listening-log.jsonl", "mobile-listening-log.jsonl"):
        p = SD + "/" + fn
        if os.path.exists(p):
            rows = [json.loads(l) for l in open(p) if l.strip()]
            events.extend(rows)
            print(f"  {fn}: {len(rows)} events, {sum(1 for e in rows if e.get('t') == 's')} skips")

    skip_n = defaultdict(int)
    skip_early = defaultdict(int)
    skip_late = defaultdict(int)
    skip_last = {}
    art_skips = defaultdict(int)
    for e in events:
        if e.get("t") != "s":
            continue
        k = (norm(e.get("ar")), norm(e.get("ti")))
        skip_n[k] += 1
        art_skips[norm(e.get("ar"))] += 1
        ts = datetime.datetime.fromisoformat(e["ts"].replace("Z", "+00:00")).timestamp() * 1000
        skip_last[k] = max(skip_last.get(k, 0), ts)
        if "pct" in e:
            if e["pct"] <= 5: skip_early[k] += 1
            else: skip_late[k] += 1
    total_skips = sum(skip_n.values())
    print(f"  merged skip corpus: {total_skips} events over {len(skip_n)} distinct (artist,title) keys")

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

    # artist skip rate: global behavior feature (plays from library playCounts,
    # the same denominator framing v2 used); smoothed k=8 toward the global rate
    art_plays = defaultdict(float)
    for t in tracks:
        art_plays[norm(t.get("artist"))] += plays_of(t)
    g_sk = sum(art_skips.values()); g_pl = sum(art_plays.values())
    g_rate = g_sk / max(1.0, g_sk + g_pl)
    def artist_skip_rate(t):
        a = norm(t.get("artist"))
        s, p = art_skips.get(a, 0), art_plays.get(a, 0.0)
        return (s + 8 * g_rate) / (s + p + 8)

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
    asr = np.array([artist_skip_rate(t) for t in data])
    prior = float(y.mean())

    def make_rate(y, idx, keys, k=4.0):
        s, c = defaultdict(float), defaultdict(float)
        for i in idx: s[keys[i]] += y[i]; c[keys[i]] += 1
        return lambda key: (s.get(key, 0) + k * prior) / (c.get(key, 0) + k)

    EXTRA = {"tsk": tsk, "srec": srec, "esk": esk, "lsk": lsk, "asr": asr}

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
        ("E + all track shapes", ["tsk", "srec", "esk", "lsk"]),
        ("F + artist_skip_rate (v2 form)", ["asr"]),
        ("G + everything", ["tsk", "srec", "esk", "lsk", "asr"]),
    ]
    folds = list(RepeatedStratifiedKFold(n_splits=5, n_repeats=10, random_state=0).split(y, y))
    per_arm = {}
    for name, cols in ARMS:
        aucs = np.array([fold_auc(tr, te, cols) for tr, te in folds])
        per_arm[name] = aucs
        print(f"  {name:38s} AUC {aucs.mean():.4f} ± {aucs.std():.4f}  (n={len(aucs)} folds)")

    base = per_arm[ARMS[0][0]]
    print("\npaired per-fold vs production (same 50 folds); BAR = Δ>=+0.005 AND t>=3:")
    for name, _ in ARMS[1:]:
        d = per_arm[name] - base
        t = d.mean() / (d.std(ddof=1) / np.sqrt(len(d))) if d.std(ddof=1) > 0 else float("inf")
        verdict = "GRADUATES" if (d.mean() >= 0.005 and t >= 3) else "refuted"
        print(f"  {name:38s} Δ = {d.mean():+.4f} ± {d.std():.4f}   t = {t:+.2f}   improved: {(d > 0).sum()}/{len(d)}   -> {verdict}")


if __name__ == "__main__":
    main()
