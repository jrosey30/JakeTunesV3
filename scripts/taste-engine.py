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
     Two checks on other decisions can veto: the suggestion strip (did his
     adds score higher than what he passed over IN THE SAME STRIP — the
     paired check, 2026-10-27; the old pooled AUC is still logged) and the quiz judge (do
     the models agree with his Top 1000 Quiz choices — heats, duels,
     this-or-that — scored on models that never saw an answer?). When the
     quiz judge is measured it outranks the strip: a reliable quiz win
     overrides a strip veto, a reliable quiz loss vetoes on its own. The
     quiz judge is REQUIRED: if it cannot grade, v5 stays or returns.
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


class QuizUnreadable(ValueError):
    pass


def load_quiz_questions(path, lib):
    """Jake's Top 1000 Quiz CHOICES as pairwise preferences, for the quiz
    judge (quiz_check). Only questions where he chose between songs:
      - heat  (choice 'picked'): every picked song > every song not picked
      - duel / pick (this-or-that) with a song id: the winner > the other
      - best (best of three) with a song id: the winner > each of the two others
    Absolute answers (in/out, still love it, both/neither, all/none) are NOT
    pairs: they say where a song sits against his love line, and the two
    models' scores are on different scales, so there is no shared neutral
    point to compare them against. unknown/skip carry nothing. Undo lines
    retract the answer whose `at` they name (⚠️ TWIN: JakeTunesMobile
    backend/src/util/top1000.ts standingAnswers; validation follows its
    parseAnswer). Songs no longer in the library drop out of a pair.

    Returns [(ms, [(winner_tid, loser_tid), ...])], one entry per question
    with at least one pair, oldest first.

    FAILS LOUDLY (the judge is a required gate, 2026-10-27): a missing file
    raises FileNotFoundError, and an unreadable line anywhere but the last
    raises QuizUnreadable. Only a torn LAST line (an append in progress) is
    tolerated — anything else means the file is not what we think it is."""
    rows, gone = [], set()
    with open(path, encoding='utf-8') as f:
        lines = f.read().split('\n')
    while lines and not lines[-1].strip():
        lines.pop()
    bad = []
    for n, line in enumerate(lines):
        if not line.strip():
            continue
        try:
            a = json.loads(line)
        except json.JSONDecodeError:
            if n != len(lines) - 1:
                bad.append(n + 1)
            continue
        if not isinstance(a, dict):
            if n != len(lines) - 1:
                bad.append(n + 1)
            continue
        if a.get('kind') == 'undo':
            gone.add(a.get('target'))
        else:
            rows.append(a)
    if bad:
        raise QuizUnreadable(f'{len(bad)} unreadable line(s) in the answers file (first: line {bad[0]})')

    def tid_of(x):
        try:
            t = int(x)
        except (TypeError, ValueError):
            return None
        return t if t in lib else None

    out = []
    for a in rows:
        ts = to_ms(a.get('at'))
        if ts is None or a.get('at') in gone:
            continue
        kind, choice = a.get('kind'), a.get('choice')
        ids = [str(i) for i in (a.get('ids') or [])]
        if len(set(ids)) != len(ids):
            continue
        if kind == 'heat' and choice == 'picked':
            picked = list(dict.fromkeys(str(i) for i in (a.get('picked') or [])))
            if not picked or len(picked) >= len(ids) or not all(p in ids for p in picked):
                continue
            winners, losers = picked, [i for i in ids if i not in picked]
        elif (kind in ('duel', 'pick') and len(ids) == 2 and choice in ids) or (kind == 'best' and len(ids) == 3 and choice in ids):
            winners, losers = [choice], [i for i in ids if i != choice]
        else:
            continue
        pairs = [(w, l) for w in map(tid_of, winners) for l in map(tid_of, losers) if w is not None and l is not None]
        if pairs:
            out.append((ts, pairs))
    out.sort(key=lambda q: q[0])
    return out


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


STRIP_FROZEN_DAYS = 2 * HOLDOUT_DAYS   # both strip checks grade models frozen this long ago


def strip_frozen(lib, events, mood, now_ms, verdicts=()):
    """Challenger and v5 frozen at T = now − 56 days, scored over the whole
    library — shared by both strip checks. None when the challenger cannot
    be fitted there."""
    T = now_ms - STRIP_FROZEN_DAYS * DAY_MS
    model, _, _ = window_train(lib, events, mood, T, verdicts=verdicts)
    if model is None:
        return None
    snap = Snapshot(lib, events, T, verdicts)
    ids = sorted(lib)
    return {'T': T, 'snap': snap,
            'ch': dict(zip(ids, predict(model, features(snap, ids, mood)))),
            'v5': dict(zip(ids, v5_scores(lib, ids, T, snap.star, snap.play_count, snap.last_played)))}


def strip_check(lib, events, mood, now_ms, ledger_rows, members, verdicts=(), frozen=None):
    """The OLD strip check, kept for comparison (2026-10-27: no longer the
    gate — strip_paired_check is). Of the playlist suggestions shown in the
    last 56 days, did the songs Jake ADDED (and kept) score higher than the
    ones he passed over? One AUC over every impression, pooled across
    playlists and days. Challenger and v5 are both frozen as of 56 days
    ago, so the adds were never seen."""
    frozen = frozen if frozen is not None else strip_frozen(lib, events, mood, now_ms, verdicts)
    if frozen is None:
        return {'verdict': 'insufficient data'}
    T, ch, v5 = frozen['T'], frozen['ch'], frozen['v5']
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
    if a[:, 2].sum() == len(a):
        return {'verdict': 'insufficient data', 'impressions': len(rows), 'why': 'no passed-over suggestions'}
    return {'verdict': 'measured', 'impressions': len(rows), 'adds': int(a[:, 2].sum()),
            'challenger': round(wauc(a[:, 0], a[:, 2], w), 4), 'champion_v5': round(wauc(a[:, 1], a[:, 2], w), 4)}


STRIP_MIN_GROUPS = 40        # fewer strip contexts with a kept add than this = insufficient data
STRIP_BOOTSTRAP = 1000       # resamples of GROUPS (one strip context is one decision)
STRIP_SEED = 19
STRIP_SEEN = ('shown', 'accept', 'pass', 'refresh', 'reject')   # every verdict that means "it was on screen"


