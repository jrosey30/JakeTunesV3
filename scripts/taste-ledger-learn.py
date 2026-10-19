#!/usr/bin/env python3
"""
taste-ledger-learn v2 — the playlist-suggestion learner, rebuilt so it can't
saturate (2026-10-19, taste-engine repairs).

WHY v1 SATURATED (28 of 33 dials pinned at 0.5/1.5 by 10/19): every night it
re-read the SAME 90-day evidence and, if accepts beat passes on a component
by > 0.03, stepped that dial another ±0.05 from wherever it already was.
Nothing ever told it the dial had already absorbed that evidence (the logged
components are raw, unweighted), so identical evidence marched every dial
to its clamp in ~10 nights — and 3 accepts vs 10 passes was enough to start.

v2 IS STATELESS AND EVIDENCE-GATED:
  - Weights are RECOMPUTED from the ledger every night, never stepped from
    yesterday's values. Same evidence -> same weights. No drift.
  - The question asked is the right one: "with these dial settings, would
    the songs Jake added have ranked above the ones he passed over?" —
    a weighted ranking AUC over the logged blend components.
  - Candidate settings come from a fixed grid (each of vibe / genre /
    taste / era in 0.25 … 3.0 — wide on purpose: on 10/19's ledger genre
    fit predicted adds (AUC 0.61) and era fit predicted the OPPOSITE (0.39),
    which v1's 0.5–1.5 clamp could never express). A setting is adopted only if it beats the
    plain 1.0 blend on HELD-BACK data (the most recent 30% of each
    playlist's verdicts, never seen when choosing) by a margin, with a
    bootstrap lower bound above zero. Otherwise: 1.0, and the journal says
    why ("insufficient data" is a result, not a failure).
  - One GLOBAL setting is learned from every playlist pooled; a playlist
    earns its OWN setting only with >= 15 adds (>= 5 of them held back) and
    only if it beats the global one on its held-back verdicts.

VERDICTS (src/main/ipc/taste-ipc.ts) and how much each one says:
  accept (still on the playlist) ........ yes            weight 1.0
  accept, later taken back off .......... no             weight 1.0
  reject (the strip's ✕) ................ no             weight 1.0
  skipped: shown beside a pick that was
           taken, not chosen ............ no             weight 0.5
  refresh (↻ while it showed; legacy
           'pass' rows are refreshes) ... no             weight 0.3
  ignored: shown, nothing done .......... no             weight 0.1
Impressions ('shown', with a batch id) exist from 2026-10-19; older rows
are accept/pass only and are read as accepts vs refreshes.

Outputs (all in the app's userData; the app is the only reader):
  taste-weights.json        {version: 2, global, playlists, evidence, updatedAt}
  taste-learn-status.json   last run: ok/at/summary (stale = stalled job)
  strip-learn-journal.jsonl one line per run: what changed, why, held-back AUCs
The first v2 run backs up the v1 weights to taste-weights.v1-backup.json.

--dry-run prints what it would write and writes nothing.
"""
import itertools
import json
import os
import random
import sys
import time
import zlib
from collections import defaultdict
from datetime import datetime, timedelta, timezone

UD = os.environ.get('JT_UD') or os.path.expanduser('~/Library/Application Support/JakeTunes')
LEDGER = os.path.join(UD, 'taste-ledger.jsonl')
WEIGHTS = os.path.join(UD, 'taste-weights.json')
STATUS = os.path.join(UD, 'taste-learn-status.json')
JOURNAL = os.path.join(UD, 'strip-learn-journal.jsonl')
V1_BACKUP = os.path.join(UD, 'taste-weights.v1-backup.json')

WINDOW_DAYS = 120
HOLDOUT_SHARE = 0.30
GRID = (0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0)
DIALS = ('vibe', 'genre', 'taste', 'era')
GLOBAL_MIN_POS, GLOBAL_MIN_HOLDOUT_POS = 30, 10
OWN_MIN_POS, OWN_MIN_HOLDOUT_POS = 15, 5
MIN_GAIN = 0.01          # held-back AUC must improve at least this much…
BOOTSTRAP = 200          # …and its bootstrap 5th percentile must be > 0
PRIOR = 0.004            # mild pull toward 1.0 when choosing (per |ln w|)
# Verdict weights — see the table above.
W_ACCEPT, W_TAKEN_BACK, W_REJECT, W_SKIPPED, W_REFRESH, W_IGNORED = 1.0, 1.0, 1.0, 0.5, 0.3, 0.1
# ⚠️ TWIN: src/common/strip-memory.ts REFRESH_HIDE_COUNT / REFRESH_HIDE_DAYS
REFRESH_HIDE_COUNT, REFRESH_HIDE_DAYS = 2, 90
# ⚠️ TWIN: src/renderer/utils/playlistSuggest.ts suggestFromVibeHits blend
BASE = {'vn': 0.45, 'g': 0.22, 'b': 0.15, 'ta': 0.10, 'e': 0.15}
DIAL_OF = {'vn': 'vibe', 'g': 'genre', 'ta': 'taste', 'e': 'era'}


