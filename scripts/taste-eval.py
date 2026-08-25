#!/usr/bin/env python3
"""
JakeTunes Taste-Model Re-Measure — the feedback loop for "the neuron model."

What predicts whether Jake STARS a song? The 2026-06-26 study settled it: it's
IDENTITY (which artist / which album / which genre / which era), not how the song
sounds. So this job measures the model we'd actually wire into recs:

  PRIMARY — "identity affinity": for each track, how did Jake rate OTHER tracks
  by the same artist / from the same album / genre / decade? Leak-safe (every
  rate is computed from the train fold only, so a track never sees its own
  label). ~0.78 AUC — over the wire-in line. Album affinity is the strongest
  single signal: Jake stars whole records.

  SECONDARY — "sound-only": re-embed a SIGNAL-FREE string (artist/title/album/
  genre/year + the Gemma sound descriptor; NO rating/playcount, so it can't read
  the label) and ask whether the brain predicts taste from content alone. It
  mostly can't (~0.66) and enrichment barely moves it — kept to track the brain's
  hearing, NOT as the taste gate.

Honest by construction:
  - Label = the STAR (rating>=1). Jake: "my music either gets a star or it
    doesn't." Plays don't define it.
  - Metric = 5-fold cross-validated AUC (0.50 random, 0.70 wire-in, 0.80+ strong).
  - The READY alert gates on the IDENTITY AUC — the deployable model.

Appends every run to taste-eval-history.jsonl so the climb is visible, and
notifies (Mac + phone) — with a 🎯 alert the moment AUC crosses the wire-it-in
threshold. Cost: ~2,350 OpenAI embeddings per run (~半 cent). Schedule: every
few days via com.jaketunes.taste-eval.
"""
import json, os, subprocess, urllib.request, datetime
from collections import defaultdict
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import cross_val_score, StratifiedKFold, RepeatedStratifiedKFold
from sklearn.metrics import roc_auc_score
from sklearn.preprocessing import StandardScaler

SD = os.path.expanduser("~/Library/Application Support/JakeTunes")
ENVF = os.path.expanduser("~/JakeTunesV3/.env")
HIST = os.path.join(SD, "taste-eval-history.jsonl")
WIRE_IN_THRESHOLD = 0.70

KEY = ""
if os.path.exists(ENVF):
    for line in open(ENVF):
        if line.startswith("OPENAI_API_KEY="):
            KEY = line.split("=", 1)[1].strip().strip('"\'')
KEY = KEY or os.environ.get("OPENAI_API_KEY", "")


def notify(title, message):
    try:
        # ensure_ascii=False keeps emoji/dashes as literal UTF-8 — AppleScript
        # can't parse Python's default \uXXXX escapes.
        amsg, atitle = json.dumps(message, ensure_ascii=False), json.dumps(title, ensure_ascii=False)
        subprocess.run(["osascript", "-e", f"display notification {amsg} with title {atitle}"], timeout=8)
    except Exception:
        pass
    try:
        tf = os.path.expanduser("~/.config/jaketunes/ntfy-topic")
        if os.path.exists(tf):
            topic = open(tf).read().strip()
            if topic:
                url = topic if topic.startswith("http") else f"https://ntfy.sh/{topic}"
                hdr = {"Title": "".join(c for c in title if ord(c) < 128).strip() or "Taste model"}
                urllib.request.urlopen(urllib.request.Request(url, data=message.encode(), headers=hdr, method="POST"), timeout=8)
    except Exception:
        pass


