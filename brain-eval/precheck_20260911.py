import json, struct, sys, os, hashlib
from collections import Counter, defaultdict
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("JT_STATE_DIR", "/tmp/brain-snap-20260911")
import run_eval as R

SNAP = "/tmp/brain-snap-20260911"

def read_map(path):
    blob = open(path, "rb").read()
    assert blob[0:4] == b"EMBD"
    dim = struct.unpack_from("<H", blob, 6)[0]
    count = struct.unpack_from("<I", blob, 8)[0]
    off, m = 12, {}
    for _ in range(count):
        tid = struct.unpack_from("<I", blob, off)[0]
        m[tid] = blob[off+4:off+4+dim*4]
        off += 4 + dim*4
    return m

tracks, by_id, titles, artists = R.load_library()
lib_ids = set(int(x) for x in by_id.keys())
print(f"library tracks = {len(lib_ids)}")

# --- mood-index fingerprint (THE clobber pre-check) ---
mood = read_map(SNAP + "/mood-index.bin")
mo = set(mood) - lib_ids
groups = defaultdict(list)
for tid, vec in mood.items():
    groups[hashlib.sha1(vec).digest()].append(tid)
dups = {k: v for k, v in groups.items() if len(v) > 1}
dup_tracks = sum(len(v) for v in dups.values())
print(f"mood-index: vectors={len(mood)} orphans={len(mo)} dup_groups={len(dups)} dup_tracks={dup_tracks}")
print(f"  orphan ids: {sorted(mo)[:40]}")
for k, v in sorted(dups.items(), key=lambda kv: -len(kv[1]))[:10]:
    names = [(t, by_id.get(str(t), {}).get('artist', '?')) for t in sorted(v)[:6]]
    print(f"  dup group n={len(v)}: {names}")

# --- embeddings-index orphans (watch: 152 on 09-08) ---
emb = read_map(SNAP + "/embeddings.bin")
eo = set(emb) - lib_ids
print(f"embeddings: vectors={len(emb)} orphans={len(eo)} (watch: was 152 on 09-09)")

# --- descriptor / te census + backlog ---
desc = json.load(open(SNAP + "/brain-descriptors.json"))
dd = desc.get("descriptors", desc)
c = Counter(repr(d.get("te")) for d in dd.values())
print("te census:", dict(c))
enriched = sum(1 for t in tracks if str(t.get("id")) in dd and dd[str(t.get("id"))].get("d"))
print(f"enrichment: {enriched}/{len(tracks)} backlog={len(tracks)-enriched} (series 315->458->542->564->533->532->?)")

# --- watchlist 11467-11499 + 454 ---
wl = list(range(11467, 11500)) + [454]
still = [t for t in wl if str(t) in dd and dd[str(t)].get("te") not in (3, True)]
print(f"watchlist still un-encoded: {len(still)}/{len([t for t in wl if str(t) in dd])}")

# queue position of watchlist among te!=3
order = []
for i, t in enumerate(tracks):
    tid = str(t.get("id"))
    d = dd.get(tid)
    if d is None: continue
    order.append((tid, d.get("te")))
q = [tid for tid, te in order if te not in (3, True)]
pos = {tid: i for i, tid in enumerate(q)}
wpos = [(t, pos.get(str(t))) for t in wl if str(t) in pos]
print("watchlist queue pos (nights@500):", [(t, p, None if p is None else p // 500) for t, p in wpos[:5]], "...")
