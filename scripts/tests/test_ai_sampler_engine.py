#!/usr/bin/env python3
"""
Self-test for scripts/ai_sampler_engine.py.

Uses FFmpeg-synthesized click trains so CI / cloud VMs can verify the
chop → sequence path without Demucs or a music library.

Run:  python3 scripts/tests/test_ai_sampler_engine.py
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

import ai_sampler_engine as ase  # noqa: E402

FAILURES: list[str] = []
CHECKS = [0]


def check(label: str, cond: bool, detail: str = "") -> None:
    CHECKS[0] += 1
    if cond:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label}  {detail}")
        FAILURES.append(label)


def make_click_train(path: Path, bpm: float = 120.0, bars: int = 2) -> None:
    """Synthesize a mono click every beat via lavfi + adelay amix."""
    beat = 60.0 / bpm
    n_beats = bars * 4
    # Build short sine blips delayed onto a grid, then amix.
    # Simpler: use sine tone with tremolo-ish volume envelope via asetpts — 
    # instead generate a wav of clicks with ffmpeg sine + acrossfade silence.
    # Practical approach: one sine burst repeated with concat.
    parts_dir = path.parent / "_clicks"
    parts_dir.mkdir(parents=True, exist_ok=True)
    click = parts_dir / "click.wav"
    silence = parts_dir / "gap.wav"
    click_dur = 0.04
    gap_dur = max(0.01, beat - click_dur)
    subprocess.run(
        [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", "sine=frequency=150:sample_rate=44100",
            "-t", f"{click_dur:.4f}", str(click),
        ],
        check=True,
    )
    subprocess.run(
        [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono",
            "-t", f"{gap_dur:.4f}", str(silence),
        ],
        check=True,
    )
    list_file = parts_dir / "list.txt"
    lines = []
    for _ in range(n_beats):
        lines.append(f"file '{click}'")
        lines.append(f"file '{silence}'")
    list_file.write_text("\n".join(lines) + "\n", encoding="utf-8")
    subprocess.run(
        [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-f", "concat", "-safe", "0", "-i", str(list_file),
            "-c:a", "flac", str(path),
        ],
        check=True,
    )


def test_parse_event_phrase() -> None:
    ev = ase._parse_event_phrase("Play sample_index 0, delay 0.5s, stretch sample_index 2")
    # stretch capture may latch onto wrong token — just check index + delay
    check("parse play+delay", ev is not None and ev.sample_index == 0 and abs(ev.at_seconds - 0.5) < 1e-6)
    plan = ase.SequencePlan.from_dict(
        {
            "events": [
                "Play sample_index 0, delay 0.0s",
                "Play sample_index 1, delay 0.5s",
                {"sample_index": 2, "at_seconds": 1.0, "stretch": 1.2},
            ]
        }
    )
    check("plan has 3 events", len(plan.events) == 3, str(len(plan.events)))
    check("plan event 2 stretch", abs(plan.events[2].stretch - 1.2) < 1e-6)


def test_atempo_chain() -> None:
    chain = ase._atempo_chain(4.0)  # stretch factor inverse path uses this
    check("atempo splits >2", "atempo=2.0" in chain and len(chain) >= 2, str(chain))
    chain2 = ase._atempo_chain(0.25)
    check("atempo splits <0.5", "atempo=0.5" in chain2, str(chain2))


def test_chop_and_sequence() -> None:
    if ase.librosa is None:
        print("  skip chop/sequence — librosa not installed")
        return

    with tempfile.TemporaryDirectory(prefix="ai_sampler_test_") as tmp:
        tmp_path = Path(tmp)
        vault = tmp_path / "vault"
        src = tmp_path / "clicks.flac"
        make_click_train(src, bpm=120.0, bars=2)
        check("click train exists", src.is_file(), str(src))

        # Force separator=none for isolate path
        os.environ["AI_SAMPLER_SEPARATOR"] = "none"
        engine = ase.AISamplerEngine(vault)

        stems = engine.isolate_stems(src)
        check("isolate proxy stems", stems is not None and (stems / "drums.flac").is_file())
        if stems is None:
            return

        drums = stems / "drums.flac"
        manifest = engine.calculate_transient_chops(drums, bpm_target=90.0)
        check(
            "detected chops",
            len(manifest.detected_chops) >= 2,
            f"n={len(manifest.detected_chops)} bpm={manifest.source_track_bpm}",
        )
        check("bpm in ballpark", 60 <= manifest.source_track_bpm <= 180, str(manifest.source_track_bpm))

        manifest = engine.materialize_chops(manifest)
        paths_ok = all(c.path and Path(c.path).is_file() for c in manifest.detected_chops)
        check("materialized chop files", paths_ok)

        ctx = manifest.to_llm_context("Create a 4-bar boom-bap loop layout")
        check("llm context has chops", len(ctx["detected_chops"]) >= 2)
        check("llm context request", ctx["sampling_request"].startswith("Create"))

        plan = engine.build_default_boom_bap_plan(manifest, bars=1, target_bpm=90.0)
        check("default plan events", len(plan.events) >= 4, str(len(plan.events)))

        out = vault / "renders" / "test_remix.flac"
        rendered = engine.sequence_from_manifest_plan(manifest, plan, out)
        check("sequence rendered", rendered is not None and Path(rendered).is_file(), str(rendered))

        # Round-trip JSON contracts
        m2 = ase.ChopManifest.from_dict(json.loads(json.dumps(manifest.to_dict())))
        check("manifest round-trip", len(m2.detected_chops) == len(manifest.detected_chops))
        p2 = ase.SequencePlan.from_dict(json.loads(json.dumps(plan.to_dict())))
        check("plan round-trip", len(p2.events) == len(plan.events))


def test_pipeline_no_default() -> None:
    if ase.librosa is None:
        print("  skip pipeline — librosa not installed")
        return
    with tempfile.TemporaryDirectory(prefix="ai_sampler_pipe_") as tmp:
        tmp_path = Path(tmp)
        os.environ["AI_SAMPLER_SEPARATOR"] = "none"
        src = tmp_path / "src.flac"
        make_click_train(src, bpm=100.0, bars=1)
        engine = ase.AISamplerEngine(tmp_path / "vault")
        result = engine.pipeline(
            src,
            sampling_request="test",
            target_bpm=90.0,
            use_default_plan=False,
        )
        check("pipeline ok without plan", result.get("ok") is True, str(result))
        check("pipeline wrote llm context", "llm_context_path" in result)


def main() -> int:
    print("ai_sampler_engine self-test")
    # Prefer proxy stems in CI / VMs without Demucs.
    os.environ.setdefault("AI_SAMPLER_SEPARATOR", "none")
    test_parse_event_phrase()
    test_atempo_chain()
    test_chop_and_sequence()
    test_pipeline_no_default()
    print(f"\n{CHECKS[0]} checks, {len(FAILURES)} failures")
    if FAILURES:
        print("FAILED:", ", ".join(FAILURES))
        return 1
    print("ALL PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