def read_ledger(cutoff_iso):
    try:
        with open(LEDGER) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if ev.get('surface') == 'strip' and str(ev.get('ts', '')) >= cutoff_iso:
                    yield ev
    except FileNotFoundError:
        return


def playlist_members():
    """playlist id -> set of track ids as strings, desktop last (it wins)."""
    members = {}
    for name in ('mobile-playlists.json', 'playlists.json'):
        try:
            with open(os.path.join(UD, name)) as f:
                d = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            continue
        lists = d if isinstance(d, list) else next((v for v in d.values() if isinstance(v, list)), [])
        for p in lists:
            if isinstance(p, dict) and p.get('id') and isinstance(p.get('trackIds'), list):
                members[p['id']] = {str(x) for x in p['trackIds']}
    return members


def build_examples(events, members):
    """Per playlist: list of (ts, y, weight, ctx) — one row per judged
    impression (new format) or per legacy accept/pass row."""
    by_pl = defaultdict(list)
    batches = defaultdict(lambda: {'shown': {}, 'accept': set(), 'reject': set(), 'refresh': set(), 'ts': ''})
    taken_back = defaultdict(int)
    for ev in events:
        key = ev.get('key') or {}
        pid, tid = key.get('playlistId'), key.get('trackId')
        if not pid or tid is None:
            continue
        tid = str(tid)
        v, ctx = ev.get('verdict'), ev.get('ctx') or {}
        batch = ctx.get('batch')
        if batch:
            b = batches[(pid, batch)]
            b['ts'] = b['ts'] or ev.get('ts', '')
            if v == 'shown':
                b['shown'][tid] = ctx
            elif v in ('accept', 'reject', 'refresh'):
                b[v].add(tid)
                b['shown'].setdefault(tid, ctx)
            continue
        # legacy rows (no batch): accept vs pass(=refresh)
        if v == 'accept':
            back = pid in members and tid not in members[pid]
            taken_back[pid] += back
            by_pl[pid].append((ev.get('ts', ''), 0 if back else 1, W_TAKEN_BACK if back else W_ACCEPT, ctx))
        elif v == 'pass':
            by_pl[pid].append((ev.get('ts', ''), 0, W_REFRESH, ctx))
    for (pid, _batch), b in batches.items():
        any_accept = bool(b['accept'])
        for tid, ctx in b['shown'].items():
            if tid in b['accept']:
                back = pid in members and tid not in members[pid]
                taken_back[pid] += back
                y, w = (0, W_TAKEN_BACK) if back else (1, W_ACCEPT)
            elif tid in b['reject']:
                y, w = 0, W_REJECT
            elif tid in b['refresh']:
                y, w = 0, W_REFRESH if not any_accept else W_SKIPPED
            elif any_accept:
                y, w = 0, W_SKIPPED
            else:
                y, w = 0, W_IGNORED
            by_pl[pid].append((b['ts'], y, w, ctx))
    for rows in by_pl.values():
        rows.sort(key=lambda r: r[0])
    return by_pl, taken_back


def score(ctx, w):
    s = 0.0
    for c, base in BASE.items():
        x = ctx.get(c)
        if not isinstance(x, (int, float)):
            x = 0.5
        s += base * w.get(DIAL_OF.get(c, ''), 1.0) * x
    k = ctx.get('k')
    return s + (k if isinstance(k, (int, float)) else 0.0)


def wauc(rows, w):
    """Weighted Mann–Whitney AUC: P(an add outranks a no), each pair weighted
    by both verdicts' weights; ties count half. None without both classes."""
    pts = sorted(((score(c, w), y, wt) for _, y, wt, c in rows), key=lambda t: t[0])
    pos_w = sum(wt for _, y, wt in pts if y == 1)
    neg_w = sum(wt for _, y, wt in pts if y == 0)
    if pos_w <= 0 or neg_w <= 0:
        return None
    acc, neg_below, i = 0.0, 0.0, 0
    while i < len(pts):
        j = i
        while j < len(pts) and pts[j][0] == pts[i][0]:
            j += 1
        tie_pos = sum(wt for _, y, wt in pts[i:j] if y == 1)
        tie_neg = sum(wt for _, y, wt in pts[i:j] if y == 0)
        acc += tie_pos * (neg_below + 0.5 * tie_neg)
        neg_below += tie_neg
        i = j
    return acc / (pos_w * neg_w)


