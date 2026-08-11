"""FastAPI application for JakeTunes Boom Phase 2."""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from . import __version__
from .db import BoomDB
from .events import EventHub

DEFAULT_DB = Path(
    os.environ.get(
        "BOOM_DB_PATH",
        str(Path.home() / "JakeTunesState" / "boom" / "library.sqlite"),
    )
)
MUSIC_ROOT = Path(
    os.environ.get("BOOM_MUSIC_ROOT", str(Path.home() / "Music" / "JakeTunesLibrary"))
).expanduser()

hub = EventHub()
_db: BoomDB | None = None


def get_db() -> BoomDB:
    """Lazy DB handle — reopens when DEFAULT_DB is re-pointed (tests)."""
    global _db
    if _db is None or Path(_db.path) != Path(DEFAULT_DB):
        if _db is not None:
            _db.close()
        _db = BoomDB(DEFAULT_DB)
    return _db


def _maybe_import_library() -> None:
    db = get_db()
    import_path = os.environ.get("BOOM_IMPORT_LIBRARY")
    if not import_path or db.latest_event_id() != 0:
        return
    p = Path(import_path).expanduser()
    if not p.is_file():
        return
    import json

    result = db.import_library_json(json.loads(p.read_text(encoding="utf-8")))
    print(f"[boom] imported library.json → {result}")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    get_db()
    _maybe_import_library()
    yield


app = FastAPI(
    title="JakeTunes Boom API",
    version=__version__,
    lifespan=lifespan,
)


class TrackPatch(BaseModel):
    fields: dict[str, Any] = Field(default_factory=dict)
    increment: Optional[dict[str, int]] = None
    etag: Optional[int] = None


class TrackUpsert(BaseModel):
    track: dict[str, Any]


class PlaylistUpsert(BaseModel):
    playlist: dict[str, Any]


class ImportBody(BaseModel):
    library: dict[str, Any] | list[Any]


@app.get("/healthz")
@app.get("/api/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "service": "boom",
        "version": __version__,
        "latestEventId": get_db().latest_event_id(),
        "db": str(DEFAULT_DB),
    }


@app.get("/api/library")
def get_library() -> dict[str, Any]:
    return get_db().snapshot()


@app.get("/api/tracks/{track_id}")
def get_track(track_id: int) -> dict[str, Any]:
    track = get_db().get_track(track_id)
    if track is None:
        raise HTTPException(status_code=404, detail="track not found")
    return track


@app.patch("/api/tracks/{track_id}")
async def patch_track(track_id: int, body: TrackPatch) -> JSONResponse:
    result = get_db().patch_track(
        track_id,
        body.fields,
        if_etag=body.etag,
        increment=body.increment,
    )
    if not result.get("ok"):
        status = int(result.get("status") or 400)
        return JSONResponse(result, status_code=status)
    if result.get("event"):
        await hub.publish(result["event"])
    return JSONResponse(
        {"ok": True, "track": result["track"], "etag": result["etag"]},
        status_code=200,
    )


@app.post("/api/tracks")
async def upsert_track(body: TrackUpsert) -> dict[str, Any]:
    if body.track.get("id") is None:
        raise HTTPException(status_code=400, detail="track.id required")
    result = get_db().upsert_track(body.track, emit=True)
    if result.get("event"):
        await hub.publish(result["event"])
    return {"ok": True, "track": result["track"], "etag": result["etag"]}


@app.delete("/api/tracks/{track_id}")
async def delete_track(track_id: int) -> dict[str, Any]:
    result = get_db().soft_delete_track(track_id)
    if not result.get("ok"):
        raise HTTPException(status_code=int(result.get("status") or 404), detail=result.get("error"))
    if result.get("event"):
        await hub.publish(result["event"])
    return {"ok": True}


@app.post("/api/playlists")
async def upsert_playlist(body: PlaylistUpsert) -> dict[str, Any]:
    if body.playlist.get("id") is None:
        raise HTTPException(status_code=400, detail="playlist.id required")
    result = get_db().upsert_playlist(body.playlist, emit=True)
    if result.get("event"):
        await hub.publish(result["event"])
    return {"ok": True, "playlist": result["playlist"], "etag": result["etag"]}


