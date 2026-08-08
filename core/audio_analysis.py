"""
Audio analysis for one OR MANY tracks — BPM, musical key, Camelot wheel
position. Used by JakeTunes 4.0 §2.4 to enrich the library with the
metadata needed for DJ-grade transitions, harmonic playlists, and (4.5)
tempo/energy facts in the embedding brain.

BPM primary: Essentia RhythmExtractor2013 (multifeature), then an onset-
strength octave arbiter that picks bpm vs half vs double by mean onset at
the predicted beats (the machine version of tapping along — see 2026-08-05
Ken Pomeroy "Stranger" 172.3→86.15). librosa.beat.beat_track is the
fallback when Essentia is absent. Key primary: Essentia KeyExtractor vote
across edma/bgate/temperley; librosa chroma_cqt + Krumhansl-Schmuckler as
fallback. Camelot via deterministic lookup from (key, mode).

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


_es = None
_es_tried = False


def _essentia():
    """Essentia's RhythmExtractor2013, imported once. None if unavailable."""
    global _es, _es_tried
    if not _es_tried:
        _es_tried = True
        try:
            import essentia
            import essentia.standard as es
            essentia.log.infoActive = False
            essentia.log.warningActive = False
            _es = es
        except Exception:
            _es = None
    return _es


# How much stronger an octave candidate must score before we abandon the
# measured tempo. 1.15 ≈ the Ken Pomeroy gap (3.54 vs 2.75) without flipping
# Quincy Jones "Soul Bossa Nova" (~156 real) when half only barely wins.
_OCTAVE_MARGIN = 1.15
_BPM_MIN = 40.0
_BPM_MAX = 250.0


def _score_tempo_onsets(onset, sr: float, bpm: float, hop_length: int = 512) -> float:
    """Tap-along score for `bpm`: on-beat onset mean minus off-beat mean.

    Mean-on-beat alone cannot catch half-time errors — a half-tempo grid still
    lands only on real onsets, so it ties the true tempo. Subtracting the
    midpoint (off-beat) mean breaks the tie: too-slow grids put real beats on
    the "off" slots; too-fast grids dilute the on-beat mean with empty frames.
    Phase is unknown a priori, so we try a handful of offsets and keep the best.

    Numpy-only (no librosa) so the arbiter can be unit-tested without the
    full analysis stack.
    """
    import numpy as np
    if bpm <= 0 or onset is None or len(onset) < 8:
        return 0.0
    onset = np.asarray(onset, dtype=float)
    fps = float(sr) / float(hop_length)
    interval = 60.0 / float(bpm)
    duration = len(onset) / fps
    if interval <= 0 or duration < interval * 4:
        return 0.0
    best = -1e9
    # 8 phases across one beat — enough to find the pocket without being a
    # continuous optimization that would invent confidence.
    for phase in np.linspace(0.0, interval, 8, endpoint=False):
        times = np.arange(phase, duration, interval)
        frames = np.round(times * fps).astype(int)
        frames = frames[(frames >= 0) & (frames < len(onset))]
        if frames.size < 4:
            continue
        mid_times = times + (interval * 0.5)
        mid_frames = np.round(mid_times * fps).astype(int)
        mid_frames = mid_frames[(mid_frames >= 0) & (mid_frames < len(onset))]
        onbeat = float(onset[frames].mean())
        offbeat = float(onset[mid_frames].mean()) if mid_frames.size else 0.0
        score = onbeat - offbeat
        if score > best:
            best = score
    return best if best > -1e8 else 0.0


