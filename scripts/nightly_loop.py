#!/usr/bin/env python3
"""
nightly_loop — self-improvement pass for JakeTunes taste retrieval.

Runs on homemini (or any host with STATE_DIR) once a night. Reads the day's
listening logs, classifies contrastive signals, enriches positive tracks via
AudD → Deezer (ISRC) → MusicBrainz (MBIDs + relations) → Discogs (pressing),
scores yesterday's recommendation precision, updates long/short-term memory,
and emits a master prompt for the local open-source LLM so tomorrow's Deezer
search queries are hyper-targeted.

State layout (under JT_STATE_DIR / JT_UD / macOS Application Support):
  listening-log.jsonl          play/skip events from the app
  discovery-feedback.json      notForMe vetoes + accepted discoveries
  recommendations.json         yesterday's recommended list (when present)
  taste-memory-ltm.json        long-term memory (core tastes over months)
  taste-memory-stm.json        short-term memory (rolling 48h window)
  nightly-loop-out/            prompt + enriched signal dumps for this run

Env (all optional except where noted; missing keys fail soft):
  JT_STATE_DIR / JT_UD         state directory override
  AUDD_API_TOKEN               AudD recognition / metadata
  DISCOGS_API_TOKEN            Discogs pressing detail
  DEEZER_APP_ID                unused for public search; reserved
  MUSICBRAINZ_USER_AGENT       override UA (default JakeTunes/nightly_loop)
  NIGHTLY_DRY_RUN=1            skip live HTTP; enrich from local fields only
  NIGHTLY_MAX_ENRICH=N         cap enrichment calls (default 40)

Usage:
  python3 scripts/nightly_loop.py
  JT_STATE_DIR=/path/to/state NIGHTLY_DRY_RUN=1 python3 scripts/nightly_loop.py
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Optional

# ── paths / constants ─────────────────────────────────────────────────────────

STATE_DIR = Path(
    os.environ.get("JT_STATE_DIR")
    or os.environ.get("JT_UD")
    or os.path.expanduser("~/Library/Application Support/JakeTunes")
)

LISTEN_LOG = STATE_DIR / "listening-log.jsonl"
MOBILE_LISTEN_LOG = STATE_DIR / "mobile-listening-log.jsonl"
LIBRARY = STATE_DIR / "library.json"
DISCOVERY_FB = STATE_DIR / "discovery-feedback.json"
RECOMMENDATIONS = STATE_DIR / "recommendations.json"
TASTE_LEDGER = STATE_DIR / "taste-ledger.jsonl"
LTM_PATH = STATE_DIR / "taste-memory-ltm.json"
STM_PATH = STATE_DIR / "taste-memory-stm.json"
VECTOR_CANDIDATES = (
    STATE_DIR / "taste-vectors.json",
    STATE_DIR / "chroma",
    STATE_DIR / "faiss.index",
    STATE_DIR / "embeddings.bin",
)
OUT_DIR = STATE_DIR / "nightly-loop-out"
STATUS_PATH = STATE_DIR / "nightly-loop-status.json"

SKIP_SEC_THRESHOLD = 15.0
STM_HOURS = 48
DEFAULT_TRACK_SEC = 210.0  # ~3:30 when duration unknown — used only for pct→sec
MB_MIN_INTERVAL = 1.1  # MusicBrainz ToS ≈ 1 req/sec
DISCOGS_MIN_INTERVAL = 1.0
HTTP_TIMEOUT = 12
MAX_ENRICH = int(os.environ.get("NIGHTLY_MAX_ENRICH", "40"))
DRY_RUN = os.environ.get("NIGHTLY_DRY_RUN", "").strip() in ("1", "true", "yes")
USER_AGENT = os.environ.get(
    "MUSICBRAINZ_USER_AGENT",
    "JakeTunes/nightly_loop (https://github.com/jrosey30/JakeTunesV3)",
)

AUDD_TOKEN = os.environ.get("AUDD_API_TOKEN", "").strip()
DISCOGS_TOKEN = os.environ.get("DISCOGS_API_TOKEN", "").strip()


def log(*a: Any) -> None:
    print(datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "[nightly_loop]", *a, flush=True)


# ── HTTP + rate limiting ──────────────────────────────────────────────────────

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
    if DRY_RUN:
        return None
    hdrs = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    if headers:
        hdrs.update(headers)
    last_err: Optional[Exception] = None
    for attempt in range(retries + 1):
        if limiter:
            limiter.wait()
        req = urllib.request.Request(url, headers=hdrs, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                raw = resp.read()
                if not raw:
                    return None
                return json.loads(raw.decode("utf-8"))
        except urllib.error.HTTPError as e:
            last_err = e
            # 429 / 503 → back off and retry
            if e.code in (429, 503) and attempt < retries:
                time.sleep(2.0 * (attempt + 1))
                continue
            log(f"HTTP {e.code} for {url[:120]}")
            return None
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            last_err = e
            if attempt < retries:
                time.sleep(1.0 * (attempt + 1))
                continue
            log(f"request failed: {e}")
            return None
    if last_err:
        log(f"giving up: {last_err}")
    return None


def http_post_form(
    url: str,
    form: dict[str, str],
    *,
    headers: Optional[dict[str, str]] = None,
) -> Optional[dict[str, Any]]:
    if DRY_RUN:
        return None
    data = urllib.parse.urlencode(form).encode("utf-8")
    hdrs = {
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
    }
    if headers:
        hdrs.update(headers)
    req = urllib.request.Request(url, data=data, headers=hdrs, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
        log(f"POST failed ({url[:80]}): {e}")
        return None


# ── IO helpers ────────────────────────────────────────────────────────────────

def jread(path: Path, default: Any) -> Any:
    try:
        with path.open() as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return default


def jwrite_atomic(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, path)


def jlines(path: Path) -> Iterable[dict[str, Any]]:
    try:
        with path.open() as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    continue
    except FileNotFoundError:
        return


def parse_ts(ts: Any) -> Optional[datetime]:
    if ts is None:
        return None
    s = str(ts).strip()
    if not s:
        return None
    # ISO with or without Z / offset
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        return datetime.fromisoformat(s)
    except ValueError:
        pass
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(s[:19] if len(s) >= 19 else s, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def norm(s: Any) -> str:
    return (str(s) if s is not None else "").strip().lower()


# ── data model ────────────────────────────────────────────────────────────────

@dataclass
class TrackSignal:
    artist: str
    title: str
    album: str = ""
    genre: str = ""
    source: str = ""  # play | skip | replay | audd | path
    pct: Optional[float] = None
    elapsed_sec: Optional[float] = None
    local_path: str = ""
    isrc: str = ""
    artist_mbid: str = ""
    release_mbid: str = ""
    recording_mbid: str = ""
    producers: list[str] = field(default_factory=list)
    engineers: list[str] = field(default_factory=list)
    side_projects: list[str] = field(default_factory=list)
    discogs_label: str = ""
    discogs_catno: str = ""
    discogs_country: str = ""
    year: Optional[int] = None
    enrichment_notes: list[str] = field(default_factory=list)

    def key(self) -> tuple[str, str]:
        return (norm(self.artist), norm(self.title))

    def to_prompt_dict(self) -> dict[str, Any]:
        d = {
            "artist": self.artist,
            "title": self.title,
            "album": self.album or None,
            "genre": self.genre or None,
            "isrc": self.isrc or None,
            "artist_mbid": self.artist_mbid or None,
            "release_mbid": self.release_mbid or None,
            "producers": self.producers or None,
            "engineers": self.engineers or None,
            "side_projects": self.side_projects or None,
            "record_label": self.discogs_label or None,
            "catalog_number": self.discogs_catno or None,
            "country": self.discogs_country or None,
            "year": self.year,
            "elapsed_sec": self.elapsed_sec,
            "pct": self.pct,
            "source": self.source,
        }
        return {k: v for k, v in d.items() if v is not None and v != []}


# ── library index (duration for 15s skip math) ────────────────────────────────

def load_library_index() -> dict[tuple[str, str], dict[str, Any]]:
    lib = jread(LIBRARY, {})
    tracks = lib.get("tracks") if isinstance(lib, dict) else None
    if not isinstance(tracks, list):
        return {}
    idx: dict[tuple[str, str], dict[str, Any]] = {}
    for t in tracks:
        if not isinstance(t, dict):
            continue
        k = (norm(t.get("artist")), norm(t.get("title")))
        if k[0] or k[1]:
            idx[k] = t
    return idx


def duration_sec_for(ev: dict[str, Any], lib: dict[tuple[str, str], dict[str, Any]]) -> float:
    for key in ("duration", "dur", "durationSec", "length"):
        v = ev.get(key)
        if isinstance(v, (int, float)) and v > 0:
            return float(v) if v < 10_000 else float(v) / 1000.0
    t = lib.get((norm(ev.get("ar") or ev.get("artist")), norm(ev.get("ti") or ev.get("title"))))
    if t:
        d = t.get("duration")
        if isinstance(d, (int, float)) and d > 0:
            return float(d) if d < 10_000 else float(d) / 1000.0
    return DEFAULT_TRACK_SEC


def elapsed_from_event(ev: dict[str, Any], lib: dict[tuple[str, str], dict[str, Any]]) -> Optional[float]:
    """Prefer explicit seconds; else derive from pct × duration."""
    for key in ("sec", "elapsed", "elapsedSec", "pos", "position"):
        v = ev.get(key)
        if isinstance(v, (int, float)) and v >= 0:
            return float(v)
    pct = ev.get("pct")
    if isinstance(pct, (int, float)):
        return max(0.0, (float(pct) / 100.0) * duration_sec_for(ev, lib))
    return None


# ── contrastive signal extraction ─────────────────────────────────────────────

def load_day_events(now: datetime) -> list[dict[str, Any]]:
    day_start = (now - timedelta(days=1)).astimezone(timezone.utc)
    out: list[dict[str, Any]] = []
    for path in (LISTEN_LOG, MOBILE_LISTEN_LOG):
        for ev in jlines(path):
            if ev.get("ar") == "__parity-test__":
                continue
            ts = parse_ts(ev.get("ts"))
            if ts is None:
                continue
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
            if ts >= day_start:
                out.append(ev)
    return out


def classify_contrastive(
    events: list[dict[str, Any]],
    lib: dict[tuple[str, str], dict[str, Any]],
) -> tuple[list[TrackSignal], list[TrackSignal]]:
    """
    Negative: skipped within SKIP_SEC_THRESHOLD seconds.
    Positive: full plays (t=p, pct>=80) or replays (same key played ≥2 times).
    """
    play_counts: dict[tuple[str, str], int] = defaultdict(int)
    positives: dict[tuple[str, str], TrackSignal] = {}
    negatives: dict[tuple[str, str], TrackSignal] = {}

    for ev in events:
        kind = ev.get("t")
        artist = (ev.get("ar") or ev.get("artist") or "").strip()
        title = (ev.get("ti") or ev.get("title") or "").strip()
        if not artist and not title:
            continue
        album = (ev.get("al") or ev.get("album") or "").strip()
        genre = (ev.get("g") or ev.get("genre") or "").strip()
        k = (norm(artist), norm(title))
        elapsed = elapsed_from_event(ev, lib)
        pct = ev.get("pct") if isinstance(ev.get("pct"), (int, float)) else None

        # Join library metadata when the log line is thin.
        meta = lib.get(k) or {}
        if not album:
            album = (meta.get("album") or "").strip()
        if not genre:
            genre = (meta.get("genre") or "").strip()
        year = None
        try:
            year = int(meta["year"]) if meta.get("year") else None
        except (TypeError, ValueError):
            year = None
        local_path = ""
        loc = meta.get("location") or meta.get("path") or ""
        if isinstance(loc, str):
            local_path = loc

        if kind == "s":
            if elapsed is not None and elapsed <= SKIP_SEC_THRESHOLD:
                negatives[k] = TrackSignal(
                    artist=artist,
                    title=title,
                    album=album,
                    genre=genre,
                    source="skip",
                    pct=float(pct) if pct is not None else None,
                    elapsed_sec=elapsed,
                    local_path=local_path,
                    year=year,
                )
            continue

        if kind == "p":
            play_counts[k] += 1
            is_full = pct is None or float(pct) >= 80
            if is_full or play_counts[k] >= 2:
                src = "replay" if play_counts[k] >= 2 else "play"
                positives[k] = TrackSignal(
                    artist=artist,
                    title=title,
                    album=album,
                    genre=genre,
                    source=src,
                    pct=float(pct) if pct is not None else 100.0,
                    elapsed_sec=elapsed,
                    local_path=local_path,
                    year=year,
                )

    # Replays win over a same-day early skip if both somehow appear.
    for k in list(negatives):
        if k in positives and positives[k].source == "replay":
            del negatives[k]

    return list(positives.values()), list(negatives.values())


# ── AudD / path discovery of newly recognized tracks ──────────────────────────

def load_audd_candidates() -> list[TrackSignal]:
    """
    Pull newly recognized tracks from:
      1) STATE_DIR/audd-log.jsonl  (one JSON object per recognition)
      2) STATE_DIR/audd-inbox/     (audio/paths dropped for recognition)
      3) Live AudD API get? (optional; only if AUDD_API_TOKEN set and inbox paths exist)
    """
    found: list[TrackSignal] = []
    seen: set[tuple[str, str]] = set()

    for ev in jlines(STATE_DIR / "audd-log.jsonl"):
        artist = (ev.get("artist") or ev.get("ar") or "").strip()
        title = (ev.get("title") or ev.get("ti") or "").strip()
        album = (ev.get("album") or ev.get("al") or "").strip()
        if not artist and not title:
            continue
        k = (norm(artist), norm(title))
        if k in seen:
            continue
        seen.add(k)
        found.append(
            TrackSignal(
                artist=artist,
                title=title,
                album=album,
                source="audd",
                isrc=(ev.get("isrc") or "").strip(),
                local_path=(ev.get("path") or ev.get("file") or "").strip(),
            )
        )

    inbox = STATE_DIR / "audd-inbox"
    if inbox.is_dir():
        for p in sorted(inbox.iterdir()):
            if p.name.startswith("."):
                continue
            if p.suffix.lower() not in {".mp3", ".m4a", ".flac", ".wav", ".aiff", ".aif", ".ogg", ".json", ".txt"}:
                continue
            if p.suffix.lower() in {".json", ".txt"}:
                try:
                    data = json.loads(p.read_text()) if p.suffix.lower() == ".json" else {"path": p.read_text().strip()}
                except (OSError, json.JSONDecodeError):
                    continue
                artist = (data.get("artist") or "").strip()
                title = (data.get("title") or "").strip()
                path = (data.get("path") or str(p)).strip()
            else:
                artist, title, path = "", "", str(p)
                # Optionally recognize via AudD when we only have a file path.
                if AUDD_TOKEN and not DRY_RUN:
                    recognized = audd_recognize_path(path)
                    if recognized:
                        artist = recognized.get("artist") or artist
                        title = recognized.get("title") or title
                        album = recognized.get("album") or ""
                        isrc = recognized.get("isrc") or ""
                        k = (norm(artist), norm(title))
                        if artist or title:
                            if k not in seen:
                                seen.add(k)
                                found.append(
                                    TrackSignal(
                                        artist=artist,
                                        title=title,
                                        album=album,
                                        source="audd",
                                        isrc=isrc,
                                        local_path=path,
                                    )
                                )
                        continue
            if artist or title:
                k = (norm(artist), norm(title))
                if k not in seen:
                    seen.add(k)
                    found.append(
                        TrackSignal(
                            artist=artist or "Unknown",
                            title=title or p.stem,
                            source="path",
                            local_path=path,
                        )
                    )
    return found


def audd_recognize_path(path: str) -> Optional[dict[str, str]]:
    """Best-effort AudD recognize by URL/path string (file upload not used here)."""
    if not AUDD_TOKEN:
        return None
    # AudD's `url` endpoint works for reachable URLs; for local NAS paths we
    # only pass metadata when the caller already knows artist/title.
    body = http_post_form(
        "https://api.audd.io/",
        {"api_token": AUDD_TOKEN, "url": path, "return": "apple_music,spotify,deezer"},
    )
    if not body or body.get("status") != "success":
        return None
    result = body.get("result") or {}
    if not isinstance(result, dict):
        return None
    isrc = ""
    for nest in ("spotify", "apple_music", "deezer"):
        block = result.get(nest) or {}
        if isinstance(block, dict) and block.get("isrc"):
            isrc = str(block["isrc"])
            break
    return {
        "artist": str(result.get("artist") or ""),
        "title": str(result.get("title") or ""),
        "album": str(result.get("album") or ""),
        "isrc": isrc,
    }


# ── API enrichment chain ──────────────────────────────────────────────────────

def deezer_isrc(artist: str, title: str, album: str = "") -> Optional[str]:
    q = f'artist:"{artist}" track:"{title}"'
    if album:
        q += f' album:"{album}"'
    url = "https://api.deezer.com/search?" + urllib.parse.urlencode({"q": q, "limit": 5})
    data = http_get_json(url)
    if not data:
        return None
    items = data.get("data") or []
    want_a, want_t = norm(artist), norm(title)
    best = None
    for it in items:
        if not isinstance(it, dict):
            continue
        a = norm((it.get("artist") or {}).get("name") if isinstance(it.get("artist"), dict) else "")
        t = norm(it.get("title"))
        if a == want_a and t == want_t:
            best = it
            break
        if want_a in a and want_t in t and best is None:
            best = it
    if not best:
        return None
    track_id = best.get("id")
    if not track_id:
        return None
    detail = http_get_json(f"https://api.deezer.com/track/{track_id}")
    if not detail:
        return None
    isrc = (detail.get("isrc") or "").strip()
    return isrc or None


def musicbrainz_by_isrc(isrc: str) -> dict[str, Any]:
    """Return recording + artist/release MBIDs for an ISRC."""
    url = (
        "https://musicbrainz.org/ws/2/isrc/"
        + urllib.parse.quote(isrc)
        + "?inc=artists+releases+artist-credits&fmt=json"
    )
    data = http_get_json(url, limiter=_mb_limiter) or {}
    out: dict[str, Any] = {
        "recording_mbid": "",
        "artist_mbid": "",
        "release_mbid": "",
        "artist": "",
        "title": "",
        "album": "",
    }
    recordings = data.get("recordings") or []
    if not recordings:
        return out
    rec = recordings[0]
    out["recording_mbid"] = rec.get("id") or ""
    out["title"] = rec.get("title") or ""
    ac = rec.get("artist-credit") or []
    if ac and isinstance(ac[0], dict):
        artist = ac[0].get("artist") or {}
        out["artist"] = artist.get("name") or ac[0].get("name") or ""
        out["artist_mbid"] = artist.get("id") or ""
    releases = rec.get("releases") or []
    if releases:
        out["release_mbid"] = releases[0].get("id") or ""
        out["album"] = releases[0].get("title") or ""
    return out


def musicbrainz_relations(artist_mbid: str, release_mbid: str) -> dict[str, list[str]]:
    """Fetch producers, engineers, and is_member_of_band side projects."""
    producers: list[str] = []
    engineers: list[str] = []
    side_projects: list[str] = []

    if release_mbid:
        url = (
            f"https://musicbrainz.org/ws/2/release/{release_mbid}"
            "?inc=artist-rels+recording-level-rels+recordings&fmt=json"
        )
        data = http_get_json(url, limiter=_mb_limiter) or {}
        for rel in data.get("relations") or []:
            if not isinstance(rel, dict):
                continue
            rtype = (rel.get("type") or "").lower()
            artist = (rel.get("artist") or {}).get("name") if isinstance(rel.get("artist"), dict) else None
            if not artist:
                continue
            if "producer" in rtype:
                producers.append(artist)
            elif "engineer" in rtype or "mix" in rtype or "master" in rtype:
                engineers.append(artist)
        # Also scan recording-level relations when present.
        for medium in data.get("media") or []:
            for track in medium.get("tracks") or []:
                recording = track.get("recording") or {}
                for rel in recording.get("relations") or []:
                    if not isinstance(rel, dict):
                        continue
                    rtype = (rel.get("type") or "").lower()
                    artist = (rel.get("artist") or {}).get("name") if isinstance(rel.get("artist"), dict) else None
                    if not artist:
                        continue
                    if "producer" in rtype:
                        producers.append(artist)
                    elif "engineer" in rtype or "mix" in rtype or "master" in rtype:
                        engineers.append(artist)

    if artist_mbid:
        url = (
            f"https://musicbrainz.org/ws/2/artist/{artist_mbid}"
            "?inc=artist-rels&fmt=json"
        )
        data = http_get_json(url, limiter=_mb_limiter) or {}
        for rel in data.get("relations") or []:
            if not isinstance(rel, dict):
                continue
            rtype = (rel.get("type") or "").lower()
            # MusicBrainz uses "member of band" (and direction).
            if "member of band" in rtype or rtype == "member of band":
                band = (rel.get("artist") or {}).get("name") if isinstance(rel.get("artist"), dict) else None
                if band:
                    side_projects.append(band)

    def uniq(xs: list[str]) -> list[str]:
        seen: set[str] = set()
        out: list[str] = []
        for x in xs:
            k = norm(x)
            if k and k not in seen:
                seen.add(k)
                out.append(x)
        return out

    return {
        "producers": uniq(producers),
        "engineers": uniq(engineers),
        "side_projects": uniq(side_projects),
    }


def discogs_pressing(artist: str, album: str) -> dict[str, str]:
    if not artist or not album:
        return {}
    if not DISCOGS_TOKEN and not DRY_RUN:
        # Unauthenticated Discogs is heavily rate-limited; skip quietly.
        return {}
    params = {
        "artist": artist,
        "release_title": album,
        "type": "release",
        "per_page": "5",
    }
    url = "https://api.discogs.com/database/search?" + urllib.parse.urlencode(params)
    headers = {"User-Agent": USER_AGENT}
    if DISCOGS_TOKEN:
        headers["Authorization"] = f"Discogs token={DISCOGS_TOKEN}"
    data = http_get_json(url, headers=headers, limiter=_discogs_limiter) or {}
    results = data.get("results") or []
    if not results:
        return {}
    top = results[0]
    label = ""
    labels = top.get("label") or []
    if isinstance(labels, list) and labels:
        label = str(labels[0])
    catno = str(top.get("catno") or "")
    country = str(top.get("country") or "")
    return {
        "label": label,
        "catno": catno,
        "country": country,
        "year": str(top.get("year") or ""),
    }


def enrich_track(sig: TrackSignal) -> TrackSignal:
    """AudD/local → Deezer ISRC → MusicBrainz MBIDs/relations → Discogs pressing."""
    notes = list(sig.enrichment_notes)

    if DRY_RUN:
        notes.append("dry_run: skipped live enrichment")
        sig.enrichment_notes = notes
        return sig

    # 1) ISRC via Deezer (or keep AudD-provided ISRC).
    if not sig.isrc and sig.artist and sig.title:
        try:
            isrc = deezer_isrc(sig.artist, sig.title, sig.album)
            if isrc:
                sig.isrc = isrc
                notes.append("isrc:deezer")
        except Exception as e:  # noqa: BLE001 — fail soft per track
            notes.append(f"deezer_error:{e}")

    # 2) MusicBrainz via ISRC.
    if sig.isrc:
        try:
            mb = musicbrainz_by_isrc(sig.isrc)
            sig.recording_mbid = mb.get("recording_mbid") or sig.recording_mbid
            sig.artist_mbid = mb.get("artist_mbid") or sig.artist_mbid
            sig.release_mbid = mb.get("release_mbid") or sig.release_mbid
            if not sig.album and mb.get("album"):
                sig.album = mb["album"]
            notes.append("mb:isrc")
        except Exception as e:  # noqa: BLE001
            notes.append(f"mb_isrc_error:{e}")

    # 3) Relational data from MBIDs.
    if sig.artist_mbid or sig.release_mbid:
        try:
            rels = musicbrainz_relations(sig.artist_mbid, sig.release_mbid)
            sig.producers = rels.get("producers") or []
            sig.engineers = rels.get("engineers") or []
            sig.side_projects = rels.get("side_projects") or []
            notes.append("mb:relations")
        except Exception as e:  # noqa: BLE001
            notes.append(f"mb_rel_error:{e}")

    # 4) Discogs pressing.
    if sig.artist and sig.album:
        try:
            press = discogs_pressing(sig.artist, sig.album)
            if press:
                sig.discogs_label = press.get("label") or ""
                sig.discogs_catno = press.get("catno") or ""
                sig.discogs_country = press.get("country") or ""
                if not sig.year and press.get("year"):
                    try:
                        sig.year = int(press["year"])
                    except ValueError:
                        pass
                notes.append("discogs:pressing")
        except Exception as e:  # noqa: BLE001
            notes.append(f"discogs_error:{e}")

    sig.enrichment_notes = notes
    return sig


def enrich_batch(signals: list[TrackSignal], limit: int = MAX_ENRICH) -> list[TrackSignal]:
    out: list[TrackSignal] = []
    for i, sig in enumerate(signals):
        if i >= limit:
            sig.enrichment_notes = list(sig.enrichment_notes) + ["enrichment_capped"]
            out.append(sig)
            continue
        log(f"enrich [{i+1}/{min(len(signals), limit)}] {sig.artist} — {sig.title}")
        out.append(enrich_track(sig))
    return out


# ── precision score ───────────────────────────────────────────────────────────

def calculate_precision_score(now: datetime) -> dict[str, Any]:
    """
    Yesterday's recommendation success rate:
      (Successful Discoveries / Total Recommendations) * 100

    Sources (first hit wins for the denominator):
      - recommendations.json entries dated yesterday
      - taste-ledger.jsonl discover accept|reject for yesterday
      - discovery-feedback.json notForMe + accepted keys as fallback
    """
    day_start = (now - timedelta(days=1)).astimezone(timezone.utc).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    day_end = day_start + timedelta(days=1)
    day_iso = day_start.strftime("%Y-%m-%d")

    total = 0
    success = 0
    source = "none"

    # 1) recommendations.json — list or {items:[...]} with optional accepted/status.
    reco = jread(RECOMMENDATIONS, None)
    items: list[Any] = []
    if isinstance(reco, list):
        items = reco
    elif isinstance(reco, dict):
        items = reco.get("items") or reco.get("recommendations") or reco.get("tracks") or []

    dated = []
    for it in items:
        if not isinstance(it, dict):
            continue
        ts = parse_ts(it.get("ts") or it.get("at") or it.get("date") or it.get("recommendedAt"))
        if ts is None:
            # Untimestamped list: treat whole file as "yesterday's slate".
            dated.append(it)
            continue
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        if day_start <= ts < day_end:
            dated.append(it)
    if dated:
        source = "recommendations.json"
        total = len(dated)
        for it in dated:
            status = norm(it.get("status") or it.get("verdict") or "")
            if status in ("accept", "accepted", "success", "kept", "added") or it.get("accepted") is True:
                success += 1
            elif it.get("addedToLibrary") or it.get("successful"):
                success += 1

    # 2) taste-ledger discover surface for the calendar day.
    if total == 0:
        for ev in jlines(TASTE_LEDGER):
            if ev.get("surface") != "discover":
                continue
            ts = parse_ts(ev.get("ts"))
            if ts is None:
                continue
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
            if not (day_start <= ts < day_end):
                continue
            total += 1
            if ev.get("verdict") == "accept":
                success += 1
        if total:
            source = "taste-ledger.jsonl"

    # 3) discovery-feedback fallback — lifetime rates are weak; still better than silence.
    if total == 0:
        fb = jread(DISCOVERY_FB, {})
        if isinstance(fb, dict):
            not_for_me = fb.get("notForMe") or {}
            accepted = fb.get("accepted") or fb.get("loved") or {}
            # Prefer day-scoped entries when `at` is present.
            day_acc = day_rej = 0
            for bucket, is_acc in ((accepted, True), (not_for_me, False)):
                if not isinstance(bucket, dict):
                    continue
                for _k, meta in bucket.items():
                    at = None
                    if isinstance(meta, dict):
                        at = parse_ts(meta.get("at") or meta.get("ts"))
                    elif isinstance(meta, (int, float)):
                        # epoch ms or sec
                        sec = meta / 1000.0 if meta > 1e12 else float(meta)
                        at = datetime.fromtimestamp(sec, tz=timezone.utc)
                    if at is None:
                        continue
                    if at.tzinfo is None:
                        at = at.replace(tzinfo=timezone.utc)
                    if day_start <= at < day_end:
                        if is_acc:
                            day_acc += 1
                        else:
                            day_rej += 1
            if day_acc + day_rej > 0:
                success, total = day_acc, day_acc + day_rej
                source = "discovery-feedback.json(day)"
            else:
                # Last resort: overall accept vs veto if both present.
                n_acc = len(accepted) if isinstance(accepted, dict) else 0
                n_rej = len(not_for_me) if isinstance(not_for_me, dict) else 0
                if n_acc + n_rej > 0:
                    success, total = n_acc, n_acc + n_rej
                    source = "discovery-feedback.json(lifetime)"

    precision = round((success / total) * 100.0, 2) if total else 0.0
    return {
        "precision_score": precision,
        "successful_discoveries": success,
        "total_recommendations": total,
        "day": day_iso,
        "source": source,
        "weight_hint": weight_hint_for(precision),
    }


def weight_hint_for(precision: float) -> str:
    """Dynamic algorithm guidance fed into the master prompt."""
    if precision >= 70:
        return (
            "Precision is healthy — keep the current blend of genre adjacency and "
            "Discogs label threads; explore one lateral producer link per query."
        )
    if precision >= 40:
        return (
            "Precision is middling — lean harder on Discogs record labels and "
            "MusicBrainz producer/engineer overlaps; de-weight generic genre tags."
        )
    return (
        "Precision is low — heavily prioritize Discogs labels, catalog-number "
        "neighborhoods, and shared producers from positive signals; treat genre "
        "tags as weak hints only. Avoid anything sharing negative-signal labels."
    )


# ── memory tiering ────────────────────────────────────────────────────────────

def detect_vector_store() -> Optional[str]:
    for p in VECTOR_CANDIDATES:
        if p.exists():
            return str(p)
    return None


def load_memory_tiers(now: datetime) -> tuple[dict[str, Any], dict[str, Any]]:
    ltm = jread(LTM_PATH, None)
    if not isinstance(ltm, dict):
        ltm = {
            "version": 1,
            "created_at": now.isoformat(),
            "core_labels": {},
            "core_producers": {},
            "core_artists": {},
            "eras": {},
            "notes": [],
        }
    stm = jread(STM_PATH, None)
    if not isinstance(stm, dict):
        stm = {"version": 1, "window_hours": STM_HOURS, "events": []}
    # Prune STM to last 48h.
    cutoff = now - timedelta(hours=STM_HOURS)
    events = []
    for ev in stm.get("events") or []:
        if not isinstance(ev, dict):
            continue
        ts = parse_ts(ev.get("ts"))
        if ts is None:
            continue
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        if ts >= cutoff:
            events.append(ev)
    stm["events"] = events
    stm["window_hours"] = STM_HOURS
    stm["vector_store"] = detect_vector_store()
    return ltm, stm


def update_memory_tiers(
    ltm: dict[str, Any],
    stm: dict[str, Any],
    positives: list[TrackSignal],
    negatives: list[TrackSignal],
    precision: dict[str, Any],
    now: datetime,
) -> tuple[dict[str, Any], dict[str, Any]]:
    ts = now.isoformat()

    def bump(bucket: dict[str, Any], key: str, weight: float = 1.0) -> None:
        if not key:
            return
        entry = bucket.get(key) or {"count": 0, "weight": 0.0}
        entry["count"] = int(entry.get("count") or 0) + 1
        entry["weight"] = round(float(entry.get("weight") or 0.0) + weight, 4)
        entry["last_seen"] = ts
        bucket[key] = entry

    # Precision-aware weights: low precision → amplify label/producer threads.
    prec = float(precision.get("precision_score") or 0)
    label_w = 1.5 if prec < 40 else (1.2 if prec < 70 else 1.0)
    genre_w = 0.4 if prec < 40 else (0.7 if prec < 70 else 1.0)

    for sig in positives:
        bump(ltm.setdefault("core_artists", {}), sig.artist, 1.0)
        bump(ltm.setdefault("core_labels", {}), sig.discogs_label, label_w)
        for p in sig.producers:
            bump(ltm.setdefault("core_producers", {}), p, label_w)
        if sig.genre:
            bump(ltm.setdefault("core_genres", {}), sig.genre, genre_w)
        if sig.year:
            era = f"{(sig.year // 10) * 10}s"
            bump(ltm.setdefault("eras", {}), era, 1.0)
        stm.setdefault("events", []).append(
            {
                "ts": ts,
                "polarity": "positive",
                "artist": sig.artist,
                "title": sig.title,
                "label": sig.discogs_label or None,
                "producers": sig.producers,
            }
        )

    for sig in negatives:
        # Negatives: store in STM + soft-penalize LTM label affinity.
        stm.setdefault("events", []).append(
            {
                "ts": ts,
                "polarity": "negative",
                "artist": sig.artist,
                "title": sig.title,
                "elapsed_sec": sig.elapsed_sec,
                "label": sig.discogs_label or None,
            }
        )
        if sig.discogs_label:
            bump(ltm.setdefault("avoid_labels", {}), sig.discogs_label, 1.0)

    ltm["updated_at"] = ts
    ltm["last_precision"] = precision
    stm["updated_at"] = ts
    stm["vector_store"] = detect_vector_store()
    return ltm, stm


# ── hidden-thread analysis (for prompt context) ───────────────────────────────

def find_hidden_threads(
    positives: list[TrackSignal],
    negatives: list[TrackSignal],
) -> dict[str, list[str]]:
    def collect(sigs: list[TrackSignal]) -> dict[str, set[str]]:
        bags = {
            "producers": set(),
            "labels": set(),
            "eras": set(),
            "engineers": set(),
            "side_projects": set(),
        }
        for s in sigs:
            bags["producers"].update(s.producers)
            bags["engineers"].update(s.engineers)
            bags["side_projects"].update(s.side_projects)
            if s.discogs_label:
                bags["labels"].add(s.discogs_label)
            if s.year:
                bags["eras"].add(f"{(s.year // 10) * 10}s")
        return bags

    pos = collect(positives)
    neg = collect(negatives)
    return {
        k: sorted(pos[k] - neg[k], key=str.lower)
        for k in pos
    }


# ── LLM orchestrator ─────────────────────────────────────────────────────────

MASTER_PROMPT_TEMPLATE = """You are a master crate-digger and music algorithm tuned to this user's unique taste.
Yesterday's recommendation precision score was: {precision_score}%.
{weight_hint}

