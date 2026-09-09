"""rt_20260909 — router-truth on tonight's snapshot, current indexes only.
Extends the production series (09-04 0.818 -> 09-05 0.816 -> 09-06 0.811 -> 09-08 0.808).
READ-ONLY; no candidate built."""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("JT_STATE_DIR", "/tmp/brain-snap-20260909")
import numpy as np
import run_eval as R
import diag_ret011_012 as D

SNAP = "/tmp/brain-snap-20260909"
tracks, by_id, titles, artists = R.load_library()
lib_ids = set(by_id.keys())
ids_i, vecs_i, _ = R.read_embeddings(os.path.join(SNAP, "embeddings.bin"))
ids_m, vecs_m, _ = R.read_embeddings(os.path.join(SNAP, "mood-index.bin"))
eval_set = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "eval_set.json")))
probes = [p for p in eval_set["prompts"] if p["bucket"] == "retrieval"]
artist_norms = {a for a in artists if a}
qvecs = R.embed_texts([p["query"] for p in probes])

def score(ids, vecs, qv, expected, k):
    top = np.argsort(-(vecs @ qv))[: k * 3]
    got, seen = 0, 0
    for j in top:
        tid = int(ids[j])
        if tid not in lib_ids:
            seen += 1
            if seen >= k: break
            continue
        seen += 1
        if tid in expected: got += 1
        if seen >= k: break
    return got / k

rt = []
for pi, p in enumerate(probes):
    k = p.get("k", 25)
    expected = R.expected_ids(p["expected"], tracks)
    k = min(k, len(expected)) if expected else k
    si = score(ids_i, vecs_i, qvecs[pi], expected, k)
    sm = score(ids_m, vecs_m, qvecs[pi], expected, k)
    dest, why = D.route(p["query"], artist_norms, len(ids_m), len(ids_i))
    rt.append(si if dest == "main" else sm)
    print(f"{p['id']}  k={k:<3} identity={si:.2f} mood={sm:.2f}  route={dest}({why})  rt={rt[-1]:.2f}")
print(f"\nrouter-truth (current production): {np.mean(rt):.3f}")
mood_routed = [rt[i] for i, p in enumerate(probes) if D.route(p['query'], artist_norms, len(ids_m), len(ids_i))[0] != 'main']
print(f"mood-routed mean: {np.mean(mood_routed):.3f} over {len(mood_routed)} probes")
