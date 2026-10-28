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
                        'JT_TE_MIXES': os.path.join(self.d, 'mixes.json'), 'JT_TE_LEDGERS': os.path.join(self.d, 'ledger.jsonl'),
                        'JT_TE_QUIZ': os.path.join(self.d, 'top1000-answers.jsonl')})
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

    def write_quiz(self, rows):
        with open(os.path.join(self.d, 'top1000-answers.jsonl'), 'w') as f:
            for r in rows:
                f.write(json.dumps(r) + '\n')

    def test_quiz_verdicts(self):
        self.lib(n=20)
        lib = self.te.load_library(os.path.join(self.d, 'library.json'))
        t = lambda d: iso(self.now - d * DAY)
        self.write_quiz([
            {'v': 1, 'kind': 'inout', 'at': t(9), 'ids': ['1'], 'choice': 'in'},
            {'v': 1, 'kind': 'pick', 'at': t(8), 'ids': ['2', '3'], 'choice': 'both', 'reasons': ['hook']},
            {'v': 1, 'kind': 'pick', 'at': t(7), 'ids': ['4', '5'], 'choice': '4', 'reasons': ['voice']},   # a pick is not a verdict
            {'v': 1, 'kind': 'best', 'at': t(6), 'ids': ['6', '7', '8'], 'choice': 'none'},
            {'v': 1, 'kind': 'still', 'at': t(5), 'ids': ['9'], 'choice': 'no'},
            {'v': 1, 'kind': 'inout', 'at': t(4), 'ids': ['10'], 'choice': 'skip'},
            {'v': 1, 'kind': 'inout', 'at': t(3), 'ids': ['11'], 'choice': 'in'},
            {'v': 1, 'kind': 'undo', 'at': t(2), 'target': t(3)},                                           # retracts song 11
            {'v': 1, 'kind': 'inout', 'at': t(1), 'ids': ['9999'], 'choice': 'in'},                          # not in the library
            'junk',
        ])
        timeline, reasons, standing = self.te.load_quiz(os.path.join(self.d, 'top1000-answers.jsonl'), lib)
        got = {tid: v for _, tid, v in timeline}
        self.assertEqual(got, {1: 1.0, 2: 1.0, 3: 1.0, 6: -1.0, 7: -1.0, 8: -1.0, 9: -1.0})
        self.assertEqual(reasons, {'hook': 1, 'voice': 1})
        self.assertEqual(standing, 7)
        self.assertEqual(self.te.load_quiz(os.path.join(self.d, 'nope.jsonl'), lib), ([], {}, 0))

    def test_a_verdict_given_later_is_never_seen_earlier(self):
        self.lib(n=20)
        lib = self.te.load_library(os.path.join(self.d, 'library.json'))
        verdicts = [(self.now - 10 * DAY, 3, 1.0), (self.now - 1 * DAY, 4, -1.0)]
        s = self.te.Snapshot(lib, [], self.now - 5 * DAY, verdicts)
        self.assertEqual(s.verdict.get(3), 1.0)
        self.assertNotIn(4, s.verdict)   # given after the snapshot
        X = self.te.features(s, [3, 4, 5], {})
        col = X[:, self.te.FEATURES.index('quiz_verdict')]
        self.assertEqual(list(col), [0.5, 0.0, 0.0])

    NEUTRAL_QUIZ = {'verdict': 'measured', 'challenger': 0.6, 'champion_v5': 0.59, 'gain': 0.01,
                    'gainLowerBound': -0.01, 'gainUpperBound': 0.03, 'questions': 7600}

    def test_promotion_and_rollback(self):
        f = lambda a, b: {'verdict': 'measured', 'challenger': a, 'champion_v5': b}
        dp = self.te.decide_promotion
        self.te.decide_promotion = lambda e, s, w, q=self.NEUTRAL_QUIZ: dp(e, s, w, q)
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
        self.te.decide_promotion = dp

    def test_quiz_pairs_from_heats_duels_and_picks(self):
        self.lib(n=20)
        lib = self.te.load_library(os.path.join(self.d, 'library.json'))
        t = lambda d: iso(self.now - d * DAY)
        self.write_quiz([
            {'v': 1, 'kind': 'heat', 'at': t(9), 'ids': ['1', '2', '3', '4', '5'], 'choice': 'picked', 'picked': ['1', '3'], 'quota': 2},
            {'v': 1, 'kind': 'duel', 'at': t(8), 'ids': ['6', '7'], 'choice': '7', 'round': 1},
            {'v': 1, 'kind': 'pick', 'at': t(7), 'ids': ['8', '9'], 'choice': '8'},
            {'v': 1, 'kind': 'best', 'at': t(6), 'ids': ['10', '11', '12'], 'choice': '12'},
            {'v': 1, 'kind': 'pick', 'at': t(5), 'ids': ['13', '14'], 'choice': 'both'},       # absolute: no pair
            {'v': 1, 'kind': 'inout', 'at': t(5.5), 'ids': ['15'], 'choice': 'in'},           # absolute: no pair
            {'v': 1, 'kind': 'duel', 'at': t(4), 'ids': ['6', '8'], 'choice': 'skip'},        # skip: nothing
            {'v': 1, 'kind': 'heat', 'at': t(3.5), 'ids': ['1', '2', '3'], 'choice': 'picked', 'picked': ['9'], 'quota': 1},  # invalid pick
            {'v': 1, 'kind': 'duel', 'at': t(3), 'ids': ['16', '9999'], 'choice': '16'},      # loser gone from library
            {'v': 1, 'kind': 'duel', 'at': t(2), 'ids': ['17', '18'], 'choice': '17'},
            {'v': 1, 'kind': 'undo', 'at': t(1.9), 'target': t(2)},                         # retracts the 17>18 duel
            'junk',
        ])
        qs = self.te.load_quiz_questions(os.path.join(self.d, 'top1000-answers.jsonl'), lib)
        self.assertEqual([sorted(p) for _, p in qs], [
            sorted([(1, 2), (1, 4), (1, 5), (3, 2), (3, 4), (3, 5)]),
            [(7, 6)],
            [(8, 9)],
            sorted([(12, 10), (12, 11)]),
        ])
        with self.assertRaises(FileNotFoundError):
            self.te.load_quiz_questions(os.path.join(self.d, 'nope.jsonl'), lib)

    def test_quiz_agreement_counts_pairs_and_ties(self):
        qs = [(0, [(1, 2), (1, 3)]), (1, [(4, 5)]), (2, [(6, 7)])]
        ch = {1: .9, 2: .1, 3: .2, 4: .5, 5: .5, 6: .1, 7: .9}
        v5 = {1: .1, 2: .9, 3: .2, 4: .9, 5: .1, 6: .5, 7: .5}
        r = self.te.quiz_agreement(qs, ch, v5)
        self.assertEqual(r['pairs'], 4)
        self.assertEqual(r['challenger'], round((1 + 1 + 0.5 + 0) / 4, 4))
        self.assertEqual(r['champion_v5'], round((0 + 0 + 1 + 0.5) / 4, 4))
        self.assertLessEqual(r['gainLowerBound'], r['gain'])
        self.assertGreaterEqual(r['gainUpperBound'], r['gain'])
        self.assertEqual(r, self.te.quiz_agreement(qs, ch, v5))   # fixed seed

    def test_quiz_check_needs_enough_choices(self):
        self.lib(n=20)
        lib = self.te.load_library(os.path.join(self.d, 'library.json'))
        r = self.te.quiz_check(lib, [], {}, [(self.now - DAY, [(1, 2)])] * 499, self.now)
        self.assertEqual(r['verdict'], 'insufficient data')

    def test_quiz_overrides_or_vetoes_the_strip(self):
        f = lambda a, b: {'verdict': 'measured', 'challenger': a, 'champion_v5': b}
        good = {'verdict': 'measured', 'auc': {'challenger': 0.597, 'champion_v5': 0.486}, 'meanGain': 0.111, 'gainLowerBound': 0.071,
                'foldsWon': 3, 'folds': [f(.6, .5), f(.6, .5), f(.6, .5)]}
        strip_bad = {'verdict': 'measured', 'challenger': 0.585, 'champion_v5': 0.627, 'adds': 126}
        q = lambda a, b, lb, ub: {'verdict': 'measured', 'challenger': a, 'champion_v5': b, 'gain': a - b,
                                  'gainLowerBound': lb, 'gainUpperBound': ub, 'questions': 7600}
        # quiz could not grade → fail closed, whatever the strip says
        for quiz in (None, {'verdict': 'insufficient data', 'questions': 12}):
            for strip in (strip_bad, {'verdict': 'insufficient data'}):
                p, why = self.te.decide_promotion(good, strip, False, quiz)
                self.assertFalse(p)
                self.assertIn('quiz judge could not grade', why)
                self.assertIn('v5 kept', why)
        # a measured quiz with no clear answer leaves today's strip veto in place
        p, why = self.te.decide_promotion(good, strip_bad, False, q(0.60, 0.59, -0.01, 0.03))
        self.assertFalse(p)
        self.assertIn('ranks suggestion adds worse', why)
        # a reliable quiz win overrides the strip veto
        p, why = self.te.decide_promotion(good, strip_bad, False, q(0.63, 0.58, 0.03, 0.07))
        self.assertTrue(p, why)
        self.assertIn('PROMOTED', why)
        self.assertIn('overrides the suggestion-strip check (0.585 vs 0.627)', why)
        # …and keeps a promoted model on
        self.assertTrue(self.te.decide_promotion(good, strip_bad, True, q(0.63, 0.58, 0.03, 0.07))[0])
        # a quiz win that is not reliable does not override
        self.assertFalse(self.te.decide_promotion(good, strip_bad, False, q(0.60, 0.59, -0.01, 0.03))[0])
        # a reliable quiz loss vetoes even when the strip is fine
        p, why = self.te.decide_promotion(good, {'verdict': 'insufficient data'}, False, q(0.55, 0.60, -0.07, -0.02))
        self.assertFalse(p)
        self.assertIn('the quiz vetoes', why)
        p, why = self.te.decide_promotion(good, {'verdict': 'insufficient data'}, True, q(0.55, 0.60, -0.07, -0.02))
        self.assertFalse(p)
        self.assertIn('ROLLED BACK', why)
        # an unclear quiz leaves a fine strip alone
        self.assertTrue(self.te.decide_promotion(good, {'verdict': 'insufficient data'}, False, q(0.60, 0.59, -0.01, 0.03))[0])
        # the quiz never promotes on its own
        weak = dict(good, gainLowerBound=-0.01)
        self.assertFalse(self.te.decide_promotion(weak, {}, False, q(0.63, 0.58, 0.03, 0.07))[0])

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
        self.assertEqual(sc['quiz']['verdicts'], 0)
        self.assertEqual(sc['weights']['quiz_verdict'], 0.0)   # no quiz → the column is inert

    def test_old_quiz_verdicts_are_learned_and_their_worth_is_measured(self):
        """Verdicts given before every window, matching where his taste really
        is: the model weighs them and the scorecard shows what they added."""
        tracks = self.lib(n=900)
        self.mood([t['id'] for t in tracks])
        rng = np.random.default_rng(4)
        love = {t['id']: rng.random() < 0.5 for t in tracks}
        rows = []
        start = self.now - 150 * DAY
        for day in range(150):
            for _ in range(40):
                tid = int(rng.integers(1, 901))
                kind = 'play' if rng.random() < (0.95 if love[tid] else 0.6) else 'skip'
                rows.append({'ts': iso(start + day * DAY + int(rng.integers(0, DAY))), 'device': 'laptop', 'kind': kind, 'pct': 40 if kind == 'skip' else 100, 'trackId': tid})
        with open(os.path.join(self.d, 'h.jsonl'), 'w') as f:
            for r in sorted(rows, key=lambda r: r['ts']):
                f.write(json.dumps(r) + '\n')
        self.write_quiz([{'v': 1, 'kind': 'inout', 'at': iso(start - DAY + i), 'ids': [str(tid)], 'choice': 'in' if love[tid] else 'out'}
                         for i, tid in enumerate(range(1, 901, 2))])
        self.te.time.time = lambda: self.now / 1000
        self.assertEqual(self.te.main(), 0)
        sc = json.load(open(os.path.join(self.d, 'work', 'taste-scorecard.json')))
        self.assertEqual(sc['quiz']['verdicts'], 450)
        self.assertGreater(sc['weights']['quiz_verdict'], 0.0)
        self.assertIn('quizGain', sc['evaluation'])
        self.assertGreater(sc['evaluation']['quizGain'], 0.0)
        self.assertTrue(all('challenger_withoutQuiz' in f for f in sc['evaluation']['folds'] if f['verdict'] == 'measured'))

    def test_end_to_end_quiz_judge_is_measured_and_recorded(self):
        """Duels that follow where his taste really is: the judge is measured
        on models frozen at the first choice, and all three tests land in
        taste-state.json."""
        tracks = self.lib(n=900)
        self.mood([t['id'] for t in tracks])
        rng = np.random.default_rng(4)
        love = {t['id']: rng.random() < 0.5 for t in tracks}
        rows = []
        start = self.now - 150 * DAY
        for day in range(150):
            for _ in range(40):
                tid = int(rng.integers(1, 901))
                kind = 'play' if rng.random() < (0.95 if love[tid] else 0.6) else 'skip'
                rows.append({'ts': iso(start + day * DAY + int(rng.integers(0, DAY))), 'device': 'laptop', 'kind': kind, 'pct': 40 if kind == 'skip' else 100, 'trackId': tid})
        with open(os.path.join(self.d, 'h.jsonl'), 'w') as f:
            for r in sorted(rows, key=lambda r: r['ts']):
                f.write(json.dumps(r) + '\n')
        loved = [t for t in love if love[t]]
        unloved = [t for t in love if not love[t]]
        duels = []
        for i in range(600):
            a, b = int(rng.choice(loved)), int(rng.choice(unloved))
            duels.append({'v': 1, 'kind': 'duel', 'at': iso(self.now - 3 * DAY + i * 1000), 'ids': [str(b), str(a)], 'choice': str(a)})
        self.write_quiz(duels)
        self.te.time.time = lambda: self.now / 1000
        self.assertEqual(self.te.main(), 0)
        st = json.load(open(os.path.join(self.d, 'taste-state.json')))
        self.assertEqual(set(st['tests']), {'holdout', 'stripAdds', 'quizChoices'})
        qz = st['tests']['quizChoices']
        self.assertEqual(qz['verdict'], 'measured')
        self.assertEqual(qz['questions'], 600)
        self.assertEqual(qz['frozenAt'], iso(self.now - 3 * DAY)[:19] + 'Z')
        self.assertGreater(qz['challenger'], 0.5)   # it learned what he loves from behavior alone


    # ── the quiz judge as a required gate (2026-10-27, Jake: "the models absolutely cannot be getting worse") ──

    def world(self, n=900):
        """Synthetic listening where half the library is loved (finished 95%
        vs 60%); returns (lib, events, mood, love)."""
        tracks = self.lib(n=n)
        self.mood([t['id'] for t in tracks])
        rng = np.random.default_rng(4)
        love = {t['id']: rng.random() < 0.5 for t in tracks}
        rows = []
        start = self.now - 150 * DAY
        for day in range(150):
            for _ in range(40):
                tid = int(rng.integers(1, n + 1))
                kind = 'play' if rng.random() < (0.95 if love[tid] else 0.6) else 'skip'
                rows.append({'ts': iso(start + day * DAY + int(rng.integers(0, DAY))), 'device': 'laptop', 'kind': kind, 'pct': 40 if kind == 'skip' else 100, 'trackId': tid})
        with open(os.path.join(self.d, 'h.jsonl'), 'w') as f:
            for r in sorted(rows, key=lambda r: r['ts']):
                f.write(json.dumps(r) + '\n')
        lib = self.te.load_library(os.path.join(self.d, 'library.json'))
        events = self.te.load_history(os.path.join(self.d, 'h.jsonl'), lib)
        mood = self.te.mood_basis(self.te.load_mood(os.path.join(self.d, 'mood-index.bin'), lib.keys())[0])
        return lib, events, mood, love

    def duels(self, love, count, at_ms, seed=1):
        rng = np.random.default_rng(seed)
        loved = [t for t in love if love[t]]
        unloved = [t for t in love if not love[t]]
        out = []
        for i in range(count):
            a, b = int(rng.choice(loved)), int(rng.choice(unloved))
            out.append({'v': 1, 'kind': 'duel', 'at': iso(at_ms + i * 1000), 'ids': [str(b), str(a)], 'choice': str(a)})
        return out

    GOOD = {'verdict': 'measured', 'auc': {'challenger': 0.597, 'champion_v5': 0.486}, 'meanGain': 0.111, 'gainLowerBound': 0.071,
            'foldsWon': 3, 'folds': [{'verdict': 'measured'}] * 3}

    def assert_fails_closed(self, quiz, verdict):
        self.assertEqual(quiz['verdict'], verdict, quiz)
        for was in (False, True):
            p, why = self.te.decide_promotion(self.GOOD, {'verdict': 'insufficient data'}, was, quiz)
            self.assertFalse(p, why)
            self.assertIn('quiz judge could not grade: ' + verdict, why)
            self.assertIn('ROLLED BACK to v5' if was else 'v5 kept', why)

    def test_fail_closed_insufficient(self):
        lib, events, mood, love = self.world()
        self.write_quiz(self.duels(love, 499, self.now - 3 * DAY))
        self.assert_fails_closed(self.te.run_quiz_check(lib, events, mood, self.now), 'insufficient data')

    def test_fail_closed_missing_file(self):
        self.lib(n=20)
        lib = self.te.load_library(os.path.join(self.d, 'library.json'))
        self.assert_fails_closed(self.te.run_quiz_check(lib, [], {}, self.now), 'no answers file')

    def test_fail_closed_parse_error(self):
        lib, events, mood, love = self.world()
        rows = self.duels(love, 600, self.now - 3 * DAY)
        rows.insert(300, '{"v":1,"kind":"duel","at":')   # a torn line in the MIDDLE of the file
        with open(os.path.join(self.d, 'top1000-answers.jsonl'), 'w') as f:
            for r in rows:
                f.write((r if isinstance(r, str) else json.dumps(r)) + '\n')
        self.assert_fails_closed(self.te.run_quiz_check(lib, events, mood, self.now), 'parse error')
        # a torn LAST line is an append in progress, not corruption
        with open(os.path.join(self.d, 'top1000-answers.jsonl'), 'w') as f:
            for r in rows[:300] + rows[301:]:
                f.write(json.dumps(r) + '\n')
            f.write('{"v":1,"kind":"du')
        self.assertEqual(self.te.run_quiz_check(lib, events, mood, self.now)['verdict'], 'measured')

    def test_fail_closed_invalid_utf8(self):
        self.lib(n=20)
        lib = self.te.load_library(os.path.join(self.d, 'library.json'))
        with open(os.path.join(self.d, 'top1000-answers.jsonl'), 'wb') as f:
            f.write(b'\xff\xfe\x00garbage\n')
        self.assert_fails_closed(self.te.run_quiz_check(lib, [], {}, self.now), 'error')

    def test_fail_closed_exception(self):
        lib, events, mood, love = self.world()
        self.write_quiz(self.duels(love, 600, self.now - 3 * DAY))
        def boom(*a, **k):
            raise ValueError('singular matrix')
        self.te.window_train = boom
        q = self.te.run_quiz_check(lib, events, mood, self.now)
        self.assert_fails_closed(q, 'error')
        self.assertIn('singular matrix', q['why'])

    def test_fail_closed_leakage(self):
        """A Snapshot that ignores the as-of rule (sees every verdict) is caught."""
        lib, events, mood, love = self.world()
        self.write_quiz(self.duels(love, 600, self.now - 3 * DAY))
        verdicts = [(self.now - 2 * DAY, tid, 1.0 if love[tid] else -1.0) for tid in range(1, 200)]   # given INSIDE the graded window
        Real = self.te.Snapshot
        class Leaky(Real):
            def __init__(self, lib, events, at_ms, verdicts=()):
                super().__init__(lib, events, at_ms + 365 * DAY, verdicts)   # sees the future
                self.at = at_ms
        self.te.Snapshot = Leaky
        self.assert_fails_closed(self.te.run_quiz_check(lib, events, mood, self.now, verdicts), 'leakage refused')
        self.te.Snapshot = Real
        self.assertEqual(self.te.run_quiz_check(lib, events, mood, self.now, verdicts)['verdict'], 'measured')

    def test_keep_rolls_back_on_quiz_loss(self):
        loss = {'verdict': 'measured', 'challenger': 0.48, 'champion_v5': 0.59, 'gain': -0.11,
                'gainLowerBound': -0.12, 'gainUpperBound': -0.09, 'questions': 7544}
        p, why = self.te.decide_promotion(self.GOOD, {'verdict': 'insufficient data'}, True, loss)
        self.assertFalse(p)
        self.assertTrue(why.startswith('ROLLED BACK to v5'), why)
        self.assertIn('the quiz vetoes', why)
        p, why = self.te.decide_promotion(self.GOOD, {'verdict': 'insufficient data'}, True, self.NEUTRAL_QUIZ)
        self.assertTrue(p, why)   # not worse on the quiz, holdout fine → kept

    def test_after_verdicts_mature_the_judge_grades_only_held_out_choices(self):
        """Simulated 2026-11-20 onward: verdicts given more than 28 days ago
        count as a feature; the judge grades only the last 28 days of choices
        on a challenger whose verdicts all predate them."""
        lib, events, mood, love = self.world()
        old_v = [{'v': 1, 'kind': 'inout', 'at': iso(self.now - 100 * DAY + i * 1000), 'ids': [str(tid)], 'choice': 'in' if love[tid] else 'out'}
                 for i, tid in enumerate(range(1, 901, 2))]
        new_v = [{'v': 1, 'kind': 'inout', 'at': iso(self.now - 5 * DAY + i * 1000), 'ids': [str(tid)], 'choice': 'in' if love[tid] else 'out'}
                 for i, tid in enumerate(range(2, 901, 2))]
        old_q = self.duels(love, 400, self.now - 60 * DAY, seed=2)
        new_q = self.duels(love, 550, self.now - 20 * DAY, seed=3)
        self.write_quiz(old_v + old_q + new_v + new_q)
        path = os.path.join(self.d, 'top1000-answers.jsonl')
        verdicts, _, _ = self.te.load_quiz(path, lib)
        self.assertLess(verdicts[0][0] + 28 * DAY, self.now)   # the verdicts have matured into training
        q = self.te.run_quiz_check(lib, events, mood, self.now, verdicts)
        self.assertEqual(q['verdict'], 'measured', q)
        self.assertEqual(q['questions'], 550)                   # only the held-out window is graded
        self.assertEqual(q['frozenAt'], iso(self.now - 28 * DAY)[:19] + 'Z')
        self.assertEqual(q['verdictsTrainedOn'], 450)           # the old verdicts, none of the 450 recent ones
        # and the training really excluded the held-out window
        seen = []
        Real = self.te.Snapshot
        class Spy(Real):
            def __init__(self, lib, events, at_ms, verdicts=()):
                super().__init__(lib, events, at_ms, verdicts)
                seen.append((at_ms, set(self.verdict)))
        self.te.Snapshot = Spy
        self.te.run_quiz_check(lib, events, mood, self.now, verdicts)
        self.te.Snapshot = Real
        recent_ids = set(range(2, 901, 2))
        self.assertTrue(seen)
        self.assertTrue(all(at <= self.now - 28 * DAY for at, _ in seen))
        self.assertTrue(all(not (ids & recent_ids) for _, ids in seen))
        # with fewer than 500 choices in the held-out window it fails closed, even with 950 in all
        self.write_quiz(old_v + old_q + self.duels(love, 499, self.now - 20 * DAY, seed=3))
        self.assert_fails_closed(self.te.run_quiz_check(lib, events, mood, self.now, verdicts), 'insufficient data')

if __name__ == '__main__':
    unittest.main()
