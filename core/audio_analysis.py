"""
Audio analysis for a single track — BPM, musical key, Camelot wheel
position. Used by JakeTunes 4.0 §2.4 to enrich the library with the
metadata needed for DJ-grade transitions and harmonic playlists.

BPM via `aubio` (fast, accurate-enough for most material).
Key via `librosa` (chromagram → Krumhansl-Schmuckler key estimation).
Camelot via deterministic lookup from (key, mode).

Usage:
    audio_analysis.py /path/to/audio.m4a

Output (stdout, single JSON line):
    {
      "ok": true,
      "bpm": 124.0,
      "keyRoot": "A",         # one of C, C#, D, D#, E, F, F#, G, G#, A, A#, B
      "keyMode": "minor",     # "major" or "minor"
      "camelotKey": "8A"      # 1A-12A or 1B-12B
    }

On failure:
    { "ok": false, "error": "<message>" }

Designed to be invoked one-shot per file. Prints exactly one JSON object
to stdout and exits. Errors go to stderr; status is communicated via the
JSON `ok` field, not the exit code (so the Electron main process can
parse the JSON regardless).
"""

import argparse
import json
import sys
import warnings


# Camelot wheel — standard DJ notation. Each key has a position 1-12 and a
# letter (A = minor, B = major). Adjacent positions on the wheel are
# harmonically compatible. Built from the canonical Camelot ↔ key mapping
# every DJ tool uses; matches Mixed In Key, Rekordbox, Traktor.
CAMELOT: dict[tuple[str, str], str] = {
    ("C",  "major"): "8B",  ("A",  "minor"): "8A",
    ("G",  "major"): "9B",  ("E",  "minor"): "9A",
    ("D",  "major"): "10B", ("B",  "minor"): "10A",
    ("A",  "major"): "11B", ("F#", "minor"): "11A",
    ("E",  "major"): "12B", ("C#", "minor"): "12A",
    ("B",  "major"): "1B",  ("G#", "minor"): "1A",
    ("F#", "major"): "2B",  ("D#", "minor"): "2A",
    ("C#", "major"): "3B",  ("A#", "minor"): "3A",  # Db major / Bb minor
    ("G#", "major"): "4B",  ("F",  "minor"): "4A",  # Ab major
    ("D#", "major"): "5B",  ("C",  "minor"): "5A",  # Eb major
    ("A#", "major"): "6B",  ("G",  "minor"): "6A",  # Bb major
    ("F",  "major"): "7B",  ("D",  "minor"): "7A",
}

# Pitch class names, indexed 0-11 starting from C. Matches librosa's
# default chromagram axis ordering.
PITCH_CLASSES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Krumhansl-Schmuckler key profiles. These are the cognitive-research-
# derived weights for how strongly each pitch class is heard in major vs
# minor keys. The estimation is: take the mean chromagram of the track,
# rotate it across all 12 starting roots × 2 modes (24 candidate keys),
# correlate with the profile, pick the highest correlation.
KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]


def estimate_bpm(path: str) -> float:
    """BPM via aubio's onset/tempo detector. Returns 0.0 on failure."""
    try:
        from aubio import source, tempo
    except ImportError as exc:
        raise RuntimeError(f"aubio not installed: {exc}") from exc

    win_s = 1024
    hop_s = 512
    src = source(path, 0, hop_s)  # samplerate=0 → use file's native rate
    samplerate = src.samplerate
    o = tempo("default", win_s, hop_s, samplerate)

    beats: list[float] = []
    total_frames = 0
    while True:
        samples, read = src()
        if o(samples):
            beats.append(o.get_last_s())
        total_frames += read
        if read < hop_s:
            break

    if len(beats) < 2:
        return 0.0

    # Median inter-beat interval is more robust to outliers than mean.
    intervals = sorted(beats[i + 1] - beats[i] for i in range(len(beats) - 1))
    median_interval = intervals[len(intervals) // 2]
    if median_interval <= 0:
        return 0.0
    return round(60.0 / median_interval, 1)


def estimate_key(path: str) -> tuple[str, str]:
    """Returns (keyRoot, keyMode) — e.g. ("A", "minor"). Empty strings on failure."""
    # Suppress librosa's expected warnings on short tracks / odd sample rates;
    # they're informational and would pollute stderr.
    warnings.filterwarnings("ignore")

    try:
        import librosa
        import numpy as np
    except ImportError as exc:
        raise RuntimeError(f"librosa not installed: {exc}") from exc

    # Load mono at librosa's default 22.05 kHz — plenty for chroma.
    y, sr = librosa.load(path, mono=True, sr=22050)
    if y.size == 0:
        return ("", "")

    # Chroma features. CQT (constant-Q transform) chroma is more accurate
    # for key detection than STFT chroma; the difference is meaningful.
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    chroma_mean = chroma.mean(axis=1)  # 12-element vector, one per pitch class
    if not np.any(chroma_mean):
        return ("", "")

    # Krumhansl-Schmuckler: rotate the profile against the chroma vector
    # and take the highest Pearson correlation.
    major = np.asarray(KS_MAJOR, dtype=float)
    minor = np.asarray(KS_MINOR, dtype=float)
    best_score = -2.0
    best_root_idx = 0
    best_mode = "major"
    for shift in range(12):
        rotated = np.roll(chroma_mean, -shift)
        # np.corrcoef returns the 2x2 matrix; we want [0,1].
        maj_score = float(np.corrcoef(rotated, major)[0, 1])
        min_score = float(np.corrcoef(rotated, minor)[0, 1])
        if maj_score > best_score:
            best_score = maj_score
            best_root_idx = shift
            best_mode = "major"
        if min_score > best_score:
            best_score = min_score
            best_root_idx = shift
            best_mode = "minor"

    return (PITCH_CLASSES[best_root_idx], best_mode)


def analyze(path: str) -> dict:
    result: dict = {"ok": False, "bpm": None, "keyRoot": "", "keyMode": "", "camelotKey": ""}
    try:
        bpm = estimate_bpm(path)
    except Exception as exc:  # noqa: BLE001 — surface failure as JSON, don't let it crash
        print(f"[audio_analysis] BPM failed for {path}: {exc}", file=sys.stderr)
        bpm = 0.0

    try:
        root, mode = estimate_key(path)
    except Exception as exc:  # noqa: BLE001
        print(f"[audio_analysis] key failed for {path}: {exc}", file=sys.stderr)
        root, mode = "", ""

    if bpm > 0:
        result["bpm"] = bpm
    if root and mode:
        result["keyRoot"] = root
        result["keyMode"] = mode
        result["camelotKey"] = CAMELOT.get((root, mode), "")

    # ok = true if we got at least one of the two values. If both failed
    # the call site treats it as a hard miss and writes the failure
    # sentinel.
    if result["bpm"] is not None or result["keyRoot"]:
        result["ok"] = True
    else:
        result["error"] = "Both BPM and key estimation failed; see stderr."

    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Analyze a single audio file for BPM, key, Camelot.")
    parser.add_argument("path", help="Path to the audio file.")
    args = parser.parse_args()

    out = analyze(args.path)
    # Always exit 0 — status is in the JSON's `ok` field. Non-zero exit
    # would make the Electron-side spawn() reject and we'd lose the
    # structured error.
    sys.stdout.write(json.dumps(out))
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