def split(rows):
    cut = int(len(rows) * (1 - HOLDOUT_SHARE))
    return rows[:cut], rows[cut:]


def npos(rows):
    return sum(1 for _, y, _, _ in rows if y == 1)


def prior_pen(w):
    import math
    return PRIOR * sum(abs(math.log(w[d])) for d in DIALS)


def best_on(train, around=None):
    best, best_obj = None, -1.0
    for combo in itertools.product(GRID, repeat=len(DIALS)):
        w = dict(zip(DIALS, combo))
        a = wauc(train, w)
        if a is None:
            continue
        obj = a - prior_pen(w)
        if around is not None:
            import math
            obj -= PRIOR * sum(abs(math.log(w[d] / around[d])) for d in DIALS)
        if obj > best_obj + 1e-12:
            best, best_obj = w, obj
    return best


def bootstrap_gain(holdout, w_new, w_old, seed):
    rnd = random.Random(seed)
    gains = []
    for _ in range(BOOTSTRAP):
        sample = [holdout[rnd.randrange(len(holdout))] for _ in holdout]
        a, b = wauc(sample, w_new), wauc(sample, w_old)
        if a is not None and b is not None:
            gains.append(a - b)
    if not gains:
        return None
    gains.sort()
    return gains[int(0.05 * len(gains))]


NEUTRAL = {d: 1.0 for d in DIALS}


def decide(rows, base_w, min_pos, min_hold_pos, seed):
    """Pick a setting on the older 70%, keep it only if it beats `base_w`
    on the newest 30%. Returns (weights, evidence dict)."""
    train, hold = split(rows)
    ev = {'positives': npos(rows), 'examples': len(rows), 'holdoutPositives': npos(hold)}
    if npos(rows) < min_pos or npos(hold) < min_hold_pos:
        ev['decision'] = 'insufficient data'
        return base_w, ev
    cand = best_on(train, around=base_w)
    if cand is None:
        ev['decision'] = 'insufficient data'
        return base_w, ev
    a_new, a_old = wauc(hold, cand), wauc(hold, base_w)
    if a_new is None or a_old is None:
        ev['decision'] = 'insufficient data (held-back verdicts lack adds or passes)'
        return base_w, ev
    ev['holdoutAuc'] = {'candidate': round(a_new, 4), 'current': round(a_old, 4)}
    if a_new - a_old < MIN_GAIN:
        ev['decision'] = 'no reliable gain on held-back verdicts'
        return base_w, ev
    lb = bootstrap_gain(hold, cand, base_w, seed)
    ev['gainLowerBound'] = None if lb is None else round(lb, 4)
    if lb is None or lb <= 0:
        ev['decision'] = 'gain not reliable (bootstrap lower bound <= 0)'
        return base_w, ev
    ev['decision'] = 'adopted'
    return cand, ev


def repeat_failures(events, now):
    """Last 28 days: impressions of songs the strip-memory rules would
    already have hidden (✕'d, or refreshed past twice in 90 days). Baseline
    on 10/19, before the memory shipped: 3,720 of 4,950 refreshed
    impressions (75%). Should fall to ~0 — this is the check that it does."""
    refreshes = defaultdict(list)
    rejected = {}
    bad = 0
    for ev in sorted(events, key=lambda e: e.get('ts', '')):
        key = ev.get('key') or {}
        k = (key.get('playlistId'), str(key.get('trackId')))
        try:
            t = datetime.strptime(str(ev.get('ts', ''))[:19], '%Y-%m-%dT%H:%M:%S').replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        v = ev.get('verdict')
        recent = t >= now - timedelta(days=28)
        rs = [r for r in refreshes[k] if t - r <= timedelta(days=REFRESH_HIDE_DAYS)]
        hidden = k in rejected or len(rs) >= REFRESH_HIDE_COUNT
        # A 'shown' row, or a pre-10/19 refresh row (it was on screen when ↻
        # was pressed), for a song the rules would already have hidden.
        if recent and hidden and (v == 'shown' or (v in ('refresh', 'pass') and not (ev.get('ctx') or {}).get('batch'))):
            bad += 1
        if v == 'reject':
            rejected[k] = t
        elif v in ('refresh', 'pass'):
            refreshes[k].append(t)
        elif v == 'accept':
            refreshes[k] = []
    return bad


