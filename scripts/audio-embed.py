#!/usr/bin/env python3
"""
audio-embed.py — the brain's EARS (6.0 Phase 3d, gated-in by the reranker
eval: the residue queries have no genre words; only sound can answer them).

Embeds every library track's actual AUDIO with CLAP (music checkpoint) into
audio-index.bin — same EMBD container as embeddings.bin/mood-index.bin but
dim=512, its own file, never touching the text indexes. CLAP's text tower
shares the space, so a vibe query can be compared straight against sound.

Deliberately a SIBLING of core/audio_analysis.py (core/ is Do-Not-Touch);
runs on the laptop (this needs torch, not Ollama). Evicted tracks (local
file gone by design — pass-through storage) decode from homemini's HTTP
stream so the whole library is reachable.

Per track: decode three 10s windows (25% / 50% / 75%) at 48kHz mono via
ffmpeg, embed each, mean + L2-normalize. Resumable: existing ids in the
output file are skipped; the file is rewritten atomically every flush.

Usage:
  .venv-clap/bin/python scripts/audio-embed.py               # batch (resume)
  .venv-clap/bin/python scripts/audio-embed.py --limit 20    # smoke
  .venv-clap/bin/python scripts/audio-embed.py --server      # text-query JSONL
"""
import argparse, json, os, struct, subprocess, sys, time

STATE_DIR = os.environ.get("JT_STATE_DIR") or os.path.expanduser("~/Library/Application Support/JakeTunes")
LIB_PATH = os.path.join(STATE_DIR, "library.json")
OUT_PATH = os.path.join(STATE_DIR, "audio-index.bin")
HOMEMINI_AUDIO = os.environ.get("JT_HOMEMINI_AUDIO", "http://homemini:3000/audio")
# larger_clap_music's Hub conversion is BROKEN under transformers (both
# towers collapse to near-constant vectors — verified live 2026-09-01 on
# clean cache, transformers 4.49 AND 5.16). larger_clap_general is the
# newer working sibling, trained on music too.
MODEL_ID = "laion/larger_clap_general"
DIM = 512
MAGIC = b"EMBD"
SAMPLE_RATE = 48000
WINDOW_S = 10

def log(msg: str) -> None:
    print(f"{time.strftime('%H:%M:%S')} [audio-embed] {msg}", flush=True)

def _feat(out):
    # transformers 4.x returns the projected tensor; 5.x wraps it.
    return out.pooler_output if hasattr(out, "pooler_output") else out

def load_model():
    import torch
    from transformers import ClapModel, ClapProcessor
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    model = ClapModel.from_pretrained(MODEL_ID).to(device).eval()
    processor = ClapProcessor.from_pretrained(MODEL_ID)
    return model, processor, device

def read_index(path):
    out = {}
    try:
        with open(path, "rb") as f:
            head = f.read(12)
            if len(head) < 12 or head[:4] != MAGIC:
                return out
            dim = struct.unpack("<H", head[6:8])[0]
            count = struct.unpack("<I", head[8:12])[0]
            for _ in range(count):
                rec = f.read(4 + dim * 4)
                if len(rec) < 4 + dim * 4:
                    break
                tid = struct.unpack("<I", rec[:4])[0]
                out[tid] = rec[4:]
    except FileNotFoundError:
        pass
    return out

def write_index(path, vecs):
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "wb") as f:
        f.write(MAGIC + struct.pack("<H", 1) + struct.pack("<H", DIM) + struct.pack("<I", len(vecs)))
        for tid in sorted(vecs):
            f.write(struct.pack("<I", tid) + vecs[tid])
        f.flush(); os.fsync(f.fileno())
    os.replace(tmp, path)

def colon_to_abs(colon: str, music_root: str) -> str:
    return os.path.join(os.path.dirname(os.path.dirname(music_root)), *[p for p in colon.split(":") if p])

