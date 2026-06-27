"""
Audio analysis for one OR MANY tracks — BPM, musical key, Camelot wheel
position. Used by JakeTunes 4.0 §2.4 to enrich the library with the
metadata needed for DJ-grade transitions, harmonic playlists, and (4.5)
tempo/energy facts in the embedding brain.

Both BPM and key come from `librosa`. Originally the scope picked aubio
for BPM, but aubio's pip release has not been updated since 2019 and
fails to compile against modern numpy. librosa.beat.beat_track produces
comparable BPM estimates with one fewer dependency and no C-extension.

BPM via `librosa.beat.beat_track` (onset envelope → DP beat tracker).
Key via `librosa.feature.chroma_cqt` mean → Krumhansl-Schmuckler.
Camelot via deterministic lookup from (key, mode).

4.5 SPEED (Jake: "bpm and key analysis is so slow"):
  1. ONE decode per track, shared by BPM + key — the old code loaded the
     whole file TWICE (once per estimator). Decode dominates the cost.
  2. Analyze a representative 90s MIDDLE slice, not the whole track. Tempo
     and key are consistent within a song; the slice skips intros/outros
     and cuts decode + chroma_cqt work ~3x. Short tracks load whole.
  3. BATCH: accept many paths in one process. librosa's first beat_track/
     chroma_cqt call pays ~1.7s of numba-JIT + scipy warmup; a fresh
     process per track paid that EVERY track. Passing N paths warms once
     and amortizes it (the worker batches; ~5x end-to-end).
  Validated /tmp/bench_analysis.py 2026-06-26: key identical, BPM within a
  few BPM of the full-track answer; 0.45s/track (was 2.95s fresh-process).

Usage:
    audio_analysis.py /path/a.m4a [/path/b.m4a ...]

Output (stdout): one JSON object PER LINE (JSONL), in input order:
    {"path": "...", "ok": true, "bpm": 124.0, "keyRoot": "A",
     "keyMode": "minor", "camelotKey": "8A"}
On per-file failure that line is {"path": "...", "ok": false, "error": "..."}.
Errors go to stderr; status is in each line's `ok` field, exit is always 0
so the Electron side can parse results regardless.
"""

import argparse
import json
import sys
import warnings

warnings.filterwarnings("ignore")

# Camelot wheel — standard DJ notation (A = minor, B = major). Matches
# Mixed In Key / Rekordbox / Traktor.
CAMELOT: dict[tuple[str, str], str] = {
    ("C",  "major"): "8B",  ("A",  "minor"): "8A",
    ("G",  "major"): "9B",  ("E",  "minor"): "9A",
    ("D",  "major"): "10B", ("B",  "minor"): "10A",
    ("A",  "major"): "11B", ("F#", "minor"): "11A",
    ("E",  "major"): "12B", ("C#", "minor"): "12A",
    ("B",  "major"): "1B",  ("G#", "minor"): "1A",
    ("F#", "major"): "2B",  ("D#", "minor"): "2A",
    ("C#", "major"): "3B",  ("A#", "minor"): "3A",
    ("G#", "major"): "4B",  ("F",  "minor"): "4A",
    ("D#", "major"): "5B",  ("C",  "minor"): "5A",
    ("A#", "major"): "6B",  ("G",  "minor"): "6A",
    ("F",  "major"): "7B",  ("D",  "minor"): "7A",
}

PITCH_CLASSES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Krumhansl-Schmuckler key profiles (major / minor pitch-class weights).
KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

_librosa = None
_np = None


def _lazy():
    """Import librosa/numpy once; the heavy numba-JIT + scipy warmup happens
    on the first beat_track/chroma_cqt call and is reused for the whole batch."""
    global _librosa, _np
    if _librosa is None:
        import librosa
        import numpy as np
        _librosa, _np = librosa, np
    return _librosa, _np


def _load_slice(path: str, sr: int = 22050, dur: float = 90.0):
    """ONE decode of a representative middle slice (or the whole track if it's
    short). 22.05 kHz mono is plenty for both beat tracking and chroma."""
    librosa, _ = _lazy()
    total = librosa.get_duration(path=path)
    if total > dur + 10:
        offset = max(0.0, (total - dur) / 2.0)  # center slice — skip intro/outro
        return librosa.load(path, mono=True, sr=sr, offset=offset, duration=dur)
    return librosa.load(path, mono=True, sr=sr)


def _bpm_from(y, sr) -> float:
    """beat_track + octave-clamp into [70,160] (librosa's common failure mode
    is locking onto the half/double-tempo harmonic). 0.0 on failure."""
    librosa, np = _lazy()
    if y.size == 0:
        return 0.0
    tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
    bpm = float(np.asarray(tempo).flatten()[0])
    if bpm <= 0:
        return 0.0
    while bpm > 160 and bpm > 0:
        bpm /= 2
    while bpm < 70 and bpm > 0:
        bpm *= 2
    return round(bpm, 1)


def _key_from(y, sr) -> tuple[str, str]:
    """(keyRoot, keyMode) via CQT chroma mean → Krumhansl-Schmuckler. ('','') on failure."""
    librosa, np = _lazy()
    if y.size == 0:
        return ("", "")
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr).mean(axis=1)
    if not np.any(chroma):
        return ("", "")
    major = np.asarray(KS_MAJOR, dtype=float)
    minor = np.asarray(KS_MINOR, dtype=float)
    best_score = -2.0
    best_root_idx = 0
    best_mode = "major"
    for shift in range(12):
        rotated = np.roll(chroma, -shift)
        maj_score = float(np.corrcoef(rotated, major)[0, 1])
        min_score = float(np.corrcoef(rotated, minor)[0, 1])
        if maj_score > best_score:
            best_score, best_root_idx, best_mode = maj_score, shift, "major"
        if min_score > best_score:
            best_score, best_root_idx, best_mode = min_score, shift, "minor"
    return (PITCH_CLASSES[best_root_idx], best_mode)


def analyze(path: str) -> dict:
    result: dict = {"path": path, "ok": False, "bpm": None, "keyRoot": "", "keyMode": "", "camelotKey": ""}
    try:
        y, sr = _load_slice(path)  # ONE decode shared by both estimators
    except Exception as exc:  # noqa: BLE001
        print(f"[audio_analysis] load failed for {path}: {exc}", file=sys.stderr)
        result["error"] = f"load failed: {exc}"
        return result

    try:
        bpm = _bpm_from(y, sr)
    except Exception as exc:  # noqa: BLE001
        print(f"[audio_analysis] BPM failed for {path}: {exc}", file=sys.stderr)
        bpm = 0.0
    try:
        root, mode = _key_from(y, sr)
    except Exception as exc:  # noqa: BLE001
        print(f"[audio_analysis] key failed for {path}: {exc}", file=sys.stderr)
        root, mode = "", ""

    if bpm > 0:
        result["bpm"] = bpm
    if root and mode:
        result["keyRoot"] = root
        result["keyMode"] = mode
        result["camelotKey"] = CAMELOT.get((root, mode), "")
    if result["bpm"] is not None or result["keyRoot"]:
        result["ok"] = True
    else:
        result["error"] = "Both BPM and key estimation failed; see stderr."
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Analyze audio file(s) for BPM, key, Camelot.")
    parser.add_argument("paths", nargs="+", help="One or more audio file paths.")
    args = parser.parse_args()
    # One JSON line per path, in order, flushed as we go so the worker can
    # stream results and a single hung file never loses the earlier ones.
    for p in args.paths:
        sys.stdout.write(json.dumps(analyze(p)) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