def _arbitrate_bpm_octave(onset, sr: float, bpm: float, margin: float = _OCTAVE_MARGIN) -> float:
    """Choose bpm vs half vs double by tap-along onset score.

    ⚠️ TWIN: the one-shot 2026-08-05 library sweep used this same arbiter
    (mean onset at predicted beats; half won on Ken Pomeroy "Stranger").
    It lives here now so every analysis — not just a data patch — gets it.
    Genre-heuristic `scripts/fix-bpm-octaves.mjs` is a weaker offline cousin
    and must NOT diverge into a third truth; prefer re-analysis through this.
    """
    if bpm <= 0:
        return 0.0
    cands: list[float] = []
    for cand in (bpm, bpm / 2.0, bpm * 2.0):
        if _BPM_MIN <= cand <= _BPM_MAX:
            # Dedup near-identical floats (e.g. bpm already near a bound).
            if not any(abs(cand - c) < 0.5 for c in cands):
                cands.append(cand)
    if len(cands) == 1:
        return round(bpm, 1)

    scored = [(cand, _score_tempo_onsets(onset, sr, cand)) for cand in cands]
    # Prefer the measured tempo when scores are close — the extractor usually
    # has the right metrical level, and blind "max score wins" over-corrected
    # Quincy Jones. Only flip when an octave clearly taps better.
    measured_score = next((s for c, s in scored if abs(c - bpm) < 0.5), 0.0)
    best_cand, best_score = max(scored, key=lambda cs: cs[1])
    if best_score >= measured_score * margin and abs(best_cand - bpm) >= 0.5:
        return round(best_cand, 1)
    return round(bpm, 1)


def _bpm_from(y, sr) -> float:
    """Tempo via Essentia RhythmExtractor2013, librosa as fallback. 0.0 on failure.

    2026-08-02. The previous implementation was librosa.beat.beat_track followed
    by a hard octave clamp:

        while bpm > 160: bpm /= 2
        while bpm <  70: bpm *= 2

    That produced a physically impossible library: 8,812 tracks and NOT ONE
    below 70 or above 160. Fast music was silently halved — and it poisoned the
    brain too, since a 172 BPM track recorded as 86 gets described to the
    embedding as "slow, spacious, downtempo, good for winding down".

    Measured against AcousticBrainz (an independent reference) on a 15-track
    ground-truth set spanning the suspect genres and the ordinary bulk:

        librosa + clamp        10/15 within 5%
        Essentia               14/15 within 5%

    Essentia recovered the cases a wider clamp could never have fixed — e.g.
    Minutemen "Viet Nam" was off by a 3:2 metrical error (107.7 vs 161.9), not
    an octave, and came back exact. It is also the same engine that produced
    the reference numbers, so the library now agrees with the wider world.

    2026-08-08. Essentia still octave-doubles some sparse/fingerpicked tracks
    (Ken Pomeroy "Stranger": 172.3 measured, ~86 by ear). After the extractor
    returns, an onset-strength octave arbiter scores bpm vs half vs double and
    only flips when the alternative clearly taps better (_OCTAVE_MARGIN).
    [40, 250] remains a sanity bound for obvious failures, not a folding window.
    """
    measured = 0.0
    es = _essentia()
    if es is not None:
        try:
            # RhythmExtractor2013 wants 44.1k mono; _load_slice hands us 22.05k.
            librosa, np = _lazy()
            y44 = librosa.resample(y, orig_sr=sr, target_sr=44100) if sr != 44100 else y
            bpm, _b, _conf, _e, _i = es.RhythmExtractor2013(method="multifeature")(
                np.ascontiguousarray(y44, dtype="float32"))
            bpm = float(bpm)
            if _BPM_MIN <= bpm <= _BPM_MAX:
                measured = bpm
        except Exception:
            pass    # fall through to librosa

    librosa, np = _lazy()
    if measured <= 0:
        if y.size == 0:
            return 0.0
        tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
        bpm = float(np.asarray(tempo).flatten()[0])
        if bpm <= 0:
            return 0.0
        # Fallback path only. Kept because SOME number beats none, but the clamp is
        # gone — a folded value is worse than an honest out-of-range one.
        if bpm < _BPM_MIN or bpm > _BPM_MAX:
            return 0.0
        measured = bpm

    # Tap-along octave check — cheap relative to decode; runs on the same slice.
    try:
        onset = librosa.onset.onset_strength(y=y, sr=sr)
        return _arbitrate_bpm_octave(onset, float(sr), measured)
    except Exception:
        return round(measured, 1)


