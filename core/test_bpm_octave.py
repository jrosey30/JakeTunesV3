"""Pure unit tests for the BPM octave arbiter — no audio decode required.

Run: python3 core/test_bpm_octave.py
"""
from __future__ import annotations

import math
import sys

import numpy as np

# Import siblings without installing the package.
sys.path.insert(0, ".")
from audio_analysis import _arbitrate_bpm_octave, _score_tempo_onsets  # noqa: E402


def _click_onset(bpm: float, sr: float = 22050.0, seconds: float = 20.0, hop: int = 512):
    """Synthetic onset envelope with impulses every beat at `bpm`."""
    fps = sr / hop
    n = int(seconds * fps)
    onset = np.zeros(n, dtype=float)
    interval = 60.0 / bpm
    t = 0.0
    while t < seconds:
        frame = int(round(t * fps))
        if 0 <= frame < n:
            onset[frame] = 1.0
            # small smear so phase search isn't a single-bin lottery
            if frame + 1 < n:
                onset[frame + 1] = 0.4
        t += interval
    return onset


def test_prefers_true_tempo_when_extractor_doubled():
    # True 86 BPM track; extractor returned 172 (Ken Pomeroy class).
    true_bpm = 86.0
    onset = _click_onset(true_bpm)
    got = _arbitrate_bpm_octave(onset, 22050.0, 172.0)
    assert abs(got - true_bpm) < 1.0, f"expected ~{true_bpm}, got {got}"


def test_keeps_measured_when_scores_close():
    # Genuine mid-tempo: half/double grids shouldn't clearly win.
    true_bpm = 156.0
    onset = _click_onset(true_bpm)
    got = _arbitrate_bpm_octave(onset, 22050.0, true_bpm)
    assert abs(got - true_bpm) < 1.0, f"expected keep {true_bpm}, got {got}"


def test_halved_extractor_gets_doubled_back():
    # Extractor locked onto half (classic hardcore 180 → 90).
    true_bpm = 180.0
    onset = _click_onset(true_bpm)
    got = _arbitrate_bpm_octave(onset, 22050.0, 90.0)
    assert abs(got - true_bpm) < 1.0, f"expected ~{true_bpm}, got {got}"


def test_score_higher_on_true_grid():
    onset = _click_onset(100.0)
    s_true = _score_tempo_onsets(onset, 22050.0, 100.0)
    s_half = _score_tempo_onsets(onset, 22050.0, 50.0)
    s_dbl = _score_tempo_onsets(onset, 22050.0, 200.0)
    assert s_true > s_half, (s_true, s_half)
    assert s_true > s_dbl, (s_true, s_dbl)
    assert math.isfinite(s_true)


if __name__ == "__main__":
    test_score_higher_on_true_grid()
    test_prefers_true_tempo_when_extractor_doubled()
    test_keeps_measured_when_scores_close()
    test_halved_extractor_gets_doubled_back()
    print("ok — 4 bpm octave tests passed")
