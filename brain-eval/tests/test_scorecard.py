"""scorecard.py (v3 ruler): vocab-resolved predicates, the ruler-stale guard,
the frozen query-vector cache, the v3 citation check and E1's scratch tool."""
import contextlib, io, json, os, struct, sys, tempfile, unittest
import numpy as np
import _paths  # noqa: F401
import scorecard as S

VOCAB = S.Vocab({
    "leaves": {"Punk": {"family": "Punk", "umbrella": "Rock"}, "Pop-Punk": {"family": "Punk", "umbrella": "Rock"},
               "Grunge": {"family": "Rock", "umbrella": "Rock"}, "House": {"family": "Electronic & Dance", "umbrella": "Electronic"},
               "Soundtrack": {"family": "Other", "umbrella": None}},
    "families": {"Punk": {"umbrella": "Rock", "leaves": ["Punk", "Pop-Punk"]}, "Rock": {"umbrella": "Rock", "leaves": ["Grunge"]},
                 "Electronic & Dance": {"umbrella": "Electronic", "leaves": ["House"]}, "Other": {"umbrella": None, "leaves": ["Soundtrack"]}},
    "umbrellas": {"Rock": {"families": ["Rock", "Punk"]}, "Electronic": {"families": ["Electronic & Dance"]}},
    "catch_all": ["Punk"],
})
T = [
    {"id": 1, "title": "Basket Case", "artist": "Green Day", "genre": "Pop-Punk", "year": 1994, "bpm": 175.2},
    {"id": 2, "title": "Blitzkrieg Bop", "artist": "Ramones", "genre": "Punk", "year": 1976, "bpm": None},
    {"id": 3, "title": "Lithium", "artist": "Nirvana", "genre": "Grunge", "year": 1991, "bpm": 125},
    {"id": 4, "title": "One More Time", "artist": "Daft Punk", "genre": "House", "year": 2000, "bpm": 123.0},
    {"id": 5, "title": "Forgot About Dre", "artist": "Dr. Dre & Eminem", "contributingArtists": ["Dr. Dre", "Eminem"],
     "genre": "House", "year": 1999, "bpm": 0},
    {"id": 6, "title": "Theme", "artist": "Björk", "genre": "Soundtrack", "year": 2001, "bpm": 80},
]


def ids(pred):
    return S.expected_ids(pred, T, VOCAB)


class Predicates(unittest.TestCase):
    def test_exact_leaf_never_substring(self):
        self.assertEqual(ids({"genre_leaf": "Punk"}), {2})      # v1's 'punk' substring would also take Pop-Punk
        self.assertEqual(ids({"genre_family": "Punk"}), {1, 2})
        self.assertEqual(ids({"genre_umbrella": "Rock"}), {1, 2, 3})

    def test_genre_kinds_union_then_and(self):
        self.assertEqual(ids({"genre_family": "Punk", "genre_leaf": "Grunge"}), {1, 2, 3})
        self.assertEqual(ids({"genre_umbrella": "Rock", "year_range": [1990, 1999]}), {1, 3})

    def test_measured_bpm_only(self):
        self.assertEqual(ids({"bpm_min": 130}), {1})
        self.assertEqual(ids({"bpm_max": 85}), {6})           # bpm 0 / None never match
        self.assertEqual(S.real_bpm({"bpm": True}), None)

    def test_artist_exact_folded_incl_contributing(self):
        self.assertEqual(ids({"artist": "eminem"}), {5})
        self.assertEqual(ids({"artist": "Bjork"}), {6})        # accent fold
        self.assertEqual(ids({"artist": "Daft"}), set())         # no substrings

    def test_unknown_names_are_errors_not_zeros(self):
        for bad in ({"genre_leaf": "Polka"}, {"genre_family": "Rock & Roll"}, {"genre_umbrella": "Pop"}, {"genre_any": ["punk"]}):
            with self.assertRaises(ValueError):
                S.compile_predicate(bad, VOCAB)

    def test_ruler_stale_guard(self):
        ok = S.ruler_check(T, VOCAB)
        self.assertFalse(ok["stale"])
        stale = T + [{"id": 100 + i, "genre": "Funk/Soul"} for i in range(3)]
        rc = S.ruler_check(stale, VOCAB)
        self.assertTrue(rc["stale"])
        self.assertEqual(rc["top_unresolved"][0], ("Funk/Soul", 3))
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as cm:
            S.assert_ruler_fresh(stale, VOCAB)
        self.assertEqual(cm.exception.code, S.RULER_STALE_EXIT)
        big = [dict(t, id=i) for i, t in enumerate(T * 400)] + [{"id": 99999, "genre": "Nope"}]
        self.assertFalse(S.ruler_check(big, VOCAB)["stale"])   # 1/2401 < 0.5%

    def test_recall_formula_unchanged(self):
        self.assertEqual(S.recall_at_k([1, 2, 3, 4], {1, 3, 9}, 4), 2 / 3)
        self.assertEqual(S.recall_at_k([1, 2, 3, 4], {1, 2, 3, 4, 5, 6}, 4), 1.0)
        self.assertIsNone(S.recall_at_k([1], set(), 4))


