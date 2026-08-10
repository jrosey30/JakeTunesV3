#!/usr/bin/env python3
"""
ai_sampler_engine — self-hosted AI sampling pipeline for JakeTunes.

3-step architecture (brain = LLM, hands = local DSP):

  [1. Stem Separation]  →  [2. Transient Chopping]  →  [3. Algorithmic Sequencing]
   Demucs / Spleeter         Librosa onset detection      LLM plan + FFmpeg tracker

The LLM never hears waveforms. It receives a lightweight JSON chop manifest
(slice points, BPM, key hints) and returns an execution array. This module
runs Demucs/Spleeter + librosa + FFmpeg locally to isolate, chop, and
re-sequence those blocks into a reconstructed loop.

Complements scripts/music_engine.py (mixtape stitcher) and
scripts/nightly_loop.py (taste / prompt orchestrator). Sampling jobs can be
queued as JSON under $JT_STATE_DIR/sampling-inbox/ and rendered overnight via:

  python3 scripts/ai_sampler_engine.py nightly-pass

Each job file shape:
  {"source": "/path/to/track.flac", "sampling_request": "4-bar boom-bap at 90 BPM",
   "target_bpm": 90, "stem": "drums", "plan": {...optional LLM execution array...}}

Usage:
  python3 scripts/ai_sampler_engine.py isolate track.flac
  python3 scripts/ai_sampler_engine.py chop drums.flac [--bpm 90]
  python3 scripts/ai_sampler_engine.py slice drums.flac chops.json
  python3 scripts/ai_sampler_engine.py sequence plan.json --out remix.flac
  python3 scripts/ai_sampler_engine.py pipeline track.flac \\
      --request "4-bar boom-bap at 90 BPM" --plan plan.json --out remix.flac
  python3 scripts/ai_sampler_engine.py llm-context chops.json --bpm 120 \\
      --request "Create a 4-bar boom-bap loop layout"

Env:
  JT_STATE_DIR / JT_UD     state dir (default macOS Application Support)
  AI_SAMPLER_VAULT         sample vault root (default $STATE_DIR/samples_vault)
  AI_SAMPLER_SEPARATOR     demucs | spleeter | none  (default: demucs)
  DEMUCS_MODEL             demucs model name (default: htdemucs)
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Optional

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
)
log = logging.getLogger("ai_sampler")

STATE_DIR = Path(
    os.environ.get("JT_STATE_DIR")
    or os.environ.get("JT_UD")
    or os.path.expanduser("~/Library/Application Support/JakeTunes")
)
DEFAULT_VAULT = Path(
    os.environ.get("AI_SAMPLER_VAULT") or (STATE_DIR / "samples_vault")
)

AUDIO_EXTS = {".mp3", ".m4a", ".flac", ".wav", ".aiff", ".aif", ".ogg", ".aac"}
STEM_NAMES = ("drums", "bass", "vocals", "other")


def _separator_pref() -> str:
    return (os.environ.get("AI_SAMPLER_SEPARATOR") or "demucs").strip().lower()


def _demucs_model() -> str:
    return (os.environ.get("DEMUCS_MODEL") or "htdemucs").strip()

try:
    import librosa  # type: ignore
    import numpy as np  # type: ignore
except ImportError:  # pragma: no cover
    librosa = None  # type: ignore
    np = None  # type: ignore

try:
    import soundfile as sf  # type: ignore
except ImportError:  # pragma: no cover
    sf = None  # type: ignore


# =====================================================================
# Data shapes (LLM ↔ engine contract)
# =====================================================================

@dataclass
class ChopSlice:
    sample_index: int
    start_seconds: float
    end_seconds: float
    duration: float
    type: str = "transient"
    path: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        if d["path"] is None:
            d.pop("path")
        return d


@dataclass
class ChopManifest:
    source_stem: str
    source_track_bpm: float
    target_bpm: Optional[float] = None
    detected_chops: list[ChopSlice] = field(default_factory=list)
    key_hint: Optional[str] = None

    def to_llm_context(self, sampling_request: str) -> dict[str, Any]:
        """Lightweight payload for the LLM sequencing brain."""
        return {
            "sampling_request": sampling_request,
            "source_track_bpm": round(float(self.source_track_bpm), 2),
            "target_bpm": self.target_bpm,
            "key_hint": self.key_hint,
            "source_stem": self.source_stem,
            "detected_chops": [c.to_dict() for c in self.detected_chops],
        }

    def to_dict(self) -> dict[str, Any]:
        return {
            "source_stem": self.source_stem,
            "source_track_bpm": self.source_track_bpm,
            "target_bpm": self.target_bpm,
            "key_hint": self.key_hint,
            "detected_chops": [c.to_dict() for c in self.detected_chops],
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ChopManifest":
        chops = [
            ChopSlice(
                sample_index=int(c["sample_index"]),
                start_seconds=float(c["start_seconds"]),
                end_seconds=float(c["end_seconds"]),
                duration=float(c.get("duration") or (c["end_seconds"] - c["start_seconds"])),
                type=str(c.get("type") or "transient"),
                path=c.get("path"),
            )
            for c in (data.get("detected_chops") or [])
        ]
        return cls(
            source_stem=str(data.get("source_stem") or ""),
            source_track_bpm=float(data.get("source_track_bpm") or 0),
            target_bpm=(
                float(data["target_bpm"]) if data.get("target_bpm") is not None else None
            ),
            detected_chops=chops,
            key_hint=data.get("key_hint"),
        )


@dataclass
class SequenceEvent:
    """One hit in an LLM execution plan."""

    sample_index: int
    at_seconds: float
    gain_db: float = 0.0
    pitch_semitones: float = 0.0
    stretch: float = 1.0  # >1 = longer / slower
    reverse: bool = False


@dataclass
class SequencePlan:
    events: list[SequenceEvent]
    target_bpm: Optional[float] = None
    loop_bars: Optional[int] = None
    total_duration: Optional[float] = None
    sampling_request: Optional[str] = None
    swing_percent: float = 50.0  # 50 = straight; 54–58 = head-nod; ≤75 heavy

    def to_dict(self) -> dict[str, Any]:
        return {
            "sampling_request": self.sampling_request,
            "target_bpm": self.target_bpm,
            "loop_bars": self.loop_bars,
            "total_duration": self.total_duration,
            "swing_percent": self.swing_percent,
            "events": [asdict(e) for e in self.events],
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SequencePlan":
        # Accept either {events:[...]} or the flat "execution" alias.
        raw_events = data.get("events") or data.get("execution") or []
        events: list[SequenceEvent] = []
        for e in raw_events:
            if isinstance(e, str):
                parsed = _parse_event_phrase(e)
                if parsed:
                    events.append(parsed)
                continue
            events.append(
                SequenceEvent(
                    sample_index=int(e["sample_index"]),
                    at_seconds=float(e.get("at_seconds", e.get("delay", 0.0))),
                    gain_db=float(e.get("gain_db") or 0.0),
                    pitch_semitones=float(e.get("pitch_semitones") or 0.0),
                    stretch=float(e.get("stretch") or 1.0),
                    reverse=bool(e.get("reverse") or False),
                )
            )
        return cls(
            events=events,
            target_bpm=(
                float(data["target_bpm"]) if data.get("target_bpm") is not None else None
            ),
            loop_bars=(
                int(data["loop_bars"]) if data.get("loop_bars") is not None else None
            ),
            total_duration=(
                float(data["total_duration"])
                if data.get("total_duration") is not None
                else None
            ),
            sampling_request=data.get("sampling_request"),
            swing_percent=float(data.get("swing_percent") or 50.0),
        )


_PLAY_RE = re.compile(
    r"play\s+sample(?:_index)?\s*(?P<idx>\d+)"
    r"(?:.*?delay\s+(?P<delay>[\d.]+)\s*s)?"
    r"(?:.*?stretch\s+(?P<stretch>[\d.]+))?"
    r"(?:.*?pitch\s+(?P<pitch>-?[\d.]+))?",
    re.IGNORECASE,
)


def _parse_event_phrase(phrase: str) -> Optional[SequenceEvent]:
    """Parse loose LLM English like 'Play sample_index 0, delay 0.5s'."""
    m = _PLAY_RE.search(phrase)
    if not m:
        return None
    return SequenceEvent(
        sample_index=int(m.group("idx")),
        at_seconds=float(m.group("delay") or 0.0),
        stretch=float(m.group("stretch") or 1.0),
        pitch_semitones=float(m.group("pitch") or 0.0),
    )


# =====================================================================
# MPC SWING MATH
# =====================================================================
#
# step_duration = 60 / bpm / 4   (one 16th note)
# Even steps (0, 2, 4…): on grid
# Odd steps  (1, 3, 5…): delayed by step_duration * (swing% − 50) / 100
#
# 50% = robotic straight; 54–58% = head-nod boom-bap; 75% = heavy shuffle.

DEFAULT_SWING_PERCENT = 58.0


def clamp_swing_percent(swing_percent: float) -> float:
    return max(50.0, min(75.0, float(swing_percent)))


def sixteenth_duration(target_bpm: float) -> float:
    return 60.0 / float(target_bpm) / 4.0


def swing_offset_seconds(target_bpm: float, swing_percent: float) -> float:
    """Micro-delay applied only to odd 16th-note steps."""
    swing = clamp_swing_percent(swing_percent)
    swing_factor = (swing - 50.0) / 100.0
    return sixteenth_duration(target_bpm) * swing_factor


def mpc_step_delay_seconds(
    step_index: int,
    target_bpm: float,
    swing_percent: float = DEFAULT_SWING_PERCENT,
) -> float:
    """
    Absolute start time for a 16th-note grid step with MPC-style swing.
    Even steps stay on the grid; odd (off-beat) steps get the swing offset.
    """
    step = sixteenth_duration(target_bpm)
    base = int(step_index) * step
    if int(step_index) % 2 != 0:
        return base + swing_offset_seconds(target_bpm, swing_percent)
    return base


def apply_mpc_swing_to_plan(
    plan: SequencePlan,
    swing_percent: float = DEFAULT_SWING_PERCENT,
    *,
    target_bpm: Optional[float] = None,
) -> SequencePlan:
    """
    Re-time plan events onto a swung 16th grid.

    Each event snaps to the nearest 16th step; odd steps receive the MPC
    off-beat micro-delay. Downbeats (even steps) stay exactly on the grid.
    """
    bpm = float(target_bpm or plan.target_bpm or 90.0)
    swing = clamp_swing_percent(swing_percent)
    if abs(swing - 50.0) < 1e-9:
        plan.swing_percent = 50.0
        return plan

    step = sixteenth_duration(bpm)
    swung: list[SequenceEvent] = []
    for ev in plan.events:
        step_index = int(round(ev.at_seconds / step)) if step > 0 else 0
        swung.append(
            SequenceEvent(
                sample_index=ev.sample_index,
                at_seconds=round(
                    mpc_step_delay_seconds(step_index, bpm, swing), 6
                ),
                gain_db=ev.gain_db,
                pitch_semitones=ev.pitch_semitones,
                stretch=ev.stretch,
                reverse=ev.reverse,
            )
        )
    plan.events = swung
    plan.swing_percent = swing
    plan.target_bpm = bpm
    return plan


# =====================================================================
# ALGORITHMIC GROOVE SEQUENCER WITH SWING
# ⚠️ TWIN: scripts/custom_audio_engine.py (GrooveSequencer re-export / CLI)
# =====================================================================

class GrooveSequencer:
    """
    Stitch chops onto a 16th-note grid with configurable MPC swing, then
    bounce via FFmpeg adelay + amix — no destructive edits to source files.
    """

    def __init__(self, output_dir: Path | str | None = None) -> None:
        self.output_dir = Path(output_dir or DEFAULT_VAULT / "renders")
        self.output_dir.mkdir(parents=True, exist_ok=True)

    def compile_swing_loop(
        self,
        chop_paths: list[str | Path],
        target_bpm: float,
        swing_percent: float = DEFAULT_SWING_PERCENT,
        output_filename: str = "remix_loop.flac",
    ) -> Optional[Path]:
        """
        Place chops sequentially on a 16th grid with MPC swing math.

        swing_percent: 50 (straight) … 75 (heavy shuffle).
        Sweet spot for boom-bap / house pocket: 54–58.
        """
        if not chop_paths:
            return None
        if target_bpm <= 0:
            log.error("target_bpm must be > 0")
            return None

        swing = clamp_swing_percent(swing_percent)
        paths = [Path(p) for p in chop_paths]
        for p in paths:
            if not p.is_file():
                log.error("missing chop: %s", p)
                return None

        input_args: list[str] = []
        filter_parts: list[str] = []
        mix_labels: list[str] = []

        for idx, path in enumerate(paths):
            input_args.extend(["-i", str(path)])
            delay_s = mpc_step_delay_seconds(idx, target_bpm, swing)
            delay_ms = max(0, int(round(delay_s * 1000)))
            filter_parts.append(
                f"[{idx}:a]adelay={delay_ms}|{delay_ms}[a{idx}]"
            )
            mix_labels.append(f"[a{idx}]")

        n = len(paths)
        filter_parts.append(
            f"{''.join(mix_labels)}amix=inputs={n}:duration=longest:"
            f"dropout_transition=0:normalize=0[aout]"
        )
        # Pad to cover the final swung step + one 16th of tail room.
        last_t = mpc_step_delay_seconds(n - 1, target_bpm, swing)
        total = last_t + sixteenth_duration(target_bpm) * 2
        filter_parts.append(f"[aout]apad=whole_dur={total:.6f}[apadded]")
        filter_complex = ";".join(filter_parts)

        output_path = self.output_dir / output_filename
        cmd = (
            ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"]
            + input_args
            + [
                "-filter_complex",
                filter_complex,
                "-map",
                "[apadded]",
                "-c:a",
                "flac",
                str(output_path),
            ]
        )
        try:
            log.info(
                "Compiling remix loop with %.1f%% MPC swing @ %.1f BPM → %s",
                swing,
                target_bpm,
                output_path,
            )
            subprocess.run(
                cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE
            )
            return output_path
        except FileNotFoundError:
            log.error("ffmpeg not found on PATH")
            return None
        except subprocess.CalledProcessError as e:
            err = (e.stderr or b"").decode("utf-8", errors="replace")
            log.error("FFmpeg groove sequencing crashed: %s", err[-800:])
            return None


# =====================================================================
# INTEGRATED MODULE: AI STEM SEPARATOR, TRANSIENT CHOPPER, SEQUENCER
# =====================================================================

class AISamplerEngine:
    def __init__(self, sample_storage_dir: Path | str | None = None) -> None:
        self.vault = Path(sample_storage_dir or DEFAULT_VAULT)
        self.vault.mkdir(parents=True, exist_ok=True)
        self.chops_dir = self.vault / "chops"
        self.stems_dir = self.vault / "stems"
        self.renders_dir = self.vault / "renders"
        for d in (self.chops_dir, self.stems_dir, self.renders_dir):
            d.mkdir(parents=True, exist_ok=True)

    # ── Step 1: Automated source separation ───────────────────────────

    def isolate_stems(self, source_audio_path: str | Path) -> Optional[Path]:
        """
        Run local Demucs (preferred) or Spleeter to produce four stems:
        vocals, drums, bass, other. Returns the directory containing them.
        """
        source = Path(source_audio_path)
        if not source.is_file():
            log.error("source missing: %s", source)
            return None

        track_name = _safe_stem(source)
        out_dir = self.stems_dir / track_name
        out_dir.mkdir(parents=True, exist_ok=True)

        # Already separated?
        existing = _find_stem_set(out_dir)
        if existing:
            log.info("Reusing existing stems in %s", out_dir)
            return out_dir

        separator = _separator_pref()
        if separator == "none":
            log.warning("AI_SAMPLER_SEPARATOR=none — copying mix as drums.flac proxy")
            return self._copy_as_proxy_stems(source, out_dir)

        if separator in ("demucs", "auto"):
            ok = self._run_demucs(source, out_dir)
            if ok:
                return out_dir
            if separator == "demucs":
                log.error("Demucs failed and separator locked to demucs")
                return None
            log.warning("Demucs unavailable/failed — trying Spleeter")

        if separator in ("spleeter", "auto") or _separator_pref() == "demucs":
            ok = self._run_spleeter(source, out_dir)
            if ok:
                return out_dir

        log.error("No stem separator succeeded for %s", source.name)
        return None

    def _run_demucs(self, source: Path, out_dir: Path) -> bool:
        """python -m demucs -n <model> -o <tmp> <source> → copy flacs into out_dir."""
        if shutil.which("demucs") is None and not _module_available("demucs"):
            log.warning("demucs not installed (pip install demucs)")
            return False

        with tempfile.TemporaryDirectory(prefix="demucs_") as tmp:
            tmp_path = Path(tmp)
            cmd = [
                sys.executable,
                "-m",
                "demucs",
                "-n",
                _demucs_model(),
                "-o",
                str(tmp_path),
                str(source),
            ]
            log.info("Initiating Demucs (%s) on %s", _demucs_model(), source.name)
            try:
                subprocess.run(
                    cmd,
                    check=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                )
            except FileNotFoundError:
                log.error("python/demucs not runnable")
                return False
            except subprocess.CalledProcessError as e:
                err = (e.stderr or b"").decode("utf-8", errors="replace")
                log.error("Demucs fault: %s", err[-600:])
                return False

            # demucs writes <out>/<model>/<track_name>/*.wav
            candidates = list(tmp_path.rglob("drums.*"))
            if not candidates:
                log.error("Demucs produced no drums stem")
                return False
            stem_parent = candidates[0].parent
            for name in STEM_NAMES:
                matches = list(stem_parent.glob(f"{name}.*"))
                if not matches:
                    continue
                dest = out_dir / f"{name}.flac"
                self._ffmpeg_transcode(matches[0], dest)
            return _find_stem_set(out_dir) is not None

    def _run_spleeter(self, source: Path, out_dir: Path) -> bool:
        if shutil.which("spleeter") is None and not _module_available("spleeter"):
            log.warning("spleeter not installed (pip install spleeter)")
            return False

        with tempfile.TemporaryDirectory(prefix="spleeter_") as tmp:
            tmp_path = Path(tmp)
            cmd = [
                "spleeter",
                "separate",
                "-p",
                "spleeter:4stems",
                "-o",
                str(tmp_path),
                str(source),
            ]
            log.info("Initiating Spleeter 4-stem split on %s", source.name)
            try:
                subprocess.run(
                    cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE
                )
            except FileNotFoundError:
                # Fallback: python -m spleeter
                cmd = [
                    sys.executable,
                    "-m",
                    "spleeter",
                    "separate",
                    "-p",
                    "spleeter:4stems",
                    "-o",
                    str(tmp_path),
                    str(source),
                ]
                try:
                    subprocess.run(
                        cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE
                    )
                except (FileNotFoundError, subprocess.CalledProcessError) as e:
                    log.error("Spleeter fault: %s", e)
                    return False
            except subprocess.CalledProcessError as e:
                err = (e.stderr or b"").decode("utf-8", errors="replace")
                log.error("Spleeter fault: %s", err[-600:])
                return False

            # spleeter writes <out>/<track_name>/{vocals,drums,bass,other}.wav
            candidates = list(tmp_path.rglob("drums.*"))
            if not candidates:
                log.error("Spleeter produced no drums stem")
                return False
            stem_parent = candidates[0].parent
            for name in STEM_NAMES:
                matches = list(stem_parent.glob(f"{name}.*"))
                if not matches:
                    continue
                dest = out_dir / f"{name}.flac"
                self._ffmpeg_transcode(matches[0], dest)
            return _find_stem_set(out_dir) is not None

    def _copy_as_proxy_stems(self, source: Path, out_dir: Path) -> Path:
        """Dev/test path when no separator is installed — treat mix as drums."""
        dest = out_dir / "drums.flac"
        self._ffmpeg_transcode(source, dest)
        for name in ("bass", "vocals", "other"):
            # Empty-ish silence proxies so callers can still enumerate stems.
            silent = out_dir / f"{name}.flac"
            if not silent.exists():
                _write_silence_flac(silent, duration=1.0)
        return out_dir

    # ── Step 2: Mathematical transient analysis ───────────────────────

    def calculate_transient_chops(
        self,
        stem_path: str | Path,
        bpm_target: Optional[float] = None,
        *,
        backtrack: bool = True,
        min_chop_sec: float = 0.05,
        max_chops: int = 64,
    ) -> ChopManifest:
        """
        Librosa onset + beat analysis → clean slice-point inventory for the LLM.
        Prefer onset_detect (true transients) over beat frames alone.
        """
        stem = Path(stem_path)
        if librosa is None or np is None:
            log.error("Librosa dependency missing. Cannot compute sample boundaries.")
            return ChopManifest(source_stem=str(stem), source_track_bpm=0.0)

        if not stem.is_file():
            log.error("stem missing: %s", stem)
            return ChopManifest(source_stem=str(stem), source_track_bpm=0.0)

        log.info("Analyzing onsets for %s", stem.name)
        y, sr = librosa.load(str(stem), mono=True, sr=22050)
        if y.size == 0:
            return ChopManifest(source_stem=str(stem), source_track_bpm=0.0)

        onset_env = librosa.onset.onset_strength(y=y, sr=sr)
        tempo_raw, beat_frames = librosa.beat.beat_track(onset_envelope=onset_env, sr=sr)
        tempo = float(np.atleast_1d(tempo_raw)[0]) if tempo_raw is not None else 0.0

        onset_frames = librosa.onset.onset_detect(
            onset_envelope=onset_env,
            sr=sr,
            units="frames",
            backtrack=backtrack,
        )
        # Prefer onsets; fall back to beat grid if onset density is too sparse.
        if len(onset_frames) < 2 and len(beat_frames) >= 2:
            frames = beat_frames
        else:
            frames = onset_frames

        times = librosa.frames_to_time(frames, sr=sr)
        # Always close the final chop at end-of-file.
        duration = float(librosa.get_duration(y=y, sr=sr))
        times = list(times)
        if not times or times[0] > 0.02:
            times.insert(0, 0.0)
        if times[-1] < duration - 0.02:
            times.append(duration)

        chops: list[ChopSlice] = []
        for idx in range(len(times) - 1):
            start = float(times[idx])
            end = float(times[idx + 1])
            if end - start < min_chop_sec:
                continue
            chop_type = _classify_transient(y, sr, start, end)
            chops.append(
                ChopSlice(
                    sample_index=len(chops),
                    start_seconds=round(start, 4),
                    end_seconds=round(end, 4),
                    duration=round(end - start, 4),
                    type=chop_type,
                )
            )
            if len(chops) >= max_chops:
                break

        return ChopManifest(
            source_stem=str(stem),
            source_track_bpm=round(tempo, 2),
            target_bpm=bpm_target,
            detected_chops=chops,
        )

    def slice_sample_block(
        self,
        source_stem: str | Path,
        start_time: float,
        end_time: float,
        output_filename: str | Path,
    ) -> Optional[Path]:
        """FFmpeg-cut one clean sample piece from a timestamp map."""
        source = Path(source_stem)
        output_path = Path(output_filename)
        if not output_path.is_absolute():
            output_path = self.chops_dir / output_path
        output_path.parent.mkdir(parents=True, exist_ok=True)
        duration = max(0.0, float(end_time) - float(start_time))
        if duration <= 0:
            return None

        cmd = [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-ss",
            f"{start_time:.6f}",
            "-t",
            f"{duration:.6f}",
            "-i",
            str(source),
            "-c:a",
            "flac",
            str(output_path),
        ]
        try:
            subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            return output_path
        except FileNotFoundError:
            log.error("ffmpeg not found on PATH")
            return None
        except subprocess.CalledProcessError as e:
            err = (e.stderr or b"").decode("utf-8", errors="replace")
            log.error("slice failed: %s", err[-400:])
            return None

    def materialize_chops(
        self,
        manifest: ChopManifest,
        *,
        prefix: Optional[str] = None,
    ) -> ChopManifest:
        """Write each chop to disk and stamp paths back onto the manifest."""
        stem = Path(manifest.source_stem)
        tag = prefix or _safe_stem(stem)
        updated: list[ChopSlice] = []
        for chop in manifest.detected_chops:
            fname = f"{tag}_{chop.sample_index:03d}_{chop.type}.flac"
            path = self.slice_sample_block(
                stem, chop.start_seconds, chop.end_seconds, fname
            )
            updated.append(
                ChopSlice(
                    sample_index=chop.sample_index,
                    start_seconds=chop.start_seconds,
                    end_seconds=chop.end_seconds,
                    duration=chop.duration,
                    type=chop.type,
                    path=str(path) if path else None,
                )
            )
        manifest.detected_chops = updated
        return manifest

    # ── Step 3: FFmpeg macro sequencer (LLM execution array → audio) ──

    def sequence_from_plan(
        self,
        plan: SequencePlan,
        chop_paths: dict[int, Path | str],
        output_path: str | Path,
    ) -> Optional[Path]:
        """
        Compile LLM events into an FFmpeg filtergraph using adelay + amix.

        Each event: load chop[sample_index], optionally reverse / pitch / stretch,
        delay to at_seconds, gain, then amix into one rendered loop.
        """
        out = Path(output_path)
        if not out.is_absolute():
            out = self.renders_dir / out
        out.parent.mkdir(parents=True, exist_ok=True)

        if not plan.events:
            log.error("empty sequence plan")
            return None

        # Resolve inputs in event order (dedupe for -i list).
        input_files: list[Path] = []
        event_input_idx: list[int] = []
        for ev in plan.events:
            src = chop_paths.get(ev.sample_index)
            if src is None:
                log.error("plan references missing sample_index %s", ev.sample_index)
                return None
            src_path = Path(src)
            if not src_path.is_file():
                log.error("chop file missing: %s", src_path)
                return None
            if src_path not in input_files:
                input_files.append(src_path)
            event_input_idx.append(input_files.index(src_path))

        filter_parts: list[str] = []
        mix_labels: list[str] = []
        end_times: list[float] = []

        for i, ev in enumerate(plan.events):
            in_idx = event_input_idx[i]
            chain: list[str] = []
            if ev.reverse:
                chain.append("areverse")
            # Pitch via asetrate + aresample (keeps formants approximate).
            if abs(ev.pitch_semitones) > 0.01:
                ratio = 2 ** (ev.pitch_semitones / 12.0)
                chain.append(f"asetrate=44100*{ratio:.8f},aresample=44100")
            # Time stretch (atempo clamps to 0.5–2.0; chain if needed).
            if abs(ev.stretch - 1.0) > 0.01:
                chain.extend(_atempo_chain(1.0 / ev.stretch))
            if abs(ev.gain_db) > 0.01:
                chain.append(f"volume={ev.gain_db}dB")
            # adelay wants milliseconds per channel
            delay_ms = max(0, int(round(ev.at_seconds * 1000)))
            chain.append(f"adelay={delay_ms}|{delay_ms}")
            label = f"e{i}"
            filt = f"[{in_idx}:a]" + ",".join(chain) + f"[{label}]"
            filter_parts.append(filt)
            mix_labels.append(f"[{label}]")
            # Estimate contribution end for total duration.
            # Unknown chop length → assume 0.5s pre-stretch.
            approx_dur = 0.5 * max(ev.stretch, 0.01)
            end_times.append(ev.at_seconds + approx_dur)

        n = len(mix_labels)
        mix_in = "".join(mix_labels)
        # duration=longest keeps delayed tails; dropout_transition=0 avoids fades.
        filter_parts.append(
            f"{mix_in}amix=inputs={n}:duration=longest:dropout_transition=0:normalize=0[aout]"
        )
        filter_complex = ";".join(filter_parts)

        # Optional pad to loop length (bars × 4 beats).
        total = plan.total_duration
        if total is None and plan.target_bpm and plan.loop_bars:
            beat = 60.0 / float(plan.target_bpm)
            total = beat * 4 * int(plan.loop_bars)
        if total is None and end_times:
            total = max(end_times)

        map_label = "[aout]"
        if total and total > 0:
            filter_complex += f";[aout]apad=whole_dur={total:.6f}[apadded]"
            map_label = "[apadded]"

        cmd = (
            ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"]
            + [arg for f in input_files for arg in ("-i", str(f))]
            + [
                "-filter_complex",
                filter_complex,
                "-map",
                map_label,
                "-c:a",
                "flac",
                str(out),
            ]
        )
        try:
            log.info("Sequencing %d events → %s", len(plan.events), out)
            subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            return out
        except FileNotFoundError:
            log.error("ffmpeg not found on PATH")
            return None
        except subprocess.CalledProcessError as e:
            err = (e.stderr or b"").decode("utf-8", errors="replace")
            log.error("sequence render failed: %s", err[-800:])
            return None

    def sequence_from_manifest_plan(
        self,
        manifest: ChopManifest,
        plan: SequencePlan,
        output_path: str | Path,
    ) -> Optional[Path]:
        """Ensure chops are on disk, then render the plan."""
        if any(c.path is None for c in manifest.detected_chops):
            manifest = self.materialize_chops(manifest)
        chop_paths = {
            c.sample_index: Path(c.path)
            for c in manifest.detected_chops
            if c.path
        }
        if plan.target_bpm is None and manifest.target_bpm is not None:
            plan.target_bpm = manifest.target_bpm
        return self.sequence_from_plan(plan, chop_paths, output_path)

    # ── End-to-end helpers ────────────────────────────────────────────

    def build_default_boom_bap_plan(
        self,
        manifest: ChopManifest,
        *,
        bars: int = 4,
        target_bpm: Optional[float] = None,
        swing_percent: float = DEFAULT_SWING_PERCENT,
    ) -> SequencePlan:
        """
        Deterministic fallback when no LLM is available: map chops onto a
        classic boom-bap grid (kick on 1/3, snare on 2/4, hats on 8ths),
        then apply MPC swing so odd 16ths sit in the pocket.
        """
        bpm = float(target_bpm or manifest.target_bpm or manifest.source_track_bpm or 90)
        beat = 60.0 / bpm
        kicks = [c for c in manifest.detected_chops if "kick" in c.type]
        snares = [c for c in manifest.detected_chops if "snare" in c.type]
        hats = [c for c in manifest.detected_chops if "hat" in c.type or "hihat" in c.type]
        other = manifest.detected_chops
        kick_i = (kicks[0].sample_index if kicks else (other[0].sample_index if other else 0))
        snare_i = (
            snares[0].sample_index
            if snares
            else (other[min(1, len(other) - 1)].sample_index if other else 0)
        )
        hat_i = (
            hats[0].sample_index
            if hats
            else (other[min(2, len(other) - 1)].sample_index if other else 0)
        )

        events: list[SequenceEvent] = []
        for bar in range(bars):
            bar_t = bar * 4 * beat
            for b in (0, 2):  # kicks
                events.append(SequenceEvent(sample_index=kick_i, at_seconds=bar_t + b * beat))
            for b in (1, 3):  # snares
                events.append(SequenceEvent(sample_index=snare_i, at_seconds=bar_t + b * beat))
            for eighth in range(8):  # hats
                events.append(
                    SequenceEvent(
                        sample_index=hat_i,
                        at_seconds=bar_t + eighth * (beat / 2),
                        gain_db=-4.0,
                    )
                )
        plan = SequencePlan(
            events=events,
            target_bpm=bpm,
            loop_bars=bars,
            total_duration=bars * 4 * beat,
            sampling_request=(
                f"deterministic {bars}-bar boom-bap @ {bpm:.1f} BPM "
                f"swing={clamp_swing_percent(swing_percent):.0f}%"
            ),
            swing_percent=50.0,
        )
        return apply_mpc_swing_to_plan(plan, swing_percent, target_bpm=bpm)

    def compile_swing_loop(
        self,
        chop_paths: list[str | Path],
        target_bpm: float,
        swing_percent: float = DEFAULT_SWING_PERCENT,
        output_filename: str = "remix_loop.flac",
    ) -> Optional[Path]:
        """Delegate to GrooveSequencer; writes into this engine's renders/."""
        return GrooveSequencer(self.renders_dir).compile_swing_loop(
            chop_paths,
            target_bpm,
            swing_percent=swing_percent,
            output_filename=output_filename,
        )

    def pipeline(
        self,
        source_audio: str | Path,
        *,
        stem: str = "drums",
        sampling_request: str = "Create a 4-bar boom-bap loop layout",
        target_bpm: Optional[float] = None,
        plan: Optional[SequencePlan] = None,
        plan_path: Optional[Path] = None,
        output_path: Optional[Path] = None,
        use_default_plan: bool = True,
        swing_percent: float = DEFAULT_SWING_PERCENT,
    ) -> dict[str, Any]:
        """
        Full isolate → chop → (optional LLM plan) → swung sequence pass.
        Returns a result dict with paths and the LLM context payload.
        """
        result: dict[str, Any] = {"ok": False}
        stems_dir = self.isolate_stems(source_audio)
        if stems_dir is None:
            result["error"] = "stem separation failed"
            return result
        result["stems_dir"] = str(stems_dir)

        stem_file = stems_dir / f"{stem}.flac"
        if not stem_file.is_file():
            # Prefer any available audio in the stem folder.
            alts = sorted(stems_dir.glob("*.flac")) + sorted(stems_dir.glob("*.wav"))
            if not alts:
                result["error"] = f"no {stem} stem in {stems_dir}"
                return result
            stem_file = alts[0]

        manifest = self.calculate_transient_chops(stem_file, bpm_target=target_bpm)
        manifest = self.materialize_chops(manifest)
        llm_ctx = manifest.to_llm_context(sampling_request)
        result["llm_context"] = llm_ctx
        result["manifest"] = manifest.to_dict()

        ctx_path = self.vault / f"{_safe_stem(Path(source_audio))}_llm_context.json"
        _write_json(ctx_path, llm_ctx)
        result["llm_context_path"] = str(ctx_path)

        if plan is None and plan_path and plan_path.is_file():
            plan = SequencePlan.from_dict(json.loads(plan_path.read_text(encoding="utf-8")))

        if plan is None and use_default_plan:
            plan = self.build_default_boom_bap_plan(
                manifest, target_bpm=target_bpm, swing_percent=swing_percent
            )
        elif plan is not None and abs(clamp_swing_percent(swing_percent) - 50.0) > 1e-9:
            # LLM / file plans arrive on a straight grid — humanize on render.
            plan = apply_mpc_swing_to_plan(plan, swing_percent, target_bpm=target_bpm)

        if plan is None:
            result["ok"] = True
            result["note"] = "chops ready; no sequence plan provided"
            return result

        out = output_path or (
            self.renders_dir / f"{_safe_stem(Path(source_audio))}_remix.flac"
        )
        rendered = self.sequence_from_manifest_plan(manifest, plan, out)
        if rendered is None:
            result["error"] = "sequence render failed"
            return result
        result["ok"] = True
        result["render_path"] = str(rendered)
        result["plan"] = plan.to_dict()
        result["swing_percent"] = plan.swing_percent
        return result

    def _ffmpeg_transcode(self, src: Path, dest: Path) -> bool:
        dest.parent.mkdir(parents=True, exist_ok=True)
        if src.suffix.lower() == ".flac" and src.resolve() != dest.resolve():
            try:
                shutil.copy2(src, dest)
                return True
            except OSError:
                pass
        cmd = [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(src),
            "-c:a",
            "flac",
            str(dest),
        ]
        try:
            subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            return True
        except (FileNotFoundError, subprocess.CalledProcessError) as e:
            log.error("transcode %s → %s failed: %s", src, dest, e)
            return False


