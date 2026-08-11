# AI Sampler Engine

Self-hosted sampling pipeline: the LLM is the **arranger brain**; local open-source
DSP does the ear work.

```
[1. Stem Separation]  →  [2. Transient Chopping]  →  [3. Algorithmic Sequencing]
 Demucs / Spleeter         Librosa onset detection      LLM plan + FFmpeg tracker
```

Implementation: `scripts/ai_sampler_engine.py`  
Self-test: `python3 scripts/tests/test_ai_sampler_engine.py`

## Quick start

```bash
# Optional on the NAS/homemini host (large torch dep):
pip install demucs soundfile

# Chop a drum stem you already have:
python3 scripts/ai_sampler_engine.py chop drums.flac --bpm 90 -o chops.json

# Emit the lightweight JSON the nightly LLM should see:
python3 scripts/ai_sampler_engine.py llm-context chops.json \
  --request "Create a 4-bar boom-bap loop layout"

# Without an LLM yet — deterministic boom-bap grid, then render:
python3 scripts/ai_sampler_engine.py default-plan chops.json --bpm 90 -o plan.json
python3 scripts/ai_sampler_engine.py slice drums.flac chops.json
python3 scripts/ai_sampler_engine.py sequence plan.json --chops chops.json --out remix.flac

# Full pipeline (isolate → chop → default plan → render):
AI_SAMPLER_SEPARATOR=demucs python3 scripts/ai_sampler_engine.py pipeline track.flac \
  --request "4-bar boom-bap at 90 BPM" --bpm 90 --out remix.flac
```

No Demucs installed? Set `AI_SAMPLER_SEPARATOR=none` to treat the full mix as a
drums proxy (useful for wiring tests).

## LLM contract

**Input** (from `llm-context` / `pipeline`):

```json
{
  "sampling_request": "Create a 4-bar boom-bap loop layout",
  "source_track_bpm": 120,
  "target_bpm": 90,
  "detected_chops": [
    {"sample_index": 0, "start_seconds": 0.0, "end_seconds": 0.5, "type": "kick_transient"},
    {"sample_index": 1, "start_seconds": 0.5, "end_seconds": 1.0, "type": "snare_transient"}
  ]
}
```

**Output** (execution plan the sequencer consumes):

```json
{
  "target_bpm": 90,
  "loop_bars": 4,
  "events": [
    {"sample_index": 0, "at_seconds": 0.0},
    {"sample_index": 1, "at_seconds": 0.5, "gain_db": -1},
    {"sample_index": 2, "at_seconds": 1.0, "stretch": 1.1, "pitch_semitones": -2}
  ]
}
```

Loose English phrases (`"Play sample_index 0, delay 0.5s"`) are also accepted
inside `events`.

The FFmpeg macro sequencer builds `adelay` + `amix` (with optional `areverse`,
`asetrate` pitch, and chained `atempo` stretch) and writes a FLAC loop under
`$AI_SAMPLER_VAULT/renders/`.

## MPC swing (GrooveSequencer)

Odd 16th-note steps get a micro-delay; even (downbeat) steps stay on the grid:

```
step = 60 / bpm / 4
offset = step * (swing_percent - 50) / 100
even → step_index * step
odd  → step_index * step + offset
```

| swing_percent | Feel |
|---|---|
| 50 | Straight / robotic |
| 54–58 | Head-nod boom-bap / house pocket (default **58**) |
| 75 | Heavy shuffle (clamped max) |

```bash
# Ordered chops on a swung 16th grid:
python3 scripts/ai_sampler_engine.py swing-loop c0.flac c1.flac c2.flac c3.flac \
  --bpm 90 --swing 58 --out remix_loop.flac

# Same entrypoint via custom_audio_engine:
python3 scripts/custom_audio_engine.py --swing-loop c0.flac c1.flac c2.flac \
  --bpm 90 --swing 58 --swing-out remix_loop.flac

# Pipeline / default boom-bap plan apply swing automatically:
python3 scripts/ai_sampler_engine.py pipeline track.flac --bpm 90 --swing 58
```

## Nightly inbox

Drop job JSON files into `$JT_STATE_DIR/sampling-inbox/`:

```json
{
  "source": "/path/to/funk_break.flac",
  "sampling_request": "Take the drum break, pitch to 90 BPM, 4-bar boom-bap",
  "target_bpm": 90,
  "stem": "drums"
}
```

Then:

```bash
python3 scripts/ai_sampler_engine.py nightly-pass
```

Finished jobs move to `sampling-inbox/done/` (with a sibling `*_llm_context.json`
for the taste loop / local LLM). Failures land in `sampling-inbox/failed/`.

## Env

| Variable | Meaning |
|---|---|
| `AI_SAMPLER_VAULT` | Sample vault root (stems / chops / renders) |
| `AI_SAMPLER_SEPARATOR` | `demucs` (default) \| `spleeter` \| `auto` \| `none` |
| `DEMUCS_MODEL` | Demucs model name (default `htdemucs`) |
| `JT_STATE_DIR` | Falls back here for vault if unset |
