#!/usr/bin/env python3
"""
taste-engine — the nightly taste-learning exercise (2026-10-19, Jake: "I don't
want an AI system that merely runs exercises every night. I want one that
actually gets smarter.")

Runs on homemini at 04:40, after the 04:00 all-device listening history
(scripts/listening-history-nightly.sh) is rebuilt. Local, numpy only, a few
seconds of CPU. One writer for everything it writes.

WHAT IT LEARNS FROM (Jake's call: stars + behavior)
  - every play / real skip on every device (yir/listening-history.jsonl —
    'glance' (<5% then gone) and 'mechanical' (skip bursts) are NOT verdicts)
  - stars and when they were given (starredAt), lifetime play counts,
    ownership age, repeat listening on different days, coming back to a song
    after a long gap
  - the SOUND of each song (mood-index.bin: descriptor + tempo + genre line,
    identity stripped) — so it can learn which musical characteristics pull
    Jake in, not just "more by artists he stars". Artist love stays per
    artist: liking Geese never raises a band merely because it sounds like
    Geese; only the characteristics his own listening rewards carry over.
  - suggestion verdicts (taste-ledger.jsonl, synced from the laptop) and the
    mixes it served (mixes-cache.json servedHistory) — to grade past
    recommendations against what actually happened.
  - his Top 1000 Quiz verdicts (top1000-answers.jsonl on homemini) as one more
    feature, AS OF each snapshot: only answers given before it count, so a
    window is never graded with a verdict given after it started. Until the
    newest training window starts after his first answer the column is all
    zero and changes nothing; from then on the held-back test decides what it
    is worth. (2026-10-23: using the verdicts as extra TRAINING LABELS was
    tried and failed this test — "one of my 1000 favorites" is a different
    question from "will he finish it next month", and mixing them dropped the
    challenger's held-back AUC from 0.589 to 0.47, below v5.)

THE EXERCISE, EVERY NIGHT
  1. Ingest new behavior and feedback.
  2. Measure preference drift (recent sound-preference vs long-run; genre
     family shares last 30 days vs the 90 before).
  3. Grade past recommendations against outcomes (mix tracks played through
     vs skipped, strip/Discovery adds that were kept and played).
  4. Name recurring mistakes (songs served and skipped again and again).
  5. Test the challenger ranking against the champion (the live taste
     formula, v5) on HELD-BACK TIME: features from everything before a
     cut-off, outcomes from the 28 days after it, so nothing it is graded on
     was seen when it was built.
  6. Compare with a bootstrap: promote only on a reliable gain (>= MIN_GAIN
     and a 5th-percentile gain > 0); stay promoted while not worse; demote
     otherwise. "Insufficient data" is reported as such, never as a score.
  7. Publish per-song taste state (taste-state.json) — consumers use the
     challenger's ranking only while `promoted` is true and the file is
     fresh, and fall back to the v5 formula otherwise (automatic rollback).
  8. Journal what changed, why, and whether it helped (taste-journal.jsonl),
     plus a status file another nightly job checks for staleness.

The published score is QUANTILE-MAPPED onto the live v5 score distribution:
the challenger changes which songs rank high, not how much taste weighs in a
mix (TASTE_W was tuned to v5's spread).

Per-song state also carries the in-library discovery flags a future
"Discover Weekly from my own library" needs: underplayed favorites, forgotten
songs, overlooked album tracks, never-explored songs, and songs matching the
recent sound preference. Nothing consumes those yet (Jake: "do not build this
feature yet").

Paths (env overrides for testing): see CONFIG below. --dry-run computes and
prints, writes nothing.
"""
import json
import math
import os
import struct
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone

import numpy as np

# numpy 2 on Apple Accelerate raises spurious divide/overflow flags inside
# float64 matmul (inputs and results verified finite); results are checked
# with np.isfinite where it matters instead.
np.seterr(all='ignore')

HOME = os.path.expanduser('~')
UD = os.environ.get('JT_TE_UD') or os.path.join(HOME, 'Library', 'Application Support', 'JakeTunes')
CONFIG = {
    'history': os.environ.get('JT_TE_HISTORY') or os.path.join(UD, 'yir', 'listening-history.jsonl'),
    'library': os.environ.get('JT_TE_LIBRARY') or os.path.join(HOME, 'JakeTunesState', 'library.json'),
    'state': os.environ.get('JT_TE_STATE') or '/Volumes/JakeShared/JakeTunesState',
    'mixes': os.environ.get('JT_TE_MIXES') or os.path.join(HOME, 'JakeTunesState', 'mixes-cache.json'),
    'work': os.environ.get('JT_TE_WORK') or os.path.join(UD, 'taste-engine'),
    'ledgers': os.environ.get('JT_TE_LEDGERS'),   # ':'-separated; default = laptop copy + replicas
    'quiz': os.environ.get('JT_TE_QUIZ') or os.path.join(HOME, 'JakeTunesState', 'top1000-answers.jsonl'),
}
DAY_MS = 86_400_000
HOLDOUT_DAYS = 28            # the outcome window each evaluation grades
HALF_LIFE_DAYS = 120         # how fast old listening fades (changing taste)
RECENT_HALF_LIFE_DAYS = 30   # "what he's into lately"
RETURN_GAP_DAYS = 45         # a play after this long a break = he came back
MOOD_DIMS = 32               # PCA of the sound/mood vectors
L2 = 30.0                    # logistic regression ridge (18 features, ~100 skips a window)
MIN_EVAL_TRACKS = 150        # fewer labeled songs than this = insufficient data
MIN_EVAL_NEG = 25
MIN_GAIN = 0.01              # promote only on at least this AUC gain…
BOOTSTRAP = 300              # …whose bootstrap 5th percentile is > 0
STALE_INPUT_HOURS = 30       # the listening history must be this fresh
FLAG_UNDERPLAYED, FLAG_FORGOTTEN, FLAG_OVERLOOKED, FLAG_NEVER, FLAG_RECENT_SOUND = 1, 2, 4, 8, 16

# ⚠️ TWIN: JakeTunesMobile backend/src/util/tasteScore.ts + src/renderer/utils/tasteScore.ts
# (taste v5). The champion is scored exactly as production scores it.
V5_W = {'bias': -4.577, 'album': 4.238, 'artist': 2.343, 'genre': 1.442, 'decade': 2.748,
        'plays': -0.247, 'recency': 0.422, 'intensity': 3.311}


