"""exp_20260912_sag_decomp — READ-ONLY decomposition of the wave sag.

rt series: ... -> 09-09 0.805 -> 09-10 0.819 -> 09-11 0.819 -> 09-12 0.816 (2nd drain night, backlog 485->447). FOURTH data point for the orphan component.
Question: how much of the sag is (a) the 18 mood orphans (same-day-deleted
imports whose bare-genre vectors NEVER self-heal — trainer doesn't prune the
mood index) vs (b) un-enriched in-library imports (self-heal at ~50/night)?

S0 = current production mood-index                      (the 0.805 baseline)
S1 = S0 minus the 18 identity-gated orphans             (what a trainer-side prune buys)
S2 = S1 minus un-enriched in-library vectors            (post-wave ceiling ESTIMATE — upper
     bound-ish: real enrichment gives those tracks legit vectors that may re-enter top-k)

No candidate file is written. Nothing is applied.
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("JT_STATE_DIR", "/tmp/brain-snap-20260912")
import numpy as np
import run_eval as R
import diag_ret011_012 as D

SNAP = "/tmp/brain-snap-20260912"
tracks, by_id, titles, artists = R.load_library()
lib_ids = set(by_id.keys())
ids_i, vecs_i, _ = R.read_embeddings(os.path.join(SNAP, "embeddings.bin"))
ids_m, vecs_m, _ = R.read_embeddings(os.path.join(SNAP, "mood-index.bin"))
desc = json.load(open(SNAP + "/brain-descriptors.json"))
dd = desc.get("descriptors", desc)

orphan_mask = np.array([int(t) not in lib_ids and t not in lib_ids for t in ids_m])
# run_eval load_library may key by str or int — normalize
def in_lib(tid):
    return tid in lib_ids or str(tid) in lib_ids or int(tid) in {int(x) for x in []}
lib_int = set(int(x) for x in by_id.keys())
orphan_mask = np.array([int(t) not in lib_int for t in ids_m])
unenriched_mask = np.array([
    (int(t) in lib_int) and not (dd.get(str(int(t)), {}).get("d"))
    for t in ids_m
])
print(f"mood vectors={len(ids_m)} orphans={orphan_mask.sum()} unenriched_in_lib={unenriched_mask.sum()}")

eval_set = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "eval_set.json")))
probes = [p for p in eval_set["prompts"] if p["bucket"] == "retrieval"]
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

def orphan_slots(ids, vecs, qv, k):
    top = np.argsort(-(vecs @ qv))[:k]
    return sum(1 for j in top if int(ids[j]) not in lib_int), \
           sum(1 for j in top if int(ids[j]) in lib_int and not dd.get(str(int(ids[j])), {}).get("d"))

scenarios = {
    "S0_current": np.ones(len(ids_m), dtype=bool),
    "S1_no_orphans": ~orphan_mask,
    "S2_no_orphans_no_unenriched": ~orphan_mask & ~unenriched_mask,
}

results = {}
for name, keep in scenarios.items():
    ids_s, vecs_s = ids_m[keep], vecs_m[keep]
    rt, per = [], {}
    for pi, p in enumerate(probes):
        k = p.get("k", 25)
        expected = R.expected_ids(p["expected"], tracks)
        k = min(k, len(expected)) if expected else k
        si = score(ids_i, vecs_i, qvecs[pi], expected, k)
        sm = score(ids_s, vecs_s, qvecs[pi], expected, k)
        dest, why = D.route(p["query"], {a for a in artists if a}, len(ids_s), len(ids_i))
        val = si if dest == "main" else sm
        rt.append(val); per[p["id"]] = round(val, 2)
    results[name] = (float(np.mean(rt)), per)
    print(f"{name}: rt={np.mean(rt):.3f}  {per}")

# attribution: top-k slot occupancy on the watched genre probes, current index
print("\nslot occupancy in CURRENT mood top-k (orphan_slots, unenriched_slots):")
for pi, p in enumerate(probes):
    if p["id"] in ("ret-007", "ret-008", "ret-011", "ret-012", "ret-014", "ret-015"):
        k = p.get("k", 25)
        o, u = orphan_slots(ids_m, vecs_m, qvecs[pi], k)
        print(f"  {p['id']} k={k}: orphans={o} unenriched={u}")

s0, s1, s2 = results["S0_current"][0], results["S1_no_orphans"][0], results["S2_no_orphans_no_unenriched"][0]
print(f"\nDECOMPOSITION: sag from healthy 0.833-0.844 band; current {s0:.3f}")
print(f"  orphan component (never self-heals, trainer-prune fixes): +{s1-s0:.3f}")
print(f"  un-enriched component (self-heals ~50/night):            +{s2-s1:.3f}")
print(f"  post-wave ceiling estimate (S2): {s2:.3f}")
per0, per1 = results["S0_current"][1], results["S1_no_orphans"][1]
worst = min((per1[k] - per0[k]) for k in per0)
print(f"  S1 worst per-probe delta vs S0: {worst:+.2f}")
