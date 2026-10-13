# Python port of JakeTunesMobile backend/src/routes/brainEval.ts tasteCvAuc +
# backend/src/util/tasteScore.ts (v4 weights, 2026-08-23). Read-only analysis.
import json, math, datetime, collections

W = dict(bias=-6.529, album=12.625, artist=1.892, genre=-0.068, decade=0.285,
         plays=-0.824, recency=-0.191, intensity=4.65)
FINDS = ('streamrip', 'bandcamp', 'squid')
DAY = 86400000


def ms(s):
    """JS Date.parse equivalent for the formats in library.json."""
    if s is None or s == '':
        return None
    if isinstance(s, (int, float)):
        return float(s)
    s = str(s)
    if s.isdigit():
        return float(s)
    try:
        if 'T' in s:
            d = datetime.datetime.fromisoformat(s.replace('Z', '+00:00'))
            if d.tzinfo is None:  # JS parses date-time w/o tz as LOCAL; homemini is EDT
                d = d.replace(tzinfo=datetime.timezone(datetime.timedelta(hours=-4)))
            return d.timestamp() * 1000
        d = datetime.datetime.strptime(s[:10], '%Y-%m-%d').replace(tzinfo=datetime.timezone.utc)
        return d.timestamp() * 1000
    except Exception:
        return None


def djb2(s):
    h = 5381
    for c in str(s):
        h = (h * 33 + ord(c)) & 0xFFFFFFFF
    return h


def is_star(t): return (t.get('rating') or 0) > 0
def k_artist(t): return (t.get('albumArtist') or t.get('artist') or '?').strip().lower()
def k_album(t): return ((t.get('albumArtist') or t.get('artist') or '?') + ' ::: ' + (t.get('album') or '?')).strip().lower()
def k_genre(t): return (t.get('genre') or '?').strip().lower()
def k_dec(t):
    try:
        y = float(t.get('year'))
        return int(y // 10 * 10) if y > 0 and math.isfinite(y) else 0
    except Exception:
        return 0


def rate(lib, keyf, prior, k=4):
    s, n = collections.Counter(), collections.Counter()
    for t in lib:
        kk = keyf(t); n[kk] += 1
        if is_star(t): s[kk] += 1
    return {kk: (s[kk] + k * prior) / (n[kk] + k) for kk in n}


def profile(lib, now):
    prior = sum(map(is_star, lib)) / len(lib) if lib else 0
    pm = max((math.log1p(t.get('playCount') or 0) for t in lib), default=0)
    return dict(artist=rate(lib, k_artist, prior), album=rate(lib, k_album, prior),
                genre=rate(lib, k_genre, prior), decade=rate(lib, k_dec, prior),
                prior=prior, playMax=pm, now=now)


def months(t, now):
    m = ms(t.get('dateAdded'))
    if m is None: return 24.0
    return max(1.0, (now - m) / (30 * DAY))


def score_parts(t, p, w=W):
    al = p['album'].get(k_album(t), p['prior']); ar = p['artist'].get(k_artist(t), p['prior'])
    ge = p['genre'].get(k_genre(t), p['prior']); de = p['decade'].get(k_dec(t), p['prior'])
    pl = math.log1p(t.get('playCount') or 0)
    playNorm = pl / p['playMax'] if p['playMax'] > 0 else 0
    lp = float(t.get('lastPlayedAt') or 0)
    days = (p['now'] - lp) / DAY if lp > 0 else 3650
    rec = 1 - min(days, 3650) / 3650
    inten = pl / months(t, p['now'])
    return dict(album=al, artist=ar, genre=ge, decade=de, plays=playNorm, recency=rec, intensity=inten)


def score(t, p, w=W, drop=()):
    f = score_parts(t, p, w)
    z = w['bias'] + sum(w[k] * v for k, v in f.items() if k not in drop)
    return 1 / (1 + math.exp(-z))


def auc(pairs):
    npos = sum(1 for s, y in pairs if y); nneg = len(pairs) - npos
    if not npos or not nneg: return None
    srt = sorted(pairs, key=lambda x: x[0])
    sr = 0.0; i = 0
    while i < len(srt):
        j = i
        while j + 1 < len(srt) and srt[j + 1][0] == srt[i][0]: j += 1
        avg = (i + 1 + j + 1) / 2
        for k in range(i, j + 1):
            if srt[k][1]: sr += avg
        i = j + 1
    return (sr - npos * (npos + 1) / 2) / (npos * nneg)


def population(tracks, now, neg_days=90):
    cut = now - neg_days * DAY
    out = []
    for t in tracks:
        if not is_star(t):
            a = ms(t.get('dateAdded')) or 0
            if a > cut: continue
        out.append(t)
    return out


def cv(pop, now, fold_of=None, drop=(), w=W, return_pairs=False):
    fold_of = fold_of or (lambda t: djb2(t['id']) % 5)
    folds = [fold_of(t) for t in pop]
    pairs = []
    for f in range(5):
        train = [t for t, g in zip(pop, folds) if g != f]
        p = profile(train, now)
        for t, g in zip(pop, folds):
            if g == f: pairs.append((score(t, p, w, drop), is_star(t), t))
    a = auc([(s, y) for s, y, _ in pairs])
    return (a, pairs) if return_pairs else a


def as_of(tracks, D, plays_cap=True):
    """Reconstruct library state at epoch-ms D from the current library:
    only tracks added by D; star only if starredAt<=D (or no starredAt);
    lastPlayedAt after D is unknowable -> dropped."""
    out = []
    for t in tracks:
        a = ms(t.get('dateAdded'))
        if a is not None and a > D: continue
        u = dict(t)
        if is_star(t):
            sa = ms(t.get('starredAt'))
            if sa is not None and sa > D: u['rating'] = 0
        lp = float(t.get('lastPlayedAt') or 0)
        if lp > D: u['lastPlayedAt'] = 0
        out.append(u)
    return out


def apply_overrides(tracks, ov):
    n = 0
    for t in tracks:
        e = ov.get(str(t['id']))
        if not e or not isinstance(e.get('fields'), dict): continue
        if e.get('fp'):
            fp = f"{str(t.get('title') or '').lower().strip()}|{str(t.get('artist') or '').lower().strip()}|{(t.get('duration') or 0) or 0}"
            # JS Number formatting: ints print without .0
            d = t.get('duration') or 0
            ds = str(int(d)) if float(d) == int(d) else repr(float(d))
            fp = f"{str(t.get('title') or '').lower().strip()}|{str(t.get('artist') or '').lower().strip()}|{ds}"
            if fp != e['fp']: continue
        for k, v in e['fields'].items():
            if k in ('title', 'artist', 'album', 'albumArtist', 'genre') and v is not None:
                t[k] = str(v); n += 1
            elif k in ('year',) and v not in (None, ''):
                try: t[k] = float(v)
                except Exception: pass
    return n


def edt(y, m, d, hh=8, mm=30):
    return datetime.datetime(y, m, d, hh, mm, tzinfo=datetime.timezone(datetime.timedelta(hours=-4))).timestamp() * 1000
