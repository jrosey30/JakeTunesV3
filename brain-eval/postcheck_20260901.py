import json, struct, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("JT_STATE_DIR", "/tmp/brain-snap-20260901")
import run_eval as R

def read_raw(path):
    blob = open(path, "rb").read()
    assert blob[0:4] == b"EMBD", path
    dim = struct.unpack_from("<H", blob, 6)[0]
    count = struct.unpack_from("<I", blob, 8)[0]
    off, out = 12, {}
    for _ in range(count):
        tid = struct.unpack_from("<I", blob, off)[0]; off += 4
        out[tid] = blob[off:off+dim*4]; off += dim*4
    return dim, out

tracks, by_id, titles, artists = R.load_library()
lib_ids = set(int(x) for x in by_id.keys())
dim, cur = read_raw("/Volumes/JakeShared/JakeTunesState/mood-index.bin")
orphans = [t for t in cur if t not in lib_ids]
from collections import defaultdict
g = defaultdict(list)
for t, v in cur.items(): g[v].append(t)
dups = {k: v for k, v in g.items() if len(v) > 1}
print(f"mood vectors: {len(cur)} dim {dim}  library: {len(lib_ids)}")
print(f"PRE-CHECK  orphans={len(orphans)}  dup_groups={len(dups)}  dup_tracks={sum(len(v) for v in dups.values())}")
print("verdict:", "CLOBBERED" if (len(orphans) > 10 or len(dups) > 5) else "healthy")
