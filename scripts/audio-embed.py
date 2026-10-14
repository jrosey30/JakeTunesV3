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
LEDGER_PATH = os.path.join(STATE_DIR, "enrichment-ledger.json")
# Brief 177: a failed CLAP attempt is not retried for 30 days — mirrors
# lyrics-fetch.mjs's MISS_TTL_MS and scripts/enrichment-ledger.mjs's
# RETRY_TTL_MS (this file carries the Python mirror of that ledger format).
RETRY_TTL_MS = 30 * 24 * 3600 * 1000
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

# ── Enrichment ledger (Brief 177) ────────────────────────────────────────────
# enrichment-ledger.json in STATE_DIR — the cross-job per-track attempted/
# done record. The canonical format + rules live in
# scripts/enrichment-ledger.mjs; this is its Python mirror (same shape, same
# TTL). The ledger is a SIDECAR on purpose: library.json's sole writer is
# the desktop app, and jobs writing into it would recreate the multi-writer
# defect. A corrupt ledger reads as empty — audio-index.bin remains the
# truth for "done"; only attempt history is lost.
def load_ledger() -> dict:
    try:
        with open(LEDGER_PATH) as f:
            raw = json.load(f)
        if isinstance(raw, dict) and isinstance(raw.get("tracks"), dict):
            return {"version": 1, "tracks": raw["tracks"]}
    except Exception:
        pass
    return {"version": 1, "tracks": {}}

def save_ledger(ledger: dict) -> None:
    tmp = f"{LEDGER_PATH}.{os.getpid()}.tmp"
    with open(tmp, "w") as f:
        json.dump(ledger, f)
        f.flush(); os.fsync(f.fileno())
    os.replace(tmp, LEDGER_PATH)

def _ledger_entry(ledger: dict, tid: int) -> dict:
    e = ledger["tracks"].setdefault(str(tid), {
        "clapAttempted": False, "clapDone": False, "lyricsDone": False, "taxonomyDone": False,
        "clapAttemptedAt": None, "clapDoneAt": None, "lyricsAttemptedAt": None, "lyricsDoneAt": None,
        "taxonomyDoneAt": None, "lastError": None, "lastJob": None, "updatedAt": 0})
    return e

def _now_ms() -> int:
    return int(time.time() * 1000)

def order_candidates(todo: list, ledger: dict, now_ms: int) -> tuple:
    """Fresh (never attempted / TTL-expired) first; tracks that failed
    inside the retry TTL go to the BACK instead of leading every run."""
    fresh, deferred = [], []
    for t in todo:
        e = ledger["tracks"].get(str(t["id"]))
        if (e and e.get("clapAttempted") and not e.get("clapDone")
                and e.get("clapAttemptedAt") and (now_ms - e["clapAttemptedAt"]) <= RETRY_TTL_MS):
            deferred.append(t)
        else:
            fresh.append(t)
    return fresh + deferred, len(fresh), len(deferred)


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

NAS_LIB = os.environ.get("JT_NAS_LIB", "/Volumes/JakeShared/JakeTunesLibrary")

def nas_available() -> bool:
    """One cheap listability probe — a wedged SMB mount must not hang the batch."""
    try:
        import signal
        class _T(Exception): pass
        def _alarm(*_): raise _T()
        signal.signal(signal.SIGALRM, _alarm); signal.alarm(5)
        try:
            os.listdir(NAS_LIB)
            return True
        finally:
            signal.alarm(0)
    except Exception:
        return False

def run_batch(limit: int) -> int:
    lib = json.load(open(LIB_PATH))
    tracks = lib.get("tracks", [])
    music_root = os.environ.get("JT_MUSIC_DIR") or os.path.expanduser("~/Music/JakeTunesLibrary/iPod_Control/Music")
    done = read_index(OUT_PATH)
    todo = [t for t in tracks if isinstance(t.get("id"), int) and t["id"] not in done]
    # Brief 177: consult the ledger before ordering any work. Tracks the
    # index already holds are recorded done; failed-inside-TTL tracks are
    # deferred to the back of the queue instead of re-decoded first.
    ledger = load_ledger()
    for tid in done:
        e = _ledger_entry(ledger, tid)
        if not e.get("clapDone"):
            e["clapDone"] = True
            e["clapAttempted"] = True
    todo, n_fresh, n_deferred = order_candidates(todo, ledger, _now_ms())
    if n_deferred:
        log(f"ledger: {n_deferred} recently-failed track(s) deferred to the back (30-day retry TTL)")
    log(f"library {len(tracks)} | already embedded {len(done)} | to do {len(todo)}" + (f" (limit {limit})" if limit else ""))
    if not todo:
        return 0
    model, processor, device = load_model()
    use_nas = nas_available()
    log(f"model {MODEL_ID} on {device} | NAS vault {'available — preferred over homemini' if use_nas else 'absent — homemini HTTP fallback'}")
    n = ok = miss = err = 0
    t0 = time.time()
    for t in todo:
        if limit and n >= limit:
            break
        n += 1
        tid = t["id"]
        colon = str(t.get("path") or "")
        local = colon_to_abs(colon, music_root) if colon else ""
        # Source order (2026-09-01 EMFILE lesson): local file, then the NAS
        # vault DIRECTLY, and homemini's LIVE backend only as a last resort —
        # 29k HTTP range-reads from this batch once exhausted its
        # descriptors and took mobile playback down with it.
        rel = colon.replace(":", "/") if colon else ""
        nas_path = (NAS_LIB + rel) if (rel and use_nas) else ""
        if local and os.path.exists(local):
            src = local
        elif nas_path and os.path.exists(nas_path):
            src = nas_path
        else:
            src = f"{HOMEMINI_AUDIO}/{tid}"
        # Mark the attempt BEFORE the work, so even a crashed run leaves
        # the record that stops this track leading the next one.
        entry = _ledger_entry(ledger, tid)
        entry["clapAttempted"] = True
        entry["clapAttemptedAt"] = _now_ms()
        entry["lastJob"] = "clap"
        entry["updatedAt"] = _now_ms()
        try:
            dur_ms = float(t.get("duration") or 0)
            blob = embed_track(model, processor, device, src, dur_ms / 1000.0)
            if blob is None:
                miss += 1
                entry["lastError"] = "undecodable (no window decoded)"
            else:
                done[tid] = blob
                ok += 1
                entry["clapDone"] = True
                entry["clapDoneAt"] = _now_ms()
                entry["lastError"] = None
        except Exception as e:
            err += 1
            entry["lastError"] = str(e)[:200]
            if err <= 5:
                log(f"id {tid} failed: {e}")
        if ok and ok % 50 == 0:
            write_index(OUT_PATH, done)
            save_ledger(ledger)
            rate = n / max(1, time.time() - t0)
            eta_h = (len(todo) - n) / max(rate, 0.01) / 3600
            log(f"{ok} embedded ({miss} undecodable, {err} errors) — {rate:.2f}/s, ~{eta_h:.1f}h left")
    write_index(OUT_PATH, done)
    save_ledger(ledger)
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
