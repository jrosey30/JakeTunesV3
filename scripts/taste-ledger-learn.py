#!/usr/bin/env python3
"""
taste-ledger-learn — nightly pass that moves the actual weights (2026-08-07,
Jake: "the AI has no feel for playlists right now").

Reads taste-ledger.jsonl (the unified verdict stream: strip accepts/passes,
discover accept/reject, mm-playlist keep/delete, review-gate edits) and
nudges per-playlist blend weights in taste-weights.json. The suggestion
strip multiplies its vibe/genre/taste components by these weights, so a
playlist where Jake consistently accepts high-genre-fit picks drifts
toward genre, one where he accepts on vibe drifts toward vibe.

Learning rule (deliberately boring):
  - Only 'strip' events carry blend components (ctx: vn/g/ta from
    SuggestDiag). Compare the mean component among ACCEPTS vs PASSES.
  - If accepts beat passes on a component by > MARGIN, nudge that weight
    +LR; if they trail by > MARGIN, nudge -LR. Otherwise leave it.
  - Weights clamp to [0.5, 1.5]; everything starts at 1.0.
  - A playlist needs >= MIN_ACCEPTS accepts and >= MIN_PASSES passes in
    the window before we touch its weights — no learning from noise.

Read-only over the ledger (append-only file, never rewritten here);
taste-weights.json is written atomically (tmp + rename) so the app's
mtime-cached reader never sees a torn file.
"""
import json
import os
import sys
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone

UD = os.environ.get('JT_UD') or os.path.expanduser('~/Library/Application Support/JakeTunes')
LEDGER = os.path.join(UD, 'taste-ledger.jsonl')
WEIGHTS = os.path.join(UD, 'taste-weights.json')
WINDOW_DAYS = 90
LR = 0.05
MARGIN = 0.03
MIN_ACCEPTS = 3
MIN_PASSES = 10
BOUNDS = (0.5, 1.5)
# ctx key -> weight key (SuggestDiag: vn=vibe-neighbor, g=genreFit, ta=taste)
COMPONENTS = {'vn': 'vibe', 'g': 'genre', 'ta': 'taste'}


def read_ledger(cutoff):
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
                ts = ev.get('ts', '')
                if ts >= cutoff:
                    yield ev
    except FileNotFoundError:
        return


def main():
    cutoff = (datetime.now(timezone.utc) - timedelta(days=WINDOW_DAYS)).strftime('%Y-%m-%dT%H:%M:%S')
    # accepts/passes per playlist: playlistId -> verdict -> list of ctx dicts
    strip = defaultdict(lambda: {'accept': [], 'pass': []})
    counts = defaultdict(int)
    for ev in read_ledger(cutoff):
        counts[(ev.get('surface'), ev.get('verdict'))] += 1
        if ev.get('surface') != 'strip':
            continue
        pid = (ev.get('key') or {}).get('playlistId')
        v = ev.get('verdict')
        if pid and v in ('accept', 'pass'):
            strip[pid][v].append(ev.get('ctx') or {})

    try:
        with open(WEIGHTS) as f:
            store = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        store = {}
    playlists = store.get('playlists') or {}

    nudged = []
    for pid, buckets in strip.items():
        accepts, passes = buckets['accept'], buckets['pass']
        if len(accepts) < MIN_ACCEPTS or len(passes) < MIN_PASSES:
            continue
        w = dict(playlists.get(pid) or {})
        for ck, wk in COMPONENTS.items():
            a_vals = [c[ck] for c in accepts if isinstance(c.get(ck), (int, float))]
            p_vals = [c[ck] for c in passes if isinstance(c.get(ck), (int, float))]
            if not a_vals or not p_vals:
                continue
            delta = sum(a_vals) / len(a_vals) - sum(p_vals) / len(p_vals)
            cur = w.get(wk, 1.0)
            if delta > MARGIN:
                nxt = min(BOUNDS[1], round(cur + LR, 4))
            elif delta < -MARGIN:
                nxt = max(BOUNDS[0], round(cur - LR, 4))
            else:
                continue
            if nxt != cur:
                w[wk] = nxt
                nudged.append((pid, wk, cur, nxt, round(delta, 4), len(a_vals), len(p_vals)))
        if w:
            playlists[pid] = w

    store['playlists'] = playlists
    store['updatedAt'] = time.strftime('%Y-%m-%dT%H:%M:%S')
    store['evidence'] = {
        pid: {'accepts': len(b['accept']), 'passes': len(b['pass'])}
        for pid, b in strip.items()
    }
    tmp = WEIGHTS + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(store, f, indent=2)
    os.replace(tmp, WEIGHTS)

    total = sum(counts.values())
    print(f"ledger window: {total} events {dict(counts)}")
    if nudged:
        for pid, wk, cur, nxt, delta, na, np_ in nudged:
            print(f"  {pid}: {wk} {cur} -> {nxt} (delta {delta:+}, {na} accepts vs {np_} passes)")
    else:
        print("  no nudges (insufficient evidence or deltas within margin)")
    return 0


if __name__ == '__main__':
    sys.exit(main())
