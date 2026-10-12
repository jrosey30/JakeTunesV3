"""Decompose candidate ret-007 mood 0.44->0.16: bare ADDS vs text refresh. READ-ONLY."""
import json, os, sys, struct
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("JT_STATE_DIR", "/tmp/brain-cand-20261012")
import numpy as np
import run_eval as R

tracks, by_id, _, _ = R.load_library()
es = json.load(open("eval_set.json"))
p = [q for q in es["prompts"] if q["id"] == "ret-007"][0]
exp = R.expected_ids(p["expected"], tracks)
qv = R.embed_texts([p["query"]])[0]

def read_ids(path):
    ids, vecs, _ = R.read_embeddings(path)
    return ids, vecs
snap_ids, _ = read_ids("/tmp/brain-snap-20261012/mood-index.bin")
snap_set = set(int(x) for x in snap_ids)
ids, vecs = read_ids("/tmp/brain-cand-20261012/mood-index.bin")
top = np.argsort(-(vecs @ qv))[:25]
desc = json.load(open("/tmp/brain-cand-20261012/brain-descriptors.json"))
dd = desc.get("descriptors", desc)
new_adds = hits = bare = 0
for rank, j in enumerate(top, 1):
    tid = int(ids[j])
    is_new = tid not in snap_set
    is_bare = not dd.get(str(tid), {}).get("d")
    new_adds += is_new; bare += is_bare; hits += tid in exp
    print(f"{rank:2d} id={tid:5d} {'ADD' if is_new else '   '} {'BARE' if is_bare else '    '} {'HIT' if tid in exp else 'miss'}")
print(f"\nhits={hits}/25  newly-added-in-top25={new_adds}  bare-in-top25={bare}")