class QvecCacheRoundTrip(unittest.TestCase):
    def test_overflow_then_freeze_bit_exact(self):
        with tempfile.TemporaryDirectory() as d:
            c = S.QvecCache(os.path.join(d, "frozen.json"), os.path.join(d, "over.json"))
            raw = np.random.default_rng(0).normal(size=S.EMBED_DIM).astype(np.float32)
            c.overflow[S.qvec_key("punk rock")] = {"text": "punk rock", "b64": S._vec_to_b64(raw)}
            got = c.get_many(["punk rock"], api_key="")["punk rock"]
            self.assertTrue(np.array_equal(got, raw / np.linalg.norm(raw)))
            self.assertEqual(c.freeze(["punk rock"]), 1)
            c2 = S.QvecCache(os.path.join(d, "frozen.json"), os.path.join(d, "missing.json"))
            self.assertTrue(np.array_equal(S._b64_to_vec(c2.lookup("punk rock")["b64"]), raw))


class Citations(unittest.TestCase):
    def setUp(self):
        import run_eval as R
        self.R = R
        self.idx = R.title_index(T)

    def check(self, cited, pred):
        return self.R.check_citations_v3(cited, self.idx, S.compile_predicate(pred, VOCAB))

    def test_real_and_on_predicate(self):
        n, bad, _ = self.check([{"title": "Basket Case", "artist": "Green Day"}], {"genre_family": "Punk"})
        self.assertEqual((n, bad), (1, 0))

    def test_existing_but_off_predicate_fails(self):
        n, bad, det = self.check([{"title": "Lithium", "artist": "Nirvana"}], {"genre_family": "Punk"})
        self.assertEqual((n, bad, det[0][0]), (1, 1, "OFF-PREDICATE"))

    def test_fabricated_and_misattributed(self):
        _, bad, det = self.check([{"title": "Imaginary 9z9z", "artist": "Nobody"}], {"genre_family": "Punk"})
        self.assertEqual(det[0][0], "FABRICATED")
        _, bad, det = self.check([{"title": "Basket Case", "artist": "Ramones"}], {"genre_family": "Punk"})
        self.assertEqual(det[0][0], "MISATTRIBUTED")

    def test_feat_and_contributing_artists_resolve(self):
        n, bad, _ = self.check([{"title": "Forgot About Dre (feat. Eminem)", "artist": "Eminem"}], {"genre_leaf": "House"})
        self.assertEqual((n, bad), (1, 0))


def write_embd(path, items, dim=S.EMBED_DIM):
    with open(path, "wb") as f:
        f.write(b"EMBD" + struct.pack("<HHI", 1, dim, len(items)))
        for i, v in items:
            f.write(struct.pack("<I", i) + np.asarray(v, dtype="<f4").tobytes())


class DropBareMood(unittest.TestCase):
    def test_drops_only_bare_in_library_and_preserves_bytes(self):
        sys.path.insert(0, os.path.join(_paths.BRAIN_EVAL, "experiments", "tools"))
        import drop_bare_mood as D
        with tempfile.TemporaryDirectory() as d:
            json.dump({"tracks": [{"id": i} for i in (1, 2, 3)]}, open(os.path.join(d, "library.json"), "w"))
            json.dump({"1": {"d": "loud fast guitars"}, "2": {"d": "  "}}, open(os.path.join(d, "brain-descriptors.json"), "w"))
            rng = np.random.default_rng(1)
            vecs = {i: rng.normal(size=S.EMBED_DIM) for i in (1, 2, 3, 9)}   # 9 = orphan (left to the trainer's prune)
            write_embd(os.path.join(d, "mood-index.bin"), list(vecs.items()))
            before = open(os.path.join(d, "mood-index.bin"), "rb").read()
            self.assertEqual(S.bare_mood_ids(d), [2, 3])
            with contextlib.redirect_stdout(io.StringIO()):
                D.main(["--state-dir", d])
            after = open(os.path.join(d, "mood-index.bin"), "rb").read()
            self.assertEqual(S.embd_ids(os.path.join(d, "mood-index.bin")), [1, 9])
            rec = 4 + S.EMBED_DIM * 4
            self.assertEqual(after[12:12 + rec], before[12:12 + rec])                       # id 1 byte-identical
            self.assertEqual(after[12 + rec:], before[12 + 3 * rec:12 + 4 * rec])            # id 9 byte-identical
            self.assertEqual(json.load(open(os.path.join(d, "E1-dropped-ids.json"))), [2, 3])

    def test_refuses_live_dirs_and_symlinks(self):
        sys.path.insert(0, os.path.join(_paths.BRAIN_EVAL, "experiments", "tools"))
        import drop_bare_mood as D
        live = S.LIVE_STATE_DIRS[0]
        if os.path.exists(live):
            with self.assertRaises(SystemExit):
                D.main(["--state-dir", live, "--dry-run"])
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as e:
            write_embd(os.path.join(e, "real.bin"), [(1, np.ones(S.EMBED_DIM))])
            os.symlink(os.path.join(e, "real.bin"), os.path.join(d, "mood-index.bin"))
            with self.assertRaises(SystemExit):
                D.main(["--state-dir", d])


if __name__ == "__main__":
    unittest.main()
