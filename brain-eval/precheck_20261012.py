"""precheck_20261012 — READ-ONLY integrity fingerprint before measuring.

Context tonight (IMPORT NIGHT, wave 4): library 11,419 -> 11,560 (+141,
landed 10-11 23:15 ET pre-trainer); trainer clean launchd 06:00-06:01:30Z
(7th consecutive post-ecba7d1), +50 enriched => trainer-reported backlog 327
(compounding 4th night: 226 -> 236 -> 327). Also tonight: a large laptop
metadata-overrides refresh (applied 11,345 -> 11,558; stale 58 -> 2).

Expected benign shape: ~+50 net adds per index (emb 11,566 -> 11,616,
mood 11,410 -> 11,460), changed-bytes ~= the 50-batch (+ any catch-up),
orphans ~steady (~156 emb), dups ~0/benign, in-lib-missing ~= vector backlog.
Watch: the overrides refresh does NOT re-embed by itself — hundreds of
changed-bytes on previously-enriched ids would be a NEW writer, stop and
adjudicate before measuring.
"""
import json, struct, sys, os, hashlib
from collections import Counter, defaultdict
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("JT_STATE_DIR", "/tmp/brain-snap-20261012")
import run_eval as R

SNAP = "/tmp/brain-snap-20261012"
PREV = "/tmp/brain-snap-20261011"

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
print(f"enrichment: {enriched}/{len(tracks)} backlog={len(tracks)-enriched} (trainer says 11233/11560)")
