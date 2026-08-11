"""Unit + API tests for Boom Phase 2 server."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

# Allow `python -m unittest` from server/boom
ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from boom.db import BoomDB  # noqa: E402
from boom.events import format_sse  # noqa: E402


class BoomDBTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.db = BoomDB(Path(self.tmp.name) / "t.sqlite")

    def tearDown(self) -> None:
        self.db.close()
        self.tmp.cleanup()

    def test_import_and_snapshot(self) -> None:
        result = self.db.import_library_json(
            {
                "tracks": [
                    {"id": 1, "title": "A", "artist": "X", "path": ":iPod_Control:Music:F00:a.mp3"},
                    {"id": 2, "title": "B", "artist": "Y", "path": ":iPod_Control:Music:F00:b.mp3"},
                ],
                "playlists": [{"id": "p1", "name": "Favs", "trackIds": [1, 2]}],
            }
        )
        self.assertEqual(result["tracks"], 2)
        self.assertEqual(result["playlists"], 1)
        snap = self.db.snapshot()
        self.assertEqual(len(snap["tracks"]), 2)
        self.assertEqual(len(snap["playlists"]), 1)
        self.assertGreaterEqual(snap["latestEventId"], 1)

    def test_field_patch_and_etag_conflict(self) -> None:
        self.db.upsert_track({"id": 7, "title": "Old", "genre": "Rock"}, emit=False)
        ok = self.db.patch_track(7, {"title": "New"}, if_etag=1)
        self.assertTrue(ok["ok"])
        self.assertEqual(ok["track"]["title"], "New")
        self.assertEqual(ok["track"]["genre"], "Rock")
        self.assertEqual(ok["etag"], 2)

        conflict = self.db.patch_track(7, {"title": "Nope"}, if_etag=1)
        self.assertFalse(conflict["ok"])
        self.assertEqual(conflict["status"], 409)
        self.assertEqual(conflict["track"]["title"], "New")

    def test_increment_play_count(self) -> None:
        self.db.upsert_track({"id": 3, "title": "T", "playCount": 4}, emit=False)
        r = self.db.patch_track(3, {}, increment={"playCount": 1})
        self.assertTrue(r["ok"])
        self.assertEqual(r["track"]["playCount"], 5)

    def test_soft_delete_track(self) -> None:
        self.db.upsert_track({"id": 9, "title": "Gone"}, emit=False)
        r = self.db.soft_delete_track(9)
        self.assertTrue(r["ok"])
        self.assertIsNone(self.db.get_track(9))
        events = self.db.events_after(0)
        types = [e["type"] for e in events]
        self.assertIn("track-deleted", types)

    def test_events_after_cursor(self) -> None:
        self.db.upsert_track({"id": 1, "title": "A"}, emit=True)
        self.db.upsert_track({"id": 2, "title": "B"}, emit=True)
        all_e = self.db.events_after(0)
        mid = all_e[0]["id"]
        rest = self.db.events_after(mid)
        self.assertEqual(len(rest), len(all_e) - 1)
        self.assertTrue(all(e["id"] > mid for e in rest))


class SseFormatTests(unittest.TestCase):
    def test_format_includes_id_and_event(self) -> None:
        chunk = format_sse(
            {
                "id": 42,
                "schema": 1,
                "type": "track-updated",
                "entity_id": "7",
                "payload": {"id": 7, "fields": {"title": "X"}, "etag": 2},
                "ts": 1.5,
            }
        )
        self.assertIn("id: 42\n", chunk)
        self.assertIn("event: track-updated\n", chunk)
        self.assertIn("data: ", chunk)
        self.assertTrue(chunk.endswith("\n\n"))
        data_line = [l for l in chunk.splitlines() if l.startswith("data: ")][0]
        payload = json.loads(data_line[len("data: ") :])
        self.assertEqual(payload["type"], "track-updated")
        self.assertEqual(payload["payload"]["fields"]["title"], "X")


class ApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        db_path = Path(self.tmp.name) / "api.sqlite"
        import boom.app as appmod
        from fastapi.testclient import TestClient

        appmod.DEFAULT_DB = db_path
        appmod._db = None  # force reopen against temp path
        # Context manager enters lifespan so get_db() binds to DEFAULT_DB.
        self._cm = TestClient(appmod.app)
        self.client = self._cm.__enter__()
        self.appmod = appmod

    def tearDown(self) -> None:
        self._cm.__exit__(None, None, None)
        self.tmp.cleanup()

    def test_health_and_patch_roundtrip(self) -> None:
        h = self.client.get("/healthz")
        self.assertEqual(h.status_code, 200)
        self.assertTrue(h.json()["ok"])

        up = self.client.post(
            "/api/tracks",
            json={"track": {"id": 11, "title": "Hello", "artist": "A", "genre": "Jazz"}},
        )
        self.assertEqual(up.status_code, 200)
        etag = up.json()["etag"]

        patched = self.client.patch(
            "/api/tracks/11",
            json={"fields": {"title": "Hello World"}, "etag": etag},
        )
        self.assertEqual(patched.status_code, 200)
        self.assertEqual(patched.json()["track"]["title"], "Hello World")
        self.assertEqual(patched.json()["track"]["genre"], "Jazz")

        lib = self.client.get("/api/library")
        self.assertEqual(lib.status_code, 200)
        self.assertEqual(len(lib.json()["tracks"]), 1)

    def test_sse_replay(self) -> None:
        self.client.post("/api/tracks", json={"track": {"id": 1, "title": "A"}})
        self.client.post("/api/tracks", json={"track": {"id": 2, "title": "B"}})
        # Avoid long-lived SSE in unit tests (keepalive blocks iter_text).
        # Replay semantics are covered by BoomDBTests + format_sse.
        events = self.appmod.get_db().events_after(0)
        self.assertGreaterEqual(len(events), 2)
        self.assertEqual(events[0]["type"], "track-updated")
        from boom.events import format_sse

        chunk = format_sse(events[0])
        self.assertIn("event: track-updated", chunk)
        self.assertIn(f"id: {events[0]['id']}", chunk)


if __name__ == "__main__":
    unittest.main()
