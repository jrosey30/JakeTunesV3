#!/usr/bin/env python3
"""repair_20260904 — completes the 7th-clobber repair that the aborted 08-27 session never ran of the 08-18 mood-index repair after the
day-sync RESURRECTED the pre-repair map on an import day (+8 tracks; see
REPORT-20260820-nightly.md for the root cause, PROPOSAL-mood-import-clobber.md
for the gated fix). Pre-check tonight: TBD (pre-check below) (healthy 0/1).

Phase A (this script, READ-ONLY on the brain):
  1. Fidelity gate: trainer-fresh vectors (descriptor `at` >= tonight —
     trainer ran clean 06:00Z) must match my reconstruction
     (mood-texts.jsonl, extracted from the trainer source) at cos >= 0.98
     — else ABORT. (Normal gate; 08-24's aged-cohort variant was only for
     the trainer-FATAL night.)
  2. Embed ALL intended texts; suspects = in-library tracks whose stored
     vector mismatches intended (cos < 0.98). Tempo-view rule as REFINED
     2026-08-24: exclude only when teb is a REAL recorded tempo and the
     library bpm has since nulled/moved; teb==0 means the reconstruction
     has the strictly better view — repair it.
  3. Candidate = current map with suspects re-embedded from intended
     text + all orphan vectors pruned (identity-gated vs library.json).
  4. Prove on the frozen ruler: all 15 ret probes on identity /
     current-mood / candidate-mood + production-router emulation.
     Bars (pre-registered): no candidate mood probe below current by
     >0.0; router-truth must recover to >= 0.83 (post-repair band).
Writes: /tmp/mood-index.candidate-20260904.bin + repair_20260904_ids.json
Never touches the NAS. Apply is a separate, gated step.
"""
import json, os, struct, sys, time
sys.path.insert(0, "/Users/jakerosenbaumnas/.brain-eval-wt-20260904/brain-eval")
os.environ.setdefault("JT_STATE_DIR", "/tmp/brain-snap-20260904")
import numpy as np
import run_eval as R
import urllib.request

