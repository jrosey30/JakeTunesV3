#!/usr/bin/env python3
"""gate_only_20260901 — READ-ONLY re-run of repair_20260901.py's fidelity gate.

The full repair already ran and PASSED tonight, but its gate lines were lost
to a truncated terminal capture. This replays ONLY the 50-vector cohort embed
(same logic, same cohort selection) to record the numbers for the ledger.
Excludes repair_20260901_ids.json from the prior-ids glob (it now exists,
written by tonight's run — the original gate ran before it existed).
"""
import json, os, struct, sys, time, glob
sys.path.insert(0, "/Users/jakerosenbaumnas/.brain-eval-wt-20260901/brain-eval")
os.environ.setdefault("JT_STATE_DIR", "/tmp/brain-snap-20260901")
import numpy as np
import run_eval as R
import urllib.request

HERE = "/Users/jakerosenbaumnas/.brain-eval-wt-20260901/brain-eval"
SNAP = "/tmp/brain-snap-20260901"
FRESH_CUTOFF = "2026-09-01T05:55"

def embed_raw(texts):
    k = R.key("OPENAI_API_KEY")
    payload = json.dumps({"model": R.EMBED_MODEL, "input": texts}).encode()
    req = urllib.request.Request(
        "https://api.openai.com/v1/embeddings", data=payload,
        headers={"Authorization": f"Bearer {k}", "Content-Type": "application/json"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                data = json.loads(r.read())
            ordered = sorted(data["data"], key=lambda d: d["index"])
            return np.array([d["embedding"] for d in ordered], dtype=np.float32)
        except Exception:
            if attempt == 3:
                raise
            time.sleep(2.0 * (attempt + 1))

def read_raw_map(path):
    blob = open(path, "rb").read()
    assert blob[0:4] == b"EMBD"
    ver = struct.unpack_from("<H", blob, 4)[0]
    dim = struct.unpack_from("<H", blob, 6)[0]
    count = struct.unpack_from("<I", blob, 8)[0]
    off, out = 12, {}
    for _ in range(count):
        tid = struct.unpack_from("<I", blob, off)[0]; off += 4
        out[tid] = np.frombuffer(blob[off:off + dim * 4], dtype=np.float32).copy(); off += dim * 4
    return ver, dim, out

def cos(a, b):
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    if na == 0 or nb == 0: return 0.0
    return float(np.dot(a, b) / (na * nb))

tracks, by_id, titles, artists = R.load_library()
lib_ids = set(by_id.keys())
desc = json.load(open(os.path.join(SNAP, "brain-descriptors.json")))
intended = {}
for line in open(os.path.join(HERE, "mood-texts.jsonl")):
    r = json.loads(line)
    intended[r["id"]] = r["base"]

ver, dim, cur = read_raw_map(os.path.join(SNAP, "mood-index.bin"))
prior_ids = set()
for f in glob.glob(os.path.join(HERE, "repair_*_ids.json")):
    if "20260901" in f:
        continue  # tonight's file didn't exist when the original gate ran
    d = json.load(open(f))
    for k2 in ("repaired", "pruned_orphans", "excluded_tempo_view"):
        prior_ids.update(d.get(k2, []))
fresh = sorted(i for i in cur if str(i) in desc and (desc[str(i)].get("at") or "") >= FRESH_CUTOFF
               and i in intended and i in lib_ids)[:50]
print(f"trainer-fresh vectors tonight: {len(fresh)}")
if len(fresh) < 50:
    aged = sorted(i for i in cur
                  if str(i) in desc and desc[str(i)].get("d")
                  and (desc[str(i)].get("at") or "9999") < "2026-08-16"
                  and i in intended and i in lib_ids and i not in prior_ids)
    need = 50 - len(fresh)
    step = max(1, len(aged) // need)
    topup = aged[::step][:need]
    fresh = fresh + topup
    print(f"  topped up with {len(topup)} aged never-repaired vectors "
          f"({len(aged)} eligible) -> cohort {len(fresh)}")
emb = embed_raw([intended[i] for i in fresh])
sims = [cos(emb[j], cur[i]) for j, i in enumerate(fresh)]
ok = sum(1 for s in sims if s >= 0.98)
print(f"fidelity gate (hybrid): {ok}/{len(fresh)} trainer-authored vectors match reconstruction >=0.98 "
      f"(min {min(sims):.4f})")
for j, i in enumerate(fresh):
    if sims[j] < 0.98:
        t = by_id[i]
        print(f"  MISS id {i} cos {sims[j]:.3f} bpm={t.get('bpm')} teb={desc[str(i)].get('teb')} "
              f"{t.get('artist')} — {t.get('title')}")
