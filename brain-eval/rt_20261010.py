"""rt_20261010 — router-truth on tonight's snapshot, current indexes only.

First post-retirement night (orphan-tax decomp series closed 10-09 at 22
points): the standard nightly now carries rt WITHOUT the S1/S2 decomposition.
Standing rule: rt < 0.80 = something NEW (no orphan excuse remains).
Series: 10-06 0.835 -> 10-07 0.835 -> 10-09 0.837 (healthy band 0.833-0.844);
tonight is backlog-226 wave night 2 — in-band wobble expected, no alarm
unless < 0.80. READ-ONLY; no candidate built.
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("JT_STATE_DIR", "/tmp/brain-snap-20261010")
import numpy as np
import run_eval as R
import diag_ret011_012 as D

SNAP = "/tmp/brain-snap-20261010"
tracks, by_id, titles, artists = R.load_library()
lib_int = set(int(x) for x in by_id.keys())
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
        if tid not in lib_int:
            seen += 1
            if seen >= k: break
            continue
        seen += 1
        if tid in expected: got += 1
        if seen >= k: break
    return got / k

rt, routed_mood = [], []
for pi, p in enumerate(probes):
    k = p.get("k", 25)
    expected = R.expected_ids(p["expected"], tracks)
    k = min(k, len(expected)) if expected else k
    si = score(ids_i, vecs_i, qvecs[pi], expected, k)
    sm = score(ids_m, vecs_m, qvecs[pi], expected, k)
    dest, why = D.route(p["query"], artist_norms, len(ids_m), len(ids_i))
    val = si if dest == "main" else sm
    rt.append(val)
    if dest != "main": routed_mood.append(val)
    print(f"{p['id']}  k={k:<4} identity={si:.2f} mood={sm:.2f}  route={dest}({why})  rt={val:.2f}")
print(f"\nrouter-truth (current production): {np.mean(rt):.3f}")
print(f"mood-routed mean: {np.mean(routed_mood):.3f} over {len(routed_mood)} probes")
