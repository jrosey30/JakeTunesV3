#!/usr/bin/env python3
"""repair_20260820 — re-run of the 08-18 mood-index repair after the
day-sync RESURRECTED the pre-repair map (see REPORT-20260820-nightly.md).

Phase A (this script, READ-ONLY on the brain):
  1. Fidelity gate: trainer-fresh vectors (descriptor `at` >= tonight)
     must match my reconstruction (mood-texts.jsonl, extracted from the
     trainer source) at cos >= 0.98 — else ABORT.
  2. Embed ALL intended texts; suspects = in-library tracks whose stored
     vector mismatches intended (cos < 0.98). Exclude any suspect whose
     tempo view is poorer than the trainer's (teb recorded but library
     bpm null/moved — the 08-18 Stereolab rule).
  3. Candidate = current map with suspects re-embedded from intended
     text + all orphan vectors pruned (identity-gated vs library.json).
  4. Prove on the frozen ruler: all 15 ret probes on identity /
     current-mood / candidate-mood + production-router emulation.
     Bars (pre-registered): no candidate mood probe below current by
     >0.0; router-truth must recover to >= 0.83 (post-repair band).
Writes: /tmp/mood-index.candidate-20260820.bin + repair_20260820_ids.json
Never touches the NAS. Apply is a separate, gated step.
"""
import json, os, struct, sys, time
sys.path.insert(0, "/tmp/brain-eval-20260820/brain-eval")
os.environ.setdefault("JT_STATE_DIR", "/tmp/brain-snap-20260820")
import numpy as np
import run_eval as R
import urllib.request

HERE = "/tmp/brain-eval-20260820/brain-eval"
SNAP = "/tmp/brain-snap-20260820"
CAND = "/tmp/mood-index.candidate-20260820.bin"
FRESH_CUTOFF = "2026-08-20T05:55"  # tonight's trainer run (UTC)

