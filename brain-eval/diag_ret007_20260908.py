import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("JT_STATE_DIR", "/tmp/brain-snap-20260908")
import numpy as np
import run_eval as R

SNAP = "/tmp/brain-snap-20260908"
tracks, by_id, titles, artists = R.load_library()
lib_ids = set(by_id.keys())
ids_m, vecs_m, _ = R.read_embeddings(os.path.join(SNAP, "mood-index.bin"))
eval_set = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "eval_set.json")))
p = [q for q in eval_set["prompts"] if q["id"] == "ret-007"][0]
expected = R.expected_ids(p["expected"], tracks)
k = min(p.get("k", 25), len(expected))
qv = R.embed_texts([p["query"]])[0]
desc = json.load(open(SNAP + "/brain-descriptors.json"))
dd = desc.get("descriptors", desc)
top = np.argsort(-(vecs_m @ qv))[:k]
print(f"query: {p['query']!r}  k={k}")
for rank, j in enumerate(top):
    tid = int(ids_m[j])
    tr = by_id.get(str(tid)) or by_id.get(tid) or {}
    d = dd.get(str(tid), {})
    hit = "HIT " if tid in expected else "MISS"
    print(f"{rank+1:>2} {hit} cos={float(vecs_m[j] @ qv):.3f} id={tid} {str(tr.get('artist'))[:22]:<22} {str(tr.get('title'))[:24]:<24} genre={str(tr.get('genre'))[:14]:<14} enriched={bool(d.get('d'))} te={d.get('te')}")