# =====================================================================
# Helpers
# =====================================================================

def _safe_stem(path: Path) -> str:
    name = path.stem
    return re.sub(r"[^\w\-]+", "_", name).strip("_") or "track"


def _find_stem_set(directory: Path) -> Optional[Path]:
    drums = list(directory.glob("drums.*"))
    return directory if drums else None


def _module_available(name: str) -> bool:
    try:
        __import__(name)
        return True
    except ImportError:
        return False


def _atempo_chain(factor: float) -> list[str]:
    """Split atempo into 0.5–2.0 steps (FFmpeg constraint)."""
    filters: list[str] = []
    remaining = float(factor)
    # Guard extremes
    remaining = max(0.125, min(8.0, remaining))
    while remaining > 2.0 + 1e-6:
        filters.append("atempo=2.0")
        remaining /= 2.0
    while remaining < 0.5 - 1e-6:
        filters.append("atempo=0.5")
        remaining /= 0.5
    filters.append(f"atempo={remaining:.6f}")
    return filters


def _classify_transient(y: Any, sr: int, start: float, end: float) -> str:
    """Heuristic kick / snare / hat labels from spectral centroid + energy."""
    if librosa is None or np is None:
        return "transient"
    i0 = max(0, int(start * sr))
    i1 = min(len(y), int(end * sr))
    if i1 <= i0:
        return "transient"
    seg = y[i0:i1]
    if seg.size < 16:
        return "transient"
    try:
        cent = float(np.mean(librosa.feature.spectral_centroid(y=seg, sr=sr)))
        rms = float(np.sqrt(np.mean(seg**2)))
    except Exception:  # noqa: BLE001
        return "transient"
    # Rough buckets tuned for drum stems at 22.05 kHz.
    if cent < 1500 and rms > 0.02:
        return "kick_transient"
    if 1500 <= cent < 4500:
        return "snare_transient"
    if cent >= 4500:
        return "hihat_transient"
    return "transient"


