"""exp_20260920_stale_drain_check — READ-ONLY. Falsifiable follow-up to
exp_20260916_stale215_eta: did the frozen stale-215 mood cohort start draining
on the 09-17 trainer run as hypothesis A (pure queue tail) predicted?

Prediction (09-16, pre-registered): cohort 215 -> ~198 after night 1 (17 in
queue positions 0-49), or reopen the investigation.

Method: id-level SET DIFF of the cohort between the frozen nightly snapshots
(/tmp/brain-snap-20260916 vs /tmp/brain-snap-20260919) — proves which ids
drained and which joined, instead of trusting count arithmetic. Reusable for
subsequent drain nights by bumping the two SNAP dirs.

RESULT 09-17: old 215 -> survivors 200, drained 15, joined 0. The -2 gap vs
the predicted 17 is the night's +2 fresh imports (12002/12003) queue-jumping
the recent-first head (both got full descriptors tonight = 2 of the 50 slots).
Hypothesis A CONFIRMED on drain night 1; no reopen.

RESULT 09-20 (drain night 4, this copy): old 104 -> survivors 90, drained 14,
joined 0. The night's +36 fresh imports (12008-12043) queue-jumped the
recent-first head — 36 + 14 = 50 exactly, zero residual a FOURTH night.
The import wave stretches empty-day past ~09-21 while imports continue.
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("JT_STATE_DIR", "/tmp/brain-snap-20260920")
import run_eval as R

OLD = "/tmp/brain-snap-20260919"
NEW = "/tmp/brain-snap-20260920"

def cohort(snap):
    desc = json.load(open(snap + "/brain-descriptors.json"))
    dd = desc.get("descriptors", desc)
    lib = json.load(open(snap + "/library.json"))
    tracks = lib.get("tracks", lib)
    lib_int = set(int(t["id"]) for t in tracks)
    ids_m, _, _ = R.read_embeddings(snap + "/mood-index.bin")
    return set(int(t) for t in ids_m
               if int(t) in lib_int and not dd.get(str(int(t)), {}).get("d")), lib_int

old, lib_old = cohort(OLD)
new, lib_new = cohort(NEW)
print(f"old cohort={len(old)} new cohort={len(new)}")
print(f"drained (old->enriched): {len(old - new)}")
print(f"joined: {len(new - old)} ids={sorted(new - old)}")
print(f"new library ids: {sorted(lib_new - lib_old)}")
print(f"survivors: {len(old & new)}")
