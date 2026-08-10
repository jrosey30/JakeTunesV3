#!/usr/bin/env python3
"""
music_engine — NAS-side data layer, FFmpeg mixtape renderer, metadata
harmonizer, and inbox file watcher for JakeTunes.

Complements scripts/nightly_loop.py:
  - SQLite indexes virtual tracks inside multi-hour live masters
  - Stores contrastive listening logs + nightly precision scores
  - Harmonizes Deezer → MusicBrainz → Discogs enrichment
  - Watches an inbox directory, tags new audio, and indexes it

Usage:
  python3 scripts/music_engine.py --watch              # inbox watcher
  python3 scripts/music_engine.py --render mixtape.json out.flac
  python3 scripts/music_engine.py --enrich "Artist" "Title" ["Album"]
  python3 scripts/music_engine.py --context /path/to/live.flac 3721.5

Env:
  JT_STATE_DIR / JT_UD     state dir (default macOS Application Support)
  DISCOGS_API_TOKEN        Discogs personal token
  MUSIC_ENGINE_INBOX       inbox to watch (default $STATE_DIR/inbox)
  MUSIC_ENGINE_DB          sqlite path (default $STATE_DIR/music_server.db)
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
)
log = logging.getLogger("music_engine")

STATE_DIR = Path(
    os.environ.get("JT_STATE_DIR")
    or os.environ.get("JT_UD")
    or os.path.expanduser("~/Library/Application Support/JakeTunes")
)
DEFAULT_DB = Path(os.environ.get("MUSIC_ENGINE_DB") or (STATE_DIR / "music_server.db"))
DEFAULT_INBOX = Path(os.environ.get("MUSIC_ENGINE_INBOX") or (STATE_DIR / "inbox"))
USER_AGENT = os.environ.get(
    "MUSICBRAINZ_USER_AGENT",
    "JakeTunes/music_engine (https://github.com/jrosey30/JakeTunesV3)",
)
DISCOGS_TOKEN = os.environ.get("DISCOGS_API_TOKEN", "").strip()
MB_MIN_INTERVAL = 1.1
DISCOGS_MIN_INTERVAL = 1.0
HTTP_TIMEOUT = 12
AUDIO_EXTS = {".mp3", ".m4a", ".flac", ".wav", ".aiff", ".aif", ".ogg", ".aac"}


# ── HTTP helpers (stdlib; rate-limited for MB/Discogs) ────────────────────────

class RateLimiter:
    def __init__(self, min_interval: float) -> None:
        self.min_interval = min_interval
        self._last = 0.0

    def wait(self) -> None:
        gap = self.min_interval - (time.monotonic() - self._last)
        if gap > 0:
            time.sleep(gap)
        self._last = time.monotonic()


_mb_limiter = RateLimiter(MB_MIN_INTERVAL)
_discogs_limiter = RateLimiter(DISCOGS_MIN_INTERVAL)


def http_get_json(
    url: str,
    *,
    headers: Optional[dict[str, str]] = None,
    limiter: Optional[RateLimiter] = None,
    retries: int = 2,
) -> Optional[dict[str, Any]]:
    hdrs = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    if headers:
        hdrs.update(headers)
    for attempt in range(retries + 1):
        if limiter:
            limiter.wait()
        req = urllib.request.Request(url, headers=hdrs, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                raw = resp.read()
                return json.loads(raw.decode("utf-8")) if raw else None
        except urllib.error.HTTPError as e:
            if e.code in (429, 503) and attempt < retries:
                time.sleep(2.0 * (attempt + 1))
                continue
            log.error("HTTP %s for %s", e.code, url[:120])
            return None
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            if attempt < retries:
                time.sleep(1.0 * (attempt + 1))
                continue
            log.error("request failed: %s", e)
            return None
    return None


# =====================================================================
# DATA LAYER & MEMORY MANAGEMENT (SQLite)
# =====================================================================

class MusicEngineDatabase:
    """Virtual track indexing for live concerts + LLM memory / feedback layers."""

    def __init__(self, db_path: Path | str = DEFAULT_DB) -> None:
        self.db_path = str(db_path)
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self) -> None:
        with self._connect() as conn:
            # Continuous multi-hour live files → virtual track map
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS virtual_tracks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    master_file_path TEXT NOT NULL,
                    track_title TEXT NOT NULL,
                    artist_name TEXT NOT NULL,
                    start_time_seconds REAL NOT NULL,
                    end_time_seconds REAL NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_virtual_tracks_master_time
                ON virtual_tracks (master_file_path, start_time_seconds, end_time_seconds)
                """
            )
            # Precision feedback loop
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS recommendation_feedback (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    date TEXT UNIQUE,
                    total_recommended INTEGER,
                    successful_discoveries INTEGER,
                    precision_score REAL
                )
                """
            )
            # Contrastive listening store
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS listening_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp TEXT,
                    track_id TEXT,
                    isrc TEXT,
                    artist TEXT,
                    title TEXT,
                    play_duration_seconds REAL,
                    total_duration_seconds REAL,
                    skipped_early INTEGER DEFAULT 0
                )
                """
            )
            # Enriched metadata cache (ISRC / MB / Discogs)
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS track_enrichment (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    artist TEXT NOT NULL,
                    title TEXT NOT NULL,
                    album TEXT,
                    isrc TEXT,
                    deezer_id TEXT,
                    mbid TEXT,
                    bpm REAL,
                    gain REAL,
                    producers_engineers_json TEXT,
                    discogs_json TEXT,
                    updated_at TEXT,
                    UNIQUE(artist, title, album)
                )
                """
            )
            conn.commit()

    def add_virtual_track(
        self,
        master_file_path: str,
        track_title: str,
        artist_name: str,
        start_time_seconds: float,
        end_time_seconds: float,
    ) -> int:
        with self._connect() as conn:
            cur = conn.execute(
                """
                INSERT INTO virtual_tracks
                    (master_file_path, track_title, artist_name, start_time_seconds, end_time_seconds)
                VALUES (?, ?, ?, ?, ?)
                """,
                (master_file_path, track_title, artist_name, start_time_seconds, end_time_seconds),
            )
            conn.commit()
            return int(cur.lastrowid)

    def log_playback(
        self,
        track_id: str,
        isrc: str,
        artist: str,
        title: str,
        play_time: float,
        total_time: float,
    ) -> None:
        """Record playback; flag sharp negatives (skip <15s on tracks >30s)."""
        skipped = 1 if (play_time < 15 and total_time > 30) else 0
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO listening_logs
                    (timestamp, track_id, isrc, artist, title,
                     play_duration_seconds, total_duration_seconds, skipped_early)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    datetime.now(timezone.utc).isoformat(),
                    track_id,
                    isrc,
                    artist,
                    title,
                    play_time,
                    total_time,
                    skipped,
                ),
            )
            conn.commit()

    def get_contrastive_signals(self, since_iso: str) -> dict[str, list[dict[str, Any]]]:
        """Positive = completed/long plays; negative = early skips."""
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM listening_logs
                WHERE timestamp >= ?
                ORDER BY timestamp ASC
                """,
                (since_iso,),
            ).fetchall()
        positives: list[dict[str, Any]] = []
        negatives: list[dict[str, Any]] = []
        for r in rows:
            item = dict(r)
            if item.get("skipped_early"):
                negatives.append(item)
            elif (item.get("play_duration_seconds") or 0) >= 0.8 * max(
                item.get("total_duration_seconds") or 1, 1
            ):
                positives.append(item)
        return {"positive_signals": positives, "negative_signals": negatives}

    def record_precision(
        self,
        date: str,
        total_recommended: int,
        successful_discoveries: int,
        precision_score: float,
    ) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO recommendation_feedback
                    (date, total_recommended, successful_discoveries, precision_score)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(date) DO UPDATE SET
                    total_recommended=excluded.total_recommended,
                    successful_discoveries=excluded.successful_discoveries,
                    precision_score=excluded.precision_score
                """,
                (date, total_recommended, successful_discoveries, precision_score),
            )
            conn.commit()

    def get_precision(self, date: str) -> Optional[dict[str, Any]]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM recommendation_feedback WHERE date = ?",
                (date,),
            ).fetchone()
        return dict(row) if row else None

    def upsert_enrichment(self, artist: str, title: str, album: str, payload: dict[str, Any]) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO track_enrichment
                    (artist, title, album, isrc, deezer_id, mbid, bpm, gain,
                     producers_engineers_json, discogs_json, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(artist, title, album) DO UPDATE SET
                    isrc=excluded.isrc,
                    deezer_id=excluded.deezer_id,
                    mbid=excluded.mbid,
                    bpm=excluded.bpm,
                    gain=excluded.gain,
                    producers_engineers_json=excluded.producers_engineers_json,
                    discogs_json=excluded.discogs_json,
                    updated_at=excluded.updated_at
                """,
                (
                    artist,
                    title,
                    album or "",
                    payload.get("isrc"),
                    str(payload.get("deezer_id") or "") or None,
                    payload.get("mbid"),
                    payload.get("bpm"),
                    payload.get("gain"),
                    json.dumps(payload.get("producers_engineers") or []),
                    json.dumps(payload.get("discogs") or {}),
                    datetime.now(timezone.utc).isoformat(),
                ),
            )
            conn.commit()

    def get_current_track_context(
        self, master_file_path: str, current_playback_position: float
    ) -> dict[str, Any]:
        """Index into a multi-hour live master by absolute playback position."""
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT track_title, artist_name, start_time_seconds, end_time_seconds
                FROM virtual_tracks
                WHERE master_file_path = ?
                  AND ? >= start_time_seconds
                  AND ? < end_time_seconds
                ORDER BY start_time_seconds DESC
                LIMIT 1
                """,
                (master_file_path, current_playback_position, current_playback_position),
            ).fetchone()
        if not row:
            return {"error": "No track mapped at this timestamp."}
        return {
            "track_title": row["track_title"],
            "artist_name": row["artist_name"],
            "relative_position": current_playback_position - row["start_time_seconds"],
            "duration": row["end_time_seconds"] - row["start_time_seconds"],
            "start_time_seconds": row["start_time_seconds"],
            "end_time_seconds": row["end_time_seconds"],
        }


# =====================================================================
# AUDIO METRICS PROCESSING & TRANSITION MIXER (FFmpeg)
# =====================================================================

class MixtapeRenderer:
    @staticmethod
    def render_mixtape(track_list: list[dict[str, Any]], output_path: str) -> bool:
        """
        Stitch songs into one mixtape with key/tempo-aware crossfades.
        Each track dict needs: path, bpm, key, duration (seconds).
        """
        if not track_list:
            return False
        for t in track_list:
            if not Path(t["path"]).is_file():
                log.error("missing input: %s", t["path"])
                return False

        input_args: list[str] = []
        for track in track_list:
            input_args.extend(["-i", track["path"]])

        if len(track_list) == 2:
            t1, t2 = track_list[0], track_list[1]
            bpm1 = float(t1.get("bpm") or 0)
            bpm2 = float(t2.get("bpm") or 0)
            key_match = (t1.get("key") or "") == (t2.get("key") or "") and bool(t1.get("key"))
            tempo_match = bpm1 > 0 and bpm2 > 0 and abs(bpm1 - bpm2) < 5
            if key_match or tempo_match:
                # Compatible: long triangular overlap
                filter_complex = "[0:a][1:a]acrossfade=d=10:c1=tri:c2=tri[aout]"
            else:
                # Signature mismatch: short logarithmic bridge
                filter_complex = "[0:a][1:a]acrossfade=d=2:c1=log:c2=log[aout]"
            cmd = (
                ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"]
                + input_args
                + ["-filter_complex", filter_complex, "-map", "[aout]", "-c:a", "flac", output_path]
            )
        else:
            # Pairwise acrossfade chain when possible; else concat.
            if len(track_list) > 2:
                # Build a sequential acrossfade (2s) chain: a0+a1 -> x1, x1+a2 -> x2, ...
                filters = []
                prev = "[0:a]"
                for i in range(1, len(track_list)):
                    out_label = "[aout]" if i == len(track_list) - 1 else f"[x{i}]"
                    cur = f"[{i}:a]"
                    # Compatible pair → 6s, else 2s
                    a, b = track_list[i - 1], track_list[i]
                    bpm_a, bpm_b = float(a.get("bpm") or 0), float(b.get("bpm") or 0)
                    compatible = (
                        ((a.get("key") or "") == (b.get("key") or "") and bool(a.get("key")))
                        or (bpm_a > 0 and bpm_b > 0 and abs(bpm_a - bpm_b) < 5)
                    )
                    dur = 6 if compatible else 2
                    filters.append(f"{prev}{cur}acrossfade=d={dur}:c1=tri:c2=tri{out_label}")
                    prev = out_label
                filter_complex = ";".join(filters)
            else:
                concat_inputs = "".join(f"[{i}:a]" for i in range(len(track_list)))
                filter_complex = f"{concat_inputs}concat=n={len(track_list)}:v=0:a=1[aout]"
            cmd = (
                ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"]
                + input_args
                + ["-filter_complex", filter_complex, "-map", "[aout]", "-c:a", "flac", output_path]
            )

        try:
            log.info("Rendering mixtape → %s", output_path)
            subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            return True
        except FileNotFoundError:
            log.error("ffmpeg not found on PATH")
            return False
        except subprocess.CalledProcessError as e:
            err = (e.stderr or b"").decode("utf-8", errors="replace")
            log.error("FFmpeg pipeline failed: %s", err[-800:])
            return False


# =====================================================================
# AUTOMATED DEEP METADATA ENRICHMENT HARMONIZER
# =====================================================================

class MetadataHarmonizer:
    """Deezer (ISRC) → MusicBrainz (relations) → Discogs (pressing)."""

    def __init__(self, discogs_token: Optional[str] = None) -> None:
        self.discogs_token = (discogs_token if discogs_token is not None else DISCOGS_TOKEN) or ""
        self.deezer_base = "https://api.deezer.com"
        self.mb_base = "https://musicbrainz.org/ws/2"

    def fetch_deezer_metadata(self, artist: str, title: str) -> dict[str, Any]:
        """Primary track vars + definitive ISRC."""
        try:
            q = f'artist:"{artist}" track:"{title}"'
            url = f"{self.deezer_base}/search?" + urllib.parse.urlencode({"q": q, "limit": 5})
            res = http_get_json(url) or {}
            items = res.get("data") or []
            if not items:
                return {}
            want_a, want_t = artist.strip().lower(), title.strip().lower()
            track_data = None
            for it in items:
                a = ((it.get("artist") or {}).get("name") or "").strip().lower()
                t = (it.get("title") or "").strip().lower()
                if a == want_a and t == want_t:
                    track_data = it
                    break
            if track_data is None:
                track_data = items[0]
            track_id = track_data.get("id")
            if not track_id:
                return {}
            extended = http_get_json(f"{self.deezer_base}/track/{track_id}") or {}
            return {
                "isrc": extended.get("isrc"),
                "bpm": extended.get("bpm"),
                "gain": extended.get("gain"),
                "deezer_id": track_id,
                "album": ((extended.get("album") or {}).get("title") if isinstance(extended.get("album"), dict) else None),
            }
        except Exception as e:  # noqa: BLE001
            log.error("Deezer extraction fault: %s", e)
            return {}

    def fetch_musicbrainz_relations(self, isrc: str) -> dict[str, Any]:
        """ISRC → producers / engineers / mixers + recording MBID."""
        if not isrc:
            return {}
        try:
            url = (
                f"{self.mb_base}/isrc/{urllib.parse.quote(isrc)}"
                "?inc=artists+releases+recording-rels+work-rels&fmt=json"
            )
            res = http_get_json(url, limiter=_mb_limiter) or {}
            recordings = res.get("recordings") or []
            if not recordings:
                return {}
            rec = recordings[0]
            credits: list[dict[str, str]] = []
            for rel in rec.get("relations") or []:
                rtype = (rel.get("type") or "").lower()
                if rtype in ("engineer", "producer", "mixer", "remixer", "mix", "recording"):
                    artist = rel.get("artist") or {}
                    name = artist.get("name") if isinstance(artist, dict) else None
                    if name:
                        credits.append({"role": rel.get("type") or rtype, "name": name})
            artist_mbid = ""
            ac = rec.get("artist-credit") or []
            if ac and isinstance(ac[0], dict):
                artist_mbid = ((ac[0].get("artist") or {}).get("id") or "")
            release_mbid = ""
            releases = rec.get("releases") or []
            if releases:
                release_mbid = releases[0].get("id") or ""
            # Side projects via artist member-of-band relations
            side_projects: list[str] = []
            if artist_mbid:
                arel = http_get_json(
                    f"{self.mb_base}/artist/{artist_mbid}?inc=artist-rels&fmt=json",
                    limiter=_mb_limiter,
                ) or {}
                for rel in arel.get("relations") or []:
                    if "member of band" in (rel.get("type") or "").lower():
                        band = (rel.get("artist") or {}).get("name") if isinstance(rel.get("artist"), dict) else None
                        if band:
                            side_projects.append(band)
            return {
                "producers_engineers": credits,
                "mbid": rec.get("id"),
                "artist_mbid": artist_mbid,
                "release_mbid": release_mbid,
                "side_projects": side_projects,
            }
        except Exception as e:  # noqa: BLE001
            log.error("MusicBrainz mapping fault: %s", e)
            return {}

    def fetch_discogs_pressing_context(self, artist: str, album_title: str) -> dict[str, Any]:
        """Physical pressing: label, country, catalog number, styles."""
        if not self.discogs_token or not album_title:
            return {}
        try:
            params = {
                "artist": artist,
                "release_title": album_title,
                "type": "release",
                "per_page": "5",
            }
            url = "https://api.discogs.com/database/search?" + urllib.parse.urlencode(params)
            headers = {"Authorization": f"Discogs token={self.discogs_token}"}
            res = http_get_json(url, headers=headers, limiter=_discogs_limiter) or {}
            results = res.get("results") or []
            if not results:
                return {}
            release = results[0]
            labels = release.get("label") or []
            return {
                "record_label": labels[0] if isinstance(labels, list) and labels else "Independent Records",
                "country": release.get("country") or "Unknown",
                "catalog_number": release.get("catno") or "Unknown",
                "style_tags": release.get("style") or [],
                "year": release.get("year"),
            }
        except Exception as e:  # noqa: BLE001
            log.error("Discogs database query fault: %s", e)
            return {}

    def harmonize(self, artist: str, title: str, album: str = "") -> dict[str, Any]:
        """Full enrichment chain for one track."""
        out: dict[str, Any] = {"artist": artist, "title": title, "album": album}
        deezer = self.fetch_deezer_metadata(artist, title)
        out.update({k: v for k, v in deezer.items() if v is not None})
        if not out.get("album") and deezer.get("album"):
            out["album"] = deezer["album"]
        mb = self.fetch_musicbrainz_relations(out.get("isrc") or "")
        out.update(mb)
        discogs = self.fetch_discogs_pressing_context(artist, out.get("album") or album)
        if discogs:
            out["discogs"] = discogs
        return out


# =====================================================================
# FILE INGESTION PIPELINE WATCHER
# =====================================================================

def _read_tags(path: Path) -> dict[str, str]:
    """Best-effort ID3/Vorbis tags via mutagen (optional)."""
    try:
        from mutagen import File as MutagenFile  # type: ignore
        from mutagen.easyid3 import EasyID3  # type: ignore
    except ImportError:
        return {"artist": "", "title": path.stem, "album": ""}

    artist = title = album = ""
    try:
        if path.suffix.lower() == ".mp3":
            try:
                tags = EasyID3(str(path))
            except Exception:  # noqa: BLE001
                tags = {}
            artist = (tags.get("artist") or [""])[0]
            title = (tags.get("title") or [""])[0]
            album = (tags.get("album") or [""])[0]
        else:
            audio = MutagenFile(str(path), easy=True)
            if audio is not None and audio.tags is not None:
                artist = (audio.tags.get("artist") or [""])[0]
                title = (audio.tags.get("title") or [""])[0]
                album = (audio.tags.get("album") or [""])[0]
    except Exception as e:  # noqa: BLE001
        log.warning("tag read failed for %s: %s", path, e)
    return {
        "artist": artist or "Unknown Artist",
        "title": title or path.stem,
        "album": album or "",
    }


def _write_enrichment_comment(path: Path, payload: dict[str, Any]) -> None:
    """Embed a compact enrichment COMM/comment frame when mutagen is available."""
    try:
        from mutagen.id3 import ID3, COMM, error as ID3Error  # type: ignore
        from mutagen import File as MutagenFile  # type: ignore
    except ImportError:
        return
    blob = json.dumps(
        {
            "isrc": payload.get("isrc"),
            "mbid": payload.get("mbid"),
            "discogs": payload.get("discogs"),
            "producers_engineers": payload.get("producers_engineers"),
        },
        ensure_ascii=False,
    )[:900]
    try:
        if path.suffix.lower() == ".mp3":
            try:
                tags = ID3(str(path))
            except ID3Error:
                tags = ID3()
            tags.delall("COMM")
            tags.add(COMM(encoding=3, lang="eng", desc="jaketunes-enrichment", text=blob))
            if payload.get("isrc"):
                from mutagen.id3 import TSRC  # type: ignore

                tags.delall("TSRC")
                tags.add(TSRC(encoding=3, text=str(payload["isrc"])))
            tags.save(str(path))
        else:
            audio = MutagenFile(str(path), easy=True)
            if audio is not None:
                audio["comment"] = [blob]
                if payload.get("isrc") and hasattr(audio, "tags"):
                    try:
                        audio["isrc"] = [str(payload["isrc"])]
                    except Exception:  # noqa: BLE001
                        pass
                audio.save()
    except Exception as e:  # noqa: BLE001
        log.warning("tag write failed for %s: %s", path, e)


class IngestEventHandler:
    """Process newly dropped audio files: tag → enrich → index."""

    def __init__(
        self,
        db: MusicEngineDatabase,
        harmonizer: MetadataHarmonizer,
        settle_seconds: float = 1.5,
    ) -> None:
        self.db = db
        self.harmonizer = harmonizer
        self.settle_seconds = settle_seconds
        self._seen: set[str] = set()

    def process_file(self, path: Path) -> Optional[dict[str, Any]]:
        path = path.resolve()
        key = str(path)
        if key in self._seen:
            return None
        if not path.is_file() or path.suffix.lower() not in AUDIO_EXTS:
            return None
        # Wait for the writer to finish (SMB / copy settle).
        time.sleep(self.settle_seconds)
        if not path.is_file():
            return None
        self._seen.add(key)
        tags = _read_tags(path)
        log.info("Ingesting %s — %s (%s)", tags["artist"], tags["title"], path.name)
        enriched = self.harmonizer.harmonize(tags["artist"], tags["title"], tags["album"])
        self.db.upsert_enrichment(tags["artist"], tags["title"], tags.get("album") or "", enriched)
        _write_enrichment_comment(path, enriched)
        log.info(
            "Enriched %s — %s (isrc=%s, label=%s)",
            tags["artist"],
            tags["title"],
            enriched.get("isrc"),
            (enriched.get("discogs") or {}).get("record_label"),
        )
        return enriched


try:
    from watchdog.events import FileSystemEventHandler  # type: ignore
    from watchdog.observers import Observer  # type: ignore

    class InboxHandler(FileSystemEventHandler, IngestEventHandler):  # type: ignore[misc]
        def __init__(self, db: MusicEngineDatabase, harmonizer: MetadataHarmonizer) -> None:
            FileSystemEventHandler.__init__(self)
            IngestEventHandler.__init__(self, db, harmonizer)

        def on_created(self, event):  # noqa: ANN001
            if getattr(event, "is_directory", False):
                return
            self.process_file(Path(event.src_path))

        def on_moved(self, event):  # noqa: ANN001
            if getattr(event, "is_directory", False):
                return
            dest = getattr(event, "dest_path", None) or event.src_path
            self.process_file(Path(dest))

    HAS_WATCHDOG = True
except ImportError:
    HAS_WATCHDOG = False
    InboxHandler = None  # type: ignore[misc, assignment]


def watch_inbox(
    inbox: Path = DEFAULT_INBOX,
    db_path: Path = DEFAULT_DB,
    discogs_token: Optional[str] = None,
) -> None:
    inbox.mkdir(parents=True, exist_ok=True)
    db = MusicEngineDatabase(db_path)
    harmonizer = MetadataHarmonizer(discogs_token=discogs_token)
    handler = IngestEventHandler(db, harmonizer)

    # Catch up on anything already sitting in the inbox.
    for p in sorted(inbox.iterdir()):
        if p.is_file() and p.suffix.lower() in AUDIO_EXTS:
            handler.process_file(p)

    if HAS_WATCHDOG and InboxHandler is not None:
        observer = Observer()
        wd_handler = InboxHandler(db, harmonizer)
        # Reuse catch-up seen set
        wd_handler._seen = handler._seen
        observer.schedule(wd_handler, str(inbox), recursive=False)
        observer.start()
        log.info("Watching inbox with watchdog: %s", inbox)
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            observer.stop()
        observer.join()
        return

    log.info("watchdog not installed — polling inbox every 5s: %s", inbox)
    try:
        while True:
            for p in sorted(inbox.iterdir()):
                if p.is_file() and p.suffix.lower() in AUDIO_EXTS:
                    handler.process_file(p)
            time.sleep(5)
    except KeyboardInterrupt:
        log.info("watcher stopped")


# =====================================================================
# CLI
# =====================================================================

def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="JakeTunes NAS music engine")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB, help="SQLite path")
    parser.add_argument("--watch", action="store_true", help="Watch MUSIC_ENGINE_INBOX")
    parser.add_argument("--inbox", type=Path, default=DEFAULT_INBOX)
    parser.add_argument(
        "--render",
        nargs=2,
        metavar=("MANIFEST_JSON", "OUTPUT"),
        help="Render mixtape from JSON manifest of {path,bpm,key,duration}",
    )
    parser.add_argument(
        "--enrich",
        nargs="+",
        metavar="ARG",
        help="Enrich Artist Title [Album]",
    )
    parser.add_argument(
        "--context",
        nargs=2,
        metavar=("MASTER_PATH", "POSITION_SEC"),
        help="Resolve virtual track at playback position",
    )
    parser.add_argument(
        "--add-virtual",
        nargs=5,
        metavar=("MASTER", "TITLE", "ARTIST", "START", "END"),
        help="Insert a virtual track mapping",
    )
    args = parser.parse_args(argv)

    db = MusicEngineDatabase(args.db)

    if args.add_virtual:
        master, title, artist, start, end = args.add_virtual
        row_id = db.add_virtual_track(master, title, artist, float(start), float(end))
        print(json.dumps({"ok": True, "id": row_id}))
        return 0

    if args.context:
        master, pos = args.context
        print(json.dumps(db.get_current_track_context(master, float(pos)), indent=2))
        return 0

    if args.enrich:
        if len(args.enrich) < 2:
            parser.error("--enrich needs at least Artist Title")
        artist, title = args.enrich[0], args.enrich[1]
        album = args.enrich[2] if len(args.enrich) > 2 else ""
        harmonizer = MetadataHarmonizer()
        payload = harmonizer.harmonize(artist, title, album)
        db.upsert_enrichment(artist, title, album, payload)
        print(json.dumps(payload, indent=2, ensure_ascii=False))
        return 0

    if args.render:
        manifest_path, output = args.render
        track_list = json.loads(Path(manifest_path).read_text())
        ok = MixtapeRenderer.render_mixtape(track_list, output)
        return 0 if ok else 1

    if args.watch:
        watch_inbox(inbox=args.inbox, db_path=args.db)
        return 0

    parser.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
