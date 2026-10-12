"""diag_ruler_20261012 — adjudicate tonight's ret-006 (-0.52) / ret-011 (-0.48)
drops: brain regression vs ruler shift. Tonight 0 existing vectors changed
bytes, but the laptop metadata-overrides refresh rewrote library.json genres
(applied 11,345->11,558; taxonomy-merged fell 10,516->10,495 despite +141).
Compare expected-set membership computed from the 10-11 vs 10-12 snapped
library.json, and re-score tonight's top-k under LAST NIGHT'S ruler. READ-ONLY."""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("JT_STATE_DIR", "/tmp/brain-snap-20261012")
import numpy as np
import run_eval as R

CUR, PREV = "/tmp/brain-snap-20261012", "/tmp/brain-snap-20261011"
es = json.load(open("eval_set.json"))
prompts = {q["id"]: q for q in es["prompts"]}

def load_lib(path):
    saved_env = os.environ["JT_STATE_DIR"]
    os.environ["JT_STATE_DIR"] = path
    try:
        return R.load_library()
    finally:
        os.environ["JT_STATE_DIR"] = saved_env

tr_cur, by_cur, _, _ = load_lib(CUR)
tr_prev, by_prev, _, _ = load_lib(PREV)
ids_e, vecs_e, _ = R.read_embeddings(os.path.join(CUR, "embeddings.bin"))

for pid in ("ret-006", "ret-011"):
    p = prompts[pid]
    k = {"ret-006": 25, "ret-011": 25}[pid]
    exp_cur = set(R.expected_ids(p["expected"], tr_cur))
    exp_prev = set(R.expected_ids(p["expected"], tr_prev))
    lost = exp_prev - exp_cur          # left the ruler tonight
    gained = exp_cur - exp_prev        # entered the ruler tonight
    print(f"\n== {pid} {p['query']!r}  |expected| prev={len(exp_prev)} cur={len(exp_cur)} "
          f"lost={len(lost)} gained={len(gained)}")
    qv = R.embed_texts([p["query"]])[0]
    top = [int(ids_e[j]) for j in np.argsort(-(vecs_e @ qv))[:k]]
    hit_cur = sum(1 for t in top if t in exp_cur)
    hit_prev = sum(1 for t in top if t in exp_prev)
    print(f"top-{k} scored by TONIGHT's ruler: {hit_cur}/{k} = {hit_cur/k:.2f}")
    print(f"same top-{k} by LAST NIGHT's ruler: {hit_prev}/{k} = {hit_prev/k:.2f}")
    flipped = [t for t in top if (t in exp_prev) and (t not in exp_cur)]
    print(f"top-{k} slots that flipped OUT of expected overnight: {len(flipped)}")
    def g(byid, t):
        rec = byid.get(str(t)) or byid.get(t) or {}
        return rec.get("artist","?"), rec.get("title","?"), rec.get("genre","?"), rec.get("year","?")
    for t in flipped[:12]:
        a1,t1,g1,y1 = g(by_prev, t); a2,t2,g2,y2 = g(by_cur, t)
        print(f"  id={t} {a1[:20]} — {t1[:24]}: genre {g1!r} -> {g2!r}, year {y1} -> {y2}")