# ---------- raw (non-normalized) embed, mirrors the trainer's write ----------
def embed_raw(texts):
    k = R.key("OPENAI_API_KEY")
    payload = json.dumps({"model": R.EMBED_MODEL, "input": texts}).encode()
    req = urllib.request.Request(
        "https://api.openai.com/v1/embeddings", data=payload,
        headers={"Authorization": f"Bearer {k}", "Content-Type": "application/json"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                data = json.loads(r.read())
            ordered = sorted(data["data"], key=lambda d: d["index"])
            return np.array([d["embedding"] for d in ordered], dtype=np.float32)
        except Exception as e:
            if attempt == 3:
                raise
            time.sleep(2.0 * (attempt + 1))

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

def cos(a, b):
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    if na == 0 or nb == 0: return 0.0
    return float(np.dot(a, b) / (na * nb))

def main():
    tracks, by_id, titles, artists = R.load_library()
    lib_ids = set(by_id.keys())
    desc = json.load(open(os.path.join(SNAP, "brain-descriptors.json")))
    intended = {}
    for line in open(os.path.join(HERE, "mood-texts.jsonl")):
        r = json.loads(line)
        intended[int(r["id"])] = r["base"]

    ver, dim, cur = read_raw_map(os.path.join(SNAP, "mood-index.bin"))
    print(f"current mood map: {len(cur)} vecs dim {dim} ver {ver}")

    # ---- 1. fidelity gate on trainer-fresh vectors ----
    fresh = [i for i in cur if str(i) in desc and (desc[str(i)].get("at") or "") >= FRESH_CUTOFF
             and i in intended and i in lib_ids]
    fresh = sorted(fresh)[:50]
    if len(fresh) < 20:
        raise SystemExit(f"[abort] only {len(fresh)} trainer-fresh vectors to gate on (<20)")
    emb = embed_raw([intended[i] for i in fresh])
    sims = [cos(emb[j], cur[i]) for j, i in enumerate(fresh)]
    ok = sum(1 for s in sims if s >= 0.98)
    print(f"fidelity gate: {ok}/{len(fresh)} trainer-fresh vectors match reconstruction >=0.98 "
          f"(min {min(sims):.4f})")
    for j, i in enumerate(fresh):
        if sims[j] < 0.98:
            t = by_id[i]
            print(f"  MISS id {i} cos {sims[j]:.3f} bpm={t.get('bpm')} teb={desc[str(i)].get('teb')} "
                  f"{t.get('artist')} — {t.get('title')}")
    if ok / len(fresh) < 0.95:
        raise SystemExit("[abort] fidelity gate FAILED — reconstruction does not match the trainer")

    # ---- 2. embed all intended texts, find suspects ----
    ids_all = [i for i in sorted(lib_ids) if i in intended and i in cur]
    print(f"embedding {len(ids_all)} intended texts…")
    emb_by_id = {}
    B = 128
    for s in range(0, len(ids_all), B):
        chunk = ids_all[s:s + B]
        vecs = embed_raw([intended[i] for i in chunk])
        for j, i in enumerate(chunk):
            emb_by_id[i] = vecs[j]
        if (s // B) % 10 == 0:
            print(f"  …{s + len(chunk)}/{len(ids_all)}")

    suspects, excluded = [], []
    for i in ids_all:
        c = cos(emb_by_id[i], cur[i])
        if c < 0.98:
            teb = desc.get(str(i), {}).get("teb")
            bpm = by_id[i].get("bpm")
            if teb is not None and (bpm is None or abs(float(bpm) - float(teb)) > 3):
                excluded.append((i, c, bpm, teb))
            else:
                suspects.append((i, c))
    print(f"suspects (stored != intended, cos<0.98): {len(suspects)}  "
          f"excluded by tempo-view rule: {len(excluded)}")
    if excluded[:5]:
        print("  excluded sample:", [(i, f"{c:.3f}", bpm, teb) for i, c, bpm, teb in excluded[:5]])
    sc = sorted(c for _, c in suspects)
    if sc:
        print(f"  suspect cos: median {sc[len(sc)//2]:.3f} max {sc[-1]:.3f}")

    orphans = sorted(i for i in cur if i not in lib_ids)
    print(f"orphans to prune: {len(orphans)}")

    # ---- 3. candidate ----
    cand = dict(cur)
    for i, _ in suspects:
        cand[i] = emb_by_id[i]
    for i in orphans:
        del cand[i]
    write_map(CAND, ver, dim, cand)
    print(f"candidate written: {len(cand)} vecs -> {CAND}")

    json.dump({"repaired": [i for i, _ in suspects], "pruned_orphans": orphans,
               "excluded_tempo_view": [i for i, *_ in excluded]},
              open(os.path.join(HERE, "repair_20260820_ids.json"), "w"), indent=1)

    # ---- 4. prove on the frozen ruler ----
    import diag_ret011_012 as D
    ids_i, vecs_i, _ = R.read_embeddings(os.path.join(SNAP, "embeddings.bin"))
    ids_m, vecs_m, _ = R.read_embeddings(os.path.join(SNAP, "mood-index.bin"))
    ids_c, vecs_c, _ = R.read_embeddings(CAND)
    eval_set = json.load(open(os.path.join(HERE, "eval_set.json")))
    probes = [p for p in eval_set["prompts"] if p["bucket"] == "retrieval"]
    artist_norms = {a for a in artists if a}
    qvecs = R.embed_texts([p["prompt"] for p in probes])

    def score(ids, vecs, qv, expected, k):
        top = np.argsort(-(vecs @ qv))[: k * 3]
        got, seen = 0, 0
        for j in top:
            tid = int(ids[j])
            if tid not in lib_ids:  # orphans can occupy slots but never match
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
        dest, why = D.route(p["prompt"], artist_norms, len(ids_m), len(ids_i))
        rt_cur.append(si if dest == "main" else sm)
        rt_cand.append(si if dest == "main" else sc_)
        rows.append((p["id"], k, si, sm, sc_, dest, why))
        print(f"{p['id']}  k={k:<3} identity={si:.2f} mood(cur)={sm:.2f} mood(CAND)={sc_:.2f} "
              f"Δ{sc_-sm:+.2f}  route={dest}({why})")
    print(f"\nrouter-truth: current {np.mean(rt_cur):.3f} -> candidate {np.mean(rt_cand):.3f}")
    worst = min(scd - smd for _, _, _, smd, scd, _, _ in rows)
    print(f"worst per-probe candidate-vs-current mood delta: {worst:+.2f}")
    bars = worst >= -0.0001 and np.mean(rt_cand) >= 0.83
    print("BARS:", "PASS — candidate is apply-eligible" if bars else "FAIL — do NOT apply")

if __name__ == "__main__":
    main()
