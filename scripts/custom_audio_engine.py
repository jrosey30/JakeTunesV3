#!/usr/bin/env python3
"""
custom_audio_engine.py — unified NAS music ecosystem for JakeTunes.

Concert virtual-track indexing, FFmpeg mixtape rendering, Deezer/MusicBrainz/
Discogs harmonization, AudD rare-vinyl inbox ingestion, contrastive listening
logs, and the nightly LLM prompt compiler.

Usage:
  python3 scripts/custom_audio_engine.py                  # watch inbox + preview nightly prompt
  python3 scripts/custom_audio_engine.py --nightly-only    # compile master prompt and exit
  python3 scripts/custom_audio_engine.py --render tracks.json out.flac
  python3 scripts/custom_audio_engine.py --context /path/live.flac 1900.5

Env:
  JT_STATE_DIR / JT_UD     state directory (DB + inbox default under here)
  AUDD_API_TOKEN / AUDD_TOKEN
  DISCOGS_API_TOKEN / DISCOGS_TOKEN
  MUSIC_ENGINE_DB          sqlite path (default $STATE_DIR/music_server.db)
  MUSIC_ENGINE_INBOX       watch dir (default $STATE_DIR/inbox or ./nas/incoming_rips)
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
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

try:
    import requests
except ImportError:  # pragma: no cover
    requests = None  # type: ignore

try:
    from mutagen.easyid3 import EasyID3
    from mutagen.id3 import ID3, COMM, error as ID3Error
except ImportError:  # pragma: no cover
    EasyID3 = None  # type: ignore
    ID3 = None  # type: ignore
    COMM = None  # type: ignore
    ID3Error = Exception  # type: ignore

try:
    from watchdog.observers import Observer
    from watchdog.events import FileSystemEventHandler
except ImportError:  # pragma: no cover
    Observer = None  # type: ignore
    FileSystemEventHandler = object  # type: ignore

# Setup logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
log = logging.getLogger("custom_audio_engine")

STATE_DIR = Path(
    os.environ.get("JT_STATE_DIR")
    or os.environ.get("JT_UD")
    or os.path.expanduser("~/Library/Application Support/JakeTunes")
)
DEFAULT_DB = Path(os.environ.get("MUSIC_ENGINE_DB") or (STATE_DIR / "music_server.db"))
DEFAULT_INBOX = Path(
    os.environ.get("MUSIC_ENGINE_INBOX")
    or (STATE_DIR / "inbox" if STATE_DIR.exists() else Path("./nas/incoming_rips"))
)
USER_AGENT = "JakeTunes/custom_audio_engine (https://github.com/jrosey30/JakeTunesV3)"
HTTP_TIMEOUT = 15


def _env_token(*names: str) -> str:
    for n in names:
        v = (os.environ.get(n) or "").strip()
        if v and not v.startswith("mock_"):
            return v
    for n in names:
        v = (os.environ.get(n) or "").strip()
        if v:
            return v
    return ""


# =====================================================================
# DATA LAYER & MEMORY MANAGEMENT (SQLite & Vector Mock-Up)
# =====================================================================

class MusicEngineDatabase:
    """Manages virtual track indexing for live concerts and memory layers for the LLM."""

    def __init__(self, db_path: str | Path = "music_server.db") -> None:
        self.db_path = str(db_path)
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def _init_db(self) -> None:
        with sqlite3.connect(self.db_path) as conn:
            # Feature 1: Continuous multi-hour live files track map
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
            # Precision Feedback Loop Log Tracker
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
            # Contrastive Learning System Store
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
            # Optional enrichment cache (vector / LTM mock-up neighbor)
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS memory_vectors (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    key TEXT UNIQUE,
                    polarity TEXT,
                    payload_json TEXT,
                    updated_at TEXT
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
        """ConcertIndexer helper — map a song window inside a gapless live master."""
        with sqlite3.connect(self.db_path) as conn:
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
        """Records playback data to isolate sharp negative signals from true runs."""
        skipped = 1 if (play_time < 15 and total_time > 30) else 0
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                """
                INSERT INTO listening_logs (
                    timestamp, track_id, isrc, artist, title,
                    play_duration_seconds, total_duration_seconds, skipped_early
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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

    def record_precision(
        self,
        date: str,
        total_recommended: int,
        successful_discoveries: int,
        precision_score: float,
    ) -> None:
        with sqlite3.connect(self.db_path) as conn:
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

    def upsert_memory_vector(self, key: str, polarity: str, payload: dict[str, Any]) -> None:
        """Lightweight structured stand-in for a vector DB row."""
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                """
                INSERT INTO memory_vectors (key, polarity, payload_json, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    polarity=excluded.polarity,
                    payload_json=excluded.payload_json,
                    updated_at=excluded.updated_at
                """,
                (key, polarity, json.dumps(payload, ensure_ascii=False), datetime.now(timezone.utc).isoformat()),
            )
            conn.commit()

    def get_current_track_context(
        self, master_file_path: str, current_playback_position: float
    ) -> dict[str, Any]:
        """Queries the live show database to index tracks seamlessly inside massive files."""
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT track_title, artist_name, start_time_seconds, end_time_seconds
                FROM virtual_tracks
                WHERE master_file_path = ?
                  AND ? >= start_time_seconds
                  AND ? <= end_time_seconds
                ORDER BY start_time_seconds DESC
                LIMIT 1
                """,
                (master_file_path, current_playback_position, current_playback_position),
            )
            result = cursor.fetchone()

        if result:
            return {
                "track_title": result[0],
                "artist_name": result[1],
                "relative_position": current_playback_position - result[2],
                "duration": result[3] - result[2],
            }
        return {"error": "No track mapped at this timestamp."}


# ConcertIndexer alias — same backing store, clearer name for live-set callers.
class ConcertIndexer(MusicEngineDatabase):
    """Keeps giant continuous live sets as single files (gapless) with a DB timestamp map."""

    def index_setlist(self, master_file_path: str, tracks: list[dict[str, Any]]) -> int:
        """
        tracks: [{title, artist, start_time_seconds, end_time_seconds}, ...]
        """
        n = 0
        for t in tracks:
            self.add_virtual_track(
                master_file_path,
                t["title"],
                t["artist"],
                float(t["start_time_seconds"]),
                float(t["end_time_seconds"]),
            )
            n += 1
        return n


# =====================================================================
# AUDIO METRICS PROCESSING & TRANSITION MIXER (FFmpeg)
# =====================================================================

class MixtapeRenderer:
    @staticmethod
    def render_mixtape(track_list: list[dict[str, Any]], output_path: str) -> bool:
        """
        Stitches individual songs into a unified mixtape using intelligent key/tempo rules.
        Expects a list of dicts containing 'path', 'bpm', 'key', and 'duration'.
        """
        if not track_list:
            return False

        for track in track_list:
            if not Path(track["path"]).is_file():
                log.error("Missing input: %s", track["path"])
                return False

        input_args: list[str] = []
        for track in track_list:
            input_args.extend(["-i", track["path"]])

        # 2-Track smart transition logic builder example
        if len(track_list) == 2:
            t1, t2 = track_list[0], track_list[1]
            # If tempos align or keys match, execute clean seamless long overlap
            if t1.get("key") == t2.get("key") or abs(float(t1.get("bpm") or 0) - float(t2.get("bpm") or 0)) < 5:
                filter_complex = "[0:a][1:a]acrossfade=d=10:c1=tri:c2=tri[aout]"
            else:
                # Sound signature mismatch: Crossfade quickly without structural clash
                filter_complex = "[0:a][1:a]acrossfade=d=2:c1=log:c2=log[aout]"

            cmd = (
                ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"]
                + input_args
                + ["-filter_complex", filter_complex, "-map", "[aout]", "-c:a", "flac", output_path]
            )
        else:
            # Balanced fallback sequence block compilation
            concat_inputs = "".join(f"[{i}:a]" for i in range(len(track_list)))
            filter_complex = f"{concat_inputs}concat=n={len(track_list)}:v=0:a=1[aout]"
            cmd = (
                ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"]
                + input_args
                + ["-filter_complex", filter_complex, "-map", "[aout]", "-c:a", "flac", output_path]
            )

        try:
            log.info("Rendering high-fidelity mixtape sequence out to: %s", output_path)
            subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            return True
        except FileNotFoundError:
            log.error("ffmpeg not found on PATH")
            return False
        except subprocess.CalledProcessError as e:
            err = (e.stderr or b"").decode("utf-8", errors="replace")
            log.error("FFmpeg pipeline crashed: %s", err[-800:])
            return False


# =====================================================================
# AUTOMATED DEEP METADATA ENRICHMENT HARMONIZER
# =====================================================================

class MetadataHarmonizer:
    """Connects to Deezer, MusicBrainz, and Discogs to aggregate data strings."""

    def __init__(self, discogs_token: Optional[str] = None) -> None:
        self.discogs_token = discogs_token or _env_token("DISCOGS_API_TOKEN", "DISCOGS_TOKEN")
        # Correct public API bases (not the website HTML hosts).
        self.deezer_base = "https://api.deezer.com"
        self.mb_base = "https://musicbrainz.org/ws/2"
        self.headers = {"User-Agent": USER_AGENT}

    def _get(self, url: str, headers: Optional[dict[str, str]] = None) -> dict[str, Any]:
        if requests is None:
            raise RuntimeError("requests is required — pip install requests")
        hdrs = dict(self.headers)
        if headers:
            hdrs.update(headers)
        res = requests.get(url, headers=hdrs, timeout=HTTP_TIMEOUT)
        res.raise_for_status()
        return res.json()

    def fetch_deezer_metadata(self, artist: str, title: str) -> dict[str, Any]:
        """Pulls primary track variables and definitive track ISRCs."""
        try:
            from urllib.parse import quote

            q = f'artist:"{artist}" track:"{title}"'
            url = f"{self.deezer_base}/search?q={quote(q)}&limit=5"
            res = self._get(url)
            if res.get("data"):
                track_data = res["data"][0]
                track_id = track_data["id"]
                # Fetch deeper track level specifications
                extended = self._get(f"{self.deezer_base}/track/{track_id}")
                return {
                    "isrc": extended.get("isrc"),
                    "bpm": extended.get("bpm"),
                    "gain": extended.get("gain"),
                    "deezer_id": track_id,
                    "album": (extended.get("album") or {}).get("title")
                    if isinstance(extended.get("album"), dict)
                    else None,
                }
        except Exception as e:  # noqa: BLE001
            log.error("Deezer extraction fault: %s", e)
        return {}

    def fetch_musicbrainz_relations(self, isrc: str) -> dict[str, Any]:
        """Leverages ISRCs to extract production, engineering, and sub-project histories."""
        if not isrc:
            return {}
        try:
            from urllib.parse import quote

            # MusicBrainz ToS: ~1 req/sec
            time.sleep(1.1)
            url = (
                f"{self.mb_base}/isrc/{quote(isrc)}"
                "?inc=artists+releases+recording-rels+work-rels&fmt=json"
            )
            res = self._get(url)
            recordings = res.get("recordings", [])
            if recordings:
                rec = recordings[0]
                credits = []
                for rel in rec.get("relations", []):
                    if rel.get("type") in ("engineer", "producer", "mixer", "remixer"):
                        artist = (rel.get("artist") or {}).get("name")
                        if artist:
                            credits.append({"role": rel["type"], "name": artist})
                artist_mbid = ""
                ac = rec.get("artist-credit") or []
                if ac and isinstance(ac[0], dict):
                    artist_mbid = ((ac[0].get("artist") or {}).get("id") or "")
                side_projects: list[str] = []
                if artist_mbid:
                    time.sleep(1.1)
                    arel = self._get(f"{self.mb_base}/artist/{artist_mbid}?inc=artist-rels&fmt=json")
                    for rel in arel.get("relations") or []:
                        if "member of band" in (rel.get("type") or "").lower():
                            band = (rel.get("artist") or {}).get("name") if isinstance(rel.get("artist"), dict) else None
                            if band:
                                side_projects.append(band)
                return {
                    "producers_engineers": credits,
                    "mbid": rec.get("id"),
                    "side_projects": side_projects,
                }
        except Exception as e:  # noqa: BLE001
            log.error("MusicBrainz mapping fault: %s", e)
        return {}

    def fetch_discogs_pressing_context(self, artist: str, album_title: str) -> dict[str, Any]:
        """Scans the physical media archive database to match rare label distributions."""
        if not self.discogs_token or not album_title:
            return {}
        try:
            from urllib.parse import urlencode

            time.sleep(1.0)
            params = {
                "artist": artist,
                "release_title": album_title,
                "type": "release",
                "per_page": "5",
            }
            url = "https://api.discogs.com/database/search?" + urlencode(params)
            headers = {
                "Authorization": f"Discogs token={self.discogs_token}",
                "User-Agent": USER_AGENT,
            }
            res = self._get(url, headers=headers)
            results = res.get("results", [])
            if results:
                release = results[0]
                labels = release.get("label") or ["Independent Records"]
                return {
                    "record_label": labels[0] if labels else "Independent Records",
                    "country": release.get("country", "Unknown"),
                    "catalog_number": release.get("catno", "Unknown"),
                    "style_tags": release.get("style", []),
                }
        except Exception as e:  # noqa: BLE001
            log.error("Discogs database query fault: %s", e)
        return {}

    def harmonize(self, artist: str, title: str, album: str = "") -> dict[str, Any]:
        dz = self.fetch_deezer_metadata(artist, title)
        mb = self.fetch_musicbrainz_relations(dz.get("isrc") or "")
        dc = self.fetch_discogs_pressing_context(artist, album or (dz.get("album") or ""))
        return {"deezer": dz, "musicbrainz": mb, "discogs": dc}


# =====================================================================
# FILE INGESTION PIPELINE WATCHER
# =====================================================================

class RareVinylHandler(FileSystemEventHandler):
    """AudD-backed inbox ingest — unverified files become Rare Unreleased Archive."""

    def __init__(self, audd_token: str, harmonizer: MetadataHarmonizer, db: Optional[MusicEngineDatabase] = None) -> None:
        super().__init__()
        self.audd_token = audd_token
        self.harmonizer = harmonizer
        self.db = db

    def on_created(self, event):  # noqa: ANN001
        if getattr(event, "is_directory", False):
            return
        src = event.src_path
        if not str(src).lower().endswith((".flac", ".wav", ".mp3", ".m4a", ".aiff", ".aif")):
            return
        log.info("Ingestion engine intercepted new drop: %s", src)
        # Settle so SMB/copy finishes writing
        time.sleep(1.5)
        self.process_file(src)

    def on_moved(self, event):  # noqa: ANN001
        if getattr(event, "is_directory", False):
            return
        dest = getattr(event, "dest_path", None) or event.src_path
        if str(dest).lower().endswith((".flac", ".wav", ".mp3", ".m4a", ".aiff", ".aif")):
            time.sleep(1.5)
            self.process_file(dest)

    def process_file(self, file_path: str) -> dict[str, Any]:
        if requests is None:
            raise RuntimeError("requests is required — pip install requests")

        is_rare = False
        filename = os.path.basename(file_path)
        artist = title = album = ""
        audd_result: dict[str, Any] = {}

        # AudD Audio Recognition check step
        try:
            with open(file_path, "rb") as f:
                res = requests.post(
                    "https://api.audd.io/",
                    data={"api_token": self.audd_token, "return": "apple_music,spotify,deezer"},
                    files={"file": (filename, f)},
                    timeout=HTTP_TIMEOUT,
                ).json()
            if res.get("status") == "error" or not res.get("result"):
                is_rare = True
            else:
                result = res["result"]
                audd_result = result if isinstance(result, dict) else {}
                artist = audd_result.get("artist") or ""
                title = audd_result.get("title") or ""
                album = audd_result.get("album") or ""
        except Exception:  # noqa: BLE001
            is_rare = True

        if is_rare:
            log.info("AudD audio check unverified. Classifying as Rare Unreleased Archive.")
            # Raw file format structural parser fallback logic
            stem = Path(filename).stem
            parts = [p.strip() for p in stem.replace("_", " - ").split("-")]
            artist = parts[0].strip() if len(parts) > 1 else "Unknown Collector"
            title = parts[1].strip() if len(parts) > 1 else parts[0].strip()
            album = "Rare Archive Ingestion"

        # Harmonize gathered data arrays across services
        dz_data = self.harmonizer.fetch_deezer_metadata(artist, title)
        mb_data = self.harmonizer.fetch_musicbrainz_relations(dz_data.get("isrc") or "")
        dc_data = self.harmonizer.fetch_discogs_pressing_context(artist, album)

        # Apply definitive physical media asset metadata locks (MP3/ID3 path)
        if EasyID3 is not None and ID3 is not None and COMM is not None and file_path.lower().endswith(".mp3"):
            try:
                try:
                    audio = EasyID3(file_path)
                except Exception:  # noqa: BLE001
                    audio = ID3()
                    audio.save(file_path)
                    audio = EasyID3(file_path)
                audio["title"] = title
                audio["artist"] = artist
                audio["album"] = album
                if dc_data.get("record_label"):
                    audio["organization"] = dc_data["record_label"]
                audio.save()

                tags = ID3(file_path)
                comment_payload = json.dumps(
                    {"engine_meta": {"deezer": dz_data, "musicbrainz": mb_data, "discogs": dc_data, "audd": audd_result}}
                )
                tags.add(
                    COMM(
                        encoding=3,
                        lang="eng",
                        desc="Archive Status",
                        text=f"Rare Vinyl Rip | {comment_payload}" if is_rare else f"Verified | {comment_payload}",
                    )
                )
                tags.save(file_path)
            except Exception as e:  # noqa: BLE001
                log.warning("ID3 lock failed for %s: %s", file_path, e)

        payload = {
            "artist": artist,
            "title": title,
            "album": album,
            "rare": is_rare,
            "deezer": dz_data,
            "musicbrainz": mb_data,
            "discogs": dc_data,
            "audd": audd_result,
            "path": file_path,
        }
        if self.db is not None:
            key = f"{artist}|{title}|{album}".lower()
            self.db.upsert_memory_vector(key, "rare" if is_rare else "verified", payload)
            # Seed identity into listening store (0 play — not a skip signal)
            self.db.log_playback(
                track_id=file_path,
                isrc=str(dz_data.get("isrc") or ""),
                artist=artist,
                title=title,
                play_time=30.0,  # neutral seed (not early-skip)
                total_time=30.0,
            )

        log.info("System processing complete. File metadata locked with custom metrics payload.")
        return payload


# =====================================================================
# NIGHTLY EVALUATOR LOOP COMPILER (Runs Before Sleep)
# =====================================================================

class NightlyLoopEvaluator:
    def __init__(self, db_path: str | Path = "music_server.db") -> None:
        self.db_path = str(db_path)

    def compile_nightly_prompt(self) -> str:
        """Processes logs, extracts contrastive signals, and structures the master prompt."""
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.cursor()

            # Fetch latest calculated precision loop accuracy
            cursor.execute(
                "SELECT precision_score FROM recommendation_feedback ORDER BY id DESC LIMIT 1"
            )
            score_res = cursor.fetchone()
            precision = score_res[0] if score_res else 100.0

            # Gather strict positive indicators (tracks completely spun / not early-skipped)
            cursor.execute(
                """
                SELECT artist, title, isrc FROM listening_logs
                WHERE skipped_early = 0
                  AND play_duration_seconds >= 0.8 * CASE
                        WHEN total_duration_seconds > 0 THEN total_duration_seconds
                        ELSE play_duration_seconds
                      END
                ORDER BY id DESC LIMIT 25
                """
            )
            positives = [{"artist": r[0], "title": r[1], "isrc": r[2]} for r in cursor.fetchall()]
            if not positives:
                # Fall back to any non-skip rows if completion math is sparse
                cursor.execute(
                    "SELECT artist, title, isrc FROM listening_logs WHERE skipped_early = 0 ORDER BY id DESC LIMIT 5"
                )
                positives = [{"artist": r[0], "title": r[1], "isrc": r[2]} for r in cursor.fetchall()]

            # Gather strict negative indicators (instantly rejected skips)
            cursor.execute(
                "SELECT artist, title FROM listening_logs WHERE skipped_early = 1 ORDER BY id DESC LIMIT 25"
            )
            negatives = [{"artist": r[0], "title": r[1]} for r in cursor.fetchall()]

            # Memory vector mock-up (LTM/STM stand-in)
            cursor.execute(
                "SELECT key, polarity, payload_json FROM memory_vectors ORDER BY id DESC LIMIT 20"
            )
            memory = [
                {"key": r[0], "polarity": r[1], "payload": json.loads(r[2]) if r[2] else {}}
                for r in cursor.fetchall()
            ]

        weight_hint = (
            "Precision healthy — keep genre adjacency + Discogs label threads."
            if float(precision) >= 70
            else (
                "Precision middling — lean harder on Discogs labels and MusicBrainz producers; de-weight generic genre tags."
                if float(precision) >= 40
                else "Precision low — prioritize Discogs labels / catalog neighborhoods / shared producers; treat genre as weak."
            )
        )

        # Master crate-digger prompt (string form for open-source LLM)
        master_prompt = (
            "You are a master crate-digger and music algorithm tuned to this user's unique taste.\n"
            f"Yesterday's recommendation precision score was: {precision}%.\n"
            f"{weight_hint}\n\n"
            "Analyze the following contrastive data from today's listening logs:\n"
            f"- POSITIVE SIGNALS (Enriched via Deezer, MusicBrainz, Discogs): {json.dumps(positives, ensure_ascii=False)}\n"
            f"- NEGATIVE SIGNALS (Tracks to avoid): {json.dumps(negatives, ensure_ascii=False)}\n\n"
            "Your goal is to adjust your internal retrieval weights. Identify hidden threads "
            "(overlapping producers, record labels, or release eras) in the positive signals that are "
            "entirely absent in the negative signals. Update the long-term memory matrix and output "
            "5 precise search queries for the Deezer API to discover new music for tomorrow."
        )

        # Inject consolidated profiles to feed downstream LLM context updates
        prompt_manifest = {
            "role": "Master Crate-Digger Algorithm",
            "system_precision_score": f"{precision}%",
            "weight_hint": weight_hint,
            "contrastive_tuning_directives": {
                "positive_signals": positives,
                "negative_signals": negatives,
            },
            "memory_vectors": memory,
            "master_prompt": master_prompt,
            "execution_instruction": (
                "Isolate the hidden patterns (producers, labels, master release eras) present in "
                "the positive signals while completely avoiding attributes found in the negative tracks. "
                "Adjust internal context weights and output 5 precise search arguments for tomorrow's run."
            ),
        }
        return json.dumps(prompt_manifest, indent=2)


# =====================================================================
# RUNNER INTERFACE ENGINE CONTROL
# =====================================================================

def run_watcher(watch_dir: Path, db: MusicEngineDatabase, harmonizer: MetadataHarmonizer, audd_token: str) -> None:
    watch_dir.mkdir(parents=True, exist_ok=True)
    if Observer is None:
        log.error("watchdog is not installed — pip install watchdog")
        sys.exit(1)

    event_handler = RareVinylHandler(audd_token, harmonizer, db=db)
    # Catch up existing drops
    for p in sorted(watch_dir.iterdir()):
        if p.is_file() and p.suffix.lower() in {".flac", ".wav", ".mp3", ".m4a", ".aiff", ".aif"}:
            event_handler.process_file(str(p))

    observer = Observer()
    observer.schedule(event_handler, path=str(watch_dir), recursive=False)
    log.info("Ingestion pipeline active. Watching directory: %s", watch_dir)
    observer.start()

    evaluator = NightlyLoopEvaluator(db.db_path)
    print("\n--- NIGHTLY LLM SYSTEM RULES PROMPT PREVIEW ---")
    print(evaluator.compile_nightly_prompt())
    print("------------------------------------------------\n")

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        observer.stop()
    observer.join()


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="JakeTunes custom audio engine")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--inbox", type=Path, default=DEFAULT_INBOX)
    parser.add_argument("--nightly-only", action="store_true", help="Compile nightly prompt and exit")
    parser.add_argument("--watch", action="store_true", help="Run inbox watcher (default if no other action)")
    parser.add_argument("--render", nargs=2, metavar=("MANIFEST", "OUTPUT"))
    parser.add_argument("--context", nargs=2, metavar=("MASTER", "POSITION_SEC"))
    parser.add_argument(
        "--add-virtual",
        nargs=5,
        metavar=("MASTER", "TITLE", "ARTIST", "START", "END"),
    )
    parser.add_argument("--log-play", nargs=6, metavar=("ID", "ISRC", "ARTIST", "TITLE", "PLAY_SEC", "TOTAL_SEC"))
    args = parser.parse_args(argv)

    audd_token = _env_token("AUDD_API_TOKEN", "AUDD_TOKEN") or "mock_audd_token"
    discogs_token = _env_token("DISCOGS_API_TOKEN", "DISCOGS_TOKEN") or "mock_discogs_token"

    db = MusicEngineDatabase(args.db)
    harmonizer = MetadataHarmonizer(discogs_token=discogs_token)

    if args.add_virtual:
        master, title, artist, start, end = args.add_virtual
        row_id = db.add_virtual_track(master, title, artist, float(start), float(end))
        print(json.dumps({"ok": True, "id": row_id}))
        return 0

    if args.context:
        master, pos = args.context
        print(json.dumps(db.get_current_track_context(master, float(pos)), indent=2))
        return 0

    if args.log_play:
        tid, isrc, artist, title, play_sec, total_sec = args.log_play
        db.log_playback(tid, isrc, artist, title, float(play_sec), float(total_sec))
        print(json.dumps({"ok": True}))
        return 0

    if args.render:
        manifest_path, output = args.render
        track_list = json.loads(Path(manifest_path).read_text())
        ok = MixtapeRenderer.render_mixtape(track_list, output)
        return 0 if ok else 1

    if args.nightly_only:
        evaluator = NightlyLoopEvaluator(args.db)
        print(evaluator.compile_nightly_prompt())
        return 0

    # Default: watch inbox + preview nightly prompt (original __main__ behavior)
    run_watcher(args.inbox, db, harmonizer, audd_token)
    return 0


if __name__ == "__main__":
    sys.exit(main())
