"""diag_ret007_20261011 — why did ret-007's mood score drop 1.00->0.44 tonight?
Hypothesis: the 10-10 --reembed-all added bare tempo+genre mood vectors for the
~277 backlog tracks (no descriptor yet); present-but-bare pollutes top-k where
absent could not. READ-ONLY."""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("JT_STATE_DIR", "/tmp/brain-snap-20261011")
import numpy as np
import run_eval as R

SNAP = "/tmp/brain-snap-20261011"
tracks, by_id, titles, artists = R.load_library()
lib_int = set(int(x) for x in by_id.keys())
ids_m, vecs_m, _ = R.read_embeddings(os.path.join(SNAP, "mood-index.bin"))
desc = json.load(open(SNAP + "/brain-descriptors.json"))
dd = desc.get("descriptors", desc)
es = json.load(open("eval_set.json"))
p = [q for q in es["prompts"] if q["id"] == "ret-007"][0]
expected = R.expected_ids(p["expected"], tracks)
qv = R.embed_texts([p["query"]])[0]
top = np.argsort(-(vecs_m @ qv))[:25]
newly_added = set(range(12163, 12571))  # tonight's added id range
hit = 0
for rank, j in enumerate(top, 1):
    tid = int(ids_m[j])
    t = by_id.get(str(tid), {})
    has_d = bool(dd.get(str(tid), {}).get("d"))
    ok = tid in expected
    hit += ok
    print(f"{rank:2d} id={tid} {'NEW' if tid in newly_added else '   '} desc={'Y' if has_d else 'BARE'} "
          f"{'HIT ' if ok else 'miss'} {t.get('artist','?')[:24]} — {t.get('title','?')[:28]} [{t.get('genre','?')[:18]}]")
print(f"\nrecall@25 = {hit/25:.2f}; bare-in-top25 = {sum(1 for j in top if not dd.get(str(int(ids_m[j])),{}).get('d'))}")
