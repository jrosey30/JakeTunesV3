"""rt_v3_20261012 — router-truth on tonight's snapshot, current indexes only.

TAXONOMY NIGHT: the laptop overrides refresh re-tagged 7,189/11,560 tracks
(coarse -> fine leaves: Rap 1250->0, Funk/Soul 165->0, Classic Rock
1073->634). 0 existing vectors changed bytes, so 62% of main-index embed
texts (and the mood texts' genre line) now carry STALE coarse tags while
library.json (the ruler + the production reranker's lexical source) speaks
the fine taxonomy. run_eval fell 0.781 -> 0.731 entirely on ret-006 (-0.52)
and ret-011 (-0.48); both reproduce on LAST night's bytes under today's
ruler = ruler/text-staleness event, not a brain regression. rt tonight
measures the production cost. Series: 10-09 0.837 -> 10-10 0.837 -> 10-11
0.849 (plain-brain high). Standing rule: rt < 0.80 = something NEW. READ-ONLY.
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("JT_STATE_DIR", "/tmp/brain-v3-20261012")
import numpy as np
import run_eval as R
import diag_ret011_012 as D

SNAP = "/tmp/brain-v3-20261012"
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
