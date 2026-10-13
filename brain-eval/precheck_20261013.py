"""precheck_20261013 — READ-ONLY integrity fingerprint before measuring.

Context tonight: library 11,561 -> 11,577 (+16). The trainer ran TWICE since
the 10-12 measurement: (1) 10-12 23:29-23:37 ET, FIRST PR-#105 run ("every
new add + up to 50 older, 40-min budget") enriched 328 -> 11,561/11,561 —
the whole backlog including the 227-track BARE-MOOD cohort drained in one
night; (2) 10-13 02:00 launchd, +16 -> 11,577/11,577, backlog 0.

⚠️ PREV (/tmp/brain-snap-20261012) is the PRE-APPLY pristine snapshot: the
10-12 nightly APPLIED a main-index taxonomy refresh AFTER it (emb
163b3f52 -> 99d0de2f, 11,716 vec). So vs PREV the MAIN index is expected to
show ~ALL existing vectors changed (the applied refresh + trainer batches)
— that is the known writer, NOT a clobber. The clobber adjudicators tonight
are: mood orphans/dups, removed ids, and mood changed-count ~= 328+16 batch.

Expected benign shape: emb 11,716 -> 11,733 vectors (+16 new + 1?), mood
11,460 -> 11,577 (+117 = 328 enriched incl. 101 vectorless + 16 new),
mood changed ~= 328 (bare cohort re-embedded WITH descriptors) + 16,
orphans ~steady (~156 emb, 0 mood), dups ~0/benign, in-lib-missing ~0
(backlog drained). Hundreds of REMOVED ids or mood changed-bytes far beyond
the enrich batches = a NEW writer, stop and adjudicate before measuring.
"""
import json, struct, sys, os, hashlib
from collections import Counter, defaultdict
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("JT_STATE_DIR", "/tmp/brain-snap-20261013")
import run_eval as R

SNAP = "/tmp/brain-snap-20261013"
PREV = "/tmp/brain-snap-20261012"

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

# --- id-level diff vs the 10-12 PRE-APPLY snap (see header for adjudication) ---
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
    ch_sorted = sorted(changed)
    print(f"  changed ids sample: {ch_sorted[:15]}{' ...' if len(changed)>15 else ''}")

# --- descriptor / te census + backlog + BARE-MOOD cohort (E1/E3 gate input) ---
desc = json.load(open(SNAP + "/brain-descriptors.json"))
dd = desc.get("descriptors", desc)
c = Counter(repr(d.get("te")) for d in dd.values())
print("te census:", dict(c))
enriched = sum(1 for t in tracks if str(t.get("id")) in dd and dd[str(t.get("id"))].get("d"))
print(f"enrichment: {enriched}/{len(tracks)} backlog={len(tracks)-enriched} (trainer says 11577/11577)")
# bare mood vector = has a mood vector but NO descriptor 'd' (tempo+genre-only)
bare = [t for t in sorted(mood) if t in lib_int and not (dd.get(str(t), {}) or {}).get("d")]
print(f"BARE mood vectors (in-lib, vector but no descriptor): {len(bare)}")
print("  sample:", bare[:12])
