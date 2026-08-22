#!/usr/bin/env python3
"""prove_20260822 — score the repair candidate on the frozen ruler.
Identical methodology to diag_ret011_012 (same loaders, scorer, router)
so router-truth is comparable to the 0.821/0.836/0.837 series.
Pre-registered bars: no candidate-vs-current mood probe regression;
router-truth(candidate) >= 0.83. READ-ONLY."""
import json, os, re, sys
sys.path.insert(0, "/tmp/jt-brain-eval-0822/brain-eval")
os.environ.setdefault("JT_STATE_DIR", "/tmp/brain-snap-20260822")
import numpy as np
import run_eval as R
from diag_ret011_012 import route

CAND = "/tmp/mood-index.candidate-20260822.bin"

ids_i, vecs_i, meta_i = R.read_embeddings(R.EMB_PATH)
ids_m, vecs_m, meta_m = R.read_embeddings(os.path.join(R.STATE_DIR, "mood-index.bin"))
ids_c, vecs_c, meta_c = R.read_embeddings(CAND)
tracks, by_id, titles, artists = R.load_library()
print(f"identity {meta_i['count']} sha {R.sha_of(R.EMB_PATH)} | mood-cur {meta_m['count']} "
      f"sha {R.sha_of(os.path.join(R.STATE_DIR, 'mood-index.bin'))} | cand {meta_c['count']} sha {R.sha_of(CAND)}")

GENRE_WORD_ARTISTS = {"house", "gospel", "punk", "disco", "funk", "soul", "jazz", "blues"}
artist_norms = set()
for t in tracks:
    a = re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", (t.get("artist") or "").lower())).strip()
    if len(a) >= 4 and a not in GENRE_WORD_ARTISTS:
        artist_norms.add(a)

prompts = [p for p in json.load(open(os.path.join(R.HERE, "eval_set.json")))["prompts"]
           if p["bucket"] == "retrieval"]
qvecs = R.embed_texts([p["query"] for p in prompts])

rt_cur, rt_cand, worst = [], [], 0.0
print(f"\n{'probe':<9} {'k':>3} {'ident':>6} {'moodC':>6} {'moodX':>6} {'Δmood':>7}  route")
for p, qv in zip(prompts, qvecs):
    expected = R.expected_ids(p["expected"], tracks)
    k = p["k"]
    ri = R.recall_at_k(R.retrieve_topk(qv, ids_i, vecs_i, k), expected, k)
    rm = R.recall_at_k(R.retrieve_topk(qv, ids_m, vecs_m, k), expected, k)
    rc = R.recall_at_k(R.retrieve_topk(qv, ids_c, vecs_c, k), expected, k)
    rt, why = route(p["query"], artist_norms, meta_c["count"], meta_i["count"])
    rt_cur.append(rm if rt == "mood" else ri)
    rt_cand.append(rc if rt == "mood" else ri)
    worst = min(worst, rc - rm)
    print(f"{p['id']:<9} {k:>3} {ri:>6.2f} {rm:>6.2f} {rc:>6.2f} {rc - rm:>+7.2f}  {rt}({why})")

print(f"\nrouter-truth: current {np.mean(rt_cur):.3f} -> candidate {np.mean(rt_cand):.3f}")
print(f"worst per-probe mood delta (cand - cur): {worst:+.2f}")
ok = worst >= -0.0001 and float(np.mean(rt_cand)) >= 0.83
print("BARS:", "PASS — candidate is apply-eligible" if ok else "FAIL — do NOT apply")
