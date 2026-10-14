#!/usr/bin/env python3
"""
taste-candidate.py — Brief 194: the taste-model REFIT, as a candidate.

The nightly taste-eval.py MEASURES the deployed taste model (identity
affinity + behavior, 5x5 CV AUC, appended to taste-eval-history.jsonl) but
nothing ever refits the weights W that live, byte-identical, in
src/renderer/utils/tasteScore.ts (V3) and the mobile backend's
tasteScore.ts. Re-deriving W has been a manual lab act (v4, v5). This job
automates the derivation — and ONLY the derivation:

  * it fits a candidate W on the deployment-parity protocol (below),
  * measures the candidate's 5x5 CV AUC,
  * reads the baseline AUC from taste-eval's recorded history,
  * and writes taste-candidate.json {W, candidateCvAuc, baselineCvAuc,
    beatsBaseline, generatedAt, ...} to the state dir.

It NEVER edits tasteScore.ts, never opens a PR, never deploys. If the
candidate does not beat the baseline it still writes the file, marked
beatsBaseline: false — a losing candidate is a result, not an error, and
it is never hidden. Promotion is a separate, human-approved step
(scripts/taste-candidate-pr.py --apply on Jake's Mac; Brief 159's
no-auto-refit decision stands — Jake's approval + the nightly W guard
remain the gates).

DEPLOYMENT-PARITY PROTOCOL (from tasteScore.ts's header + taste-eval.py):
  * Dataset: exactly taste-eval.py's — positives = starred (rating>=1)
    tracks with artist/title; negatives = unstarred tracks added before
    2026-05-25, subsampled to <=1600 with rng seed 42.
  * Features on the DEPLOYED basis (what tasteScore() actually computes):
    album/artist/genre/decade star-affinities (k=4 smoothing), plays =
    log1p(playCount)/playMax (library max), recency = 1 - days/3650,
    intensity = log1p(playCount)/sqrt(monthsOwned) (v5/E9 form).
  * Affinities are OUT-OF-FOLD (5-fold, seed 0): a track's affinity
    features come from rates computed without its own fold — the v5
    refit's documented basis, and the only leak-free way to fit on the
    full dataset.
  * Final W fit: LogisticRegression(C=0.2, class_weight='balanced',
    max_iter=4000) — taste-eval's learner — on the MATURED fit set
    (v5: "refit on the matured-90d library": positives added >=90 days
    ago; negatives qualify by construction), raw feature basis, no
    scaler, so the coefficients ARE the deployed W (rounded to 3 dp,
    the files' house style).
  * candidateCvAuc: the same learner under RepeatedStratifiedKFold
    (5 splits x 5 repeats, seed 0) per taste-eval.py, on the full eval
    dataset (affinities per-fold there, as in the eval).
  * baselineCvAuc: the last auc_identity in taste-eval-history.jsonl.

DEVIATION FROM THE BRIEF'S LETTER (documented, per program rules): the
brief pointed at scripts/taste-experiments-v2.py as "the lab that emits
W". It does not — it is a read-only AUC study of skip/behavior features
(119 lines, prints means, exports nothing; it also predates the v5
feature set). The refit protocol that actually produced the deployed W
is the one documented in tasteScore.ts's header and mirrored by
taste-eval.py, and that is what this script implements.

Usage:
  python3 scripts/taste-candidate.py [--state-dir DIR] [--out FILE]
State dir: JT_STATE_DIR or ~/Library/Application Support/JakeTunes.
Exit codes: 0 = candidate written (win or lose); 2 = cannot run
(missing data / sklearn) — no candidate file is fabricated.
"""
import argparse
import datetime
import json
import os
import sys
from collections import defaultdict

import numpy as np

SD_DEFAULT = os.path.expanduser("~/Library/Application Support/JakeTunes")
NEG_CUTOFF = "2026-05-25"     # taste-eval.py's unstarred_old cutoff
NEG_CAP = 1600                # taste-eval.py's negative subsample
MATURE_DAYS = 90              # tasteScore.ts v5: "matured-90d library"
K_SMOOTH = 4.0                # affinity smoothing, both files agree

FEATURE_ORDER = ["album", "artist", "genre", "decade", "plays", "recency", "intensity"]


