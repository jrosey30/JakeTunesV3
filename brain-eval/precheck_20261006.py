"""precheck_20261006 — READ-ONLY integrity fingerprint before measuring.

Context tonight (first nightly since 09-27 — trainer was FATAL 09-27..10-05,
NAS unmounted at 02:00 each night; mount-wait fix commit ecba7d1 landed and
tonight the trainer ran clean TWICE: 02:27Z catch-up + 06:00Z launchd):
 - commit 34ba4de shipped the trainer-side MOOD-INDEX orphan prune
   (brain-prune-ledger.jsonl: 19 ids removed 02:27Z incl. the benign-18 list
   + 12071, then 1 more 06:00Z). EXPECT mood orphans == 0 tonight.
 - embeddings.bin is NOT pruned by that commit: expect ~154 orphans
   (11187 vectors - 11033 tracks).
 - watchlist/stale-cohort checks CLOSED 09-23/24 — dropped.
"""
import json, struct, sys, os, hashlib
from collections import Counter, defaultdict
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("JT_STATE_DIR", "/tmp/brain-snap-20261006")
import run_eval as R

SNAP = "/tmp/brain-snap-20261006"

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
lib_int = set(int(x) for x in by_id.keys())
print(f"library tracks = {len(lib_int)}")

# --- mood-index fingerprint (THE clobber pre-check) ---
mood = read_map(SNAP + "/mood-index.bin")
mo = set(mood) - lib_int
groups = defaultdict(list)
for tid, vec in mood.items():
    groups[hashlib.sha1(vec).digest()].append(tid)
dups = {k: v for k, v in groups.items() if len(v) > 1}
dup_tracks = sum(len(v) for v in dups.values())
print(f"mood-index: vectors={len(mood)} orphans={len(mo)} (EXPECT 0 post-prune) dup_groups={len(dups)} dup_tracks={dup_tracks}")
print(f"  orphan ids: {sorted(mo)[:40]}")
for k, v in sorted(dups.items(), key=lambda kv: -len(kv[1]))[:10]:
    names = [(t, by_id.get(str(t), {}).get('artist', '?')) for t in sorted(v)[:6]]
    print(f"  dup group n={len(v)}: {names}")

# --- missing mood vectors for in-library tracks (prune must never eat live tracks) ---
missing = [t for t in lib_int if t not in mood]
print(f"in-library tracks WITHOUT a mood vector: {len(missing)} (should be ~0 at 100% enrichment)")
if missing[:10]:
    print("  sample:", sorted(missing)[:10])

# --- embeddings-index orphans ---
emb = read_map(SNAP + "/embeddings.bin")
eo = set(emb) - lib_int
emiss = [t for t in lib_int if t not in emb]
print(f"embeddings: vectors={len(emb)} orphans={len(eo)} (expect ~154; 152 steady pre-gap + 09-27 additions) in-lib-missing={len(emiss)}")

# --- descriptor / te census + backlog ---
desc = json.load(open(SNAP + "/brain-descriptors.json"))
dd = desc.get("descriptors", desc)
c = Counter(repr(d.get("te")) for d in dd.values())
print("te census:", dict(c))
enriched = sum(1 for t in tracks if str(t.get("id")) in dd and dd[str(t.get("id"))].get("d"))
print(f"enrichment: {enriched}/{len(tracks)} backlog={len(tracks)-enriched} (trainer says 11033/11033)")
