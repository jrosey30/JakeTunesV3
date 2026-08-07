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
import sys
import time
from collections import defaultdict

UD = os.path.expanduser('~/Library/Application Support/JakeTunes')
HISTORY = os.path.join(UD, 'kpi-history.jsonl')
WINDOW_DAYS = 28   # trailing window for rate metrics


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
    for ev in jlines('listening-log.jsonl'):
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

    # ── Coverage (representation health) ──
    n = len(tracks)
    snap['libraryTracks'] = n
    snap['subgenreCoverage'] = round(len(sub_of) / n, 4) if n else None

    os.makedirs(UD, exist_ok=True)
    with open(HISTORY, 'a') as f:
        f.write(json.dumps(snap) + '\n')
    print(json.dumps(snap, indent=2))


if __name__ == '__main__':
    main()
