#!/usr/bin/env python3
"""candB_20260906 — surgical candidate: repair ONLY the 34 aged settled
suspects (last night's watchlist 11467-11499 + id 454) + prune the 12
orphans. Tonight's fresh-49 (metadata still landing, library re-pushed
02:40) are left for the trainer — same class the 09-05 report proved
faithful-at-embed-time.

Why this differs from the full candidate (which FAILED bars at 0.829):
the fresh-49's repair vectors are built from a mid-wave library view that
may move again by morning; the aged-34's intended vectors are cos 1.0000
identical to last night's (24h settled — verified) and the trainer's
catch-up queue (library-order slice(0,500), 8,481 te=2 tracks ahead)
verifiably will not reach them for ~17 nights.

Bars (same pre-registered): worst per-probe candidate-vs-current mood
delta >= -0.0001 AND router-truth >= 0.83. READ-ONLY on the brain;
writes /tmp/mood-index.candidateB-20260906.bin only.
"""
import json, os, struct, sys
sys.path.insert(0, "/Users/jakerosenbaumnas/.jt-eval-worktrees/nightly-20260906/brain-eval")
os.environ.setdefault("JT_STATE_DIR", "/tmp/brain-snap-20260906")
import numpy as np
import run_eval as R

HERE = "/Users/jakerosenbaumnas/.jt-eval-worktrees/nightly-20260906/brain-eval"
SNAP = "/tmp/brain-snap-20260906"
CAND_FULL = "/tmp/mood-index.candidate-20260906.bin"
CAND_B = "/tmp/mood-index.candidateB-20260906.bin"
AGED = [454] + list(range(11467, 11500))

def read_raw_map(path):
    blob = open(path, "rb").read()
    assert blob[0:4] == b"EMBD"
    ver = struct.unpack_from("<H", blob, 4)[0]
    dim = struct.unpack_from("<H", blob, 6)[0]
    count = struct.unpack_from("<I", blob, 8)[0]
    off, out = 12, {}
    for _ in range(count):
        tid = struct.unpack_from("<I", blob, off)[0]; off += 4
        out[tid] = np.frombuffer(blob[off:off + dim * 4], dtype=np.float32).copy(); off += dim * 4
    return ver, dim, out

def write_map(path, ver, dim, m):
    ids = sorted(m.keys())
    buf = bytearray()
    buf += b"EMBD" + struct.pack("<H", ver) + struct.pack("<H", dim) + struct.pack("<I", len(ids))
    for tid in ids:
        buf += struct.pack("<I", tid) + m[tid].astype(np.float32).tobytes()
    open(path, "wb").write(bytes(buf))

def main():
    tracks, by_id, titles, artists = R.load_library()
    lib_ids = set(by_id.keys())
    ver, dim, cur = read_raw_map(os.path.join(SNAP, "mood-index.bin"))
    _, _, full = read_raw_map(CAND_FULL)

    cand = dict(cur)
    for i in AGED:
        assert i in full and i in cur, f"id {i} missing"
        cand[i] = full[i]
    orphans = sorted(i for i in cur if i not in lib_ids)
    for i in orphans:
        del cand[i]
    write_map(CAND_B, ver, dim, cand)
    print(f"candidate B: {len(cand)} vecs (repaired {len(AGED)}, pruned {len(orphans)} orphans) -> {CAND_B}")

    import diag_ret011_012 as D
    ids_i, vecs_i, _ = R.read_embeddings(os.path.join(SNAP, "embeddings.bin"))
    ids_m, vecs_m, _ = R.read_embeddings(os.path.join(SNAP, "mood-index.bin"))
    ids_c, vecs_c, _ = R.read_embeddings(CAND_B)
    eval_set = json.load(open(os.path.join(HERE, "eval_set.json")))
    probes = [p for p in eval_set["prompts"] if p["bucket"] == "retrieval"]
    artist_norms = {a for a in artists if a}
    qvecs = R.embed_texts([p["query"] for p in probes])

    def score(ids, vecs, qv, expected, k):
        top = np.argsort(-(vecs @ qv))[: k * 3]
        got, seen = 0, 0
        for j in top:
            tid = int(ids[j])
            if tid not in lib_ids:
                seen += 1
                if seen >= k: break
                continue
            seen += 1
            if tid in expected: got += 1
            if seen >= k: break
        return got / k

    rows, rt_cur, rt_cand = [], [], []
    for pi, p in enumerate(probes):
        k = p.get("k", 25)
        expected = R.expected_ids(p["expected"], tracks)
        k = min(k, len(expected)) if expected else k
        si = score(ids_i, vecs_i, qvecs[pi], expected, k)
        sm = score(ids_m, vecs_m, qvecs[pi], expected, k)
        sc_ = score(ids_c, vecs_c, qvecs[pi], expected, k)
        dest, why = D.route(p["query"], artist_norms, len(ids_m), len(ids_i))
        rt_cur.append(si if dest == "main" else sm)
        rt_cand.append(si if dest == "main" else sc_)
        rows.append((p["id"], k, si, sm, sc_, dest, why))
        print(f"{p['id']}  k={k:<3} identity={si:.2f} mood(cur)={sm:.2f} mood(CANDB)={sc_:.2f} "
              f"Δ{sc_-sm:+.2f}  route={dest}({why})")
    print(f"\nrouter-truth: current {np.mean(rt_cur):.3f} -> candidateB {np.mean(rt_cand):.3f}")
    worst = min(scd - smd for _, _, _, smd, scd, _, _ in rows)
    print(f"worst per-probe candidateB-vs-current mood delta: {worst:+.2f}")
    bars = worst >= -0.0001 and np.mean(rt_cand) >= 0.83
    print("BARS:", "PASS — candidateB is apply-eligible" if bars else "FAIL — do NOT apply")

if __name__ == "__main__":
    main()