@app.delete("/api/playlists/{playlist_id}")
async def delete_playlist(playlist_id: str) -> dict[str, Any]:
    result = get_db().soft_delete_playlist(playlist_id)
    if not result.get("ok"):
        raise HTTPException(status_code=int(result.get("status") or 404), detail=result.get("error"))
    if result.get("event"):
        await hub.publish(result["event"])
    return {"ok": True}


@app.post("/api/import")
async def import_library(body: ImportBody) -> dict[str, Any]:
    result = get_db().import_library_json(body.library)
    # Notify subscribers that a full snapshot is recommended.
    snap_event = {
        "id": result["latestEventId"],
        "schema": 1,
        "type": "snapshot",
        "entity_id": "library",
        "payload": result,
        "ts": result.get("ts"),
    }
    await hub.publish(snap_event)
    return result


@app.get("/api/events")
async def events(
    request: Request,
    last_event_id: Optional[int] = Query(None, alias="lastEventId"),
    last_event_id_header: Optional[str] = Header(None, alias="Last-Event-ID"),
):
    after = 0
    if last_event_id is not None:
        after = last_event_id
    elif last_event_id_header:
        try:
            after = int(last_event_id_header)
        except ValueError:
            after = 0

    latest = get_db().latest_event_id()
    gap = latest - after
    # If client is too far behind, tell them to cold-fetch.
    if after > 0 and gap > 10_000:
        raise HTTPException(
            status_code=409,
            detail={"error": "snapshot-recommended", "latestEventId": latest, "after": after},
        )

    replay = get_db().events_after(after)

    async def gen():
        async for chunk in hub.sse_stream(replay=replay):
            if await request.is_disconnected():
                break
            yield chunk

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/api/audio/{track_id}")
def audio(track_id: int, request: Request):
    """HTTP Range audio from MUSIC_ROOT using the track's colon path."""
    track = get_db().get_track(track_id)
    if track is None:
        raise HTTPException(status_code=404, detail="track not found")
    colon = str(track.get("path") or "")
    if not colon:
        raise HTTPException(status_code=404, detail="track has no path")
    rel = colon.replace(":", os.sep).lstrip(os.sep)
    # Colon paths are like :iPod_Control:Music:F00:x.mp3 → iPod_Control/Music/...
    file_path = (MUSIC_ROOT / rel).resolve()
    try:
        file_path.relative_to(MUSIC_ROOT.resolve())
    except ValueError:
        raise HTTPException(status_code=400, detail="path escape blocked")
    if not file_path.is_file():
        raise HTTPException(status_code=404, detail="audio file missing")

    file_size = file_path.stat().st_size
    range_header = request.headers.get("range") or request.headers.get("Range")
    content_type = _guess_audio_type(file_path)

    if range_header and range_header.startswith("bytes="):
        start_s, _, end_s = range_header.replace("bytes=", "").partition("-")
        start = int(start_s) if start_s else 0
        end = int(end_s) if end_s else file_size - 1
        end = min(end, file_size - 1)
        if start > end or start >= file_size:
            raise HTTPException(status_code=416, detail="invalid range")
        length = end - start + 1

        def ranged():
            with open(file_path, "rb") as f:
                f.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = f.read(min(64 * 1024, remaining))
                    if not chunk:
                        break
                    remaining -= len(chunk)
                    yield chunk

        return StreamingResponse(
            ranged(),
            status_code=206,
            media_type=content_type,
            headers={
                "Content-Range": f"bytes {start}-{end}/{file_size}",
                "Accept-Ranges": "bytes",
                "Content-Length": str(length),
            },
        )

    def full():
        with open(file_path, "rb") as f:
            while True:
                chunk = f.read(64 * 1024)
                if not chunk:
                    break
                yield chunk

    return StreamingResponse(
        full(),
        media_type=content_type,
        headers={
            "Accept-Ranges": "bytes",
            "Content-Length": str(file_size),
        },
    )


def _guess_audio_type(path: Path) -> str:
    ext = path.suffix.lower()
    return {
        ".mp3": "audio/mpeg",
        ".m4a": "audio/mp4",
        ".aac": "audio/aac",
        ".wav": "audio/wav",
        ".flac": "audio/flac",
        ".aiff": "audio/aiff",
        ".aif": "audio/aiff",
    }.get(ext, "application/octet-stream")


def create_app(db_path: Path | None = None) -> FastAPI:
    """Test helper — rebuild app lifespan against a temp DB."""
    global DEFAULT_DB
    if db_path is not None:
        DEFAULT_DB = Path(db_path)
    return app