def main():
    dry_run = '--dry-run' in sys.argv
    started = time.time()
    now = datetime.now(timezone.utc)
    cutoff = (now - timedelta(days=WINDOW_DAYS)).strftime('%Y-%m-%dT%H:%M:%S')
    events = list(read_ledger(cutoff))
    members = playlist_members()
    by_pl, taken_back = build_examples(events, members)

    pooled = sorted((r for rows in by_pl.values() for r in rows), key=lambda r: r[0])
    g_w, g_ev = decide(pooled, NEUTRAL, GLOBAL_MIN_POS, GLOBAL_MIN_HOLDOUT_POS, seed=1)

    playlists, evidence = {}, {}
    for pid in sorted(by_pl):
        rows = by_pl[pid]
        w, ev = decide(rows, g_w, OWN_MIN_POS, OWN_MIN_HOLDOUT_POS, seed=zlib.crc32(pid.encode()))   # stable across runs (hash() is salted)
        ev['source'] = 'own' if ev.get('decision') == 'adopted' else ('global' if g_ev.get('decision') == 'adopted' else 'neutral')
        ev['acceptsTakenBack'] = taken_back.get(pid, 0)
        playlists[pid] = w
        evidence[pid] = ev

    try:
        with open(WEIGHTS) as f:
            previous = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        previous = {}
    prev_pl = previous.get('playlists') or {}
    changes = []
    for pid, w in playlists.items():
        old = {d: prev_pl.get(pid, {}).get(d, 1.0) for d in DIALS}
        if any(abs(old[d] - w[d]) > 1e-9 for d in DIALS):
            changes.append({'playlist': pid, 'from': old, 'to': w, 'why': evidence[pid]['decision']})

    store = {'version': 2, 'global': g_w, 'playlists': playlists, 'evidence': evidence,
             'globalEvidence': g_ev, 'updatedAt': now.strftime('%Y-%m-%dT%H:%M:%S')}
    rf = repeat_failures(events, now)
    summary = {
        'examples': len(pooled), 'adds': npos(pooled), 'playlists': len(playlists),
        'own': sum(1 for e in evidence.values() if e['source'] == 'own'),
        'global': g_ev.get('decision'), 'changes': len(changes), 'repeatFailures28d': rf,
    }
    if dry_run:
        print('DRY RUN — nothing written')
        print(json.dumps({'summary': summary, 'global': g_w, 'globalEvidence': g_ev, 'changes': changes[:20]}, indent=2))
        return 0

    if previous and previous.get('version') != 2 and not os.path.exists(V1_BACKUP):
        with open(V1_BACKUP, 'w') as f:
            json.dump(previous, f, indent=2)
    tmp = WEIGHTS + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(store, f, indent=2)
    os.replace(tmp, WEIGHTS)
    with open(JOURNAL, 'a') as f:
        f.write(json.dumps({'at': store['updatedAt'], 'summary': summary, 'globalEvidence': g_ev, 'changes': changes}) + '\n')
    status = {'ok': True, 'at': store['updatedAt'], 'seconds': round(time.time() - started, 1), 'summary': summary}
    with open(STATUS + '.tmp', 'w') as f:
        json.dump(status, f, indent=2)
    os.replace(STATUS + '.tmp', STATUS)
    print(f"strip learner v2: {summary}")
    for c in changes:
        print(f"  {c['playlist']}: {c['from']} -> {c['to']} ({c['why']})")
    return 0


def mac_notify(msg):
    """A Mac notification (this job runs on the laptop, where Jake sees it).
    JT_UD set = a test or a by-hand run against another folder: stay quiet."""
    if os.environ.get('JT_UD'):
        print('(notification suppressed)', msg)
        return
    try:
        import subprocess
        subprocess.run(['osascript', '-e', 'display notification "%s" with title "JakeTunes"' % msg.replace('"', "'")], timeout=10)
    except Exception as e:
        print('notify failed:', e)


def check_taxonomy_handoff():
    """The subgenre hand-off (src/main/taxonomy-staged.ts) applies within
    minutes while the app runs. A staged file a day old means the app is not
    applying it — say so instead of letting subgenres silently pile up again."""
    p = os.path.join(UD, 'taxonomy-staged.json')
    if os.path.exists(p) and time.time() - os.path.getmtime(p) > 24 * 3600:
        mac_notify('Subgenres waiting over a day — the app has not filed them (taxonomy-staged.json).')


if __name__ == '__main__':
    try:
        rc = main()
        check_taxonomy_handoff()
        sys.exit(rc)
    except Exception as e:   # leave a visible failure, never a silent stall
        try:
            with open(STATUS + '.tmp', 'w') as f:
                json.dump({'ok': False, 'at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S'), 'error': str(e)}, f)
            os.replace(STATUS + '.tmp', STATUS)
            mac_notify('The playlist-suggestion learner failed last night: %s' % str(e)[:120])
        finally:
            raise
