"""SQLite schema + helpers for Boom Phase 2."""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Iterable, Optional

SCHEMA_VERSION = 1

SCHEMA_SQL = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tracks (
  id INTEGER PRIMARY KEY,
  etag INTEGER NOT NULL DEFAULT 1,
  body TEXT NOT NULL,
  updated_at REAL NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS playlists (
  id TEXT PRIMARY KEY,
  etag INTEGER NOT NULL DEFAULT 1,
  body TEXT NOT NULL,
  updated_at REAL NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schema INTEGER NOT NULL,
  type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  ts REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_id ON events(id);
CREATE INDEX IF NOT EXISTS idx_tracks_deleted ON tracks(deleted);
CREATE INDEX IF NOT EXISTS idx_playlists_deleted ON playlists(deleted);
"""


class BoomDB:
    """Thread-safe thin wrapper around a single SQLite connection."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(str(self.path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.executescript(SCHEMA_SQL)
            self._conn.execute(
                "INSERT OR IGNORE INTO meta(key, value) VALUES('schema', ?)",
                (str(SCHEMA_VERSION),),
            )
            self._conn.commit()

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def _now(self) -> float:
        return time.time()

    def append_event(
        self,
        event_type: str,
        entity_id: str,
        payload: dict[str, Any],
        *,
        schema: int = SCHEMA_VERSION,
        ts: Optional[float] = None,
    ) -> dict[str, Any]:
        with self._lock:
            cur = self._conn.execute(
                "INSERT INTO events(schema, type, entity_id, payload, ts) VALUES(?,?,?,?,?)",
                (schema, event_type, str(entity_id), json.dumps(payload), ts or self._now()),
            )
            self._conn.commit()
            eid = int(cur.lastrowid)
            return {
                "id": eid,
                "schema": schema,
                "type": event_type,
                "entity_id": str(entity_id),
                "payload": payload,
                "ts": ts or self._now(),
            }

    def events_after(self, after_id: int, *, limit: int = 10_000) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT id, schema, type, entity_id, payload, ts FROM events "
                "WHERE id > ? ORDER BY id ASC LIMIT ?",
                (after_id, limit),
            ).fetchall()
        out: list[dict[str, Any]] = []
        for r in rows:
            out.append(
                {
                    "id": int(r["id"]),
                    "schema": int(r["schema"]),
                    "type": r["type"],
                    "entity_id": r["entity_id"],
                    "payload": json.loads(r["payload"]),
                    "ts": float(r["ts"]),
                }
            )
        return out

    def latest_event_id(self) -> int:
        with self._lock:
            row = self._conn.execute("SELECT COALESCE(MAX(id), 0) AS m FROM events").fetchone()
        return int(row["m"])

    def upsert_track(self, track: dict[str, Any], *, emit: bool = True) -> dict[str, Any]:
        tid = int(track["id"])
        now = self._now()
        with self._lock:
            row = self._conn.execute(
                "SELECT etag, body, deleted FROM tracks WHERE id=?", (tid,)
            ).fetchone()
            if row is None:
                etag = 1
                self._conn.execute(
                    "INSERT INTO tracks(id, etag, body, updated_at, deleted) VALUES(?,?,?,?,0)",
                    (tid, etag, json.dumps(track), now),
                )
            else:
                etag = int(row["etag"]) + 1
                prev = json.loads(row["body"]) if row["body"] else {}
                merged = {**prev, **track, "id": tid}
                track = merged
                self._conn.execute(
                    "UPDATE tracks SET etag=?, body=?, updated_at=?, deleted=0 WHERE id=?",
                    (etag, json.dumps(track), now, tid),
                )
            event = None
            if emit:
                event = self.append_event(
                    "track-updated",
                    str(tid),
                    {"id": tid, "fields": track, "etag": etag, "ts": now},
                    ts=now,
                )
            else:
                self._conn.commit()
        return {"track": track, "etag": etag, "event": event}

    def patch_track(
        self,
        track_id: int,
        fields: dict[str, Any],
        *,
        if_etag: Optional[int] = None,
        increment: Optional[dict[str, int]] = None,
    ) -> dict[str, Any]:
        """Field-level LWW patch. Returns 409-shaped dict on etag mismatch."""
        now = self._now()
        with self._lock:
            row = self._conn.execute(
                "SELECT etag, body, deleted FROM tracks WHERE id=?", (track_id,)
            ).fetchone()
            if row is None or int(row["deleted"]):
                return {"ok": False, "error": "not-found", "status": 404}
            etag = int(row["etag"])
            if if_etag is not None and if_etag != etag:
                body = json.loads(row["body"])
                return {
                    "ok": False,
                    "error": "conflict",
                    "status": 409,
                    "etag": etag,
                    "track": body,
                }
            body = json.loads(row["body"])
            for k, v in fields.items():
                if k == "id":
                    continue
                body[k] = v
            if increment:
                for k, delta in increment.items():
                    cur = body.get(k, 0) or 0
                    try:
                        body[k] = int(cur) + int(delta)
                    except (TypeError, ValueError):
                        body[k] = int(delta)
            new_etag = etag + 1
            self._conn.execute(
                "UPDATE tracks SET etag=?, body=?, updated_at=?, deleted=0 WHERE id=?",
                (new_etag, json.dumps(body), now, track_id),
            )
            event = self.append_event(
                "track-updated",
                str(track_id),
                {"id": track_id, "fields": fields if not increment else body, "etag": new_etag, "ts": now},
                ts=now,
            )
        return {"ok": True, "track": body, "etag": new_etag, "event": event}

    def soft_delete_track(self, track_id: int) -> dict[str, Any]:
        now = self._now()
        with self._lock:
            row = self._conn.execute(
                "SELECT etag, deleted FROM tracks WHERE id=?", (track_id,)
            ).fetchone()
            if row is None:
                return {"ok": False, "error": "not-found", "status": 404}
            if int(row["deleted"]):
                return {"ok": True, "already": True}
            new_etag = int(row["etag"]) + 1
            self._conn.execute(
                "UPDATE tracks SET etag=?, deleted=1, updated_at=? WHERE id=?",
                (new_etag, now, track_id),
            )
            event = self.append_event(
                "track-deleted",
                str(track_id),
                {"id": track_id, "ts": now},
                ts=now,
            )
        return {"ok": True, "etag": new_etag, "event": event}

    def upsert_playlist(self, playlist: dict[str, Any], *, emit: bool = True) -> dict[str, Any]:
        pid = str(playlist["id"])
        now = self._now()
        with self._lock:
            row = self._conn.execute(
                "SELECT etag, body FROM playlists WHERE id=?", (pid,)
            ).fetchone()
            if row is None:
                etag = 1
                self._conn.execute(
                    "INSERT INTO playlists(id, etag, body, updated_at, deleted) VALUES(?,?,?,?,0)",
                    (pid, etag, json.dumps(playlist), now),
                )
            else:
                etag = int(row["etag"]) + 1
                prev = json.loads(row["body"]) if row["body"] else {}
                playlist = {**prev, **playlist, "id": pid}
                self._conn.execute(
                    "UPDATE playlists SET etag=?, body=?, updated_at=?, deleted=0 WHERE id=?",
                    (etag, json.dumps(playlist), now, pid),
                )
            event = None
            if emit:
                event = self.append_event(
                    "playlist-updated",
                    pid,
                    {"id": pid, "playlist": playlist, "etag": etag, "ts": now},
                    ts=now,
                )
            else:
                self._conn.commit()
        return {"playlist": playlist, "etag": etag, "event": event}

    def soft_delete_playlist(self, playlist_id: str) -> dict[str, Any]:
        now = self._now()
        pid = str(playlist_id)
        with self._lock:
            row = self._conn.execute(
                "SELECT etag, deleted FROM playlists WHERE id=?", (pid,)
            ).fetchone()
            if row is None:
                return {"ok": False, "error": "not-found", "status": 404}
            if int(row["deleted"]):
                return {"ok": True, "already": True}
            new_etag = int(row["etag"]) + 1
            self._conn.execute(
                "UPDATE playlists SET etag=?, deleted=1, updated_at=? WHERE id=?",
                (new_etag, now, pid),
            )
            event = self.append_event(
                "playlist-deleted",
                pid,
                {"id": pid, "ts": now},
                ts=now,
            )
        return {"ok": True, "etag": new_etag, "event": event}

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            track_rows = self._conn.execute(
                "SELECT id, etag, body FROM tracks WHERE deleted=0 ORDER BY id"
            ).fetchall()
            playlist_rows = self._conn.execute(
                "SELECT id, etag, body FROM playlists WHERE deleted=0 ORDER BY id"
            ).fetchall()
            latest = self.latest_event_id()
        tracks = []
        etags: dict[str, int] = {}
        for r in track_rows:
            body = json.loads(r["body"])
            body["_etag"] = int(r["etag"])
            tracks.append(body)
            etags[str(r["id"])] = int(r["etag"])
        playlists = []
        for r in playlist_rows:
            body = json.loads(r["body"])
            body["_etag"] = int(r["etag"])
            playlists.append(body)
        return {
            "schema": SCHEMA_VERSION,
            "latestEventId": latest,
            "tracks": tracks,
            "playlists": playlists,
            "etags": etags,
        }

    def import_library_json(self, data: dict[str, Any] | list[Any]) -> dict[str, Any]:
        """One-shot migration from a JakeTunes library.json payload."""
        if isinstance(data, list):
            tracks = data
            playlists: list[Any] = []
        else:
            tracks = data.get("tracks") or []
            playlists = data.get("playlists") or []
        imported_tracks = 0
        imported_playlists = 0
        for t in tracks:
            if not isinstance(t, dict) or t.get("id") is None:
                continue
            self.upsert_track(t, emit=False)
            imported_tracks += 1
        for p in playlists:
            if not isinstance(p, dict) or p.get("id") is None:
                continue
            self.upsert_playlist(p, emit=False)
            imported_playlists += 1
        # Baseline snapshot marker so clients can resume from here.
        event = self.append_event(
            "snapshot",
            "library",
            {
                "tracks": imported_tracks,
                "playlists": imported_playlists,
                "reason": "one-shot-migration",
            },
        )
        return {
            "ok": True,
            "tracks": imported_tracks,
            "playlists": imported_playlists,
            "latestEventId": event["id"],
        }

    def get_track(self, track_id: int) -> Optional[dict[str, Any]]:
        with self._lock:
            row = self._conn.execute(
                "SELECT etag, body, deleted FROM tracks WHERE id=?", (track_id,)
            ).fetchone()
        if row is None or int(row["deleted"]):
            return None
        body = json.loads(row["body"])
        body["_etag"] = int(row["etag"])
        return body
