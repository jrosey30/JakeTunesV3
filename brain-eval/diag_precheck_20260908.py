import json, struct, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("JT_STATE_DIR", "/tmp/brain-snap-20260908")
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
dim, cur = read_raw("/tmp/brain-snap-20260908/mood-index.bin")
orphans = sorted(t for t in cur if t not in lib_ids)
print("orphan ids:", orphans)
from collections import defaultdict
g = defaultdict(list)
for t, v in cur.items(): g[v].append(t)
dups = [sorted(v) for v in g.values() if len(v) > 1]
desc = json.load(open("/tmp/brain-snap-20260908/brain-descriptors.json"))
dd = desc.get("descriptors", desc) if isinstance(desc, dict) else {}
for grp in sorted(dups):
    info = []
    for t in grp:
        tr = by_id.get(str(t)) or by_id.get(t) or {}
        d = dd.get(str(t), {})
        info.append(f"{t}:{tr.get('artist','?')}/{tr.get('title','?')[:18]} te={d.get('te')} hasdesc={bool(d.get('d'))}")
    print("DUP:", " | ".join(info))
