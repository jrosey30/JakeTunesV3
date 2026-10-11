"""precheck_20261011 — READ-ONLY integrity fingerprint before measuring.

Context tonight (IMPORT NIGHT, wave 3): library 11,359 -> 11,419 (+60);
trainer clean launchd 06:00-06:01:30Z (6th consecutive post-ecba7d1),
+50 enriched => trainer-reported backlog 236 (compounding a 3rd night).

ANOMALY TO ADJUDICATE: BOTH indexes gained +277 vectors overnight while the
trainer added at most 50 (mood 11,133 -> 11,410; emb 11,289 -> 11,566) and
the library grew only +60. in-lib-missing apparently fell ~226 -> ~9, i.e.
~227 backlog tracks acquired vectors from a NON-trainer writer (desktop app
import-time embeds carried by the day sync / one-way adoption 309b375?).
Benign shape: orphans ~steady, dup groups ~0, newly-vectored ids == the
backlog block, and NO previously-enriched vector reverted.
Clobber shape: orphans ~100+/dups ~50+ byte-identical bare-genre groups and
enriched ids' bytes changed vs last night's snapshot.

Id-level diff vs /tmp/brain-snap-20261010 (kept) adjudicates which.
"""
import json, struct, sys, os, hashlib
from collections import Counter, defaultdict
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("JT_STATE_DIR", "/tmp/brain-snap-20261011")
import run_eval as R

SNAP = "/tmp/brain-snap-20261011"
PREV = "/tmp/brain-snap-20261010"

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
print(f"mood-index: vectors={len(mood)} orphans={len(mo)} dup_groups={len(dups)} dup_tracks={dup_tracks}")
print(f"  orphan ids: {sorted(mo)[:40]}")
for k, v in sorted(dups.items(), key=lambda kv: -len(kv[1]))[:10]:
    names = [(t, by_id.get(str(t), {}).get('artist', '?')) for t in sorted(v)[:6]]
    print(f"  dup group n={len(v)}: {names}")
missing = sorted(t for t in lib_int if t not in mood)
print(f"in-library tracks WITHOUT a mood vector: {len(missing)}")
print("  sample:", missing[:12])

# --- embeddings-index ---
emb = read_map(SNAP + "/embeddings.bin")
eo = set(emb) - lib_int
emiss = sorted(t for t in lib_int if t not in emb)
print(f"embeddings: vectors={len(emb)} orphans={len(eo)} (prior ~156) in-lib-missing={len(emiss)}")
print("  emb missing sample:", emiss[:12])

# --- id-level diff vs last night (the +277 adjudicator) ---
for name in ("embeddings.bin", "mood-index.bin"):
    prev = read_map(os.path.join(PREV, name))
    cur = read_map(os.path.join(SNAP, name))
    added = set(cur) - set(prev)
    removed = set(prev) - set(cur)
    changed = [t for t in (set(cur) & set(prev)) if cur[t] != prev[t]]
    added_in_lib = added & lib_int
    added_orphan = added - lib_int
    print(f"{name}: +{len(added)} added ({len(added_in_lib)} in-lib, {len(added_orphan)} orphan) "
          f"-{len(removed)} removed, {len(changed)} existing vectors CHANGED bytes")
    print(f"  added id range: {min(added) if added else '-'}..{max(added) if added else '-'}")
    if added_orphan:
        print(f"  ⚠️ orphan adds: {sorted(added_orphan)[:20]}")
    if removed:
        print(f"  removed ids: {sorted(removed)[:20]}")
    # changed existing vectors: trainer's 50 enrich + catch-up are legit; a
    # whole-map revert (hundreds, incl. old-id tracks) is the clobber shape
    ch_sorted = sorted(changed)
    print(f"  changed ids sample: {ch_sorted[:15]}{' ...' if len(changed)>15 else ''}")

# --- descriptor / te census + backlog ---
desc = json.load(open(SNAP + "/brain-descriptors.json"))
dd = desc.get("descriptors", desc)
c = Counter(repr(d.get("te")) for d in dd.values())
print("te census:", dict(c))
enriched = sum(1 for t in tracks if str(t.get("id")) in dd and dd[str(t.get("id"))].get("d"))
print(f"enrichment: {enriched}/{len(tracks)} backlog={len(tracks)-enriched} (trainer says 11183/11419)")