def strip_groups(ledger_rows, members, lib, t_from, t_to=float('inf')):
    """The suggestion strip as Jake saw it, one group per strip context in
    [t_from, t_to). The context key:
      - the shown batch id (ctx.batch, logged on every strip row since
        2026-10-19 — one strip of five songs on one playlist), when the row
        has one;
      - otherwise (older rows, which never carry a batch) the playlist and
        the UTC day.
    In each group: KEPT = songs he added and that are still on the playlist
    (an unknown playlist counts as kept, as in strip_check); PASSED = songs
    shown in that group that he did not add. A song added and later removed
    is neither — it is not a clean "yes" and was not passed over. Groups with
    no kept add or no passed song carry no pair and are dropped.
    Returns [(key, [kept tids], [passed tids])], sorted by key."""
    g = defaultdict(lambda: (set(), set(), set()))   # kept, added (any), seen
    for r in ledger_rows:
        if not isinstance(r, dict) or r.get('surface') != 'strip' or r.get('verdict') not in STRIP_SEEN:
            continue
        ts = to_ms(r.get('ts'))
        k = r.get('key') or {}
        try:
            tid = int(k.get('trackId'))
        except (TypeError, ValueError, AttributeError):
            continue
        if ts is None or not (t_from <= ts < t_to) or tid not in lib:
            continue
        ctx = r.get('ctx')
        batch = ctx.get('batch') if isinstance(ctx, dict) else None
        key = ('batch', str(batch)) if batch else ('day', str(k.get('playlistId')), int(ts // DAY_MS))
        kept, added, seen = g[key]
        seen.add(tid)
        if r['verdict'] == 'accept':
            added.add(tid)
            if str(tid) in members.get(k.get('playlistId'), {str(tid)}):
                kept.add(tid)
    out = []
    for key in sorted(g, key=str):
        kept, added, seen = g[key]
        passed = seen - added
        if kept and passed:
            out.append((key, sorted(kept), sorted(passed)))
    return out


def paired_agreement(groups, a, b, seed=STRIP_SEED):
    """Per-group pairwise agreement of two score maps with the strip: in each
    group, the share of (kept add, passed song) pairs where the model scores
    the kept add higher (a tie counts half); then the plain mean over groups
    (every strip context weighs the same, however many songs it showed). The
    bootstrap resamples whole GROUPS, STRIP_BOOTSTRAP times with a fixed
    seed; the interval is the 5th / 95th percentile of (a − b)."""
    ga, gb = np.zeros(len(groups)), np.zeros(len(groups))
    pairs = 0
    for i, (_, kept, passed) in enumerate(groups):
        for s, out in ((a, ga), (b, gb)):
            d = np.subtract.outer(np.array([s[t] for t in kept], float), np.array([s[t] for t in passed], float))
            out[i] = float(np.mean((d > 0) + 0.5 * (d == 0)))
        pairs += len(kept) * len(passed)
    rnd = np.random.default_rng(seed)
    idx = rnd.integers(0, len(groups), (STRIP_BOOTSTRAP, len(groups)))
    gains = np.sort(ga[idx].mean(axis=1) - gb[idx].mean(axis=1))
    return {'a': float(ga.mean()), 'b': float(gb.mean()), 'gain': float(ga.mean() - gb.mean()),
            'lb': float(gains[int(0.05 * STRIP_BOOTSTRAP)]), 'ub': float(gains[int(0.95 * STRIP_BOOTSTRAP) - 1]),
            'pairs': pairs, 'groups': len(groups)}


def strip_paired_check(lib, events, mood, now_ms, ledger_rows, members, verdicts=(), frozen=None):
    """The suggestion-strip GATE (2026-10-27, replaces the pooled AUC of
    strip_check, which stays computed and logged for comparison): each kept
    add is compared only with the songs shown and passed over in the SAME
    strip context (strip_groups), so a model is not rewarded for ranking one
    playlist's suggestions above another's. Same frozen-time rule: challenger
    and v5 frozen 56 days ago, graded on strip contexts since then. Needs
    STRIP_MIN_GROUPS groups with a kept add."""
    frozen = frozen if frozen is not None else strip_frozen(lib, events, mood, now_ms, verdicts)
    if frozen is None:
        return {'verdict': 'insufficient data', 'why': 'no challenger can be fitted at the freeze'}
    groups = strip_groups(ledger_rows, members, lib, frozen['T'])
    if len(groups) < STRIP_MIN_GROUPS:
        return {'verdict': 'insufficient data', 'groups': len(groups),
                'why': f'{len(groups)} strip contexts with a kept add (need {STRIP_MIN_GROUPS})'}
    r = paired_agreement(groups, frozen['ch'], frozen['v5'])
    return {'verdict': 'measured', 'groups': r['groups'], 'adds': sum(len(k) for _, k, _ in groups), 'pairs': r['pairs'],
            'challenger': round(r['a'], 4), 'champion_v5': round(r['b'], 4), 'gain': round(r['gain'], 4),
            'gainLowerBound': round(r['lb'], 4), 'gainUpperBound': round(r['ub'], 4),
            'frozenAt': datetime.fromtimestamp(frozen['T'] / 1000, tz=timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}


QUIZ_MIN_QUESTIONS = 500     # fewer scorable quiz choices than this = insufficient data
QUIZ_BOOTSTRAP = 1000        # resamples of QUESTIONS (a heat is one decision, not k×(n−k))
QUIZ_SEED = 13


def quiz_agreement(questions, ch, v5):
    """Pairwise agreement of two score maps with Jake's quiz choices: the
    share of (picked > not picked) pairs where the model scores the picked
    song higher (a tie counts half). Pooled over pairs; the bootstrap
    resamples whole questions, QUIZ_BOOTSTRAP times with a fixed seed, and
    reports the 5th / 95th percentiles of (challenger − v5)."""
    n = np.zeros(len(questions))
    ach = np.zeros(len(questions))
    av5 = np.zeros(len(questions))
    agree = lambda d: 1.0 if d > 0 else (0.5 if d == 0 else 0.0)
    for q, (_, pairs) in enumerate(questions):
        n[q] = len(pairs)
        ach[q] = sum(agree(ch[w] - ch[l]) for w, l in pairs)
        av5[q] = sum(agree(v5[w] - v5[l]) for w, l in pairs)
    a, b = float(ach.sum() / n.sum()), float(av5.sum() / n.sum())
    rnd = np.random.default_rng(QUIZ_SEED)
    idx = rnd.integers(0, len(questions), (QUIZ_BOOTSTRAP, len(questions)))
    nn = n[idx].sum(axis=1)
    gains = np.sort(ach[idx].sum(axis=1) / nn - av5[idx].sum(axis=1) / nn)
    return {'challenger': round(a, 4), 'champion_v5': round(b, 4), 'gain': round(a - b, 4),
            'gainLowerBound': round(float(gains[int(0.05 * QUIZ_BOOTSTRAP)]), 4),
            'gainUpperBound': round(float(gains[int(0.95 * QUIZ_BOOTSTRAP) - 1]), 4),
            'questions': len(questions), 'pairs': int(n.sum())}


QUIZ_GRADE_DAYS = HOLDOUT_DAYS   # the judge grades on the most recent 28 days of choices


class QuizLeak(RuntimeError):
    pass


def quiz_check(lib, events, mood, questions, now_ms, verdicts=()):
    """Third check — the quiz judge (2026-10-27, Jake: "i want it now"; then
    "the models absolutely cannot be getting worse"): do the challenger and
    v5 agree with the choices Jake made in the Top 1000 Quiz (heats, duels,
    this-or-that, best of three)?

    HELD-OUT TIME, like every other test here. The graded choices are the
    ones made in [T, now), T = max(his first standing choice, now − 28 days).
    Both models are frozen at T, and the challenger is fitted the way the
    live model is (the two 28-day windows ending at T) with the quiz
    verdicts AS OF T — so once the verdicts start counting as a feature
    (2026-11-20, see quiz_active_from in main) it is still graded only on
    choices made after everything it learned from. Until then T is his first
    choice and no verdict is older than T, so the quiz column is empty.
    (A random split by question was rejected: the verdict feature is per
    SONG, so a song answered in a training question would carry its answer
    into a graded one.)

    Raises QuizLeak if the frozen snapshot holds any verdict given at or
    after T, or the quiz column disagrees with the as-of-T verdicts."""
    if not questions:
        return {'verdict': 'insufficient data', 'questions': 0, 'why': 'no scorable choices (heats, duels, this-or-that, best of three)'}
    T = max(questions[0][0], now_ms - QUIZ_GRADE_DAYS * DAY_MS)
    graded = [q for q in questions if q[0] >= T]
    if len(graded) < QUIZ_MIN_QUESTIONS:
        return {'verdict': 'insufficient data', 'questions': len(graded),
                'why': f'{len(graded)} choices in the held-out window (need {QUIZ_MIN_QUESTIONS})'}
    model, _, _ = window_train(lib, events, mood, T, windows=2, verdicts=verdicts)
    if model is None:
        return {'verdict': 'insufficient data', 'questions': len(graded), 'why': 'no training data before the held-out window'}
    snap = Snapshot(lib, events, T, verdicts)
    ids = sorted({t for _, pairs in graded for p in pairs for t in p})
    X = features(snap, ids, mood)
    # the guarantee, checked: the challenger knows exactly the verdicts given
    # before T — none from the held-out window — and the graded choices are
    # all inside it
    allowed = defaultdict(float)
    for ts, tid, v in verdicts:
        if ts < T:
            allowed[tid] += v
    seen = {k: v for k, v in snap.verdict.items() if v}
    if seen != {k: v for k, v in allowed.items() if v}:
        raise QuizLeak('the challenger saw quiz verdicts from the held-out window — refusing to grade it on the quiz')
    want = np.array([max(-2.0, min(2.0, allowed.get(t, 0.0))) / 2.0 for t in ids])
    if not np.allclose(X[:, FEATURES.index('quiz_verdict')], want) or any(q[0] < T for q in graded):
        raise QuizLeak('the quiz column does not match the verdicts before the held-out window — refusing to grade it on the quiz')
    ch = dict(zip(ids, predict(model, X)))
    v5 = dict(zip(ids, v5_scores(lib, ids, T, snap.star, snap.play_count, snap.last_played)))
    res = quiz_agreement(graded, ch, v5)
    res['frozenAt'] = datetime.fromtimestamp(T / 1000, tz=timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    res['verdictsTrainedOn'] = sum(1 for ts, _, _ in verdicts if ts < T)
    res['verdict'] = 'measured'
    return res


def run_quiz_check(lib, events, mood, now_ms, verdicts=(), path=None):
    """The quiz judge, never raising: any failure (missing or unreadable
    answers file, leakage refusal, any exception) comes back as a verdict
    that is not 'measured' — and decide_promotion keeps or returns v5 on
    anything but 'measured' (fail closed)."""
    try:
        questions = load_quiz_questions(path or CONFIG['quiz'], lib)
        return quiz_check(lib, events, mood, questions, now_ms, verdicts)
    except FileNotFoundError:
        return {'verdict': 'no answers file', 'why': 'no Top 1000 Quiz answers file'}
    except QuizUnreadable as e:
        return {'verdict': 'parse error', 'why': str(e)}
    except QuizLeak as e:
        return {'verdict': 'leakage refused', 'why': str(e)}
    except Exception as e:   # noqa: BLE001 — fail closed on anything
        return {'verdict': 'error', 'why': f'{type(e).__name__}: {e}'[:300]}


def decide_promotion(ev_res, strip, was_promoted, quiz=None, strip_fallback=None):
    """Promote on a reliable win, keep while not worse, demote otherwise.
    The suggestion-strip check may veto, never promote on its own.
    The quiz judge (Jake's ~10k direct choices vs ~126 strip adds) is a
    REQUIRED gate (2026-10-27, Jake: "the models absolutely cannot be
    getting worse"): if it could not grade — too few held-out choices, a
    leakage refusal, an unreadable or missing answers file, any error — the
    challenger is neither promoted nor kept, v5 stays or returns. When it is
    measured it never promotes on its own, but it outranks the strip: a
    reliable quiz win (bootstrap lower bound > 0) overrides the strip's
    veto, and a reliable quiz loss (upper bound < 0) is a veto of its own —
    for promoting AND for keeping (a promoted challenger is rolled back the
    first night it loses on the quiz)."""
    quiz = quiz or {'verdict': 'not run', 'why': 'the quiz judge did not run'}
    # 2026-10-27: when the paired strip test cannot grade (fewer than
    # STRIP_MIN_GROUPS strip contexts — he builds playlists in bursts, so this
    # is common), the old pooled check keeps the veto it had: switching tests
    # must never loosen the gate
    if strip.get('verdict') != 'measured' and strip_fallback and strip_fallback.get('verdict') == 'measured':
        strip = strip_fallback
    if ev_res.get('verdict') != 'measured':
        return False, ev_res.get('verdict', 'insufficient data') + (' — v5 stays' if not was_promoted else ' — ROLLED BACK to v5 until there is enough data again')
    if quiz.get('verdict') != 'measured':
        reason = quiz.get('verdict', 'unknown') + (f" — {quiz['why']}" if quiz.get('why') else '')
        return False, f'quiz judge could not grade: {reason}; ' + ('v5 kept' if not was_promoted else 'ROLLED BACK to v5')
    a, b = ev_res['auc']['challenger'], ev_res['auc']['champion_v5']
    lb, won = ev_res.get('gainLowerBound'), ev_res['foldsWon']
    n = len([f for f in ev_res['folds'] if f['verdict'] == 'measured'])
    # the strip is the PAIRED check (strip_paired_check): it vetoes when the
    # challenger is more than 0.02 below v5, or reliably below it (the 95th
    # percentile of the gain under 0)
    strip_ok = strip.get('verdict') != 'measured' or (
        strip['challenger'] >= strip['champion_v5'] - 0.02
        and not (strip.get('gainUpperBound') is not None and strip['gainUpperBound'] < 0))
    q_measured = quiz.get('verdict') == 'measured'
    q_wins = q_measured and quiz['gain'] > 0 and quiz['gainLowerBound'] > 0
    q_veto = q_measured and quiz['gainUpperBound'] < 0
    override = q_wins and not strip_ok
    ok = (strip_ok or q_wins) and not q_veto
    s_txt = f"suggestion-strip check ({strip.get('challenger', 0):.3f} vs {strip.get('champion_v5', 0):.3f})"
    q_txt = (f"quiz {'agrees' if q_wins else 'says'} {quiz['challenger']:.3f} vs {quiz['champion_v5']:.3f} "
             f"(lb {quiz['gainLowerBound']:+.3f}, ub {quiz['gainUpperBound']:+.3f}, {quiz['questions']} choices)") if q_measured else None
    tail = ''
    if override:
        tail = f'; {q_txt} — overrides the {s_txt}'
    elif q_veto:
        tail = f'; {q_txt} — the quiz vetoes'
    elif q_txt:
        tail = f'; {q_txt}'
    if (not was_promoted) and ev_res['meanGain'] >= MIN_GAIN and lb is not None and lb > 0 and won * 2 > n and ok:
        if override:
            return True, f'PROMOTED: challenger {a:.3f} vs v5 {b:.3f} (won {won}/{n} windows, gain >= {lb:+.3f} at 95%){tail}'
        return True, f'promoted: {a:.3f} vs v5 {b:.3f} (won {won}/{n} windows, gain >= {lb:+.3f} at 95%)' + tail
    if was_promoted and ev_res['meanGain'] >= 0 and ok:
        return True, f'kept: {a:.3f} vs v5 {b:.3f} (won {won}/{n} windows)' + tail
    if was_promoted:
        why = '' if (ok or q_veto) else ' (and it ranked suggestion adds worse)'
        return False, f'ROLLED BACK to v5: challenger {a:.3f} vs v5 {b:.3f}' + why + tail
    why = '' if (ok or q_veto) else '; ranks suggestion adds worse'
    return False, f'not promoted: {a:.3f} vs v5 {b:.3f} (won {won}/{n} windows, gain lower bound {lb})' + why + tail


# ── the SHADOW: candidate #12, measured nightly, NEVER published ────────────
#
# 2026-10-27 (Jake: "Go shadow go!"; the taste lab, candidate #12): v5 + λ·m,
# where m is a pairwise taste model — Bradley–Terry on feature differences,
# weights >= 0, only the features whose direction agrees with the quiz
# (univariate agreement >= 0.52 on the quiz pairs it may train on, signs fixed
# by it), trained on three kinds of pairs:
#   quiz   his heat / duel / this-or-that / best-of-three choices (winner > loser)
#   strip  kept add > passed song in the same strip context (strip_groups)
#   plays  loved in a 28-day window (>= 2 play days and no skip, or starred)
#          > skipped in it (more skips than plays), features at the window start
# score = z(v5 logit) + λ·z(m), λ picked from SHADOW_LAMBDAS on TRAINING data
# only: an inner 80/20 split of every source, and the λ whose WORST held-out
# gain over v5 across the sources is largest (ties → the smaller λ; λ = 0 is
# v5 itself, so the pick is never worse than v5 on any training source).
#
# Each night it gets the live model's three tests plus a favourites check, each
# with its own leakage rule (from the lab):
#   holdout  per fold: fitted as of the cut; quiz pairs touching any song the
#            fold grades are dropped (the quiz postdates every fold, so only
#            global weights carry over — the lab's flagged small leak)
#   strip    frozen 56 days ago; strip pairs only from before the freeze; quiz
#            pairs touching any graded strip song dropped
#   quiz     the judge's held-out window [T, now). Choices before T always
#            train; choices inside it are graded out-of-fold by question group
#            (5 folds; a group = the same set of songs, so a rematch never
#            straddles train and test) — every graded choice comes from a model
#            that never trained on it. Features frozen at T.
# It is written to taste-shadow.jsonl and tests.shadow; it never touches the
# published scores, `promoted` or `why`, and any failure is caught and logged.

SHADOW_NAME = '#12 v5 + λ·multi-pairwise (quiz + strip + plays, taste features, w >= 0), λ nested maximin'
SHADOW_FEATURES = tuple(f for f in FEATURES if f != 'quiz_verdict') + (
    'v5_album', 'v5_artist', 'v5_genre', 'v5_decade', 'v5_plays', 'v5_recency')
SHADOW_LAMBDAS = (0.0, 0.1, 0.2, 0.5, 1.0, 2.0, 5.0)
SHADOW_AGREE = 0.52          # a feature joins m only if it agrees with the training quiz pairs this well (either way)
SHADOW_SOURCE_W = {'quiz': 1.0, 'strip': 0.5, 'plays': 0.25}   # relative to the quiz pair count
SHADOW_L2 = 10.0
SHADOW_QFOLDS = 5
SHADOW_PLAY_CAP = 4000       # sampled play pairs per window
SHADOW_MIN_VALID = 50        # an inner-validation source needs this many pairs to vote on λ
SHADOW_BUDGET_S = 420        # the nightly job has a 900 s timeout; the shadow gives up long before
SHADOW_BOOTSTRAP = 1000


class ShadowUnavailable(RuntimeError):
    pass


def fast_wauc(score, y, w):
    """wauc, vectorised (ties count half) — equal to wauc (tested)."""
    u, inv = np.unique(score, return_inverse=True)
    pw = np.bincount(inv, weights=w * (y == 1), minlength=len(u))
    nw = np.bincount(inv, weights=w * (y == 0), minlength=len(u))
    P, N = pw.sum(), nw.sum()
    if P <= 0 or N <= 0:
        return None
    below = np.cumsum(nw) - nw
    return float((pw * (below + 0.5 * nw)).sum() / (P * N))


def _zs(v):
    v = np.asarray(v, float)
    return (v - v.mean()) / (v.std() + 1e-12)


def _agree(s, idx):
    d = s[idx[:, 0]] - s[idx[:, 1]]
    return float((np.sum(d > 0) + 0.5 * np.sum(d == 0)) / len(d))


class Shadow:
    def __init__(self, lib, events, mood, ledger_rows, members, questions, deadline):
        self.lib, self.events, self.mood = lib, events, mood
        self.ledger_rows, self.members, self.questions = ledger_rows, members, questions
        self.deadline = deadline
        self.ids = sorted(lib)
        self.pos = {t: i for i, t in enumerate(self.ids)}
        self._snap = {}
        # question groups → folds (a group = the same set of songs)
        keys = [tuple(sorted({t for p in pairs for t in p})) for _, pairs in questions]
        uniq = sorted(set(keys))
        perm = np.random.default_rng(29).permutation(np.arange(len(uniq)) % SHADOW_QFOLDS)
        fold_of = dict(zip(uniq, perm))
        self.qfold = np.array([fold_of[k] for k in keys], dtype=int)

    def tick(self):
        if time.time() > self.deadline:
            raise ShadowUnavailable(f'over its {SHADOW_BUDGET_S}s time budget')

    def snap(self, at):
        """Full-library features (+ v5's parts) and v5's logit as of `at`.
        No quiz verdicts: the quiz reaches m only as pairs, never as a column."""
        if at in self._snap:
            return self._snap[at]
        self.tick()
        lib = self.lib
        snap = Snapshot(lib, self.events, at, ())
        X = features(snap, self.ids, self.mood)
        if np.any(X[:, FEATURES.index('quiz_verdict')] != 0):
            raise ShadowUnavailable('a quiz verdict reached the shadow as a feature')
        X = X[:, [FEATURES.index(f) for f in FEATURES if f != 'quiz_verdict']]
        z, parts = v5_logit_parts(lib, self.ids, at, snap.star, snap.play_count, snap.last_played)
        self._snap[at] = {'X': np.hstack([X, parts[:, :6]]), 'v5z': z, 'snap': snap}
        return self._snap[at]

    # ── training pairs ──
    def quiz_idx(self, qset, exclude=frozenset()):
        return np.array([(self.pos[w], self.pos[l]) for qi in qset for w, l in self.questions[qi][1]
                         if w not in exclude and l not in exclude], dtype=int).reshape(-1, 2), \
            np.array([self.qfold[qi] for qi in qset for w, l in self.questions[qi][1]
                      if w not in exclude and l not in exclude], dtype=int)

    def strip_idx(self, before):
        pairs = [(k, p) for _, kept, passed in strip_groups(self.ledger_rows, self.members, self.lib, 0, before)
                 for k in kept for p in passed]
        return np.array([(self.pos[a], self.pos[b]) for a, b in pairs], dtype=int).reshape(-1, 2)

    def play_idx(self, cut, windows=2, seed=3):
        rnd = np.random.default_rng(seed)
        out = []
        for i in range(windows):
            end = cut - i * HOLDOUT_DAYS * DAY_MS
            start = end - HOLDOUT_DAYS * DAY_MS
            days, pl, sk = defaultdict(set), Counter(), Counter()
            for ts, tid, k in self.events:
                if start <= ts < end:
                    if k == 'play':
                        pl[tid] += 1
                        days[tid].add(int(ts // DAY_MS))
                    else:
                        sk[tid] += 1
            starred = {tid for tid, t in self.lib.items() if t['rating'] > 0 and t['starredAt'] and start <= t['starredAt'] < end}
            good = sorted({t for t in pl if len(days[t]) >= 2 and sk[t] == 0} | starred)
            bad = sorted(t for t in set(pl) | set(sk) if sk[t] > pl[t] and t not in starred)
            if not good or not bad:
                continue
            n = min(SHADOW_PLAY_CAP, len(good) * len(bad))
            gi, bi = rnd.integers(0, len(good), n), rnd.integers(0, len(bad), n)
            out.append((start, np.array([(self.pos[good[a]], self.pos[bad[b]]) for a, b in zip(gi, bi)], dtype=int)))
        return out

    def sources(self, at, qset, exclude, quiz_at):
        """[(name, feature time, pair index array, quiz fold per pair or None)]: the
        training data allowed for a test frozen at `at`."""
        qi, qg = self.quiz_idx(qset, exclude)
        out = [('quiz', quiz_at, qi, qg)]
        sp = self.strip_idx(at)
        if len(sp):
            out.append(('strip', at, sp, None))
        for start, pp in self.play_idx(at):
            out.append(('plays', start, pp, None))
        return out

    # ── fitting ──
    def fit_pairs(self, blocks, cols, sign):
        """Pairwise logistic on feature differences with weights >= 0 (an
        active set: a weight that comes out negative is pinned at 0 and the
        rest refitted). Returns weights over `cols` of the raw features."""
        sg = np.asarray(sign, float)
        Ds, Ws = [], []
        for X, idx, wt in blocks:
            if len(idx):
                d = (X[idx[:, 0]][:, cols] - X[idx[:, 1]][:, cols]) * sg
                Ds.append(d)
                Ws.append(np.full(len(d), wt))
        D = np.vstack(Ds)
        Z = np.vstack([D, -D])
        y = np.concatenate([np.ones(len(D)), np.zeros(len(D))])
        w = np.concatenate(Ws + Ws)
        live = list(range(len(cols)))
        while True:
            self.tick()
            m = fit_logistic(Z[:, live], y, w, SHADOW_L2)
            neg = [(m['beta'][1 + j], c) for j, c in enumerate(live) if m['beta'][1 + j] < 0]
            if not neg or len(live) == 1:
                break
            live.remove(min(neg)[1])
        beta = np.zeros(len(cols))
        beta[live] = np.maximum(0.0, m['beta'][1:]) / m['sd']
        return beta * sg

    def fit_m(self, srcs):
        q = srcs[0]
        if len(q[2]) < SHADOW_MIN_VALID:
            raise ShadowUnavailable(f'{len(q[2])} quiz pairs to train on')
        Xq = self.snap(q[1])['X']
        cols, sg = [], []
        for c in range(Xq.shape[1]):
            a = _agree(Xq[:, c], q[2])
            if a >= SHADOW_AGREE or a <= 1 - SHADOW_AGREE:
                cols.append(c)
                sg.append(1.0 if a >= 0.5 else -1.0)
        if not cols:
            raise ShadowUnavailable('no feature agrees with the quiz')
        nq = len(q[2])
        blocks = [(self.snap(t)['X'], idx, SHADOW_SOURCE_W[n] * nq / len(idx)) for n, t, idx, _ in srcs if len(idx)]
        return cols, self.fit_pairs(blocks, cols, sg)

    def blend(self, at, qset, exclude=frozenset(), quiz_at=None):
        """Candidate #12 fitted on the data allowed for a test frozen at `at`;
        returns (score over the library as of `at`, info)."""
        srcs = self.sources(at, qset, exclude, quiz_at if quiz_at is not None else at)
        rnd = np.random.default_rng(5)
        tr, va = [], []
        for n, t, idx, grp in srcs:
            if n == 'quiz' and len(set(grp.tolist())) > 1:
                m = grp == rnd.choice(sorted(set(grp.tolist())), 1)[0]
            else:
                m = rnd.random(len(idx)) < 0.2
            tr.append((n, t, idx[~m], None))
            va.append((n, t, idx[m]))
        cols, beta = self.fit_m(tr)
        worst = {}
        for lam in SHADOW_LAMBDAS:
            g = []
            for n, t, idx in va:
                if len(idx) < SHADOW_MIN_VALID:
                    continue
                v = _zs(self.snap(t)['v5z'])
                mm = _zs(self.snap(t)['X'][:, cols] @ beta)
                g.append(_agree(v + lam * mm, idx) - _agree(v, idx))
            worst[lam] = round(min(g), 4) if g else 0.0
        lam = max(SHADOW_LAMBDAS, key=lambda l_: (worst[l_], -l_))
        cols, beta = self.fit_m(srcs)
        s = self.snap(at)
        score = _zs(s['v5z']) + lam * _zs(s['X'][:, cols] @ beta)
        info = {'lambda': lam, 'innerWorstGain': worst[lam],
                'pairs': {n: int(sum(len(i) for nn, _, i, _ in srcs if nn == n)) for n in ('quiz', 'strip', 'plays')},
                'weights': {SHADOW_FEATURES[c]: round(float(b), 3) for c, b in zip(cols, beta) if b}}
        return score, info


def v5_logit_parts(lib, ids, at_ms, star_at, plays_at, last_at):
    """v5's logit z and its seven parts (album, artist, genre, decade, plays,
    recency, intensity) — the same arithmetic as v5_scores, which stays the
    only v5 the live engine uses (1 / (1 + e^−z) == v5_scores, tested)."""
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
    P = np.zeros((len(ids), 7))
    for i, tid in enumerate(ids):
        t = lib[tid]
        pc = plays_at(tid)
        lp = last_at(tid)
        days_ago = (at_ms - lp) / DAY_MS if lp else 3650
        months = max(1.0, (at_ms - t['dateAdded']) / (30 * DAY_MS)) if t['dateAdded'] else 24.0
        P[i] = [al.get(t['album'], prior), ar.get(t['artist'], prior), ge.get(t['genre'], prior), de.get(dec(t), prior),
                math.log1p(pc) / play_max if play_max > 0 else 0.0, 1 - min(days_ago, 3650) / 3650,
                math.log1p(pc) / math.sqrt(months)]
    W = V5_W
    z = (W['bias'] + W['album'] * P[:, 0] + W['artist'] * P[:, 1] + W['genre'] * P[:, 2] + W['decade'] * P[:, 3]
         + W['plays'] * P[:, 4] + W['recency'] * P[:, 5] + W['intensity'] * P[:, 6])
    return z, P


def _sigmoid(z):
    return 1 / (1 + np.exp(-z))


def shadow_holdout(sh, now_ms):
    """The holdout folds of evaluate(), graded on the shadow. v5 is scored as
    the live test scores it, so champion_v5 matches tests.holdout."""
    folds, arrays = [], []
    for k in range(1, FOLDS + 1):
        cut = now_ms - k * HOLDOUT_DAYS * DAY_MS
        te_ids, y, w = outcomes(sh.lib, sh.events, cut, cut + HOLDOUT_DAYS * DAY_MS)
        if len(te_ids) < MIN_EVAL_TRACKS or (len(y) - y.sum()) < MIN_EVAL_NEG:
            folds.append({'window': k, 'verdict': 'insufficient data'})
            continue
        s, info = sh.blend(cut, range(len(sh.questions)), exclude=frozenset(te_ids), quiz_at=sh.quiz_at)
        r = np.array([sh.pos[t] for t in te_ids])
        a, b = s[r], _sigmoid(sh.snap(cut)['v5z'][r])
        folds.append({'window': k, 'verdict': 'measured', 'shadow': round(wauc(a, y, w), 4),
                      'champion_v5': round(wauc(b, y, w), 4), 'lambda': info['lambda'], 'quizPairs': info['pairs']['quiz']})
        arrays.append((a, b, y, w))
    if len(arrays) < 2:
        return {'verdict': 'insufficient data', 'folds': folds}
    rnd = np.random.default_rng(11)
    boots = []
    for _ in range(SHADOW_BOOTSTRAP):
        g = []
        for a, b, y, w in arrays:
            i = rnd.integers(0, len(y), len(y))
            ga, gb = fast_wauc(a[i], y[i], w[i]), fast_wauc(b[i], y[i], w[i])
            if ga is not None and gb is not None:
                g.append(ga - gb)
        if g:
            boots.append(float(np.mean(g)))
    boots.sort()
    m = [f for f in folds if f['verdict'] == 'measured']
    sa, sb = float(np.mean([f['shadow'] for f in m])), float(np.mean([f['champion_v5'] for f in m]))
    return {'verdict': 'measured', 'shadow': round(sa, 4), 'champion_v5': round(sb, 4), 'gain': round(sa - sb, 4),
            'gainLowerBound': round(boots[int(0.05 * len(boots))], 4), 'gainUpperBound': round(boots[int(0.95 * len(boots)) - 1], 4),
            'foldsWon': sum(1 for f in m if f['shadow'] > f['champion_v5']), 'folds': folds}


def shadow_strip(sh, frozen):
    """The paired strip gate, graded on the shadow (v5 = the live frozen v5)."""
    if frozen is None:
        return {'verdict': 'insufficient data', 'why': 'no frozen models'}
    T = frozen['T']
    groups = strip_groups(sh.ledger_rows, sh.members, sh.lib, T)
    if len(groups) < STRIP_MIN_GROUPS:
        return {'verdict': 'insufficient data', 'groups': len(groups)}
    graded = frozenset(t for _, k, p in groups for t in k + p)
    s, info = sh.blend(T, range(len(sh.questions)), exclude=graded, quiz_at=sh.quiz_at)
    r = paired_agreement(groups, dict(zip(sh.ids, s)), frozen['v5'])
    return {'verdict': 'measured', 'shadow': round(r['a'], 4), 'champion_v5': round(r['b'], 4), 'gain': round(r['gain'], 4),
            'gainLowerBound': round(r['lb'], 4), 'gainUpperBound': round(r['ub'], 4), 'groups': r['groups'],
            'lambda': info['lambda'], 'quizPairs': info['pairs']['quiz'], 'stripPairs': info['pairs']['strip']}


def shadow_quiz(sh, now_ms):
    """The quiz judge's held-out window, graded on the shadow out-of-fold."""
    qs = sh.questions
    if not qs:
        return {'verdict': 'insufficient data', 'why': 'no scorable choices'}
    T = sh.quiz_at
    graded = [i for i, q in enumerate(qs) if q[0] >= T]
    if len(graded) < QUIZ_MIN_QUESTIONS:
        return {'verdict': 'insufficient data', 'questions': len(graded)}
    before = [i for i, q in enumerate(qs) if q[0] < T]
    n = np.array([len(qs[i][1]) for i in graded], float)
    ach, av5 = np.zeros(len(graded)), np.zeros(len(graded))
    v5 = _sigmoid(sh.snap(T)['v5z'])
    agree = lambda d: 1.0 if d > 0 else (0.5 if d == 0 else 0.0)
    lams = []
    for f in range(SHADOW_QFOLDS):
        test = [j for j, i in enumerate(graded) if sh.qfold[i] == f]
        if not test:
            continue
        train = before + [i for i in graded if sh.qfold[i] != f]
        s, info = sh.blend(T, train, quiz_at=T)
        lams.append(info['lambda'])
        if any(qs[i][0] >= T and sh.qfold[i] == f for i in train):
            raise ShadowUnavailable('a graded choice is in its own training fold')
        for j in test:
            pairs = qs[graded[j]][1]
            ach[j] = sum(agree(s[sh.pos[w]] - s[sh.pos[l]]) for w, l in pairs)
    for j, i in enumerate(graded):
        av5[j] = sum(agree(v5[sh.pos[w]] - v5[sh.pos[l]]) for w, l in qs[i][1])
    a, b = float(ach.sum() / n.sum()), float(av5.sum() / n.sum())
    rnd = np.random.default_rng(QUIZ_SEED)
    idx = rnd.integers(0, len(graded), (QUIZ_BOOTSTRAP, len(graded)))
    nn = n[idx].sum(axis=1)
    gains = np.sort(ach[idx].sum(axis=1) / nn - av5[idx].sum(axis=1) / nn)
    return {'verdict': 'measured', 'shadow': round(a, 4), 'champion_v5': round(b, 4), 'gain': round(a - b, 4),
            'gainLowerBound': round(float(gains[int(0.05 * QUIZ_BOOTSTRAP)]), 4),
            'gainUpperBound': round(float(gains[int(0.95 * QUIZ_BOOTSTRAP) - 1]), 4),
            'questions': len(graded), 'pairs': int(n.sum()), 'trainedBeforeWindow': len(before),
            'frozenAt': datetime.fromtimestamp(T / 1000, tz=timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'lambdas': lams}


def shadow_favourites(sh, now_ms, live_raw):
    """Mean library percentile (1 = top) of the songs starred as of now under
    the shadow fitted on everything up to now, next to v5 and the live model.
    A sanity check, not a test: stars are one of m's features."""
    s, info = sh.blend(now_ms, range(len(sh.questions)), quiz_at=now_ms)
    stars = np.array([sh.snap(now_ms)['snap'].star(t) > 0 for t in sh.ids])
    if not stars.any():
        return {'verdict': 'no starred songs'}, info
    pct = lambda v: float((np.argsort(np.argsort(v, kind='mergesort'), kind='mergesort') / max(1, len(v) - 1))[stars].mean())
    out = {'starred': int(stars.sum()), 'shadow': round(pct(s), 4), 'champion_v5': round(pct(sh.snap(now_ms)['v5z']), 4)}
    if live_raw is not None:
        out['challenger'] = round(pct(np.asarray(live_raw)), 4)
    return out, info


def run_shadow(lib, events, mood, now_ms, ledger_rows, members, frozen, live_raw=None, quiz_path=None):
    """Every shadow test, never raising: any failure comes back as
    {'verdict': 'error' | 'unavailable', 'why': …}. Reads its inputs only."""
    started = time.time()
    try:
        questions = load_quiz_questions(quiz_path or CONFIG['quiz'], lib)
        sh = Shadow(lib, events, mood, ledger_rows, members, questions, started + SHADOW_BUDGET_S)
        # the quiz judge's freeze; quiz pairs for the holdout and strip tests use the features as of it
        sh.quiz_at = max(questions[0][0], now_ms - QUIZ_GRADE_DAYS * DAY_MS) if questions else now_ms
        out = {'candidate': SHADOW_NAME, 'verdict': 'measured', 'published': False, 'promotes': False}
        out['holdout'] = shadow_holdout(sh, now_ms)
        out['stripPaired'] = shadow_strip(sh, frozen)
        out['quizChoices'] = shadow_quiz(sh, now_ms)
        out['favourites'], now_info = shadow_favourites(sh, now_ms, live_raw)
        out['lambda'], out['weights'], out['pairs'] = now_info['lambda'], now_info['weights'], now_info['pairs']
        tests = [out[k] for k in ('holdout', 'stripPaired', 'quizChoices')]
        out['clearsAll'] = all(t.get('verdict') == 'measured' and t['gainLowerBound'] > 0 for t in tests)
        out['seconds'] = round(time.time() - started, 1)
        return out
    except ShadowUnavailable as e:
        return {'candidate': SHADOW_NAME, 'verdict': 'unavailable', 'why': str(e), 'seconds': round(time.time() - started, 1)}
    except FileNotFoundError:
        return {'candidate': SHADOW_NAME, 'verdict': 'unavailable', 'why': 'no Top 1000 Quiz answers file',
                'seconds': round(time.time() - started, 1)}
    except Exception as e:   # noqa: BLE001 — the shadow must never fail the nightly run
        return {'candidate': SHADOW_NAME, 'verdict': 'error', 'why': f'{type(e).__name__}: {e}'[:300],
                'seconds': round(time.time() - started, 1)}


def shadow_summary(sh):
    if sh.get('verdict') != 'measured':
        return f"{sh.get('verdict')} — {sh.get('why', '')}"
    part = lambda name, t: (f"{name} {t['shadow']:.3f} vs v5 {t['champion_v5']:.3f} [{t['gainLowerBound']:+.3f}, {t['gainUpperBound']:+.3f}]"
                            if t.get('verdict') == 'measured' else f"{name} {t.get('verdict')}")
    fav = sh.get('favourites') or {}
    return (f"λ={sh['lambda']} · " + ' · '.join(part(n, sh[k]) for n, k in (('holdout', 'holdout'), ('strip', 'stripPaired'), ('quiz', 'quizChoices')))
            + (f" · ★ pct {fav['shadow']:.2f} (v5 {fav['champion_v5']:.2f})" if 'shadow' in fav else '')
            + f" · clears all three: {'YES' if sh['clearsAll'] else 'no'} · {sh['seconds']}s")


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
    try:
        verdicts, quiz_reasons, quiz_answers = load_quiz(CONFIG['quiz'], lib)
    except Exception as e:   # noqa: BLE001 — the quiz judge below fails closed on the same file
        log(f'Top 1000 Quiz answers unreadable ({type(e).__name__}: {e}) — no verdicts')
        verdicts, quiz_reasons, quiz_answers = [], Counter(), 0
    quiz_active_from = (verdicts[0][0] + HOLDOUT_DAYS * DAY_MS) if verdicts else None
    if verdicts:
        log(f'Top 1000 Quiz: {quiz_answers} answers, {len(verdicts)} verdicts; the model can use them from '
            f'{datetime.fromtimestamp(quiz_active_from / 1000, tz=timezone.utc):%Y-%m-%d}')

    # 5–6. champion vs challenger on held-back time
    ev_res = evaluate(lib, events, mood, now_ms, verdicts=verdicts)
    frozen = strip_frozen(lib, events, mood, now_ms, verdicts)
    strip_auc = strip_check(lib, events, mood, now_ms, ledger_rows, members, verdicts=verdicts, frozen=frozen)
    strip = strip_paired_check(lib, events, mood, now_ms, ledger_rows, members, verdicts=verdicts, frozen=frozen)
    ev_res['stripAdds'] = strip_auc     # the old pooled AUC — logged for comparison, not a gate
    ev_res['stripPaired'] = strip       # the gate
    log('strip (paired, the gate): ' + (f"challenger {strip['challenger']:.3f} vs v5 {strip['champion_v5']:.3f} on {strip['groups']} strip contexts "
                                       f"({strip['adds']} kept adds, {strip['pairs']} pairs), gain {strip['gain']:+.3f} "
                                       f"[{strip['gainLowerBound']:+.3f}, {strip['gainUpperBound']:+.3f}]"
                                       if strip['verdict'] == 'measured' else strip['verdict'] + (f" — {strip['why']}" if strip.get('why') else ''))
        + ' · old pooled AUC: ' + (f"challenger {strip_auc['challenger']:.3f} vs v5 {strip_auc['champion_v5']:.3f} on {strip_auc['impressions']} impressions"
                                   if strip_auc.get('verdict') == 'measured' else strip_auc.get('verdict', '?')))
    quiz = run_quiz_check(lib, events, mood, now_ms, verdicts)
    ev_res['quizChoices'] = quiz
    log('quiz judge: ' + (f"challenger {quiz['challenger']:.3f} vs v5 {quiz['champion_v5']:.3f} on {quiz['questions']} choices "
                          f"({quiz['pairs']} pairs), gain {quiz['gain']:+.3f} [{quiz['gainLowerBound']:+.3f}, {quiz['gainUpperBound']:+.3f}]"
                          if quiz['verdict'] == 'measured' else f"could not grade: {quiz['verdict']}" + (f" — {quiz['why']}" if quiz.get('why') else '')))
    prev = previous_state(state_path)
    was_promoted = bool(prev.get('promoted'))
    promoted, why = decide_promotion(ev_res, strip, was_promoted, quiz, strip_fallback=strip_auc)
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
        # the three tests behind the decision (holdout windows, paired suggestion
        # strip, quiz judge) + the old pooled strip AUC, kept for comparison only
        'tests': {
            'holdout': {k: ev_res.get(k) for k in ('verdict', 'auc', 'meanGain', 'gainLowerBound', 'foldsWon')},
            'stripPaired': strip,
            'stripAdds': strip_auc,
            'quizChoices': quiz,
        },
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
    # the shadow (candidate #12): measured AFTER everything above is final, so
    # it cannot change the published scores, `promoted` or `why`; it only adds
    # tests.shadow, scorecard.shadow and a line in taste-shadow.jsonl
    shadow = None
    if os.environ.get('JT_TE_SHADOW', '1') != '0':
        try:
            shadow = run_shadow(lib, events, mood, now_ms, ledger_rows, members, frozen, live_raw=raw)
            shadow['at'] = state['builtAt']
            shadow['live'] = {'holdout': {k: (ev_res.get('auc') or {}).get(k) for k in ('challenger', 'champion_v5')},
                              'stripPaired': {k: strip.get(k) for k in ('challenger', 'champion_v5')},
                              'quizChoices': {k: quiz.get(k) for k in ('challenger', 'champion_v5')},
                              'promoted': state['promoted']}
            log('shadow (never published): ' + shadow_summary(shadow))
        except Exception as e:   # noqa: BLE001 — never fail the nightly run over the shadow
            shadow = {'candidate': SHADOW_NAME, 'verdict': 'error', 'why': f'{type(e).__name__}: {e}'[:300]}
            log(f'shadow failed (ignored): {shadow["why"]}')
        state['tests']['shadow'] = shadow
        scorecard['shadow'] = shadow
    if dry:
        print(json.dumps(scorecard, indent=2, default=str))
        return 0
    atomic_json(state_path, state)
    atomic_json(os.path.join(CONFIG['work'], 'taste-scorecard.json'), scorecard, indent=2)
    with open(os.path.join(CONFIG['work'], 'taste-journal.jsonl'), 'a') as f:
        f.write(json.dumps({'at': state['builtAt'], 'promoted': state['promoted'], 'wasPromoted': was_promoted,
                            'why': why, 'auc': ev_res.get('auc'), 'gainLowerBound': ev_res.get('gainLowerBound'),
                            'foldsWon': ev_res.get('foldsWon'),
                            'quiz': {'verdicts': len(verdicts), 'gain': ev_res.get('quizGain')}, 'stripAdds': {k: strip_auc.get(k) for k in ('challenger', 'champion_v5', 'adds')}, 'stripPaired': {k: strip.get(k) for k in ('verdict', 'challenger', 'champion_v5', 'gainLowerBound', 'gainUpperBound', 'groups')},'quizChoices': {k: quiz.get(k) for k in ('verdict', 'challenger', 'champion_v5', 'gainLowerBound', 'gainUpperBound', 'questions')}, 'mixes': {k: mix_grade.get(k) for k in ('served', 'playedThroughRate', 'skipRateWhenPlayed')},
                            'suggestions': {k: led.get(k) for k in ('stripAddPlayedRate', 'stripAddKeptRate', 'stripAddSkipped2xRate', 'stripShownFromPlaylistArtists28d', 'stripDistinctArtistsPer100')},
                            'drift': {'soundPrefAgreement': dr.get('soundPrefAgreement')}}, default=str) + '\n')
    if shadow is not None:
        try:
            with open(os.path.join(CONFIG['work'], 'taste-shadow.jsonl'), 'a') as f:
                f.write(json.dumps(shadow, default=str) + '\n')
        except Exception as e:   # noqa: BLE001
            log(f'taste-shadow.jsonl not written (ignored): {type(e).__name__}: {e}')
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
