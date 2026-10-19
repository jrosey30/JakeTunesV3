#!/usr/bin/env python3
"""taste-engine (2026-10-19): past-only features, Jake's love rule, bulk star
stamps, promotion/rollback, and an end-to-end run on synthetic listening
where taste really is in the sound.

Run: python3 scripts/tests/test_taste_engine.py
"""
import importlib.util
import json
import os
import struct
import tempfile
import unittest
from datetime import datetime, timezone

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
DAY = 86_400_000


def load(env):
    os.environ.update(env)
    spec = importlib.util.spec_from_file_location('te', os.path.join(HERE, '..', 'taste-engine.py'))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def iso(ms):
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')


class EngineTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix='te-')
        self.te = load({'JT_TE_NOTIFY': '0', 'JT_TE_UD': self.d, 'JT_TE_STATE': self.d, 'JT_TE_WORK': os.path.join(self.d, 'work'),
                        'JT_TE_HISTORY': os.path.join(self.d, 'h.jsonl'), 'JT_TE_LIBRARY': os.path.join(self.d, 'library.json'),
                        'JT_TE_MIXES': os.path.join(self.d, 'mixes.json'), 'JT_TE_LEDGERS': os.path.join(self.d, 'ledger.jsonl')})
        self.now = 1_790_000_000_000

    def lib(self, n=600, bulk_day=None):
        rng = np.random.default_rng(3)
        tracks = []
        for i in range(1, n + 1):
            star = i % 7 == 0
            sa = None
            if star:
                sa = str(int(bulk_day if bulk_day and i % 2 == 0 else self.now - (200 + i % 50) * DAY))
            tracks.append({'id': i, 'artist': f'Artist {i % 40}', 'album': f'Album {i % 90}', 'genre': ['Rock', 'Pop', 'Jazz'][i % 3],
                           'year': 1970 + i % 50, 'rating': 5 if star else 0, 'starredAt': sa, 'playCount': int(rng.integers(0, 12)),
                           'dateAdded': '2025-01-01'})
        json.dump({'tracks': tracks}, open(os.path.join(self.d, 'library.json'), 'w'))
        return tracks

    def mood(self, ids, dim=16):
        rng = np.random.default_rng(5)
        with open(os.path.join(self.d, 'mood-index.bin'), 'wb') as f:
            f.write(b'EMBD' + struct.pack('<H', 1) + struct.pack('<H', dim) + struct.pack('<I', len(ids)))
            vecs = {}
            for i in ids:
                v = rng.normal(size=dim).astype('<f4')
                vecs[i] = v
                f.write(struct.pack('<I', i) + v.tobytes())
        return vecs

    def test_bulk_star_days_are_not_fresh_stars(self):
        bulk = self.now - 2 * DAY
        self.lib(n=1000, bulk_day=bulk)   # ~71 stamps on one day > BULK_STAR_DAY
        lib = self.te.load_library(os.path.join(self.d, 'library.json'))
        stamped_bulk = [t for tid, t in lib.items() if t['rating'] > 0 and t['starredAt'] is None]
        self.assertGreater(len(stamped_bulk), 0)
        ids, y, w = self.te.outcomes(lib, [], self.now - 28 * DAY, self.now)
        self.assertEqual(ids, [])   # a migration stamp is not a "yes" in the window

    def test_snapshot_never_sees_the_future(self):
        self.lib(n=20)
        lib = self.te.load_library(os.path.join(self.d, 'library.json'))
        ev = [(self.now - 10 * DAY, 3, 'play'), (self.now - 1 * DAY, 3, 'play'), (self.now - 1 * DAY, 4, 'skip')]
        s = self.te.Snapshot(lib, ev, self.now - 5 * DAY)
        self.assertEqual(s.raw_plays[3], 1)
        self.assertEqual(s.raw_skips[4], 0)
        self.assertEqual(s.play_count(3), max(0.0, lib[3]['playCount'] - 1))   # the later play is subtracted

    def test_love_rule(self):
        self.lib(n=10)
        lib = self.te.load_library(os.path.join(self.d, 'library.json'))
        ev = [(self.now - DAY, 1, 'play'), (self.now - DAY, 2, 'skip'), (self.now - DAY, 3, 'play'), (self.now - DAY, 3, 'skip')]
        ids, y, w = self.te.outcomes(lib, ev, self.now - 28 * DAY, self.now)
        got = dict(zip(ids, y))
        self.assertEqual(got[1], 1.0)
        self.assertEqual(got[2], 0.0)
        self.assertNotIn(3, got)   # a tie carries no verdict

    def test_promotion_and_rollback(self):
        f = lambda a, b: {'verdict': 'measured', 'challenger': a, 'champion_v5': b}
        good = {'verdict': 'measured', 'auc': {'challenger': 0.61, 'champion_v5': 0.50}, 'meanGain': 0.11, 'gainLowerBound': 0.07,
                'foldsWon': 3, 'folds': [f(.6, .5), f(.62, .5), f(.6, .5)]}
        p, why = self.te.decide_promotion(good, {'verdict': 'insufficient data'}, False)
        self.assertTrue(p, why)
        p, _ = self.te.decide_promotion(good, {'verdict': 'measured', 'challenger': 0.55, 'champion_v5': 0.62}, False)
        self.assertFalse(p)   # the strip check vetoes
        noisy = dict(good, gainLowerBound=-0.01)
        self.assertFalse(self.te.decide_promotion(noisy, {}, False)[0])
        self.assertTrue(self.te.decide_promotion(noisy, {}, True)[0])   # stays promoted while not worse
        worse = dict(good, meanGain=-0.02, auc={'challenger': 0.48, 'champion_v5': 0.50})
        p, why = self.te.decide_promotion(worse, {}, True)
        self.assertFalse(p)
        self.assertIn('ROLLED BACK', why)
        p, why = self.te.decide_promotion({'verdict': 'insufficient data', 'folds': []}, {}, True)
        self.assertFalse(p)

    def test_end_to_end_learns_taste_that_lives_in_the_sound(self):
        tracks = self.lib(n=900)
        vecs = self.mood([t['id'] for t in tracks])
        lib = self.te.load_library(os.path.join(self.d, 'library.json'))
        rng = np.random.default_rng(9)
        direction = rng.normal(size=16)
        rows = []
        start = self.now - 150 * DAY
        for day in range(150):
            for _ in range(40):
                tid = int(rng.integers(1, 901))
                like = float(vecs[tid] @ direction)
                p_skip = 0.5 if like < -1.0 else 0.03   # he bails on one corner of the sound
                kind = 'skip' if rng.random() < p_skip else 'play'
                rows.append({'ts': iso(start + day * DAY + int(rng.integers(0, DAY))), 'device': 'laptop', 'kind': kind, 'pct': 40 if kind == 'skip' else 100, 'trackId': tid})
        with open(os.path.join(self.d, 'h.jsonl'), 'w') as f:
            for r in sorted(rows, key=lambda r: r['ts']):
                f.write(json.dumps(r) + '\n')
        self.te.time.time = lambda: self.now / 1000
        rc = self.te.main()
        self.assertEqual(rc, 0)
        sc = json.load(open(os.path.join(self.d, 'work', 'taste-scorecard.json')))
        self.assertEqual(sc['evaluation']['verdict'], 'measured')
        self.assertGreater(sc['evaluation']['auc']['challenger'], sc['evaluation']['auc']['champion_v5'])
        st = json.load(open(os.path.join(self.d, 'taste-state.json')))
        self.assertEqual(len(st['tracks']), 900)
        self.assertTrue(all(0 <= v[0] <= 1 and 0 <= v[1] <= 1 for v in st['tracks'].values()))
        status = json.load(open(os.path.join(self.d, 'work', 'taste-engine-status.json')))
        self.assertTrue(status['ok'])


if __name__ == '__main__':
    unittest.main()
