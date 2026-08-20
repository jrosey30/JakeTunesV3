import json, struct, sys, os
sys.path.insert(0, "/tmp/brain-eval-20260820/brain-eval")
os.environ.setdefault("JT_STATE_DIR", "/tmp/brain-snap-20260820")
import run_eval as R

def read_raw(path):
    blob = open(path, "rb").read()
    assert blob[0:4] == b"EMBD", path
    dim = struct.unpack_from("<H", blob, 6)[0]
    count = struct.unpack_from("<I", blob, 8)[0]
    off = 12
    out = {}
    for _ in range(count):
        tid = struct.unpack_from("<I", blob, off)[0]; off += 4
        vec = blob[off:off+dim*4]; off += dim*4
        out[tid] = vec
    return dim, out

tracks, by_id, titles, artists = R.load_library()
lib_ids = set(by_id.keys())
try: lib_ids = set(int(x) for x in lib_ids)
except Exception: pass

dim, cur = read_raw("/tmp/brain-snap-20260820/mood-index.bin")
_, pre  = read_raw("/Volumes/JakeShared/JakeTunesState/mood-index.bin.pre-repair-20260818")

led = json.load(open("repair_20260818_ids.json"))
pruned = set(led["pruned_orphans"]); repaired = set(led["repaired"])

orphans = [t for t in cur if t not in lib_ids]
print(f"mood vectors: {len(cur)}  dim {dim}  library: {len(lib_ids)}")
print(f"orphans now: {len(orphans)}")
print(f"  … of which were pruned on 08-18: {len(set(orphans) & pruned)} / {len(pruned)} pruned then")
new_orph = sorted(set(orphans) - pruned)
print(f"  … new orphans not in 08-18 prune: {len(new_orph)} {new_orph[:10]}")

# byte-identity vs the pre-repair (corrupted) file
orph_same = sum(1 for t in orphans if t in pre and cur[t] == pre[t])
print(f"orphan vectors byte-identical to pre-repair backup: {orph_same}/{len(orphans)}")
rep_in = [t for t in repaired if t in cur]
reverted = sum(1 for t in rep_in if t in pre and cur[t] == pre[t])
print(f"08-18 repaired tracks still present: {len(rep_in)}; REVERTED to pre-repair bytes: {reverted}")

# duplicate groups
from collections import defaultdict
g = defaultdict(list)
for t, v in cur.items(): g[v].append(t)
dups = {k: v for k, v in g.items() if len(v) > 1}
ntracks = sum(len(v) for v in dups.values())
print(f"byte-identical dup groups: {len(dups)}  tracks involved: {ntracks}")
for k, v in sorted(dups.items(), key=lambda kv: -len(kv[1]))[:8]:
    names = []
    for t in sorted(v)[:4]:
        tr = by_id.get(t) or by_id.get(str(t))
        names.append(f"{t}:{(tr or {}).get('genre','?')}/{(tr or {}).get('artist','ORPHAN')}" if tr else f"{t}:ORPHAN")
    print(f"  group n={len(v)}: {names}")
