"""precheck_20261010 — READ-ONLY integrity fingerprint before measuring.

Context tonight (IMPORT NIGHT, wave 2 of the October run):
 - library grew 11,203 -> 11,359 (+156); trainer enriched 50, backlog 226
   (wave outruns batch=50 a second night — backlog GREW 119 -> 226).
 - 06:00Z launchd run clean (5th consecutive post-ecba7d1): mood prune removed
   1 orphan (11084->11083), then nightly +50 => mood 11,133 vectors.
 - EXPECT mood orphans == 0 post-prune (guard-proof night 4 if it holds).
 - embeddings.bin NOT pruned (34ba4de is mood-only): 11,289 vectors vs 11,359
   tracks; prior steady orphans ~155 => expect ~155-157 orphans and ~226 in-lib
   missing (the unenriched backlog).
 - THE import-day clobber pre-check (replay-writer guards 5baa13e/309b375):
   dup-vector groups must stay at the benign fingerprint (18-orphan group was
   PRUNED, so expect 0 meaningful dup groups / 0 orphan dups).
"""
import json, struct, sys, os, hashlib
from collections import Counter, defaultdict
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("JT_STATE_DIR", "/tmp/brain-snap-20261010")
import run_eval as R

SNAP = "/tmp/brain-snap-20261010"

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
print(f"in-library tracks WITHOUT a mood vector: {len(missing)} (EXPECT ~226 = tonight's backlog)")
if missing[:10]:
    print("  sample:", sorted(missing)[:10])

# --- embeddings-index orphans ---
emb = read_map(SNAP + "/embeddings.bin")
eo = set(emb) - lib_int
emiss = [t for t in lib_int if t not in emb]
print(f"embeddings: vectors={len(emb)} orphans={len(eo)} (expect ~155) in-lib-missing={len(emiss)}")

# --- descriptor / te census + backlog ---
desc = json.load(open(SNAP + "/brain-descriptors.json"))
dd = desc.get("descriptors", desc)
c = Counter(repr(d.get("te")) for d in dd.values())
print("te census:", dict(c))
enriched = sum(1 for t in tracks if str(t.get("id")) in dd and dd[str(t.get("id"))].get("d"))
print(f"enrichment: {enriched}/{len(tracks)} backlog={len(tracks)-enriched} (trainer says 11133/11359)")