def k_artist(t): return (t.get("albumArtist") or t.get("artist") or "?").strip().lower()
def k_album(t): return ((t.get("albumArtist") or t.get("artist") or "?") + " ::: " + (t.get("album") or "?")).strip().lower()
def k_genre(t): return (t.get("genre") or "?").strip().lower()
def k_decade(t):
    try: return (int(t["year"]) // 10) * 10
    except Exception: return 0


def months_owned(t, now_ms):
    """Mirror tasteScore.ts monthsOwned: fallback 24, floor 1."""
    da = str(t.get("dateAdded") or "")
    if not da: return 24.0
    try:
        d = (datetime.datetime.fromisoformat(da.replace("Z", "+00:00")) if "T" in da
             else datetime.datetime.strptime(da[:10], "%Y-%m-%d").replace(tzinfo=datetime.timezone.utc))
        return max(1.0, (now_ms / 1000 - d.timestamp()) / (30 * 86400))
    except Exception:
        return 24.0


def behavior_features(tracks, now_ms, play_max):
    plays, rec, inten = [], [], []
    for t in tracks:
        pc = float(t.get("playCount") or 0)
        plays.append(np.log1p(pc) / play_max if play_max > 0 else 0.0)
        lp = t.get("lastPlayedAt") or 0
        days = 3650.0 if not lp else min(3650.0, (now_ms - lp) / 86400000.0)
        rec.append(1.0 - days / 3650.0)
        inten.append(np.log1p(pc) / np.sqrt(months_owned(t, now_ms)))
    return np.array(plays), np.array(rec), np.array(inten)


def rate_fn(y, idx, keys, prior):
    s, c = defaultdict(float), defaultdict(float)
    for i in idx: s[keys[i]] += y[i]; c[keys[i]] += 1
    return lambda key: (s.get(key, 0) + K_SMOOTH * prior) / (c.get(key, 0) + K_SMOOTH)


def affinity_block(y, fit_idx, eval_idx, keys_by_name, prior):
    """Affinity features for eval_idx rows, rates computed on fit_idx only."""
    cols = []
    for name in ["album", "artist", "genre", "decade"]:
        fn = rate_fn(y, fit_idx, keys_by_name[name], prior)
        cols.append([fn(keys_by_name[name][i]) for i in eval_idx])
    return cols


def build_matrix(tracks, y, fit_idx, eval_idx, keys_by_name, prior, beh):
    cols = affinity_block(y, fit_idx, eval_idx, keys_by_name, prior)
    plays, rec, inten = beh
    cols.append([plays[i] for i in eval_idx])
    cols.append([rec[i] for i in eval_idx])
    cols.append([inten[i] for i in eval_idx])
    return np.column_stack(cols)


def main():
    ap = argparse.ArgumentParser(description="Fit a candidate taste-model W (Brief 194). Never deploys.")
    ap.add_argument("--state-dir", default=os.environ.get("JT_STATE_DIR", SD_DEFAULT))
    ap.add_argument("--out", default=None, help="candidate path (default: <state-dir>/taste-candidate.json)")
    args = ap.parse_args()
    sd = args.state_dir
    out_path = args.out or os.path.join(sd, "taste-candidate.json")

    try:
        from sklearn.linear_model import LogisticRegression
        from sklearn.model_selection import RepeatedStratifiedKFold, StratifiedKFold
        from sklearn.metrics import roc_auc_score
        from sklearn.preprocessing import StandardScaler
    except ImportError:
        print("taste-candidate: scikit-learn is required (the taste jobs' env has it); cannot fit.", file=sys.stderr)
        return 2

    lib_path = os.path.join(sd, "library.json")
    if not os.path.exists(lib_path):
        print(f"taste-candidate: no library.json under {sd}", file=sys.stderr)
        return 2
    library = json.load(open(lib_path))["tracks"]
    now_ms = int(datetime.datetime.now().timestamp() * 1000)

    def starred(t): return (t.get("rating", 0) or 0) >= 1
    def unstarred_old(t): return (t.get("rating", 0) or 0) == 0 and (t.get("dateAdded", "") or "") < NEG_CUTOFF
    pos = [t for t in library if (t.get("artist") or t.get("title")) and starred(t)]
    neg_all = [t for t in library if (t.get("artist") or t.get("title")) and unstarred_old(t)]
    rng = np.random.default_rng(42)
    neg = list(rng.choice(neg_all, size=min(NEG_CAP, len(neg_all)), replace=False)) if neg_all else []
    if len(pos) < 40 or len(neg) < 40:
        print(f"taste-candidate: not enough labeled data (starred {len(pos)} / old-unstarred {len(neg)})", file=sys.stderr)
        return 2
    tracks = list(pos) + list(neg)
    y = np.array([1] * len(pos) + [0] * len(neg))
    prior = float(y.mean())
    keys_by_name = {
        "album": [k_album(t) for t in tracks], "artist": [k_artist(t) for t in tracks],
        "genre": [k_genre(t) for t in tracks], "decade": [k_decade(t) for t in tracks],
    }
    play_max = max((np.log1p(float(t.get("playCount") or 0)) for t in library), default=0.0)
    beh = behavior_features(tracks, now_ms, play_max)

    # ── candidate CV AUC (taste-eval.py's protocol: 5x5 repeated, scaler+LR) ──
    aucs = []
    for tr, te in RepeatedStratifiedKFold(n_splits=5, n_repeats=5, random_state=0).split(y, y):
        Xtr = build_matrix(tracks, y, tr, tr, keys_by_name, prior, beh)
        Xte = build_matrix(tracks, y, tr, te, keys_by_name, prior, beh)
        sc = StandardScaler().fit(Xtr)
        clf = LogisticRegression(C=0.2, class_weight="balanced", max_iter=4000).fit(sc.transform(Xtr), y[tr])
        aucs.append(roc_auc_score(y[te], clf.predict_proba(sc.transform(Xte))[:, 1]))
    cand_auc, cand_std = float(np.mean(aucs)), float(np.std(aucs))

    # ── final W fit: out-of-fold affinities, matured-90d fit set, raw basis ──
    oof = np.zeros((len(tracks), 4))
    for tr, te in StratifiedKFold(n_splits=5, shuffle=True, random_state=0).split(y, y):
        cols = affinity_block(y, tr, te, keys_by_name, prior)
        for j, col in enumerate(cols): oof[te, j] = col
    plays, rec, inten = beh
    X_all = np.column_stack([oof, plays, rec, inten])
    mature_cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=MATURE_DAYS)
    def is_mature(t):
        da = str(t.get("dateAdded") or "")
        if not da: return False
        try:
            d = (datetime.datetime.fromisoformat(da.replace("Z", "+00:00")) if "T" in da
                 else datetime.datetime.strptime(da[:10], "%Y-%m-%d").replace(tzinfo=datetime.timezone.utc))
            return d <= mature_cutoff
        except Exception:
            return False
    fit_idx = np.array([i for i, t in enumerate(tracks) if y[i] == 0 or is_mature(t)])
    clf = LogisticRegression(C=0.2, class_weight="balanced", max_iter=4000).fit(X_all[fit_idx], y[fit_idx])
    W = {"bias": round(float(clf.intercept_[0]), 3)}
    for name, coef in zip(FEATURE_ORDER, clf.coef_[0]):
        W[name] = round(float(coef), 3)

    # ── baseline from taste-eval's recorded history ──
    baseline = None
    hist_path = os.path.join(sd, "taste-eval-history.jsonl")
    if os.path.exists(hist_path):
        for line in open(hist_path):
            try:
                rec_ = json.loads(line)
                if isinstance(rec_.get("auc_identity"), (int, float)): baseline = float(rec_["auc_identity"])
            except Exception:
                continue
    beats = (baseline is not None) and (cand_auc > baseline)

    candidate = {
        "W": W,
        "candidateCvAuc": round(cand_auc, 4),
        "candidateCvAucStd": round(cand_std, 4),
        "baselineCvAuc": baseline,
        "beatsBaseline": beats,
        "generatedAt": datetime.datetime.now().isoformat(timespec="seconds"),
        "nPos": len(pos), "nNeg": len(neg), "nFit": int(len(fit_idx)),
        "protocol": "deployment-parity (tasteScore.ts header + taste-eval.py 5x5 CV): eval dataset, "
                    "out-of-fold affinities (k=4), deployment-basis features, LogReg C=0.2 balanced, "
                    f"final fit on matured-{MATURE_DAYS}d set, raw basis",
        "note": "Candidate only — never auto-deployed (Brief 159). Promotion: scripts/taste-candidate-pr.py --apply on the Mac, then Jake approves the twin PRs.",
    }
    tmp = out_path + ".tmp"
    with open(tmp, "w") as f: json.dump(candidate, f, indent=2)
    os.replace(tmp, out_path)
    verdict = "BEATS baseline" if beats else ("no baseline recorded" if baseline is None else "does NOT beat baseline")
    print(f"taste-candidate: candidateCvAuc {cand_auc:.4f} ± {cand_std:.4f} vs baseline {baseline} — {verdict}")
    print(f"taste-candidate: W = {W}")
    print(f"taste-candidate: wrote {out_path} (beatsBaseline={beats})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