Analyze the following contrastive data from today's listening logs:
- POSITIVE SIGNALS (Enriched via Deezer, MusicBrainz, Discogs): {positive_signals_json}
- NEGATIVE SIGNALS (Tracks to avoid): {negative_signals_json}

Hidden threads present in positives and absent from negatives:
{hidden_threads_json}

Long-term memory snapshot (core tastes):
{ltm_json}

Short-term memory (last {stm_hours}h):
{stm_json}

Your goal is to adjust your internal retrieval weights. Identify hidden threads (overlapping producers, record labels, or release eras) in the positive signals that are entirely absent in the negative signals. Update the long-term memory matrix and output 5 precise search queries for the Deezer API to discover new music for tomorrow.
"""


def build_master_prompt(
    precision: dict[str, Any],
    positives: list[TrackSignal],
    negatives: list[TrackSignal],
    ltm: dict[str, Any],
    stm: dict[str, Any],
    threads: dict[str, list[str]],
) -> str:
    pos_json = json.dumps([s.to_prompt_dict() for s in positives], ensure_ascii=False, indent=2)
    neg_json = json.dumps([s.to_prompt_dict() for s in negatives], ensure_ascii=False, indent=2)
    # Keep LTM compact for the prompt — top weights only.
    ltm_compact = {
        "core_labels": _top_n(ltm.get("core_labels") or {}, 12),
        "core_producers": _top_n(ltm.get("core_producers") or {}, 12),
        "core_artists": _top_n(ltm.get("core_artists") or {}, 12),
        "eras": _top_n(ltm.get("eras") or {}, 8),
        "avoid_labels": _top_n(ltm.get("avoid_labels") or {}, 8),
        "last_precision": ltm.get("last_precision"),
    }
    stm_compact = {
        "window_hours": stm.get("window_hours"),
        "event_count": len(stm.get("events") or []),
        "recent": (stm.get("events") or [])[-20:],
        "vector_store": stm.get("vector_store"),
    }
    return MASTER_PROMPT_TEMPLATE.format(
        precision_score=precision.get("precision_score", 0),
        weight_hint=precision.get("weight_hint", ""),
        positive_signals_json=pos_json,
        negative_signals_json=neg_json,
        hidden_threads_json=json.dumps(threads, ensure_ascii=False, indent=2),
        ltm_json=json.dumps(ltm_compact, ensure_ascii=False, indent=2),
        stm_json=json.dumps(stm_compact, ensure_ascii=False, indent=2),
        stm_hours=STM_HOURS,
    )


def _top_n(bucket: dict[str, Any], n: int) -> dict[str, Any]:
    items = []
    for k, v in bucket.items():
        if isinstance(v, dict):
            w = float(v.get("weight") or v.get("count") or 0)
        else:
            w = float(v or 0)
        items.append((k, v, w))
    items.sort(key=lambda x: x[2], reverse=True)
    return {k: v for k, v, _ in items[:n]}


def llm_orchestrator(
    precision: dict[str, Any],
    positives: list[TrackSignal],
    negatives: list[TrackSignal],
    ltm: dict[str, Any],
    stm: dict[str, Any],
) -> dict[str, Any]:
    """
    Compile enriched contrastive data into a single master prompt string.
    Optionally POST to a local LLM if NIGHTLY_LLM_URL is set; otherwise write
    the prompt for the homemini brain to consume.
    """
    threads = find_hidden_threads(positives, negatives)
    prompt = build_master_prompt(precision, positives, negatives, ltm, stm, threads)
    result: dict[str, Any] = {
        "prompt": prompt,
        "hidden_threads": threads,
        "precision": precision,
        "positive_count": len(positives),
        "negative_count": len(negatives),
        "llm_response": None,
    }

    llm_url = os.environ.get("NIGHTLY_LLM_URL", "").strip()
    if llm_url and not DRY_RUN:
        # Ollama-compatible generate endpoint by default.
        payload = json.dumps(
            {
                "model": os.environ.get("NIGHTLY_LLM_MODEL", "gemma3:4b"),
                "prompt": prompt,
                "stream": False,
            }
        ).encode("utf-8")
        req = urllib.request.Request(
            llm_url,
            data=payload,
            headers={"Content-Type": "application/json", "User-Agent": USER_AGENT},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                body = json.loads(resp.read().decode("utf-8"))
            result["llm_response"] = body.get("response") or body.get("text") or body
        except Exception as e:  # noqa: BLE001
            log(f"LLM call failed (prompt still saved): {e}")
            result["llm_error"] = str(e)
    return result


# ── music_engine SQLite bridge ────────────────────────────────────────────────

def _load_music_engine_db():
    """Optional bridge to scripts/music_engine.MusicEngineDatabase."""
    try:
        scripts_dir = Path(__file__).resolve().parent
        if str(scripts_dir) not in sys.path:
            sys.path.insert(0, str(scripts_dir))
        from music_engine import MusicEngineDatabase  # type: ignore

        db_path = Path(os.environ.get("MUSIC_ENGINE_DB") or (STATE_DIR / "music_server.db"))
        return MusicEngineDatabase(db_path)
    except Exception as e:  # noqa: BLE001
        log(f"music_engine DB unavailable: {e}")
        return None


def sync_signals_to_engine_db(
    db: Any,
    positives: list[TrackSignal],
    negatives: list[TrackSignal],
    lib: dict[tuple[str, str], dict[str, Any]],
) -> None:
    """Mirror contrastive signals into SQLite listening_logs for the NAS engine."""
    for sig in positives:
        meta = lib.get(sig.key()) or {}
        total = float(meta.get("duration") or 0) or (sig.elapsed_sec or DEFAULT_TRACK_SEC)
        if total > 10_000:
            total = total / 1000.0
        play = float(sig.elapsed_sec if sig.elapsed_sec is not None else total)
        db.log_playback(
            track_id=str(meta.get("id") or f"{sig.artist}|{sig.title}"),
            isrc=sig.isrc or "",
            artist=sig.artist,
            title=sig.title,
            play_time=play,
            total_time=total,
        )
    for sig in negatives:
        meta = lib.get(sig.key()) or {}
        total = float(meta.get("duration") or 0) or DEFAULT_TRACK_SEC
        if total > 10_000:
            total = total / 1000.0
        play = float(sig.elapsed_sec if sig.elapsed_sec is not None else min(SKIP_SEC_THRESHOLD - 0.1, total))
        db.log_playback(
            track_id=str(meta.get("id") or f"{sig.artist}|{sig.title}"),
            isrc=sig.isrc or "",
            artist=sig.artist,
            title=sig.title,
            play_time=play,
            total_time=max(total, 31.0),  # ensure early-skip rule can fire
        )


def merge_engine_db_signals(
    db: Any,
    positives: list[TrackSignal],
    negatives: list[TrackSignal],
    now: datetime,
) -> tuple[list[TrackSignal], list[TrackSignal]]:
    """Fold SQLite listening_logs (e.g. from inbox ingest clients) into contrastive sets."""
    since = (now - timedelta(days=1)).isoformat()
    try:
        bags = db.get_contrastive_signals(since)
    except Exception as e:  # noqa: BLE001
        log(f"engine contrastive read failed: {e}")
        return positives, negatives
    seen_p = {p.key() for p in positives}
    seen_n = {n.key() for n in negatives}
    for row in bags.get("positive_signals") or []:
        k = (norm(row.get("artist")), norm(row.get("title")))
        if not (k[0] or k[1]) or k in seen_p:
            continue
        positives.append(
            TrackSignal(
                artist=row.get("artist") or "",
                title=row.get("title") or "",
                source="engine_db",
                isrc=row.get("isrc") or "",
                elapsed_sec=row.get("play_duration_seconds"),
            )
        )
        seen_p.add(k)
    for row in bags.get("negative_signals") or []:
        k = (norm(row.get("artist")), norm(row.get("title")))
        if not (k[0] or k[1]) or k in seen_n or k in seen_p:
            continue
        negatives.append(
            TrackSignal(
                artist=row.get("artist") or "",
                title=row.get("title") or "",
                source="engine_db_skip",
                isrc=row.get("isrc") or "",
                elapsed_sec=row.get("play_duration_seconds"),
            )
        )
        seen_n.add(k)
    return positives, negatives


# ── main ──────────────────────────────────────────────────────────────────────

def write_status(payload: dict[str, Any]) -> None:
    try:
        jwrite_atomic(STATUS_PATH, payload)
    except OSError as e:
        log(f"status write failed: {e}")


def main() -> int:
    now = datetime.now(timezone.utc)
    log(f"start STATE_DIR={STATE_DIR} dry_run={DRY_RUN}")
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    try:
        engine_db = _load_music_engine_db()
        lib = load_library_index()
        events = load_day_events(now)
        log(f"listening events (24h): {len(events)}; library index: {len(lib)}")

        positives, negatives = classify_contrastive(events, lib)
        if engine_db is not None:
            positives, negatives = merge_engine_db_signals(engine_db, positives, negatives, now)

        audd_new = load_audd_candidates()
        # Fold newly recognized AudD tracks into positives (discovery fuel).
        seen = {p.key() for p in positives}
        for a in audd_new:
            if a.key() not in seen:
                positives.append(a)
                seen.add(a.key())

        log(f"signals: +{len(positives)} / -{len(negatives)} (audd/path adds: {len(audd_new)})")

        # Enrich positives fully; negatives lightly (identity only — skip Discogs spam).
        positives = enrich_batch(positives, limit=MAX_ENRICH)
        # Still try ISRC/MB for a small negative sample so avoid-threads are real.
        negatives = enrich_batch(negatives, limit=min(10, MAX_ENRICH))

        precision = calculate_precision_score(now)
        log(
            f"precision={precision['precision_score']}% "
            f"({precision['successful_discoveries']}/{precision['total_recommendations']}) "
            f"via {precision['source']}"
        )

        if engine_db is not None:
            try:
                engine_db.record_precision(
                    date=str(precision.get("day") or now.strftime("%Y-%m-%d")),
                    total_recommended=int(precision.get("total_recommendations") or 0),
                    successful_discoveries=int(precision.get("successful_discoveries") or 0),
                    precision_score=float(precision.get("precision_score") or 0),
                )
                sync_signals_to_engine_db(engine_db, positives, negatives, lib)
                for sig in positives:
                    if sig.isrc or sig.discogs_label or sig.producers:
                        engine_db.upsert_enrichment(
                            sig.artist,
                            sig.title,
                            sig.album or "",
                            {
                                "isrc": sig.isrc,
                                "mbid": sig.recording_mbid,
                                "producers_engineers": [
                                    {"role": "producer", "name": p} for p in sig.producers
                                ]
                                + [{"role": "engineer", "name": e} for e in sig.engineers],
                                "discogs": {
                                    "record_label": sig.discogs_label,
                                    "catalog_number": sig.discogs_catno,
                                    "country": sig.discogs_country,
                                },
                            },
                        )
                log(f"synced contrastive + precision → {engine_db.db_path}")
            except Exception as e:  # noqa: BLE001
                log(f"engine DB sync failed (non-fatal): {e}")

        ltm, stm = load_memory_tiers(now)
        ltm, stm = update_memory_tiers(ltm, stm, positives, negatives, precision, now)
        jwrite_atomic(LTM_PATH, ltm)
        jwrite_atomic(STM_PATH, stm)

        orchestrated = llm_orchestrator(precision, positives, negatives, ltm, stm)

        stamp = now.strftime("%Y%m%dT%H%M%SZ")
        positive_path = OUT_DIR / f"positive_signals_{stamp}.json"
        negative_path = OUT_DIR / f"negative_signals_{stamp}.json"
        prompt_path = OUT_DIR / f"master_prompt_{stamp}.txt"
        bundle_path = OUT_DIR / f"nightly_bundle_{stamp}.json"
        latest_prompt = OUT_DIR / "master_prompt_latest.txt"
        latest_bundle = OUT_DIR / "nightly_bundle_latest.json"

        jwrite_atomic(positive_path, [s.to_prompt_dict() for s in positives])
        jwrite_atomic(negative_path, [s.to_prompt_dict() for s in negatives])
        prompt_path.write_text(orchestrated["prompt"], encoding="utf-8")
        latest_prompt.write_text(orchestrated["prompt"], encoding="utf-8")

        bundle = {
            "at": now.isoformat(),
            "precision": precision,
            "hidden_threads": orchestrated["hidden_threads"],
            "positive_signals": [s.to_prompt_dict() for s in positives],
            "negative_signals": [s.to_prompt_dict() for s in negatives],
            "memory": {
                "ltm_path": str(LTM_PATH),
                "stm_path": str(STM_PATH),
                "vector_store": detect_vector_store(),
                "music_engine_db": str(getattr(engine_db, "db_path", None) or ""),
            },
            "prompt_path": str(prompt_path),
            "llm_response": orchestrated.get("llm_response"),
            "llm_error": orchestrated.get("llm_error"),
        }
        jwrite_atomic(bundle_path, bundle)
        jwrite_atomic(latest_bundle, bundle)

        write_status(
            {
                "ok": True,
                "at": now.isoformat(),
                "precision_score": precision["precision_score"],
                "positives": len(positives),
                "negatives": len(negatives),
                "prompt_path": str(latest_prompt),
                "dry_run": DRY_RUN,
            }
        )
        log(f"wrote prompt → {latest_prompt}")
        log("done")
        return 0
    except Exception as e:  # noqa: BLE001
        log(f"FATAL: {e}")
        write_status({"ok": False, "at": now.isoformat(), "error": str(e)})
        return 1


if __name__ == "__main__":
    sys.exit(main())
