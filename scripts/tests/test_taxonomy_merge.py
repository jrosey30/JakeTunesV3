#!/usr/bin/env python3
"""Brief 182 — fixture tests for taxonomy-classify.py's write-time merge.

The script runs its whole pipeline at import, so this test extracts the
write-path functions (fp_of / has_subgenre_in / merge_staged /
rotate_backups / deferred markers) from the shipped file by source segment
and execs them against fixtures — the code under test is the code that
ships, not a copy.

Scenarios:
  1. A concurrent edit lands between load and write -> the write-time
     merge preserves it, and the additive rule still holds (an existing
     subgenre is never overwritten; unrelated fields survive).
  2. Backup rotation keeps 5 generations and drops the oldest.
  3. The deferred marker round-trips {at, pendingCount}.

Run: python3 scripts/tests/test_taxonomy_merge.py
"""
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "..", "taxonomy-classify.py")).read()
START = SRC.index("def fp_of(t):")
END = SRC.index("# First pass against the load-time copy")
SEGMENT = SRC[START:END]


def load_write_path(sd, ovp):
    g = {
        "json": json, "os": os, "shutil": __import__("shutil"), "datetime": __import__("datetime"),
        "SD": sd, "OVP": ovp, "log": lambda *a: None,
    }
    exec(SEGMENT, g)
    return g


class TaxonomyMergeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="taxonomy182-")
        self.ovp = os.path.join(self.tmp, "metadata-overrides.json")
        self.g = load_write_path(self.tmp, self.ovp)
        self.byid = {
            "1": {"id": 1, "title": "Song One", "artist": "Artist A", "duration": 200000},
            "2": {"id": 2, "title": "Song Two", "artist": "Artist B", "duration": 180000},
            "3": {"id": 3, "title": "Song Three", "artist": "Artist C", "duration": 190000},
        }
        self.cache = {
            "1": {"subgenre": "Synthpop", "path": "Pop › Synthpop", "lean": "New Wave"},
            "2": {"subgenre": "Shoegaze", "path": "Rock › Shoegaze", "lean": ""},
            "3": {"subgenre": "Grime", "path": "Electronic › Grime", "lean": ""},
        }

    def test_concurrent_edit_survives_and_additive_rule_holds(self):
        # What the script loaded at start: track 2 has an entry (no subgenre).
        loaded = {"2": {"fp": "song two|artist b|180000", "fields": {"rating": 5}}}
        # The "classify" happens against the cache; meanwhile another writer
        # lands edits on disk: a subgenre for track 1 (the very thing we were
        # about to write), a new field on track 2, and a brand-new track 9.
        on_disk = {
            "1": {"fp": "song one|artist a|200000", "fields": {"subgenre": "Dream Pop", "subgenrePath": "Rock › Dream Pop"}},
            "2": {"fp": "song two|artist b|180000", "fields": {"rating": 5, "playCount": 12}},
            "9": {"fp": "other|someone|1000", "fields": {"genre": "Jazz"}},
        }
        staged = self.g["merge_staged"](on_disk, self.cache, self.byid)
        # Tracks 2 and 3 were still missing a subgenre at write time;
        # track 1 was not (the concurrent writer beat us to it).
        self.assertEqual(staged, 2)
        # Track 1: concurrent subgenre NOT overwritten by our cached Synthpop.
        self.assertEqual(on_disk["1"]["fields"]["subgenre"], "Dream Pop")
        # Track 2: concurrent field survives; our staged subgenre added.
        self.assertEqual(on_disk["2"]["fields"]["playCount"], 12)
        self.assertEqual(on_disk["2"]["fields"]["rating"], 5)
        self.assertEqual(on_disk["2"]["fields"]["subgenre"], "Shoegaze")
        # Track 2's accepted fp preserved (not recomputed).
        self.assertEqual(on_disk["2"]["fp"], "song two|artist b|180000")
        # Track 9 (unknown to this run): untouched.
        self.assertEqual(on_disk["9"], {"fp": "other|someone|1000", "fields": {"genre": "Jazz"}})
        # Track 3: brand-new entry got a computed fp in the app's format.
        self.assertEqual(on_disk["3"]["fp"], "song three|artist c|190000")
        self.assertEqual(on_disk["3"]["fields"]["subgenrePath"], "Electronic › Grime")

    def test_backup_rotation_keeps_five_generations(self):
        with open(self.ovp, "w") as f:
            f.write("current")
        for gen, body in [("", "gen0"), (".1", "gen1"), (".2", "gen2"), (".3", "gen3"), (".4", "gen4"), (".5", "gen5-oldest")]:
            with open(self.ovp + ".bak-classify" + gen, "w") as f:
                f.write(body)
        self.g["rotate_backups"]()
        def body(suffix):
            p = self.ovp + ".bak-classify" + suffix
            return open(p).read() if os.path.exists(p) else None
        self.assertEqual(body(""), "current")     # fresh backup of the pre-write file
        self.assertEqual(body(".1"), "gen0")
        self.assertEqual(body(".2"), "gen1")
        self.assertEqual(body(".4"), "gen3")
        self.assertEqual(body(".5"), "gen4")      # gen5-oldest rotated out
        self.assertIsNone(body(".6"))

    def test_deferred_marker_round_trips(self):
        self.g["write_deferred"](17)
        marker = json.load(open(os.path.join(self.tmp, "taxonomy-deferred.json")))
        self.assertEqual(marker["pendingCount"], 17)
        self.assertIn("at", marker)
        self.g["clear_deferred"]()
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "taxonomy-deferred.json")))


if __name__ == "__main__":
    unittest.main()