def log(*a):
    print('[taste-engine]', *a, flush=True)


def to_ms(v):
    if v is None or v == '':
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v)
    if s.isdigit():
        return float(s)
    try:
        if len(s) == 10:
            return datetime.strptime(s, '%Y-%m-%d').replace(tzinfo=timezone.utc).timestamp() * 1000
        return datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp() * 1000
    except ValueError:
        return None


# ── inputs ──────────────────────────────────────────────────────────────────

BULK_STAR_DAY = 60   # more stars than this stamped on one day = an import/migration, not a session


def load_library(path):
    lib = json.load(open(path))
    rows = lib['tracks'] if isinstance(lib, dict) else lib
    # Bulk star stamps (2026-10-19): on 10/17 the phone's star list was
    # migrated and 317 phone stars were stamped with that day — real stars,
    # fake dates (05-25, 06-07 and 07-01 are earlier imports). A star stamped
    # on such a day is treated as given before the history began, so it is
    # never mistaken for a fresh "yes" inside a test window.
    per_day = Counter()
    for t in rows:
        ms = to_ms(t.get('starredAt'))
        if ms:
            per_day[int(ms // DAY_MS)] += 1
    bulk = {d for d, n in per_day.items() if n > BULK_STAR_DAY}
    out = {}
    for t in rows:
        try:
            tid = int(t.get('id'))
        except (TypeError, ValueError):
            continue
        out[tid] = {
            'artist': (t.get('albumArtist') or t.get('artist') or '?').strip().lower(),
            'album': ((t.get('albumArtist') or t.get('artist') or '?') + ' ::: ' + (t.get('album') or '?')).strip().lower(),
            'genre': (t.get('genre') or '?').strip().lower(),
            'year': t.get('year'),
            'rating': float(t.get('rating') or 0),
            'starredAt': (lambda ms: None if (ms is None or int(ms // DAY_MS) in bulk) else ms)(to_ms(t.get('starredAt'))),
            'playCount': float(t.get('playCount') or 0),
            'lastPlayedAt': to_ms(t.get('lastPlayedAt')),
            'dateAdded': to_ms(t.get('dateAdded')),
        }
    return out


def load_history(path, lib):
    ev = []
    for line in open(path):
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue
        tid = e.get('trackId')
        if tid is None or int(tid) not in lib or e.get('kind') not in ('play', 'skip'):
            continue
        ts = to_ms(e.get('ts'))
        if ts is None:
            continue
        ev.append((ts, int(tid), e['kind']))
    ev.sort()
    return ev


def load_mood(path, ids):
    buf = open(path, 'rb').read()
    if buf[:4] != b'EMBD':
        raise ValueError('mood-index.bin: bad magic')
    dim = struct.unpack('<H', buf[6:8])[0]
    cnt = struct.unpack('<I', buf[8:12])[0]
    rec = 4 + dim * 4
    want = set(ids)
    vecs, off = {}, 12
    for _ in range(cnt):
        if off + rec > len(buf):
            break
        tid = struct.unpack('<I', buf[off:off + 4])[0]
        if tid in want:
            vecs[tid] = np.frombuffer(buf, dtype='<f4', count=dim, offset=off + 4)
        off += rec
    return vecs, dim


def load_ledgers():
    paths = CONFIG['ledgers'].split(':') if CONFIG['ledgers'] else (
        [os.path.join(UD, 'taste-ledger.jsonl')] +
        [os.path.join(UD, 'replicas', r, 'taste-ledger.jsonl') for r in (os.listdir(os.path.join(UD, 'replicas')) if os.path.isdir(os.path.join(UD, 'replicas')) else [])])
    rows = []
    for p in paths:
        try:
            for line in open(p):
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
        except FileNotFoundError:
            pass
    return rows


def load_quiz(path, lib):
    """Jake's Top 1000 Quiz answers (homemini top1000-answers.jsonl).

    A verdict is an answer about a song against the line: in/out, still love
    it yes/no, "both"/"neither" on this-or-that, "all three"/"none" on
    best-of-three. Which of two songs he picked says nothing about the line,
    so picks are not verdicts. Undo lines retract the answer they name.
    ⚠️ TWIN: JakeTunesMobile backend/src/util/top1000Hints.ts hintLabels — the
    same verdict rule, which the quiz's own hints model learns from.

    Returns (timeline [(ms, tid, +1/-1)], reason-chip counts, standing answers)."""
    rows, gone = [], set()
    try:
        for line in open(path):
            try:
                a = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(a, dict):
                continue
            if a.get('kind') == 'undo':
                gone.add(a.get('target'))
            else:
                rows.append(a)
    except FileNotFoundError:
        return [], Counter(), 0
    timeline, reasons, standing = [], Counter(), 0
    for a in rows:
        ts = to_ms(a.get('at'))
        if ts is None or a.get('at') in gone:
            continue
        standing += 1
        kind, choice, ids = a.get('kind'), a.get('choice'), a.get('ids') or []
        for r in a.get('reasons') or []:
            reasons[str(r)] += 1
        if kind == 'inout' and choice in ('in', 'out'):
            verdicts = [(ids[0], choice == 'in')]
        elif kind == 'still' and choice in ('yes', 'no'):
            verdicts = [(ids[0], choice == 'yes')]
        elif kind == 'pick' and choice in ('both', 'neither'):
            verdicts = [(i, choice == 'both') for i in ids]
        elif kind == 'best' and choice in ('all', 'none'):
            verdicts = [(i, choice == 'all') for i in ids]
        else:
            continue
        for tid, yes in verdicts:
            try:
                tid = int(tid)
            except (TypeError, ValueError):
                continue
            if tid in lib:
                timeline.append((ts, tid, 1.0 if yes else -1.0))
    timeline.sort()
    return timeline, reasons, standing


def playlist_members():
    try:
        d = json.load(open(os.path.join(CONFIG['state'], 'playlists.json')))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}
    lists = d if isinstance(d, list) else next((v for v in d.values() if isinstance(v, list)), [])
    return {p['id']: {str(x) for x in p.get('trackIds') or []} for p in lists if isinstance(p, dict) and p.get('id')}


# ── the champion: taste v5 exactly as production computes it ────────────────

def v5_scores(lib, ids, at_ms, star_at, plays_at, last_at):
    """Taste v5 over `ids`, using the library AS OF at_ms (stars given by then,
    play counts and last-played as of then)."""
    stars = {tid: star_at(tid) for tid in lib}
    prior = sum(stars.values()) / max(1, len(lib))
    def rate(keyf):
        s, n = Counter(), Counter()
        for tid, t in lib.items():
            k = keyf(t)
            n[k] += 1
            s[k] += stars[tid]
        return {k: (s[k] + 4 * prior) / (n[k] + 4) for k in n}
    dec = lambda t: (int(t['year']) // 10 * 10) if str(t.get('year') or '').isdigit() and int(t['year']) > 0 else 0
    al, ar, ge, de = rate(lambda t: t['album']), rate(lambda t: t['artist']), rate(lambda t: t['genre']), rate(dec)
    play_max = max((math.log1p(plays_at(tid)) for tid in lib), default=0.0)
    out = np.zeros(len(ids))
    for i, tid in enumerate(ids):
        t = lib[tid]
        pc = plays_at(tid)
        play_norm = math.log1p(pc) / play_max if play_max > 0 else 0.0
        lp = last_at(tid)
        days_ago = (at_ms - lp) / DAY_MS if lp else 3650
        recency = 1 - min(days_ago, 3650) / 3650
        months = max(1.0, (at_ms - t['dateAdded']) / (30 * DAY_MS)) if t['dateAdded'] else 24.0
        intensity = math.log1p(pc) / math.sqrt(months)
        z = (V5_W['bias'] + V5_W['album'] * al.get(t['album'], prior) + V5_W['artist'] * ar.get(t['artist'], prior)
             + V5_W['genre'] * ge.get(t['genre'], prior) + V5_W['decade'] * de.get(dec(t), prior)
             + V5_W['plays'] * play_norm + V5_W['recency'] * recency + V5_W['intensity'] * intensity)
        out[i] = 1 / (1 + math.exp(-z))
    return out


# ── features as of a moment (only the past) ─────────────────────────────────

class Snapshot:
    """Everything known about Jake's listening at `at_ms` — nothing after it."""

    def __init__(self, lib, events, at_ms, verdicts=()):
        self.lib, self.at = lib, at_ms
        # Top 1000 Quiz verdicts given before `at` (net in − out per song)
        self.verdict = defaultdict(float)
        for ts, tid, v in verdicts:
            if ts < at_ms:
                self.verdict[tid] += v
        self.plays, self.skips = defaultdict(float), defaultdict(float)
        self.recent_plays, self.recent_skips = defaultdict(float), defaultdict(float)
        self.raw_plays, self.raw_skips = Counter(), Counter()
        self.days = defaultdict(set)
        self.returns = Counter()
        self.last = {}
        self.later_plays = Counter()
        for ts, tid, kind in events:
            if ts >= at_ms:
                if kind == 'play':
                    self.later_plays[tid] += 1
                continue
            age = (at_ms - ts) / DAY_MS
            w = 0.5 ** (age / HALF_LIFE_DAYS)
            wr = 0.5 ** (age / RECENT_HALF_LIFE_DAYS)
            if kind == 'play':
                prev = self.last.get(tid)
                if prev is not None and (ts - prev) / DAY_MS >= RETURN_GAP_DAYS:
                    self.returns[tid] += 1
                self.plays[tid] += w
                self.recent_plays[tid] += wr
                self.raw_plays[tid] += 1
                self.days[tid].add(int(ts // DAY_MS))
                self.last[tid] = ts
            else:
                self.skips[tid] += w
                self.recent_skips[tid] += wr
                self.raw_skips[tid] += 1

    def star(self, tid):
        t = self.lib[tid]
        if t['rating'] <= 0:
            return 0.0
        return 1.0 if (t['starredAt'] is None or t['starredAt'] < self.at) else 0.0

    def play_count(self, tid):
        """Lifetime plays as of `at`: the library's count minus the plays the
        history logged after `at` (the library count is always 'now')."""
        return max(0.0, self.lib[tid]['playCount'] - self.later_plays[tid])

    def last_played(self, tid):
        lp = self.last.get(tid)
        lib_lp = self.lib[tid]['lastPlayedAt']
        if lib_lp and lib_lp < self.at:
            lp = max(lp or 0, lib_lp)
        return lp


def smoothed(num, den, prior, k):
    return (num + k * prior) / (den + k)


def mood_basis(mood_vecs):
    ids = sorted(mood_vecs)
    M = np.stack([mood_vecs[i] for i in ids]).astype(np.float64)
    mu = M.mean(axis=0)
    _, _, vt = np.linalg.svd(M - mu, full_matrices=False)
    P = vt[:MOOD_DIMS].T
    Z = (M - mu) @ P
    Z /= (Z.std(axis=0) + 1e-9)
    return {tid: Z[i] for i, tid in enumerate(ids)}


def ridge_pref(snap, ids, mood, recent=False):
    """Learn which SOUND characteristics his own listening rewards: a ridge
    regression of each played/starred song's engagement on its sound
    coordinates, then score every song. Engagement is per song (artist love
    is not spread to similar-sounding artists)."""
    X, y = [], []
    plays = snap.recent_plays if recent else snap.plays
    skips = snap.recent_skips if recent else snap.skips
    for tid in ids:
        if tid not in mood:
            continue
        p, s, st = plays.get(tid, 0.0), skips.get(tid, 0.0), snap.star(tid)
        if p + s + st <= 0:
            continue
        X.append(mood[tid])
        y.append(math.log1p(p) - 1.5 * math.log1p(s) + (0.0 if recent else 1.0 * st))
    out = np.zeros(len(ids))
    if len(X) < 50:
        return out
    X, y = np.array(X), np.array(y)
    y = y - y.mean()
    beta = np.linalg.solve(X.T @ X + 50.0 * np.eye(X.shape[1]), X.T @ y)
    for i, tid in enumerate(ids):
        if tid in mood:
            out[i] = float(mood[tid] @ beta)
    return out


FEATURES = ('star', 'track_completion', 'track_plays', 'track_skips', 'distinct_days', 'returns',
            'intensity', 'recency', 'artist_star', 'artist_completion', 'artist_plays', 'album_star',
            'album_completion', 'genre_completion', 'sound_pref', 'sound_pref_recent', 'owned_months', 'quiz_verdict')


def features(snap, ids, mood):
    lib = snap.lib
    # group aggregates (artist / album / genre) over the whole library, past only
    g = {name: (defaultdict(float), defaultdict(float), defaultdict(float), Counter()) for name in ('artist', 'album', 'genre')}
    tot_p = sum(snap.plays.values())
    tot_s = sum(snap.skips.values())
    p0 = tot_p / max(1e-9, tot_p + tot_s)
    stars = {tid: snap.star(tid) for tid in lib}
    star_prior = sum(stars.values()) / max(1, len(lib))
    for tid, t in lib.items():
        for name in ('artist', 'album', 'genre'):
            P, S, ST, N = g[name]
            k = t[name]
            P[k] += snap.plays.get(tid, 0.0)
            S[k] += snap.skips.get(tid, 0.0)
            ST[k] += stars[tid]
            N[k] += 1
    sp = ridge_pref(snap, list(lib), mood)
    spr = ridge_pref(snap, list(lib), mood, recent=True)
    sp_of = dict(zip(list(lib), sp))
    spr_of = dict(zip(list(lib), spr))
    X = np.zeros((len(ids), len(FEATURES)))
    for i, tid in enumerate(ids):
        t = lib[tid]
        p, s = snap.plays.get(tid, 0.0), snap.skips.get(tid, 0.0)
        pc = snap.play_count(tid)
        months = max(1.0, (snap.at - t['dateAdded']) / (30 * DAY_MS)) if t['dateAdded'] else 24.0
        lp = snap.last_played(tid)
        A, AL, GE = g['artist'], g['album'], g['genre']
        a, al, ge = t['artist'], t['album'], t['genre']
        X[i] = [
            stars[tid],
            smoothed(p, p + s, p0, 2.0),
            math.log1p(p),
            math.log1p(s),
            math.log1p(len(snap.days.get(tid, ()))),
            math.log1p(snap.returns.get(tid, 0)),
            math.log1p(pc) / math.sqrt(months),
            math.exp(-((snap.at - lp) / DAY_MS) / 90.0) if lp else 0.0,
            smoothed(A[2][a], A[3][a], star_prior, 4.0),
            smoothed(A[0][a], A[0][a] + A[1][a], p0, 3.0),
            math.log1p(A[0][a]),
            smoothed(AL[2][al], AL[3][al], star_prior, 4.0),
            smoothed(AL[0][al], AL[0][al] + AL[1][al], p0, 3.0),
            smoothed(GE[0][ge], GE[0][ge] + GE[1][ge], p0, 5.0),
            sp_of.get(tid, 0.0),
            spr_of.get(tid, 0.0),
            math.log(months),
            max(-2.0, min(2.0, snap.verdict.get(tid, 0.0))) / 2.0,
        ]
    return X


# ── outcomes in a window (the future, relative to a snapshot) ───────────────

def outcomes(lib, events, start_ms, end_ms):
    """Per song with a verdict in [start, end): Jake's 'love' rule — a star
    given in the window is the strongest yes (counts 2), each full listen is
    a yes, each real skip is a no. Ties carry no verdict."""
    pos, neg = Counter(), Counter()
    for ts, tid, kind in events:
        if start_ms <= ts < end_ms:
            if kind == 'play':
                pos[tid] += 1
            else:
                neg[tid] += 1
    for tid, t in lib.items():
        if t['rating'] > 0 and t['starredAt'] and start_ms <= t['starredAt'] < end_ms:
            pos[tid] += 2
    ids, y, w = [], [], []
    for tid in set(pos) | set(neg):
        if pos[tid] == neg[tid]:
            continue
        ids.append(tid)
        y.append(1.0 if pos[tid] > neg[tid] else 0.0)
        w.append(float(min(3, pos[tid] + neg[tid])))
    return ids, np.array(y), np.array(w)


# ── model + metrics ─────────────────────────────────────────────────────────

def fit_logistic(X, y, w, l2=L2):
    mu, sd = X.mean(axis=0), X.std(axis=0) + 1e-9
    Z = np.hstack([np.ones((len(X), 1)), (X - mu) / sd])
    beta = np.zeros(Z.shape[1])
    R = l2 * np.eye(Z.shape[1])
    R[0, 0] = 0.0
    for _ in range(50):
        p = 1 / (1 + np.exp(-(Z @ beta)))
        g = Z.T @ (w * (y - p)) - R @ beta
        H = (Z * (w * p * (1 - p))[:, None]).T @ Z + R
        step = np.linalg.solve(H, g)
        beta += step
        if np.abs(step).max() < 1e-7:
            break
    return {'mu': mu, 'sd': sd, 'beta': beta}


def predict(model, X):
    Z = np.hstack([np.ones((len(X), 1)), (X - model['mu']) / model['sd']])
    return 1 / (1 + np.exp(-(Z @ model['beta'])))


def wauc(score, y, w):
    order = np.argsort(score, kind='mergesort')
    s, yy, ww = score[order], y[order], w[order]
    pos_w, neg_w = ww[yy == 1].sum(), ww[yy == 0].sum()
    if pos_w <= 0 or neg_w <= 0:
        return None
    acc, neg_below, i = 0.0, 0.0, 0
    while i < len(s):
        j = i
        while j < len(s) and s[j] == s[i]:
            j += 1
        tp = ww[i:j][yy[i:j] == 1].sum()
        tn = ww[i:j][yy[i:j] == 0].sum()
        acc += tp * (neg_below + 0.5 * tn)
        neg_below += tn
        i = j
    return float(acc / (pos_w * neg_w))


def bootstrap_gain(a, b, y, w, seed=7):
    rnd = np.random.default_rng(seed)
    gains = []
    n = len(y)
    for _ in range(BOOTSTRAP):
        idx = rnd.integers(0, n, n)
        ga, gb = wauc(a[idx], y[idx], w[idx]), wauc(b[idx], y[idx], w[idx])
        if ga is not None and gb is not None:
            gains.append(ga - gb)
    if not gains:
        return None
    gains.sort()
    return float(gains[int(0.05 * len(gains))])


FOLDS = 3                    # rolling-origin windows (most recent first)


def window_train(lib, events, mood, cut_ms, windows=1, verdicts=()):
    """Fit on the `windows` 28-day windows that END at cut_ms (features as of
    each window's start, outcomes inside it). Nothing at or after cut_ms."""
    Xs, ys, ws = [], [], []
    for i in range(windows):
        end = cut_ms - i * HOLDOUT_DAYS * DAY_MS
        start = end - HOLDOUT_DAYS * DAY_MS
        ids, y, w = outcomes(lib, events, start, end)
        if not ids:
            continue
        Xs.append(features(Snapshot(lib, events, start, verdicts), ids, mood))
        ys.append(y)
        ws.append(w)
    if not Xs:
        return None, 0, 0
    y = np.concatenate(ys)
    if len(y) < MIN_EVAL_TRACKS or (len(y) - y.sum()) < MIN_EVAL_NEG:
        return None, len(y), int(len(y) - y.sum())
    return fit_logistic(np.vstack(Xs), y, np.concatenate(ws)), len(y), int(len(y) - y.sum())


def evaluate(lib, events, mood, now_ms, verdicts=()):
    """Rolling-origin out-of-time test. For each of the last FOLDS 28-day
    windows: fit the challenger on the window before it, then grade it and
    the champion (v5, scored as of the window's start) on what Jake actually
    did inside it — finished or skipped, starred or not. Nothing graded was
    seen when the model was built. Folds are judged separately (scores from
    different months are not on one scale) and combined as a mean gain with
    a fold-stratified bootstrap.

    A fold whose training snapshot already holds quiz verdicts also grades a
    twin fitted without them, so the scorecard shows what the verdicts added."""
    folds = []
    for k in range(1, FOLDS + 1):
        cut = now_ms - k * HOLDOUT_DAYS * DAY_MS
        te_ids, te_y, te_w = outcomes(lib, events, cut, cut + HOLDOUT_DAYS * DAY_MS)
        model, n_tr, neg_tr = window_train(lib, events, mood, cut, verdicts=verdicts)
        f = {'window': k, 'testSongs': len(te_ids), 'testNo': int(len(te_y) - te_y.sum()), 'trainSongs': n_tr}
        if model is None or len(te_ids) < MIN_EVAL_TRACKS or f['testNo'] < MIN_EVAL_NEG:
            f['verdict'] = 'insufficient data'
            folds.append(f)
            continue
        snap = Snapshot(lib, events, cut, verdicts)
        ch = predict(model, features(snap, te_ids, mood))
        v5 = v5_scores(lib, te_ids, cut, snap.star, snap.play_count, snap.last_played)
        f.update({'challenger': round(wauc(ch, te_y, te_w), 4), 'champion_v5': round(wauc(v5, te_y, te_w), 4), 'verdict': 'measured'})
        if any(ts < cut - HOLDOUT_DAYS * DAY_MS for ts, _, _ in verdicts):
            plain, _, _ = window_train(lib, events, mood, cut)
            if plain is not None:
                f['challenger_withoutQuiz'] = round(wauc(predict(plain, features(Snapshot(lib, events, cut), te_ids, mood)), te_y, te_w), 4)
        f['_arrays'] = (ch, v5, te_y, te_w)
        folds.append(f)
    measured = [f for f in folds if f['verdict'] == 'measured']
    res = {'folds': [{k: v for k, v in f.items() if k != '_arrays'} for f in folds]}
    if len(measured) < 2:
        res['verdict'] = 'insufficient data'
        return res
    gains = [f['challenger'] - f['champion_v5'] for f in measured]
    res['meanGain'] = round(float(np.mean(gains)), 4)
    res['foldsWon'] = sum(1 for g in gains if g > 0)
    res['auc'] = {'challenger': round(float(np.mean([f['challenger'] for f in measured])), 4),
                  'champion_v5': round(float(np.mean([f['champion_v5'] for f in measured])), 4)}
    twins = [f for f in measured if 'challenger_withoutQuiz' in f]
    if twins:
        res['quizGain'] = round(float(np.mean([f['challenger'] - f['challenger_withoutQuiz'] for f in twins])), 4)
    rnd = np.random.default_rng(11)
    boots = []
    for _ in range(BOOTSTRAP):
        g = []
        for f in measured:
            ch, v5, y, w = f['_arrays']
            idx = rnd.integers(0, len(y), len(y))
            a, b = wauc(ch[idx], y[idx], w[idx]), wauc(v5[idx], y[idx], w[idx])
            if a is not None and b is not None:
                g.append(a - b)
        if g:
            boots.append(float(np.mean(g)))
    boots.sort()
    res['gainLowerBound'] = round(boots[int(0.05 * len(boots))], 4) if boots else None
    res['verdict'] = 'measured'
    return res


def strip_check(lib, events, mood, now_ms, ledger_rows, members, verdicts=()):
    """Secondary check on a different decision: of the playlist suggestions
    shown in the last 56 days, did the songs Jake ADDED (and kept) score
    higher than the ones he passed over? Challenger and v5 are both frozen
    as of 56 days ago, so the adds were never seen."""
    T = now_ms - 2 * HOLDOUT_DAYS * DAY_MS
    model, _, _ = window_train(lib, events, mood, T, verdicts=verdicts)
    if model is None:
        return {'verdict': 'insufficient data'}
    snap = Snapshot(lib, events, T, verdicts)
    ids = sorted(lib)
    ch = dict(zip(ids, predict(model, features(snap, ids, mood))))
    v5 = dict(zip(ids, v5_scores(lib, ids, T, snap.star, snap.play_count, snap.last_played)))
    rows = []
    for r in ledger_rows:
        if r.get('surface') != 'strip' or r.get('verdict') not in ('accept', 'pass', 'refresh', 'reject'):
            continue
        ts = to_ms(r.get('ts'))
        k = r.get('key') or {}
        try:
            tid = int(k.get('trackId'))
        except (TypeError, ValueError):
            continue
        if ts is None or ts < T or tid not in ch:
            continue
        kept = str(tid) in members.get(k.get('playlistId'), {str(tid)})
        rows.append((ch[tid], v5[tid], 1.0 if (r['verdict'] == 'accept' and kept) else 0.0))
    if sum(1 for r in rows if r[2] == 1) < 20:
        return {'verdict': 'insufficient data', 'impressions': len(rows)}
    a = np.array(rows)
    w = np.ones(len(a))
    return {'verdict': 'measured', 'impressions': len(rows), 'adds': int(a[:, 2].sum()),
            'challenger': round(wauc(a[:, 0], a[:, 2], w), 4), 'champion_v5': round(wauc(a[:, 1], a[:, 2], w), 4)}


def decide_promotion(ev_res, strip, was_promoted):
    """Promote on a reliable win, keep while not worse, demote otherwise.
    The suggestion-strip check may veto, never promote on its own."""
    if ev_res.get('verdict') != 'measured':
        return False, ev_res.get('verdict', 'insufficient data') + (' — v5 stays' if not was_promoted else ' — ROLLED BACK to v5 until there is enough data again')
    a, b = ev_res['auc']['challenger'], ev_res['auc']['champion_v5']
    lb, won = ev_res.get('gainLowerBound'), ev_res['foldsWon']
    n = len([f for f in ev_res['folds'] if f['verdict'] == 'measured'])
    strip_ok = strip.get('verdict') != 'measured' or strip['challenger'] >= strip['champion_v5'] - 0.02
    if (not was_promoted) and ev_res['meanGain'] >= MIN_GAIN and lb is not None and lb > 0 and won * 2 > n and strip_ok:
        return True, f'promoted: {a:.3f} vs v5 {b:.3f} (won {won}/{n} windows, gain >= {lb:+.3f} at 95%)'
    if was_promoted and ev_res['meanGain'] >= 0 and strip_ok:
        return True, f'kept: {a:.3f} vs v5 {b:.3f} (won {won}/{n} windows)'
    if was_promoted:
        return False, f'ROLLED BACK to v5: challenger {a:.3f} vs v5 {b:.3f}' + ('' if strip_ok else ' (and it ranked suggestion adds worse)')
    return False, f'not promoted: {a:.3f} vs v5 {b:.3f} (won {won}/{n} windows, gain lower bound {lb})' + ('' if strip_ok else '; ranks suggestion adds worse')


# ── grading past recommendations ────────────────────────────────────────────

def grade_mixes(events, now_ms):
    """Daily-mix songs served vs what happened within 3 days."""
    try:
        cache = json.load(open(CONFIG['mixes']))
    except (FileNotFoundError, json.JSONDecodeError):
        return {'verdict': 'no mixes cache'}
    served = cache.get('servedHistory') or []
    by_tid = defaultdict(list)
    for ts, tid, kind in events:
        by_tid[tid].append((ts, kind))
    n = played = skipped = 0
    skipped_tids = Counter()
    for day in served:
        d_ms = to_ms(day.get('date'))
        if d_ms is None or d_ms > now_ms - 3 * DAY_MS:
            continue   # outcome window not finished
        for raw in day.get('ids') or []:
            try:
                tid = int(raw)
            except (TypeError, ValueError):
                continue
            n += 1
            evs = [k for ts, k in by_tid.get(tid, []) if d_ms <= ts < d_ms + 3 * DAY_MS]
            if 'play' in evs:
                played += 1
            elif 'skip' in evs:
                skipped += 1
                skipped_tids[tid] += 1
    out = {'served': n, 'playedThrough': played, 'skipped': skipped}
    if n >= 50:
        out['playedThroughRate'] = round(played / n, 4)
        out['skipRateWhenPlayed'] = round(skipped / max(1, played + skipped), 4) if played + skipped >= 20 else None
    else:
        out['verdict'] = 'insufficient data'
    out['repeatSkipped'] = sorted([t for t, c in skipped_tids.items() if c >= 2])[:50]
    return out


def grade_ledger(rows, lib, events, now_ms, members=None):
    """How suggestions turned out (last 90 days unless noted):
    - strip adds 14+ days old: still on the playlist? played since? skipped
      2+ times since (a pick that keeps getting skipped)?
    - Discovery adds: how many; impressions per surface (the denominators,
      recorded since 2026-10-19).
    - variety of what the strip SHOWED in the last 28 days: share of
      impressions by artists already on that playlist, and distinct artists
      per 100 impressions (refresh/✕/shown rows all mean "it was on screen")."""
    members = members or {}
    plays_after, skips_after = defaultdict(list), defaultdict(list)
    for ts, tid, kind in events:
        (plays_after if kind == 'play' else skips_after)[tid].append(ts)
    pl_artists = {pid: {lib[int(t)]['artist'] for t in ids if t.isdigit() and int(t) in lib} for pid, ids in members.items()}
    strip_acc = strip_played = strip_kept = strip_skipped = 0
    disc_acc = 0
    shown = Counter()
    seen28, own_artist28, artists28 = 0, 0, set()
    for r in rows:
        surf, v = r.get('surface'), r.get('verdict')
        ts = to_ms(r.get('ts'))
        if ts is None or now_ms - ts > 90 * DAY_MS:
            continue
        key = r.get('key') or {}
        if v == 'shown':
            shown[surf] += 1
        if surf == 'strip' and now_ms - ts <= 28 * DAY_MS and v in ('shown', 'refresh', 'pass', 'reject'):
            try:
                tid = int(key.get('trackId'))
            except (TypeError, ValueError):
                tid = None
            if tid in lib:
                seen28 += 1
                artists28.add(lib[tid]['artist'])
                if lib[tid]['artist'] in pl_artists.get(key.get('playlistId'), ()):
                    own_artist28 += 1
        if surf == 'strip' and v == 'accept':
            try:
                tid = int(key.get('trackId'))
            except (TypeError, ValueError):
                continue
            if now_ms - ts < 14 * DAY_MS:
                continue   # too young to judge
            strip_acc += 1
            if str(tid) in members.get(key.get('playlistId'), {str(tid)}):
                strip_kept += 1
            if any(p > ts for p in plays_after.get(tid, [])):
                strip_played += 1
            if sum(1 for k in skips_after.get(tid, []) if k > ts) >= 2:
                strip_skipped += 1
        elif surf == 'discover' and v == 'accept':
            disc_acc += 1
    out = {'stripAddsJudged': strip_acc, 'stripAddsKept': strip_kept, 'stripAddsPlayedSince': strip_played,
           'stripAddsSkipped2x': strip_skipped, 'discoverAdds90d': disc_acc, 'impressions90d': dict(shown)}
    ok = strip_acc >= 20
    out['stripAddKeptRate'] = round(strip_kept / strip_acc, 4) if ok else None
    out['stripAddPlayedRate'] = round(strip_played / strip_acc, 4) if ok else None
    out['stripAddSkipped2xRate'] = round(strip_skipped / strip_acc, 4) if ok else None
    if seen28 >= 100:
        out['stripShownFromPlaylistArtists28d'] = round(own_artist28 / seen28, 4)
        out['stripDistinctArtistsPer100'] = round(100 * len(artists28) / seen28, 1)
    else:
        out['stripVariety28d'] = 'insufficient data'
    return out


def vs_baseline(journal_path, today):
    """Each headline number next to its first recorded night — "improvement
    against historical performance". None until there is a first night."""
    try:
        with open(journal_path) as f:
            first = json.loads(f.readline())
    except (FileNotFoundError, json.JSONDecodeError, ValueError):
        return None
    pick = lambda j: {
        'challengerAuc': (j.get('auc') or {}).get('challenger'),
        'v5Auc': (j.get('auc') or {}).get('champion_v5'),
        'mixPlayedThroughRate': (j.get('mixes') or {}).get('playedThroughRate'),
        'mixSkipRateWhenPlayed': (j.get('mixes') or {}).get('skipRateWhenPlayed'),
        'stripAddPlayedRate': (j.get('suggestions') or {}).get('stripAddPlayedRate'),
        'stripAddKeptRate': (j.get('suggestions') or {}).get('stripAddKeptRate'),
    }
    return {'since': first.get('at'), 'first': pick(first), 'today': pick(today)}


def drift(lib, events, mood, now_ms):
    snap = Snapshot(lib, events, now_ms)
    ids = list(lib)
    long_run = ridge_pref(snap, ids, mood)
    recent = ridge_pref(snap, ids, mood, recent=True)
    out = {}
    if np.std(long_run) > 0 and np.std(recent) > 0:
        out['soundPrefAgreement'] = round(float(np.corrcoef(long_run, recent)[0, 1]), 3)
    fam_recent, fam_before = Counter(), Counter()
    for ts, tid, kind in events:
        if kind != 'play':
            continue
        age = (now_ms - ts) / DAY_MS
        g = lib[tid]['genre']
        if age <= 30:
            fam_recent[g] += 1
        elif age <= 120:
            fam_before[g] += 1
    tr, tb = sum(fam_recent.values()), sum(fam_before.values())
    if tr >= 50 and tb >= 50:
        shifts = []
        for g in set(fam_recent) | set(fam_before):
            a, b = fam_recent[g] / tr, fam_before[g] / tb
            if abs(a - b) >= 0.03 and (fam_recent[g] + fam_before[g]) >= 15:
                shifts.append((round(a - b, 3), g, round(a, 3), round(b, 3)))
        shifts.sort(reverse=True)
        pick = shifts if len(shifts) <= 8 else shifts[:4] + shifts[-4:]
        out['genreShifts'] = [{'genre': g, 'last30d': a, 'prior90d': b, 'change': d} for d, g, a, b in pick]
    else:
        out['genreShifts'] = 'insufficient data'
    return out


# ── publishing ──────────────────────────────────────────────────────────────

def quantile_map(values, reference):
    """Each value's percentile, read off the reference distribution."""
    ranks = np.argsort(np.argsort(values, kind='mergesort'), kind='mergesort') / max(1, len(values) - 1)
    ref = np.sort(reference)
    return np.interp(ranks, np.linspace(0, 1, len(ref)), ref), ranks


def flags_for(snap, lib, ids, pct, recent_pct):
    """In-library discovery flags (for a future Discover-Weekly-from-my-library)."""
    album_loved = defaultdict(bool)
    for tid in ids:
        t = lib[tid]
        if snap.star(tid) or snap.play_count(tid) >= 5:
            album_loved[t['album']] = True
    out = np.zeros(len(ids), dtype=int)
    now = snap.at
    for i, tid in enumerate(ids):
        t = lib[tid]
        pc = snap.play_count(tid)
        lp = snap.last_played(tid)
        owned_days = (now - t['dateAdded']) / DAY_MS if t['dateAdded'] else 9999
        f = 0
        if pct[i] >= 0.85 and (not lp or now - lp > 90 * DAY_MS):
            f |= FLAG_UNDERPLAYED
        if (snap.star(tid) or pc >= 5) and lp and now - lp > 180 * DAY_MS:
            f |= FLAG_FORGOTTEN
        if pc == 0 and album_loved[t['album']] and owned_days > 60:
            f |= FLAG_OVERLOOKED
        if pc == 0 and not lp and owned_days > 60:
            f |= FLAG_NEVER
        if recent_pct[i] >= 0.85:
            f |= FLAG_RECENT_SOUND
        out[i] = f
    return out


def atomic_json(path, obj, indent=None):
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(obj, f, indent=indent, separators=None if indent else (',', ':'))
    os.replace(tmp, path)


def previous_state(path):
    try:
        return json.load(open(path))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def notify(msg):
    # Only the real nightly job may reach the phone (the wrapper sets
    # JT_TE_NOTIFY=1); tests, dry runs and by-hand runs stay silent.
    if os.environ.get('JT_TE_NOTIFY') != '1':
        log(f'(notification suppressed outside the nightly job) {msg}')
        return
    try:
        topic = open(os.path.expanduser('~/.config/jaketunes/ntfy-topic')).read().strip()
        if topic:
            import urllib.request
            urllib.request.urlopen(urllib.request.Request(f'https://ntfy.sh/{topic}', data=msg.encode(), method='POST'), timeout=10)
    except Exception as e:
        log(f'notify failed: {e}')


def main():
    dry = '--dry-run' in sys.argv
    started = time.time()
    now_ms = time.time() * 1000
    os.makedirs(CONFIG['work'], exist_ok=True)
    status_path = os.path.join(CONFIG['work'], 'taste-engine-status.json')
    state_path = os.path.join(CONFIG['state'], 'taste-state.json')

    hist_age_h = (time.time() - os.path.getmtime(CONFIG['history'])) / 3600
    if hist_age_h > STALE_INPUT_HOURS:
        raise RuntimeError(f'listening history is {hist_age_h:.0f}h old — the 04:00 builder has stalled')

    lib = load_library(CONFIG['library'])
    events = load_history(CONFIG['history'], lib)
    mood_vecs, _ = load_mood(os.path.join(CONFIG['state'], 'mood-index.bin'), lib.keys())
    mood = mood_basis(mood_vecs)
    log(f'{len(lib)} songs · {len(events)} plays/skips · {len(mood)} sound vectors')

    ledger_rows = load_ledgers()
    members = playlist_members()
    verdicts, quiz_reasons, quiz_answers = load_quiz(CONFIG['quiz'], lib)
    quiz_active_from = (verdicts[0][0] + HOLDOUT_DAYS * DAY_MS) if verdicts else None
    if verdicts:
        log(f'Top 1000 Quiz: {quiz_answers} answers, {len(verdicts)} verdicts; the model can use them from '
            f'{datetime.fromtimestamp(quiz_active_from / 1000, tz=timezone.utc):%Y-%m-%d}')

    # 5–6. champion vs challenger on held-back time
    ev_res = evaluate(lib, events, mood, now_ms, verdicts=verdicts)
    strip = strip_check(lib, events, mood, now_ms, ledger_rows, members, verdicts=verdicts)
    ev_res['stripAdds'] = strip
    prev = previous_state(state_path)
    was_promoted = bool(prev.get('promoted'))
    promoted, why = decide_promotion(ev_res, strip, was_promoted)
    log(why)

    # production fit: the two most recent windows (features as of each
    # window's start -> what happened inside it)
    ids = sorted(lib)
    snap_now = Snapshot(lib, events, now_ms, verdicts)
    v5_now = v5_scores(lib, ids, now_ms, snap_now.star, snap_now.play_count, snap_now.last_played)
    model, _, _ = window_train(lib, events, mood, now_ms, windows=2, verdicts=verdicts)
    X_now = features(snap_now, ids, mood)
    raw = predict(model, X_now) if model is not None else v5_now
    if not np.isfinite(raw).all():
        raise RuntimeError('non-finite taste scores — refusing to publish')
    mapped, pct = quantile_map(raw, v5_now)
    recent_pct = np.argsort(np.argsort(X_now[:, FEATURES.index('sound_pref_recent')])) / max(1, len(ids) - 1)
    flags = flags_for(snap_now, lib, ids, pct, recent_pct)

    # 2–4. drift, grading, mistakes
    mix_grade = grade_mixes(events, now_ms)
    led = grade_ledger(ledger_rows, lib, events, now_ms, members)
    dr = drift(lib, events, mood, now_ms)

    weights = {}
    if model is not None:
        weights = {f: round(float(b), 3) for f, b in zip(FEATURES, model['beta'][1:])}
    state = {
        'v': 1, 'builtAt': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'model': 'behavior-v1' if model is not None else 'v5',
        'promoted': bool(promoted and model is not None),
        'why': why,
        'flagBits': {'underplayedFavorite': FLAG_UNDERPLAYED, 'forgotten': FLAG_FORGOTTEN,
                     'overlookedAlbumTrack': FLAG_OVERLOOKED, 'neverPlayed': FLAG_NEVER, 'matchesRecentSound': FLAG_RECENT_SOUND},
        # id -> [score mapped onto v5's scale, percentile 0..1, flags]
        'tracks': {str(tid): [round(float(mapped[i]), 4), round(float(pct[i]), 4), int(flags[i])] for i, tid in enumerate(ids)},
    }
    scorecard = {'at': state['builtAt'], 'evaluation': ev_res, 'promoted': state['promoted'], 'why': why,
                 'weights': weights, 'mixes': mix_grade, 'suggestions': led, 'drift': dr,
                 'flags': {k: int(sum(1 for f in flags if f & bit)) for k, bit in state['flagBits'].items()},
                 'inputs': {'songs': len(lib), 'events': len(events), 'soundVectors': len(mood)},
                 'quiz': {'answers': quiz_answers, 'verdicts': len(verdicts),
                          'activeFrom': datetime.fromtimestamp(quiz_active_from / 1000, tz=timezone.utc).strftime('%Y-%m-%d') if quiz_active_from else None,
                          'gain': ev_res.get('quizGain'), 'reasons': dict(quiz_reasons.most_common())},
                 'seconds': round(time.time() - started, 1)}
    scorecard['vsFirstNight'] = vs_baseline(os.path.join(CONFIG['work'], 'taste-journal.jsonl'),
                                            {'auc': ev_res.get('auc'), 'mixes': mix_grade, 'suggestions': led})
    if dry:
        print(json.dumps(scorecard, indent=2, default=str))
        return 0
    atomic_json(state_path, state)
    atomic_json(os.path.join(CONFIG['work'], 'taste-scorecard.json'), scorecard, indent=2)
    with open(os.path.join(CONFIG['work'], 'taste-journal.jsonl'), 'a') as f:
        f.write(json.dumps({'at': state['builtAt'], 'promoted': state['promoted'], 'wasPromoted': was_promoted,
                            'why': why, 'auc': ev_res.get('auc'), 'gainLowerBound': ev_res.get('gainLowerBound'),
                            'foldsWon': ev_res.get('foldsWon'),
                            'quiz': {'verdicts': len(verdicts), 'gain': ev_res.get('quizGain')}, 'stripAdds': {k: strip.get(k) for k in ('challenger', 'champion_v5', 'adds')}, 'mixes': {k: mix_grade.get(k) for k in ('served', 'playedThroughRate', 'skipRateWhenPlayed')},
                            'suggestions': {k: led.get(k) for k in ('stripAddPlayedRate', 'stripAddKeptRate', 'stripAddSkipped2xRate', 'stripShownFromPlaylistArtists28d', 'stripDistinctArtistsPer100')},
                            'drift': {'soundPrefAgreement': dr.get('soundPrefAgreement')}}, default=str) + '\n')
    atomic_json(status_path, {'ok': True, 'at': state['builtAt'], 'promoted': state['promoted'], 'why': why,
                              'seconds': scorecard['seconds']}, indent=2)
    if state['promoted'] != was_promoted:
        notify(f"JakeTunes taste: {why}")
    log(f"done in {scorecard['seconds']}s — {why}")
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as e:
        try:
            os.makedirs(CONFIG['work'], exist_ok=True)
            atomic_json(os.path.join(CONFIG['work'], 'taste-engine-status.json'),
                        {'ok': False, 'at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'error': str(e)[:300]}, indent=2)
            notify(f'JakeTunes taste engine FAILED: {str(e)[:150]}')
        finally:
            raise