def decode_window(src: str, start_s: float):
    """One WINDOW_S mono float32 slice via ffmpeg (file path or http URL)."""
    cmd = ["ffmpeg", "-v", "error", "-ss", str(max(0, start_s)), "-i", src,
           "-t", str(WINDOW_S), "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "f32le", "-"]
    r = subprocess.run(cmd, capture_output=True, timeout=120)
    if r.returncode != 0 or len(r.stdout) < SAMPLE_RATE:  # <~0.25s of audio
        return None
    import numpy as np
    return np.frombuffer(r.stdout, dtype=np.float32)

def embed_track(model, processor, device, src: str, duration_s: float):
    import numpy as np, torch
    marks = [0.25, 0.5, 0.75] if duration_s and duration_s > 45 else [0.5]
    windows = []
    for m in marks:
        start = max(0.0, (duration_s or 60) * m - WINDOW_S / 2)
        w = decode_window(src, start)
        if w is not None:
            windows.append(w)
    if not windows:
        return None
    embs = []
    with torch.no_grad():
        for w in windows:
            try:
                inputs = processor(audios=w, sampling_rate=SAMPLE_RATE, return_tensors="pt").to(device)
            except TypeError:  # transformers 5.x renamed the kwarg
                inputs = processor(audio=w, sampling_rate=SAMPLE_RATE, return_tensors="pt").to(device)
            e = _feat(model.get_audio_features(**inputs))[0].cpu().numpy()
            embs.append(e / (np.linalg.norm(e) or 1))
    v = np.mean(embs, axis=0)
    v = v / (np.linalg.norm(v) or 1)
    return v.astype(np.float32).tobytes()

def run_batch(limit: int) -> int:
    lib = json.load(open(LIB_PATH))
    tracks = lib.get("tracks", [])
    music_root = os.environ.get("JT_MUSIC_DIR") or os.path.expanduser("~/Music/JakeTunesLibrary/iPod_Control/Music")
    done = read_index(OUT_PATH)
    todo = [t for t in tracks if isinstance(t.get("id"), int) and t["id"] not in done]
    log(f"library {len(tracks)} | already embedded {len(done)} | to do {len(todo)}" + (f" (limit {limit})" if limit else ""))
    if not todo:
        return 0
    model, processor, device = load_model()
    log(f"model {MODEL_ID} on {device}")
    n = ok = miss = err = 0
    t0 = time.time()
    for t in todo:
        if limit and n >= limit:
            break
        n += 1
        tid = t["id"]
        colon = str(t.get("path") or "")
        local = colon_to_abs(colon, music_root) if colon else ""
        src = local if local and os.path.exists(local) else f"{HOMEMINI_AUDIO}/{tid}"
        try:
            dur_ms = float(t.get("duration") or 0)
            blob = embed_track(model, processor, device, src, dur_ms / 1000.0)
            if blob is None:
                miss += 1
            else:
                done[tid] = blob
                ok += 1
        except Exception as e:
            err += 1
            if err <= 5:
                log(f"id {tid} failed: {e}")
        if ok and ok % 50 == 0:
            write_index(OUT_PATH, done)
            rate = n / max(1, time.time() - t0)
            eta_h = (len(todo) - n) / max(rate, 0.01) / 3600
            log(f"{ok} embedded ({miss} undecodable, {err} errors) — {rate:.2f}/s, ~{eta_h:.1f}h left")
    write_index(OUT_PATH, done)
    log(f"DONE this run: embedded {ok}, undecodable {miss}, errors {err} — index now {len(done)} vectors")
    return 0

def run_server() -> int:
    model, processor, device = load_model()
    import numpy as np, torch
    log(f"server ready ({MODEL_ID} on {device})")
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            q = json.loads(line).get("q", "")
            with torch.no_grad():
                inputs = processor(text=[q], return_tensors="pt", padding=True).to(device)
                e = _feat(model.get_text_features(**inputs))[0].cpu().numpy()
            e = e / (np.linalg.norm(e) or 1)
            print(json.dumps({"v": [round(float(x), 6) for x in e]}), flush=True)
        except Exception as e:
            print(json.dumps({"error": str(e)[:200]}), flush=True)
    return 0

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--server", action="store_true")
    args = ap.parse_args()
    return run_server() if args.server else run_batch(args.limit)

if __name__ == "__main__":
    sys.exit(main())