HERE = "/Users/jakerosenbaumnas/.brain-eval-wt-20260904/brain-eval"
SNAP = "/tmp/brain-snap-20260904"
CAND = "/tmp/mood-index.candidate-20260904.bin"
FRESH_CUTOFF = "2026-09-04T05:55"  # tonight's trainer (launchd, clean 06:00:06Z-06:01:45Z)

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

    # ---- 1. fidelity gate: AGED-ONLY, key-trusted (2026-09-04 variant) ----
    # Tonight the replay fired POST-trainer (mood mtime 02:25 > trainer done
    # 02:09) and reverted ALL of the trainer's night writes — proven: fresh
    # stored vectors == the app's tempo+genre import embeds at cos 1.0000.
    # So there are NO trainer-fresh vectors to gate on (they'll correctly
    # show up as suspects instead). Gate on aged never-repaired vectors,
    # restricted to where the v3 encoding change is a NO-OP so v2-era
    # vectors must still match a v3 reconstruction:
    #   - te == 2 (embedded under v2; te=3 catch-up writes were reverted
    #     tonight, so te=3 stored bytes are pre-catch-up = expected suspects)
    #   - intended text contains a "key: " line (key was TRUSTED -> v2 and
    #     v3 emit identical key/camelot/good-for lines)
    # Same >=0.98 / 95% bar.
    import glob
    prior_ids = set()
    for f in glob.glob(os.path.join(HERE, "repair_*_ids.json")):
        d = json.load(open(f))
        for k2 in ("repaired", "pruned_orphans", "excluded_tempo_view"):
            prior_ids.update(d.get(k2, []))
    fresh_check = sorted(i for i in cur if str(i) in desc and (desc[str(i)].get("at") or "") >= FRESH_CUTOFF
                         and i in intended and i in lib_ids)[:50]
    print(f"trainer-fresh vectors tonight: {len(fresh_check)} (NOT gated on — trainer writes reverted by the 02:25 replay)")
    aged = sorted(i for i in cur
                  if str(i) in desc and desc[str(i)].get("d")
                  and desc[str(i)].get("te") == 2
                  and (desc[str(i)].get("at") or "9999") < "2026-08-16"
                  and i in intended and i in lib_ids and i not in prior_ids
                  and "key: " in intended[i])
    if len(aged) < 20:
        raise SystemExit(f"[abort] only {len(aged)} aged key-trusted vectors to gate on (<20)")
    step = max(1, len(aged) // 50)
    fresh = aged[::step][:50]
    print(f"  gating on {len(fresh)} aged never-repaired key-trusted te=2 vectors ({len(aged)} eligible)")
    emb = embed_raw([intended[i] for i in fresh])
    sims = [cos(emb[j], cur[i]) for j, i in enumerate(fresh)]
    ok = sum(1 for s in sims if s >= 0.98)
    print(f"fidelity gate (hybrid): {ok}/{len(fresh)} trainer-authored vectors match reconstruction >=0.98 "
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

    # Reconstruction's own tempo view = the override-APPLIED bpm, parsed back
    # out of the intended text (2026-09-04 refinement: the raw library bpm is
    # None for fresh imports whose bpm lives only in metadata-overrides — the
    # old raw-bpm check wrongly "protected" 43 clobbered tracks tonight).
    import re as _re
    def recon_bpm(i):
        m = _re.search(r"tempo: (\d+) BPM", intended[i])
        return float(m.group(1)) if m else None

    suspects, excluded, skipped_unenriched = [], [], 0
    for i in ids_all:
        c = cos(emb_by_id[i], cur[i])
        if c < 0.98:
            # 2026-09-04 refinement: no descriptor = never trainer-enriched =
            # nothing to restore. The stored app import embed was written from
            # the app's LIVE bpm view, which is at least as informed as ours —
            # "repairing" it to a bare genre-only text tonight DEGRADED fresh
            # imports into genre-query hijackers (Staind "genre: Rock" owned
            # the punk top-25). Leave un-enriched tracks to the trainer.
            if not desc.get(str(i), {}).get("d"):
                skipped_unenriched += 1
                continue
            teb = desc.get(str(i), {}).get("teb")
            bpm = recon_bpm(i)
            # Tempo-view rule REFINED (2026-08-24): exclude only when the
            # reconstruction's tempo view is genuinely POORER than what the
            # trainer embedded (teb recorded as a REAL tempo, and the bpm
            # since nulled/moved — the 08-18 Stereolab case). teb==0 means the
            # trainer embedded WITHOUT tempo; the reconstruction now has the
            # real bpm, i.e. a strictly BETTER view — repair it.
            if teb is not None and float(teb) != 0 and (bpm is None or abs(float(bpm) - float(teb)) > 3):
                excluded.append((i, c, bpm, teb))
            else:
                suspects.append((i, c))
    print(f"skipped (un-enriched, no descriptor — stored app embed kept): {skipped_unenriched}")
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
              open(os.path.join(HERE, "repair_20260904_ids.json"), "w"), indent=1)

    # ---- 4. prove on the frozen ruler ----
    import diag_ret011_012 as D
    ids_i, vecs_i, _ = R.read_embeddings(os.path.join(SNAP, "embeddings.bin"))
    ids_m, vecs_m, _ = R.read_embeddings(os.path.join(SNAP, "mood-index.bin"))
    ids_c, vecs_c, _ = R.read_embeddings(CAND)
    eval_set = json.load(open(os.path.join(HERE, "eval_set.json")))
    probes = [p for p in eval_set["prompts"] if p["bucket"] == "retrieval"]
    artist_norms = {a for a in artists if a}
    qvecs = R.embed_texts([p["query"] for p in probes])

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
        dest, why = D.route(p["query"], artist_norms, len(ids_m), len(ids_i))
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
