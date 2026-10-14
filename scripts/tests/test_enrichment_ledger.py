#!/usr/bin/env python3
"""Brief 177 — fixture tests for audio-embed.py's enrichment-ledger mirror.

Exercises the ledger read/write + candidate ordering WITHOUT the CLAP
model: audio-embed.py imports torch lazily (inside load_model/embed_track),
so importing the module here is safe on any machine.

Run: python3 -m unittest scripts.tests.test_enrichment_ledger
  or: python3 scripts/tests/test_enrichment_ledger.py
"""
import importlib.util
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SPEC = importlib.util.spec_from_file_location("audio_embed", os.path.join(HERE, "..", "audio-embed.py"))
AE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AE)

NOW_MS = 1_800_000_000_000


class LedgerMirrorTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="enrichment-ledger-py-")
        self.path = os.path.join(self.tmp, "enrichment-ledger.json")
        AE.LEDGER_PATH = self.path

    def test_missing_and_corrupt_ledgers_read_empty(self):
        self.assertEqual(AE.load_ledger(), {"version": 1, "tracks": {}})
        with open(self.path, "w") as f:
            f.write("{corrupt")
        self.assertEqual(AE.load_ledger(), {"version": 1, "tracks": {}})

    def test_round_trip_shape_matches_the_node_module(self):
        led = AE.load_ledger()
        e = AE._ledger_entry(led, 42)
        e["clapAttempted"] = True
        e["clapAttemptedAt"] = NOW_MS
        AE.save_ledger(led)
        back = AE.load_ledger()
        entry = back["tracks"]["42"]
        # the exact field set scripts/enrichment-ledger.mjs writes
        self.assertEqual(
            set(entry.keys()),
            {"clapAttempted", "clapDone", "lyricsDone", "taxonomyDone",
             "clapAttemptedAt", "clapDoneAt", "lyricsAttemptedAt", "lyricsDoneAt",
             "taxonomyDoneAt", "lastError", "lastJob", "updatedAt"})
        self.assertTrue(entry["clapAttempted"])
        self.assertEqual(entry["clapAttemptedAt"], NOW_MS)
        with open(self.path) as f:
            self.assertEqual(json.load(f)["version"], 1)

    def test_ordering_defers_recent_failures_only(self):
        led = {"version": 1, "tracks": {}}
        recent = AE._ledger_entry(led, 1)
        recent.update({"clapAttempted": True, "clapAttemptedAt": NOW_MS - 60_000})
        old = AE._ledger_entry(led, 2)
        old.update({"clapAttempted": True, "clapAttemptedAt": NOW_MS - AE.RETRY_TTL_MS - 60_000})
        done_recent = AE._ledger_entry(led, 5)
        done_recent.update({"clapAttempted": True, "clapDone": True, "clapAttemptedAt": NOW_MS})
        todo = [{"id": 1}, {"id": 2}, {"id": 3}, {"id": 5}]
        ordered, n_fresh, n_deferred = AE.order_candidates(todo, led, NOW_MS)
        # done tracks are not filtered here (the caller excludes them via the
        # index); a done entry is simply never "deferred".
        self.assertEqual([t["id"] for t in ordered], [2, 3, 5, 1])
        self.assertEqual((n_fresh, n_deferred), (3, 1))


if __name__ == "__main__":
    unittest.main()
