"""diag_newvec_20261012 — are tonight's +50 new vectors (12663-12712) the
displacers behind ret-006 0.92->0.40 and ret-011 0.60->0.12? Also score the
same queries against LAST NIGHT's embeddings.bin to isolate. READ-ONLY."""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("JT_STATE_DIR", "/tmp/brain-snap-20261012")
import numpy as np
import run_eval as R

CUR, PREV = "/tmp/brain-snap-20261012", "/tmp/brain-snap-20261011"
es = json.load(open("eval_set.json"))
prompts = {q["id"]: q for q in es["prompts"]}
tracks, by_id, _, _ = R.load_library()

for pid in ("ret-006", "ret-011"):
    p = prompts[pid]
    exp = set(R.expected_ids(p["expected"], tracks))
    qv = R.embed_texts([p["query"]])[0]
    print(f"\n== {pid} {p['query']!r}")
    for label, snap in (("CUR", CUR), ("PREV", PREV)):
        ids, vecs, _ = R.read_embeddings(os.path.join(snap, "embeddings.bin"))
        top = [int(ids[j]) for j in np.argsort(-(vecs @ qv))[:25]]
        hits = sum(1 for t in top if t in exp)
        newv = sum(1 for t in top if 12663 <= t <= 12712)
        imported = sum(1 for t in top if t >= 12520)  # tonight's import wave
        print(f" {label}: {hits}/25 hits, {newv} slots from new vectors 12663-12712, {imported} from ids>=12520")
        if label == "CUR":
            for rank, t in enumerate(top, 1):
                rec = by_id.get(str(t)) or by_id.get(t) or {}
                mark = "NEWVEC" if 12663 <= t <= 12712 else "      "
                print(f"  {rank:2d} id={t:5d} {mark} {'HIT ' if t in exp else 'miss'} "
                      f"{str(rec.get('artist','?'))[:22]} — {str(rec.get('title','?'))[:26]} "
                      f"[{str(rec.get('genre','?'))[:20]}] {rec.get('year','?')}")
