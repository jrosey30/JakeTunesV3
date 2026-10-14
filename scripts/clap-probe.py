#!/usr/bin/env python3
"""
clap-probe.py — Brief 177: measure the CLAP service's real throughput on
THIS machine, so the nightly catch-up cap is a measurement, not a guess.

The steps audit measured the mini's CLAP at 20/50/122 tracks/min under
three load profiles — the safe window depends on the hardware and what
else is running, so the number must be taken where the job will run.

What it does: loads the model exactly as audio-embed.py does, embeds up to
--tracks sample tracks from the library (skipping ones already in
audio-index.bin), times decode+embed per track, and prints:
  - measured tracks/min (mean over the sample, warmup excluded),
  - a recommended nightly cap for a given free-window budget
    (cap = tracks/min x budget minutes x 0.7 safety factor),
  - optionally (--write) clap-probe.json in the state dir, which
    scripts/enrichment-catchup.mjs reads to set its cap.

It writes NOTHING else: probe embeddings are discarded, the index and the
ledger are untouched.

Usage (on the machine that runs CLAP — the laptop today):
  .venv-clap/bin/python scripts/clap-probe.py [--tracks 12] [--budget-min 60] [--write]
"""
import argparse
import importlib.util
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SPEC = importlib.util.spec_from_file_location("audio_embed", os.path.join(HERE, "audio-embed.py"))
AE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AE)

SAFETY = 0.7   # leave headroom: the measured rate is a warm best case, and
               # the nightly window shares the machine with everything else


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tracks", type=int, default=12, help="sample size (incl. 2 warmup)")
    ap.add_argument("--budget-min", type=int, default=60, help="free-window budget for the cap recommendation")
    ap.add_argument("--write", action="store_true", help="write clap-probe.json into the state dir")
    args = ap.parse_args()

    lib = json.load(open(AE.LIB_PATH))
    tracks = lib.get("tracks", [])
    done = AE.read_index(AE.OUT_PATH)
    todo = [t for t in tracks if isinstance(t.get("id"), int) and t["id"] not in done]
    sample = todo[: max(3, args.tracks)]
    if not sample:
        print("clap-probe: nothing to sample — the audio index already covers the library")
        return 0

    model, processor, device = AE.load_model()
    use_nas = AE.nas_available()
    music_root = os.environ.get("JT_MUSIC_DIR") or os.path.expanduser("~/Music/JakeTunesLibrary/iPod_Control/Music")
    print(f"clap-probe: model {AE.MODEL_ID} on {device}; sampling {len(sample)} tracks "
          f"(first 2 are warmup and excluded from the rate)")

    times = []
    ok = 0
    for i, t in enumerate(sample):
        colon = str(t.get("path") or "")
        local = AE.colon_to_abs(colon, music_root) if colon else ""
        rel = colon.replace(":", "/") if colon else ""
        nas_path = (AE.NAS_LIB + rel) if (rel and use_nas) else ""
        if local and os.path.exists(local):
            src = local
        elif nas_path and os.path.exists(nas_path):
            src = nas_path
        else:
            src = f"{AE.HOMEMINI_AUDIO}/{t['id']}"
        t0 = time.time()
        try:
            blob = AE.embed_track(model, processor, device, src, float(t.get("duration") or 0) / 1000.0)
        except Exception as e:
            print(f"  id {t['id']}: failed ({e}) — excluded from the rate")
            continue
        dt = time.time() - t0
        if blob is None:
            print(f"  id {t['id']}: undecodable — excluded from the rate")
            continue
        ok += 1
        if i >= 2:
            times.append(dt)
        print(f"  id {t['id']}: {dt:.2f}s{' (warmup)' if i < 2 else ''}")

    if not times:
        print("clap-probe: no timed tracks — cannot measure (see failures above)")
        return 1
    mean_s = sum(times) / len(times)
    per_min = 60.0 / mean_s
    cap = int(per_min * args.budget_min * SAFETY)
    result = {
        "measuredAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "hostRole": "clap-probe",
        "model": AE.MODEL_ID,
        "device": device,
        "sampleTracks": len(times),
        "meanSecondsPerTrack": round(mean_s, 3),
        "tracksPerMin": round(per_min, 2),
        "safetyFactor": SAFETY,
        "budgetMin": args.budget_min,
        "recommendedNightlyCap": cap,
    }
    print(json.dumps(result, indent=2))
    print(f"clap-probe: {per_min:.1f} tracks/min -> recommended nightly cap {cap} "
          f"for a {args.budget_min}-min window (safety x{SAFETY})")
    if args.write:
        out = os.path.join(AE.STATE_DIR, "clap-probe.json")
        tmp = f"{out}.{os.getpid()}.tmp"
        with open(tmp, "w") as f:
            json.dump(result, f, indent=2)
        os.replace(tmp, out)
        print(f"clap-probe: wrote {out} (enrichment-catchup.mjs reads the cap from here)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
