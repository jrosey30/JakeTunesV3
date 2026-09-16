"""exp_20260916_stale215_eta — READ-ONLY. When (if ever) does the frozen
stale-215 mood cohort drain?

Context: rt plateau 0.813 decomposes into orphan +0.011 (Jake-gated
trainer-prune) and un-enriched +0.007 whose mood cohort (215 in-lib mood
vectors with no descriptor `d`) has been FROZEN 7 straight nights while the
enrichment backlog drained 564->248 at 50/night. Two hypotheses:
  (A) the 215 sit at the tail of the trainer's enrichment queue
      (recent-adds-first then most-played-first, brain-trainer.mjs:753-761)
      and will drain in the backlog's final nights;
  (B) some/all of the 215 have a descriptor ENTRY with an empty `d` —
      the trainer's `done = Set(Object.keys(desc))` (line 456) skips any
      key that exists, so entry-without-d would NEVER drain (a real bug).
This script decides A vs B and, under A, gives the night-by-night ETA.
Writes nothing; reads the frozen /tmp snapshot only.
"""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("JT_STATE_DIR", "/tmp/brain-snap-20260916")
import run_eval as R

SNAP = "/tmp/brain-snap-20260916"
tracks, by_id, titles, artists = R.load_library()
lib_int = set(int(x) for x in by_id.keys())
desc = json.load(open(SNAP + "/brain-descriptors.json"))
dd = desc.get("descriptors", desc)

ids_m, _, _ = R.read_embeddings(os.path.join(SNAP, "mood-index.bin"))
stale = [int(t) for t in ids_m
         if int(t) in lib_int and not dd.get(str(int(t)), {}).get("d")]
print(f"stale mood cohort = {len(stale)}")

# --- hypothesis B check: entry present but d empty (trainer would skip forever)
entry_no_d = [t for t in stale if str(t) in dd]
no_entry   = [t for t in stale if str(t) not in dd]
print(f"  entry-without-d (NEVER drains, trainer bug if >0): {len(entry_no_d)}")
if entry_no_d:
    for t in entry_no_d[:10]:
        tr = by_id.get(str(t), {})
        print(f"    id={t} {tr.get('artist','?')} — {tr.get('title','?')} entry={json.dumps(dd[str(t)])[:120]}")
print(f"  no-entry (in the normal enrichment queue): {len(no_entry)}")

# --- whole-backlog census for the same split
backlog = [int(t.get("id")) for t in tracks
           if (t.get("artist") or t.get("title")) and not dd.get(str(t.get("id")), {}).get("d")]
b_entry_no_d = [t for t in backlog if str(t) in dd]
print(f"backlog(no-d, artist|title) = {len(backlog)}; of those entry-without-d = {len(b_entry_no_d)}")

# --- hypothesis A: reconstruct the trainer's exact queue (mjs lines 753-761)
RECENT_MS = 14 * 24 * 3600 * 1000
now = time.time() * 1000
def added_ms(t):
    v = t.get("dateAdded") or ""
    try:
        import datetime
        return datetime.datetime.fromisoformat(v.replace("Z", "+00:00")).timestamp() * 1000
    except Exception:
        return 0
def is_recent(t):
    a = added_ms(t)
    return a > 0 and (now - a) < RECENT_MS

queue = [t for t in tracks
         if str(t.get("id")) not in dd and (t.get("artist") or t.get("title"))]
queue.sort(key=lambda t: (
    0 if is_recent(t) else 1,
    -added_ms(t) if is_recent(t) else -(t.get("playCount") or 0),
))
pos = {int(t.get("id")): i for i, t in enumerate(queue)}
print(f"reconstructed queue length = {len(queue)} (trainer said backlog 248)")

in_q = sorted(pos[t] for t in no_entry if t in pos)
missing = [t for t in no_entry if t not in pos]
if missing:
    print(f"  WARNING: {len(missing)} stale ids not in queue (no artist/title?): {missing[:10]}")
if in_q:
    import math
    print(f"stale-cohort queue positions: min={in_q[0]} median={in_q[len(in_q)//2]} max={in_q[-1]}")
    nights = {}
    for p in in_q:
        n = p // 50 + 1
        nights[n] = nights.get(n, 0) + 1
    print("drain schedule at 50/night (night 1 = tonight's next trainer run):")
    for n in sorted(nights):
        print(f"  night {n}: {nights[n]} of the cohort")
    # playcount profile — why they waited
    pcs = [ (by_id.get(str(t), {}).get("playCount") or 0) for t in no_entry ]
    print(f"cohort playCount: zero={sum(1 for p in pcs if p==0)}/{len(pcs)} max={max(pcs) if pcs else '-'}")
