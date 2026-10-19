#!/usr/bin/env python3
"""taste-ledger-learn v2 (2026-10-19): stateless, evidence-gated, can't saturate.

Run: python3 scripts/tests/test_taste_ledger_learn.py
"""
import importlib.util
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, '..', 'taste-ledger-learn.py')


def load(ud):
    os.environ['JT_UD'] = ud
    spec = importlib.util.spec_from_file_location('tl', SCRIPT)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def iso(dt):
    return dt.strftime('%Y-%m-%dT%H:%M:%S.000Z')


class LearnerTest(unittest.TestCase):
    def setUp(self):
        self.ud = tempfile.mkdtemp(prefix='tl2-')
        self.now = datetime.now(timezone.utc)

    def write(self, rows, members=None):
        with open(os.path.join(self.ud, 'taste-ledger.jsonl'), 'w') as f:
            for r in rows:
                f.write(json.dumps(r) + '\n')
        if members is not None:
            with open(os.path.join(self.ud, 'playlists.json'), 'w') as f:
                json.dump({'playlists': [{'id': pid, 'trackIds': ids} for pid, ids in members.items()]}, f)

    def batches(self, n, genre_drives_adds=True, start_days=100):
        """n strip batches of 5; in each, the highest-GENRE item is added
        (when genre_drives_adds) — vibe is noise."""
        rows, members = [], {'pl': []}
        tid = 1000
        for b in range(n):
            t = self.now - timedelta(days=start_days) + timedelta(hours=b * 12)
            batch = f'pl:{b}'
            items = []
            for r in range(5):
                tid += 1
                g = ((b * 7 + r * 3) % 11) / 10
                vn = ((b * 5 + r * 7) % 13) / 12
                items.append((tid, {'vn': vn, 'g': g, 'b': 0.5, 'ta': 0.3, 'e': 0.5, 'rank': r, 'batch': batch}))
            for tid_, ctx in items:
                rows.append({'ts': iso(t), 'surface': 'strip', 'verdict': 'shown', 'key': {'trackId': tid_, 'playlistId': 'pl'}, 'ctx': ctx})
            pick = max(items, key=lambda it: it[1]['g'] if genre_drives_adds else it[1]['rank'] == 2)
            rows.append({'ts': iso(t + timedelta(seconds=30)), 'surface': 'strip', 'verdict': 'accept', 'key': {'trackId': pick[0], 'playlistId': 'pl'}, 'ctx': pick[1]})
            members['pl'].append(pick[0])
        return rows, members

    def test_insufficient_data_is_neutral_not_a_clamp(self):
        rows, members = self.batches(6)
        self.write(rows, members)
        tl = load(self.ud)
        tl.main()
        w = json.load(open(os.path.join(self.ud, 'taste-weights.json')))
        self.assertEqual(w['playlists']['pl'], tl.NEUTRAL)
        self.assertEqual(w['evidence']['pl']['decision'], 'insufficient data')

    def test_real_signal_is_adopted_and_rerun_is_identical(self):
        rows, members = self.batches(80)
        self.write(rows, members)
        tl = load(self.ud)
        tl.main()
        first = json.load(open(os.path.join(self.ud, 'taste-weights.json')))
        self.assertEqual(first['globalEvidence']['decision'], 'adopted')
        self.assertGreater(first['global']['genre'], first['global']['vibe'])
        tl.main()   # same evidence, second night
        second = json.load(open(os.path.join(self.ud, 'taste-weights.json')))
        self.assertEqual(first['global'], second['global'])
        self.assertEqual(first['playlists'], second['playlists'])

    def test_verdict_classes(self):
        t = self.now - timedelta(days=1)
        ctx = lambda r: {'vn': 0.5, 'g': 0.5, 'b': 0.5, 'ta': 0.5, 'e': 0.5, 'rank': r, 'batch': 'B'}
        rows = [{'ts': iso(t), 'surface': 'strip', 'verdict': 'shown', 'key': {'trackId': i, 'playlistId': 'pl'}, 'ctx': ctx(i)} for i in range(1, 6)]
        rows += [
            {'ts': iso(t), 'surface': 'strip', 'verdict': 'accept', 'key': {'trackId': 1, 'playlistId': 'pl'}, 'ctx': ctx(1)},
            {'ts': iso(t), 'surface': 'strip', 'verdict': 'accept', 'key': {'trackId': 2, 'playlistId': 'pl'}, 'ctx': ctx(2)},
            {'ts': iso(t), 'surface': 'strip', 'verdict': 'reject', 'key': {'trackId': 3, 'playlistId': 'pl'}, 'ctx': ctx(3)},
        ]
        self.write(rows, {'pl': [1]})   # 2 was taken back off
        tl = load(self.ud)
        by_pl, back = tl.build_examples(list(tl.read_ledger('2000')), tl.playlist_members())
        got = sorted((y, w) for _, y, w, _ in by_pl['pl'])
        # 1 add (yes 1.0), 2 taken back (no 1.0), 3 rejected (no 1.0), 4+5 skipped (no 0.5)
        self.assertEqual(got, sorted([(1, 1.0), (0, 1.0), (0, 1.0), (0, 0.5), (0, 0.5)]))
        self.assertEqual(back['pl'], 1)

    def test_repeat_failures_count_songs_already_passed_twice(self):
        base = self.now - timedelta(days=10)
        rows = []
        for d in range(3):   # refreshed past three times -> the third showing was a repeat failure
            rows.append({'ts': iso(base + timedelta(days=d)), 'surface': 'strip', 'verdict': 'pass', 'key': {'trackId': 9, 'playlistId': 'pl'}, 'ctx': {}})
        self.write(rows)
        tl = load(self.ud)
        self.assertEqual(tl.repeat_failures(list(tl.read_ledger('2000')), self.now), 1)


if __name__ == '__main__':
    unittest.main()