def embed(texts):
    out = []
    for i in range(0, len(texts), 100):
        body = json.dumps({"model": "text-embedding-3-small", "input": texts[i:i + 100]}).encode()
        req = urllib.request.Request("https://api.openai.com/v1/embeddings", body,
                                     {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
        out += [d["embedding"] for d in json.loads(urllib.request.urlopen(req, timeout=60).read())["data"]]
    return np.array(out, dtype=np.float32)


def identity_auc(tracks, y):
    """The wire-in taste model: predict the star from artist/album/genre/era
    AFFINITY (leak-safe — each rate computed from the train fold only) PLUS
    listening BEHAVIOR (playCount + recency, global — these come from listening,
    not the star label, so no leakage). Repeated 5x5 CV → returns (mean, std) so
    the number is STABLE run-to-run instead of bouncing ±0.02. ~0.80 AUC.

    Skips were tested (2026-06-26): per-artist skip-rate added ~nothing (+0.001 —
    the star-affinity already encodes artist preference) and skipped-as-negatives
    made it slightly WORSE (only ~141 skips, and they're noisy). Left out.
    playCount caveat: ~circular for owned tracks + 0 for new ones, so it helps
    library RANKING, not cold-start discovery."""
    y = np.asarray(y)
    prior = float(y.mean())
    now_ms = int(datetime.datetime.now().timestamp() * 1000)
    def k_artist(t): return (t.get("albumArtist") or t.get("artist") or "?").strip().lower()
    def k_album(t): return ((t.get("albumArtist") or t.get("artist") or "?") + " ::: " + (t.get("album") or "?")).strip().lower()
    def k_genre(t): return (t.get("genre") or "?").strip().lower()
    def k_dec(t):
        try: return (int(t["year"]) // 10) * 10
        except Exception: return 0
    arts = [k_artist(t) for t in tracks]; albs = [k_album(t) for t in tracks]
    gens = [k_genre(t) for t in tracks]; decs = [k_dec(t) for t in tracks]
    plays = np.array([np.log1p(float(t.get("playCount") or 0)) for t in tracks])
    # v4 (2026-08-23): playINTENSITY — plays per month owned. The feature-lab
    # win (+0.006 held-out); lifetime plays kept for continuity.
    def _months(t):
        da = str(t.get("dateAdded") or "")
        try:
            d = datetime.datetime.fromisoformat(da.replace("Z", "+00:00")) if "T" in da else datetime.datetime.strptime(da[:10], "%Y-%m-%d")
            return max(1.0, (now_ms/1000 - d.timestamp()) / (30*86400))
        except Exception:
            return 24.0
    intensity = np.array([np.log1p(float(t.get("playCount") or 0)) / _months(t) for t in tracks])
    rec = np.array([(3650.0 if not (t.get("lastPlayedAt") or 0)
                     else min(3650.0, (now_ms - (t.get("lastPlayedAt") or 0)) / 86400000.0)) / 3650.0
                    for t in tracks])

    def rate(idx, keys, kk=4.0):
        s, c = defaultdict(float), defaultdict(float)
        for i in idx: s[keys[i]] += y[i]; c[keys[i]] += 1
        return lambda key: (s.get(key, 0) + kk * prior) / (c.get(key, 0) + kk)

    aucs = []
    for tr, te in RepeatedStratifiedKFold(n_splits=5, n_repeats=5, random_state=0).split(y, y):
        ar, al, gr, dr = rate(tr, arts), rate(tr, albs), rate(tr, gens), rate(tr, decs)
        def feats(idx):
            return np.column_stack([[ar(arts[i]) for i in idx], [al(albs[i]) for i in idx],
                                    [gr(gens[i]) for i in idx], [dr(decs[i]) for i in idx],
                                    plays[idx], rec[idx], intensity[idx]])
        sc = StandardScaler().fit(feats(tr))
        clf = LogisticRegression(C=0.2, class_weight="balanced", max_iter=4000).fit(sc.transform(feats(tr)), y[tr])
        aucs.append(roc_auc_score(y[te], clf.predict_proba(sc.transform(feats(te)))[:, 1]))
    return float(np.mean(aucs)), float(np.std(aucs))


def main():
    if not KEY:
        notify("🧠 Taste model — error", "No OPENAI_API_KEY found; skipped this run.")
        return
    tracks = json.load(open(os.path.join(SD, "library.json")))["tracks"]
    descp = os.path.join(SD, "brain-descriptors.json")
    desc = json.load(open(descp)) if os.path.exists(descp) else {}

    def starred(t):   return (t.get("rating", 0) or 0) >= 1
    def unstarred_old(t): return (t.get("rating", 0) or 0) == 0 and t.get("dateAdded", "") < "2026-05-25"
    pos = [t for t in tracks if (t.get("artist") or t.get("title")) and starred(t)]
    neg = [t for t in tracks if (t.get("artist") or t.get("title")) and unstarred_old(t)]
    rng = np.random.default_rng(42)
    neg = list(rng.choice(neg, size=min(1600, len(neg)), replace=False))
    if len(pos) < 40 or len(neg) < 40:
        notify("🧠 Taste model — skipped", f"Not enough labeled data yet (★{len(pos)} / {len(neg)}).")
        return

    def text(t):
        s = [f"{t.get('artist') or '?'} — {t.get('title') or '?'}"]
        if t.get("album"): s.append(f"album: {t['album']}" + (f" ({t['year']})" if t.get("year") else ""))
        if t.get("genre"): s.append(f"genre: {t['genre']}")
        d = desc.get(str(t["id"]))
        if d and d.get("d"): s.append(f"sound and mood: {d['d']}")   # the enrichment, when present
        return "\n".join(s)

    data = [(t, 1) for t in pos] + [(t, 0) for t in neg]
    tlist = [t for t, _ in data]
    y = np.array([lab for _, lab in data])

    # PRIMARY — the wire-in model: identity affinity + behavior (leak-safe),
    # repeated 5x5 CV → a stable mean ± std (no more run-to-run bounce).
    auc_id, auc_id_std = identity_auc(tlist, y)

    # SECONDARY — sound-only: re-embed the signal-free text to track the brain's
    # hearing. (Disproven as the taste driver; kept as a brain-health metric.)
    X = embed([text(t) for t in tlist])
    auc_content = float(cross_val_score(LogisticRegression(C=0.2, class_weight="balanced", max_iter=2000),
                                        X, y, cv=5, scoring="roc_auc").mean())

    star_enriched = sum(1 for t in pos if str(t["id"]) in desc)
    pct_star = round(100 * star_enriched / max(1, len(pos)))
    lib_enriched = len(desc)

    with open(HIST, "a") as f:
        f.write(json.dumps({"at": datetime.datetime.now().isoformat(timespec="seconds"),
                            "auc": round(auc_content, 4), "auc_identity": round(auc_id, 4), "auc_identity_std": round(auc_id_std, 4),
                            "pct_star_enriched": pct_star, "lib_enriched": lib_enriched,
                            "n_pos": len(pos)}) + "\n")

    if auc_id >= WIRE_IN_THRESHOLD:
        title = "🎯 Taste model is READY"
        verdict = "ready to wire into recs + mixes"
    elif auc_id >= 0.65:
        title = "🧠 Taste model — warming up"
        verdict = "warming up"
    else:
        title = "🧠 Taste model — check-in"
        verdict = "still weak"
    msg = (f"Taste AUC {auc_id:.3f} ± {auc_id_std:.3f} ({verdict}) — album/artist affinity + behavior · "
           f"sound-only {auc_content:.3f} · brain {lib_enriched}/{len(tracks)} enriched")
    notify(title, msg)
    print(datetime.datetime.now().isoformat(timespec="seconds"), msg)


if __name__ == "__main__":
    main()