# Essentia key profiles voted against each other. edma and bgate are tuned on
# electronic/popular material; temperley is a broader corpus. Three independent
# answers give both a better estimate AND an honest confidence — where they
# disagree the track is genuinely ambiguous, and no single algorithm fixes that.
KEY_PROFILES = ("edma", "bgate", "temperley")

# Essentia may spell a key with flats; the library stores sharps.
_FLAT_TO_SHARP = {"Db": "C#", "Eb": "D#", "Gb": "F#", "Ab": "G#", "Bb": "A#"}


def _key_from(y, sr) -> tuple[str, str, float]:
    """(keyRoot, keyMode, confidence 0..1). ('', '', 0.0) on failure.

    2026-08-03. Was librosa `chroma_cqt` averaged over the whole 90s slice, then
    Krumhansl-Schmuckler correlation. Measured against Essentia on 120 real
    library tracks, that agreed on only 68% — and 23% of the time it named a
    completely unrelated key (not the relative/parallel mix-up you'd expect).

    Three things were wrong with it. A single mean chroma over 90s smears any
    key change and is dominated by whatever section is loudest. No
    harmonic/percussive separation, so drums pollute the chroma. And the K-S
    profiles come from 1980s experiments on classical music, which is not what
    this library is.

    CONFIDENCE IS NOT DECORATION. The three profiles are unanimous on only ~58%
    of tracks, so roughly two in five have no settled answer at all. Recording
    that lets the app say "probably A minor" instead of asserting it, and lets
    anything downstream (harmonic mixing, playlist keys) skip the guesses.
    """
    es = _essentia()
    if es is not None:
        try:
            librosa, np = _lazy()
            y44 = librosa.resample(y, orig_sr=sr, target_sr=44100) if sr != 44100 else y
            y44 = np.ascontiguousarray(y44, dtype="float32")
            votes: dict[tuple[str, str], list[float]] = {}
            for profile in KEY_PROFILES:
                k, scale, strength = es.KeyExtractor(profileType=profile)(y44)
                root = _FLAT_TO_SHARP.get(str(k).strip(), str(k).strip())
                mode = str(scale).strip().lower()
                if not root or mode not in ("major", "minor"):
                    continue
                votes.setdefault((root, mode), []).append(float(strength))
            if votes:
                # Winner = most votes, ties broken by summed strength.
                best = max(votes.items(), key=lambda kv: (len(kv[1]), sum(kv[1])))
                (root, mode), strengths = best
                agreement = len(strengths) / len(KEY_PROFILES)
                confidence = agreement * (sum(strengths) / len(strengths))
                return (root, mode, round(min(1.0, max(0.0, confidence)), 3))
        except Exception:
            pass    # fall through to the librosa estimate

    librosa, np = _lazy()
    if y.size == 0:
        return ("", "", 0.0)
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr).mean(axis=1)
    if not np.any(chroma):
        return ("", "", 0.0)
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
    # Fallback path only (Essentia unavailable). The K-S correlation is reported
    # as the confidence, floored at 0 — it is a weaker signal than the Essentia
    # vote, and labelling it as such is the point of carrying a number at all.
    return (PITCH_CLASSES[best_root_idx], best_mode, round(max(0.0, best_score), 3))


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
        root, mode, key_conf = _key_from(y, sr)
    except Exception as exc:  # noqa: BLE001
        print(f"[audio_analysis] key failed for {path}: {exc}", file=sys.stderr)
        root, mode, key_conf = "", "", 0.0

    if bpm > 0:
        result["bpm"] = bpm
    if root and mode:
        result["keyRoot"] = root
        result["keyMode"] = mode
        result["camelotKey"] = CAMELOT.get((root, mode), "")
        # How much the three Essentia profiles agreed. Carried so the app can
        # distinguish a settled key from a coin-flip instead of asserting both.
        result["keyConfidence"] = key_conf
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
