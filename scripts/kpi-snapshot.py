#!/usr/bin/env python3
"""
kpi-snapshot — the brain's weekly report card (2026-08-07, Jake: "we need
internal KPI's so that we know its getting better and on schedule").

Computes every KPI derivable from the app's existing logs and appends one
dated row to kpi-history.jsonl. Run weekly (launchd, Sunday morning) and
on demand. The same numbers feed the Dec-17 Year in Review.

All read-only over userData files; never touches app state.
"""
import json
import os
import subprocess
import sys
import time
from collections import defaultdict

UD = os.path.expanduser('~/Library/Application Support/JakeTunes')
HISTORY = os.path.join(UD, 'kpi-history.jsonl')
# The honest listening numbers (2026-10-10). This report used to read only
# the laptop log (and a stale copy of the phone's) and count every logged
# skip — 75.7% "skip rate" when the real one was 6.8%: workmini, the main
# listener, was missing, and 4,428 of 6,653 skips were mechanical bursts.
# homemini builds the all-device history nightly (scripts/listening-history
# .mts via scripts/listening-history-nightly.sh) and its 28-day scorecard is
# read here. Over SSH because a launchd job on this Mac may not read the NAS.
HOMEMINI = os.environ.get('JT_HOMEMINI', 'jakerosenbaumnas@homemini')
FLEET_KPI = 'Library/Application Support/JakeTunes/yir/listening-kpi.json'


def fleet_listening():
    """homemini's all-device 28-day scorecard, or None (offline, stale, absent).

    Retries (2026-10-19): the Sunday run fires the moment the laptop wakes,
    before Tailscale is back, so a single 8 s attempt failed on 10/11 and
    10/18 and the report silently fell back to the laptop's raw 55% skip
    rate (the real all-device rate was 6.8%)."""
    for attempt in range(3):
        k = _fleet_once()
        if k is not None:
            return k
        if attempt < 2:
            time.sleep(20)
    return None


def taste_engine_scorecard():
    """homemini's nightly taste-engine scorecard (scripts/taste-engine.py) —
    the per-night learning numbers, folded into this weekly report."""
    try:
        r = subprocess.run(['ssh', '-o', 'ConnectTimeout=8', '-o', 'BatchMode=yes', HOMEMINI, 'cat',
                            '"Library/Application Support/JakeTunes/taste-engine/taste-scorecard.json"'],
                           capture_output=True, text=True, timeout=30)
        return json.loads(r.stdout) if r.returncode == 0 else None
    except Exception:
        return None


def _fleet_once():
    try:
        r = subprocess.run(['ssh', '-o', 'ConnectTimeout=8', '-o', 'BatchMode=yes', HOMEMINI, 'cat', '"%s"' % FLEET_KPI],
                           capture_output=True, text=True, timeout=30)
        if r.returncode != 0:
            return None
        k = json.loads(r.stdout)
        built = time.mktime(time.strptime(str(k.get('builtAt', ''))[:19], '%Y-%m-%dT%H:%M:%S'))
        if time.time() - built > 3 * 86400:
            return None   # the nightly stopped — never report a stale week as this week
        return k
    except Exception:
        return None
WINDOW_DAYS = 28   # trailing window for rate metrics
MIN_RATE_N = 30    # fewer impressions than this = "insufficient data", not a rate


def rate_ci(k, n):
    """(rate, [lo, hi]) with a 95% Wilson interval; (None, None) when n is
    too small to say anything — insufficient data is not poor performance."""
    if n < MIN_RATE_N:
        return None, None
    z = 1.96
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * ((p * (1 - p) / n + z * z / (4 * n * n)) ** 0.5) / d
    return round(p, 4), [round(max(0.0, c - h), 4), round(min(1.0, c + h), 4)]


def _fold_key(x):
    import unicodedata
    x = unicodedata.normalize('NFKD', str(x or '').casefold())
    return ''.join(c for c in x if not unicodedata.combining(c)).strip()


def jread(name, default):
    try:
        with open(os.path.join(UD, name)) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def jlines(name):
    try:
        with open(os.path.join(UD, name)) as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        yield json.loads(line)
                    except json.JSONDecodeError:
                        continue
    except FileNotFoundError:
        return


