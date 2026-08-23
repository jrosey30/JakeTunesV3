import json, os, sys
sys.path.insert(0, "/tmp/brain-eval-20260823/brain-eval")
os.environ.setdefault("JT_STATE_DIR", "/tmp/brain-snap-20260823")
import run_eval as R
ids_m, vecs_m, _ = R.read_embeddings(os.path.join(R.STATE_DIR, "mood-index.bin"))
ids_c, vecs_c, _ = R.read_embeddings("/tmp/mood-index.candidate-20260823.bin")
tracks, by_id, *_ = R.load_library()
p = [q for q in json.load(open("eval_set.json"))["prompts"] if q["id"] == "ret-015"][0]
qv = R.embed_texts([p["query"]])[0]
expected = R.expected_ids(p["expected"], tracks)
cur = R.retrieve_topk(qv, ids_m, vecs_m, 30)
cand = R.retrieve_topk(qv, ids_c, vecs_c, 30)
rep = set(json.load(open("repair_20260822_ids.json"))["repaired"])
for label, top, other in (("CURRENT-only", [t for t in cur if t not in cand], cand),
                          ("CANDIDATE-only", [t for t in cand if t not in cur], cur)):
    print(f"--- {label} ({len(top)}) ---")
    for tid in top:
        t = by_id.get(tid)
        mark = "*" if tid in expected else " "
        r = "R" if tid in rep else " "
        if t:
            print(f" {mark}{r} {t.get('genre') or '?':<22.22} {t.get('artist') or '?':<22.22} {t.get('title') or '?'}")
        else:
            print(f" {mark}{r} [orphan {tid}]")