def _write_silence_flac(path: Path, duration: float = 1.0) -> None:
    cmd = [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        f"anullsrc=r=44100:cl=mono",
        "-t",
        f"{duration:.3f}",
        "-c:a",
        "flac",
        str(path),
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def _write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def default_boom_bap_plan_dict(
    chops: list[dict[str, Any]],
    *,
    source_bpm: float,
    target_bpm: float = 90.0,
    bars: int = 4,
) -> dict[str, Any]:
    """Pure-dict helper for tests / external callers without an engine instance."""
    manifest = ChopManifest(
        source_stem="",
        source_track_bpm=source_bpm,
        target_bpm=target_bpm,
        detected_chops=[
            ChopSlice(
                sample_index=int(c["sample_index"]),
                start_seconds=float(c["start_seconds"]),
                end_seconds=float(c["end_seconds"]),
                duration=float(c.get("duration") or 0),
                type=str(c.get("type") or "transient"),
                path=c.get("path"),
            )
            for c in chops
        ],
    )
    engine = AISamplerEngine(tempfile.mkdtemp(prefix="ai_sampler_plan_"))
    plan = engine.build_default_boom_bap_plan(
        manifest, bars=bars, target_bpm=target_bpm
    )
    return plan.to_dict()


# =====================================================================
# CLI
# =====================================================================

def _load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="JakeTunes AI sampler: stems → transient chops → FFmpeg sequence"
    )
    parser.add_argument(
        "--vault",
        type=Path,
        default=None,
        help="Sample vault directory (default: $AI_SAMPLER_VAULT or state dir)",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_iso = sub.add_parser("isolate", help="Step 1 — Demucs/Spleeter stem split")
    p_iso.add_argument("source", type=Path)

    p_chop = sub.add_parser("chop", help="Step 2 — librosa onset chop map")
    p_chop.add_argument("stem", type=Path)
    p_chop.add_argument("--bpm", type=float, default=None, help="Target BPM hint")
    p_chop.add_argument("-o", "--out", type=Path, default=None, help="Write chops JSON")

    p_slice = sub.add_parser("slice", help="Materialize chops from a JSON manifest")
    p_slice.add_argument("stem", type=Path)
    p_slice.add_argument("chops_json", type=Path)

    p_seq = sub.add_parser("sequence", help="Step 3 — FFmpeg macro sequencer")
    p_seq.add_argument("plan", type=Path, help="LLM execution plan JSON")
    p_seq.add_argument(
        "--chops",
        type=Path,
        required=True,
        help="Chop manifest JSON (with paths) OR directory of chop files",
    )
    p_seq.add_argument("--out", type=Path, required=True)
    p_seq.add_argument(
        "--swing",
        type=float,
        default=None,
        help="MPC swing %% (50=straight, 58=head-nod). Applied before render.",
    )

    p_ctx = sub.add_parser("llm-context", help="Emit LLM sampling context JSON")
    p_ctx.add_argument("chops_json", type=Path)
    p_ctx.add_argument("--bpm", type=float, default=None)
    p_ctx.add_argument(
        "--request",
        default="Create a 4-bar boom-bap loop layout",
    )
    p_ctx.add_argument("-o", "--out", type=Path, default=None)

    p_pipe = sub.add_parser("pipeline", help="Full isolate → chop → sequence")
    p_pipe.add_argument("source", type=Path)
    p_pipe.add_argument("--stem", default="drums")
    p_pipe.add_argument("--bpm", type=float, default=None)
    p_pipe.add_argument(
        "--request",
        default="Create a 4-bar boom-bap loop layout",
    )
    p_pipe.add_argument("--plan", type=Path, default=None)
    p_pipe.add_argument("--out", type=Path, default=None)
    p_pipe.add_argument(
        "--swing",
        type=float,
        default=DEFAULT_SWING_PERCENT,
        help=f"MPC swing %% (default {DEFAULT_SWING_PERCENT:.0f})",
    )
    p_pipe.add_argument(
        "--no-default-plan",
        action="store_true",
        help="Stop after chops/LLM context; do not render a fallback boom-bap",
    )

    p_plan = sub.add_parser(
        "default-plan",
        help="Build a deterministic boom-bap plan from a chops JSON (no LLM)",
    )
    p_plan.add_argument("chops_json", type=Path)
    p_plan.add_argument("--bpm", type=float, default=90.0)
    p_plan.add_argument("--bars", type=int, default=4)
    p_plan.add_argument(
        "--swing",
        type=float,
        default=DEFAULT_SWING_PERCENT,
        help=f"MPC swing %% (default {DEFAULT_SWING_PERCENT:.0f})",
    )
    p_plan.add_argument("-o", "--out", type=Path, default=None)

    p_swing = sub.add_parser(
        "swing-loop",
        help="GrooveSequencer: stitch ordered chops onto a swung 16th grid",
    )
    p_swing.add_argument(
        "chops",
        nargs="+",
        type=Path,
        help="Ordered chop audio files (step 0, 1, 2…)",
    )
    p_swing.add_argument("--bpm", type=float, required=True)
    p_swing.add_argument(
        "--swing",
        type=float,
        default=DEFAULT_SWING_PERCENT,
        help=f"MPC swing %% (default {DEFAULT_SWING_PERCENT:.0f})",
    )
    p_swing.add_argument("--out", type=Path, default=Path("remix_loop.flac"))

    p_night = sub.add_parser(
        "nightly-pass",
        help="Process $JT_STATE_DIR/sampling-inbox/*.json through the pipeline",
    )
    p_night.add_argument(
        "--inbox",
        type=Path,
        default=None,
        help="Override inbox dir (default: $STATE_DIR/sampling-inbox)",
    )

    args = parser.parse_args(argv)
    engine = AISamplerEngine(args.vault)

    if args.cmd == "isolate":
        d = engine.isolate_stems(args.source)
        if d is None:
            return 1
        print(json.dumps({"ok": True, "stems_dir": str(d)}, indent=2))
        return 0

    if args.cmd == "chop":
        manifest = engine.calculate_transient_chops(args.stem, bpm_target=args.bpm)
        payload = manifest.to_dict()
        if args.out:
            _write_json(args.out, payload)
            print(str(args.out))
        else:
            print(json.dumps(payload, indent=2))
        return 0 if manifest.detected_chops else 1

    if args.cmd == "slice":
        data = _load_json(args.chops_json)
        data["source_stem"] = str(args.stem)
        manifest = ChopManifest.from_dict(data)
        manifest = engine.materialize_chops(manifest)
        _write_json(args.chops_json, manifest.to_dict())
        print(json.dumps(manifest.to_dict(), indent=2))
        return 0

    if args.cmd == "sequence":
        plan = SequencePlan.from_dict(_load_json(args.plan))
        if args.swing is not None:
            plan = apply_mpc_swing_to_plan(plan, args.swing)
        chops_arg = args.chops
        chop_paths: dict[int, Path] = {}
        if chops_arg.is_dir():
            files = sorted(chops_arg.glob("*.flac")) + sorted(chops_arg.glob("*.wav"))
            for i, f in enumerate(files):
                chop_paths[i] = f
        else:
            manifest = ChopManifest.from_dict(_load_json(chops_arg))
            if any(c.path is None for c in manifest.detected_chops):
                if not manifest.source_stem:
                    log.error("chops JSON has no paths and no source_stem")
                    return 1
                manifest = engine.materialize_chops(manifest)
            chop_paths = {
                c.sample_index: Path(c.path)
                for c in manifest.detected_chops
                if c.path
            }
        rendered = engine.sequence_from_plan(plan, chop_paths, args.out)
        if rendered is None:
            return 1
        print(
            json.dumps(
                {
                    "ok": True,
                    "render_path": str(rendered),
                    "swing_percent": plan.swing_percent,
                },
                indent=2,
            )
        )
        return 0

    if args.cmd == "llm-context":
        data = _load_json(args.chops_json)
        if args.bpm is not None:
            data["source_track_bpm"] = args.bpm
        manifest = ChopManifest.from_dict(data)
        ctx = manifest.to_llm_context(args.request)
        if args.out:
            _write_json(args.out, ctx)
            print(str(args.out))
        else:
            print(json.dumps(ctx, indent=2))
        return 0

    if args.cmd == "default-plan":
        data = _load_json(args.chops_json)
        manifest = ChopManifest.from_dict(data)
        plan = engine.build_default_boom_bap_plan(
            manifest,
            bars=args.bars,
            target_bpm=args.bpm,
            swing_percent=args.swing,
        )
        payload = plan.to_dict()
        if args.out:
            _write_json(args.out, payload)
            print(str(args.out))
        else:
            print(json.dumps(payload, indent=2))
        return 0

    if args.cmd == "swing-loop":
        out_name = args.out.name if args.out else "remix_loop.flac"
        if args.out and args.out.is_absolute():
            seq = GrooveSequencer(args.out.parent)
        else:
            seq = GrooveSequencer(engine.renders_dir)
        rendered = seq.compile_swing_loop(
            list(args.chops),
            target_bpm=args.bpm,
            swing_percent=args.swing,
            output_filename=out_name,
        )
        if rendered is None:
            return 1
        print(
            json.dumps(
                {
                    "ok": True,
                    "render_path": str(rendered),
                    "swing_percent": clamp_swing_percent(args.swing),
                    "bpm": args.bpm,
                },
                indent=2,
            )
        )
        return 0

    if args.cmd == "pipeline":
        result = engine.pipeline(
            args.source,
            stem=args.stem,
            sampling_request=args.request,
            target_bpm=args.bpm,
            plan_path=args.plan,
            output_path=args.out,
            use_default_plan=not args.no_default_plan,
            swing_percent=args.swing,
        )
        print(json.dumps(result, indent=2))
        return 0 if result.get("ok") else 1

    if args.cmd == "nightly-pass":
        inbox = args.inbox or (STATE_DIR / "sampling-inbox")
        done_dir = inbox / "done"
        fail_dir = inbox / "failed"
        inbox.mkdir(parents=True, exist_ok=True)
        done_dir.mkdir(parents=True, exist_ok=True)
        fail_dir.mkdir(parents=True, exist_ok=True)
        jobs = sorted(inbox.glob("*.json"))
        results = []
        for job_path in jobs:
            try:
                job = _load_json(job_path)
            except (OSError, json.JSONDecodeError) as e:
                log.error("bad job %s: %s", job_path, e)
                job_path.rename(fail_dir / job_path.name)
                continue
            source = job.get("source") or job.get("source_audio")
            if not source:
                log.error("job missing source: %s", job_path)
                job_path.rename(fail_dir / job_path.name)
                continue
            plan = None
            if job.get("plan"):
                plan = SequencePlan.from_dict(job["plan"])
            elif job.get("plan_path"):
                plan = SequencePlan.from_dict(_load_json(Path(job["plan_path"])))
            result = engine.pipeline(
                source,
                stem=str(job.get("stem") or "drums"),
                sampling_request=str(
                    job.get("sampling_request")
                    or job.get("request")
                    or "Create a 4-bar boom-bap loop layout"
                ),
                target_bpm=(
                    float(job["target_bpm"]) if job.get("target_bpm") is not None else None
                ),
                plan=plan,
                output_path=Path(job["out"]) if job.get("out") else None,
                use_default_plan=bool(job.get("use_default_plan", True)),
                swing_percent=float(
                    job.get("swing_percent") or job.get("swing") or DEFAULT_SWING_PERCENT
                ),
            )
            result["job"] = str(job_path)
            results.append(result)
            dest = done_dir if result.get("ok") else fail_dir
            job_path.rename(dest / job_path.name)
            # Drop the LLM context next to the job for the taste loop to pick up.
            if result.get("llm_context"):
                _write_json(
                    dest / f"{job_path.stem}_llm_context.json",
                    result["llm_context"],
                )
        print(json.dumps({"ok": True, "processed": len(results), "results": results}, indent=2))
        return 0

    return 2


if __name__ == "__main__":
    sys.exit(main())