def main():
    now = time.time()
    cutoff_ms = (now - WINDOW_DAYS * 86400) * 1000
    snap = {'at': time.strftime('%Y-%m-%dT%H:%M:%S'), 'windowDays': WINDOW_DAYS}

    # ── 1+2. Completion + skip (listening-log.jsonl: t=p|s, ISO ts, pct,
    # artist+title join — the same join engagement.ts uses) ──
    plays = skips = rides = pct_n = 0
    sub_skips = defaultdict(lambda: [0, 0])   # subgenre -> [skips, total]
    lib = jread('library.json', {})
    tracks = {t['id']: t for t in lib.get('tracks', [])}
    ov = jread('metadata-overrides.json', {})
    sub_of = {}
    for tid, e in ov.items():
        sg = (e.get('fields') or {}).get('subgenre')
        if sg:
            try:
                sub_of[int(tid)] = sg
            except ValueError:
                pass
    key_to_sub = {}
    for t in tracks.values():
        sg = sub_of.get(t['id'])
        if sg:
            key_to_sub[((t.get('artist') or '').lower().strip(), (t.get('title') or '').lower().strip())] = sg
    cutoff_s = now - WINDOW_DAYS * 86400
    mobile_plays = 0
    def all_listen_events():
        nonlocal mobile_plays
        for ev in jlines('listening-log.jsonl'):
            yield ev
        # Phone parity (2026-08-07): the mobile backend logs the same event
        # shape; the homemini sync pulls it here. One brain, both devices.
        for ev in jlines('mobile-listening-log.jsonl'):
            mobile_plays += 1
            yield ev
    for ev in all_listen_events():
        ts = ev.get('ts')
        try:
            t_ev = time.mktime(time.strptime(str(ts)[:19], '%Y-%m-%dT%H:%M:%S'))
        except (ValueError, TypeError):
            continue
        if t_ev < cutoff_s:
            continue
        kind = ev.get('t')
        if kind not in ('p', 's'):
            continue
        if ev.get('ar') == '__parity-test__':
            continue   # endpoint verification marker, not listening
        plays += 1
        sg = key_to_sub.get(((ev.get('ar') or '').lower().strip(), (ev.get('ti') or '').lower().strip()))
        if kind == 's':
            skips += 1
        if sg:
            sub_skips[sg][1] += 1
            if kind == 's':
                sub_skips[sg][0] += 1
        pct = ev.get('pct')
        if isinstance(pct, (int, float)):
            pct_n += 1
            if pct >= 80:
                rides += 1
    snap['plays28d'] = plays
    snap['mobileEvents'] = mobile_plays
    snap['skipRate'] = round(skips / plays, 4) if plays else None
    snap['completionRate'] = round(rides / pct_n, 4) if pct_n else None
    snap['completionSampled'] = pct_n
    spread = [sk / tot for sk, tot in sub_skips.values() if tot >= 10]
    snap['skipSpreadWorst'] = round(max(spread), 3) if spread else None

    # ── 3. Review-edit rate (workout-sync-history.json) ──
    hist = jread('workout-sync-history.json', [])
    hist = hist if isinstance(hist, list) else hist.get('syncs', [])
    recent = hist[-5:]
    edits = total = 0
    for h in recent:
        removed = len(h.get('removed') or [])
        count = h.get('trackCount') or len(h.get('trackIds') or []) or 0
        proposed = count + removed - len(h.get('added') or [])
        if proposed > 0:
            edits += removed
            total += proposed
    snap['reviewEditRate'] = round(edits / total, 4) if total else None
    snap['reviewSyncsSampled'] = len(recent)

    # ── 4. Discovery conversion (discovery feedback + library arrival) ──
    fb = jread('discovery-feedback.json', {})
    snap['discoveryVetoes'] = len(fb.get('notForMe', {}))

    # ── 6. Found-through-JakeTunes share (source-tagged imports, 28d) ──
    found = hauled = 0
    for t in tracks.values():
        added = t.get('dateAdded') or t.get('addedAt')
        ts = None
        if isinstance(added, (int, float)):
            ts = added if added > 1e12 else added * 1000
        elif isinstance(added, str):
            try:
                ts = time.mktime(time.strptime(added[:19], '%Y-%m-%dT%H:%M:%S')) * 1000
            except ValueError:
                ts = None
        if ts is None or ts < cutoff_ms:
            continue
        src = str(t.get('source') or '')
        if src in ('streamrip', 'bandcamp'):
            found += 1
        else:
            hauled += 1
    snap['newTracks28d'] = found + hauled
    snap['foundShare'] = round(found / (found + hauled), 4) if (found + hauled) else None

    # ── 7. Suggestion acceptance (taste-ledger.jsonl, 28d) ──
    # 2026-10-19 (taste-engine repairs): acceptance now has a real
    # denominator. The strip logs a 'shown' row per suggestion per batch and
    # Discovery logs a card only once it was really on screen
    # (hooks/useImpressions.ts). Before that the strip divided by ↻ rows and
    # Discovery by ✕ rows — which is why Discovery read 100%.
    # *AcceptRateLegacy keeps the old formulas for continuity; every rate
    # carries its count and a 95% interval, and reads None (= insufficient
    # data) under MIN_RATE_N impressions instead of a misleading number.
    cutoff_iso = time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(now - WINDOW_DAYS * 86400))   # ledger ts are UTC
    tl = defaultdict(int)
    strip_shown, disc_shown = set(), set()
    strip_rows = []
    for ev in jlines('taste-ledger.jsonl'):
        if str(ev.get('ts', '')) < cutoff_iso:
            continue
        surf, verdict = ev.get('surface'), ev.get('verdict')
        tl[(surf, verdict)] += 1
        k = ev.get('key') or {}
        if surf == 'strip':
            strip_rows.append(ev)
            if verdict == 'shown':
                strip_shown.add((k.get('playlistId'), k.get('trackId'), (ev.get('ctx') or {}).get('batch')))
        elif surf == 'discover' and verdict == 'shown':
            disc_shown.add((_fold_key(k.get('artist')), _fold_key(k.get('title')), str(ev.get('ts', ''))[:10]))
    strip_acc = tl[('strip', 'accept')]
    strip_pass = tl[('strip', 'pass')] + tl[('strip', 'refresh')]
    disc_acc, disc_rej = tl[('discover', 'accept')], tl[('discover', 'reject')]
    snap['stripAcceptRateLegacy'] = round(strip_acc / (strip_acc + strip_pass), 4) if (strip_acc + strip_pass) else None
    snap['stripShown'] = len(strip_shown)
    snap['stripAccepts'] = strip_acc
    snap['stripRejects'] = tl[('strip', 'reject')]
    snap['stripAcceptRate'], snap['stripAcceptCI'] = rate_ci(strip_acc, len(strip_shown))
    snap['stripVerdicts'] = strip_acc + strip_pass
    snap['discoverShown'] = len(disc_shown)
    snap['discoverAccepts'], snap['discoverRejects'] = disc_acc, disc_rej
    snap['discoverAcceptRate'], snap['discoverAcceptCI'] = rate_ci(disc_acc, len(disc_shown))
    snap['discoverAcceptVsReject'] = round(disc_acc / (disc_acc + disc_rej), 4) if (disc_acc + disc_rej) else None
    snap['mmPlaylistsKept'] = tl[('mm-playlist', 'accept')] - tl[('mm-playlist', 'reject')]
    # Songs shown again after the strip-memory rules would have hidden them
    # (✕'d, or refreshed past twice in 90 days) — 75% of refreshed
    # impressions on 10/19 before the memory shipped; should be ~0 after.
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location('tll', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'taste-ledger-learn.py'))
        tll = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(tll)
        from datetime import datetime, timezone, timedelta
        nowdt = datetime.now(timezone.utc)
        rows120 = list(tll.read_ledger((nowdt - timedelta(days=120)).strftime('%Y-%m-%dT%H:%M:%S')))
        snap['stripRepeatFailures28d'] = tll.repeat_failures(rows120, nowdt)
    except Exception as e:
        snap['stripRepeatFailures28d'] = None
        snap['stripRepeatFailuresError'] = str(e)[:120]

    # ── 8. Became-loved funnel (brain-improvement-2026h2 item 4) — the
    # trust metric: shop accept → imported → playCount ≥ 5 within 60 days.
    # Accepts younger than 60d are PENDING (no verdict yet); the rate is
    # over decided cohorts only, so December's number is earned. Matching
    # is folded artist/title (albums lane: artist/album) — a read-only
    # stat, so text matching is acceptable here (never for mutations). ──
    import unicodedata
    def _fold(x):
        x = unicodedata.normalize('NFKD', str(x or '').casefold())
        return ''.join(c for c in x if not unicodedata.combining(c)).strip()
    by_song = {}
    by_album = {}
    for t in tracks.values():
        a = _fold(t.get('albumArtist') or t.get('artist'))
        by_song[(a, _fold(t.get('title')))] = t
        key = (a, _fold(t.get('album')))
        cur = by_album.get(key)
        if cur is None or (t.get('playCount') or 0) > (cur.get('playCount') or 0):
            by_album[key] = t
    LOVED_PLAYS, DECIDE_DAYS = 5, 60
    pending = decided = imported = loved = 0
    for ev in jlines('taste-ledger.jsonl'):
        if ev.get('surface') != 'discover' or ev.get('verdict') != 'accept':
            continue
        k = ev.get('key') or {}
        ctx = ev.get('ctx') or {}
        try:
            import calendar
            ts = calendar.timegm(time.strptime(str(ev.get('ts',''))[:19], '%Y-%m-%dT%H:%M:%S'))   # ledger ts are UTC
        except Exception:
            continue
        age_d = (now - ts) / 86400
        # 2026-10-19: album cards were matched against SONG titles — the check
        # read ctx.lane == 'albums', a lane that does not exist (album cards
        # carry ctx.type 'album', lanes like 'fresh-albums'), so every album
        # accept missed the library and the funnel read 0 of 40.
        is_album = ctx.get('type') == 'album' or 'album' in str(ctx.get('lane') or '')
        idx = by_album if is_album else by_song
        hit = idx.get((_fold(k.get('artist')), _fold(k.get('title'))))
        if age_d < DECIDE_DAYS:
            pending += 1
            continue
        decided += 1
        if hit is not None:
            imported += 1
            if (hit.get('playCount') or 0) >= LOVED_PLAYS:
                loved += 1
    snap['becameLovedDecided'] = decided
    snap['becameLovedPending'] = pending
    snap['becameLovedImportRate'] = round(imported / decided, 4) if decided else None
    snap['becameLovedRate'] = round(loved / decided, 4) if decided else None

    # ── Coverage (representation health) ──
    n = len(tracks)
    snap['libraryTracks'] = n
    snap['subgenreCoverage'] = round(len(sub_of) / n, 4) if n else None

    # ── Honest listening (every device, real skips only) ──
    snap['skipRateLaptopRaw'] = snap.get('skipRate')
    snap['completionRateLaptopRaw'] = snap.get('completionRate')
    fk = fleet_listening()
    if fk and fk.get('realSkipRate') is not None:
        tot = fk.get('totals', {})
        snap['skipRate'] = fk['realSkipRate']
        snap['completionRate'] = fk.get('completionRate')
        snap['plays28dFleet'] = tot.get('play')
        snap['skips28dFleet'] = tot.get('skip')
        snap['glances28d'] = tot.get('glance')
        snap['mechanical28d'] = tot.get('mechanical')
        snap['playsByDevice'] = {d: v.get('play') for d, v in (fk.get('byDevice') or {}).items()}
        snap['fleetBuiltAt'] = fk.get('builtAt')
        snap['skipRateSource'] = 'fleet'
    else:
        snap['skipRateSource'] = 'laptop-only'
    te = taste_engine_scorecard()
    if te:
        ev = te.get('evaluation') or {}
        sug = te.get('suggestions') or {}
        snap['tasteEngine'] = {
            'at': te.get('at'), 'promoted': te.get('promoted'), 'why': te.get('why'),
            'aucChallenger': (ev.get('auc') or {}).get('challenger'), 'aucV5': (ev.get('auc') or {}).get('champion_v5'),
            'mixPlayedThroughRate': (te.get('mixes') or {}).get('playedThroughRate'),
            'stripAddKeptRate': sug.get('stripAddKeptRate'), 'stripAddPlayedRate': sug.get('stripAddPlayedRate'),
            'stripDistinctArtistsPer100': sug.get('stripDistinctArtistsPer100'),
        }
    snap['metricsVersion'] = 3

    if '--dry-run' in sys.argv:   # print only — no history row
        print(json.dumps(snap, indent=2))
        return
    os.makedirs(UD, exist_ok=True)
    with open(HISTORY, 'a') as f:
        f.write(json.dumps(snap) + '\n')
    print(json.dumps(snap, indent=2))


if __name__ == '__main__':
    main()
