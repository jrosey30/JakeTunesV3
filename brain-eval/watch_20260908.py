import json, struct, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("JT_STATE_DIR", "/tmp/brain-snap-20260908")
import run_eval as R

def read_ids(path):
    blob = open(path, "rb").read()
    assert blob[0:4] == b"EMBD"
    dim = struct.unpack_from("<H", blob, 6)[0]
    count = struct.unpack_from("<I", blob, 8)[0]
    off, ids = 12, []
    for _ in range(count):
        ids.append(struct.unpack_from("<I", blob, off)[0]); off += 4 + dim*4
    return set(ids)

tracks, by_id, titles, artists = R.load_library()
lib_ids = set(int(x) for x in by_id.keys())
emb_ids = read_ids("/tmp/brain-snap-20260908/embeddings.bin")
print(f"embeddings vectors={len(emb_ids)} orphans={len(emb_ids - lib_ids)} (watch: was 146 on 09-06)")

desc = json.load(open("/tmp/brain-snap-20260908/brain-descriptors.json"))
dd = desc.get("descriptors", desc)
# te census
from collections import Counter
c = Counter()
for tid, d in dd.items():
    c[repr(d.get("te"))] += 1
print("te census (all descriptor rows):", dict(c))

# watchlist: 11467-11499 + 454
wl = list(range(11467, 11500)) + [454]
still = [t for t in wl if str(t) in dd and dd[str(t)].get("te") not in (3, True)]
print(f"watchlist still un-encoded: {len(still)}/{len([t for t in wl if str(t) in dd])} -> {still[:40]}")

# queue math: trainer catch-up queue = library-order tracks with bpm>0 and te != 3 (v3), slice(0,500)
# count how many te==2 (old encoding) sit ahead in library order
order = []
for i, t in enumerate(tracks):
    tid = str(t.get("id"))
    d = dd.get(tid)
    if d is None: continue
    te = d.get("te")
    order.append((i, tid, te))
te2 = [x for x in order if x[2] == 2]
never = [x for x in order if x[2] in (None, False)]
print(f"library-order queue: te=2 (v2 re-encode pending) = {len(te2)}, te in (None,False) with descriptor = {len(never)}")
# position of first watchlist id among te!=3 queue
q = [x for x in order if x[2] not in (3, True)]
pos = {tid: i for i, (_, tid, _) in enumerate(q)}
wpos = [(t, pos.get(str(t))) for t in wl if str(t) in pos]
print("watchlist queue positions (nights away at 500/night):", [(t, p, None if p is None else p // 500) for t, p in wpos[:8]], "...")
