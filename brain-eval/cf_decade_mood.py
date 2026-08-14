#!/usr/bin/env python3
"""cf_decade_mood — 2026-08-14 nightly counterfactual (READ-ONLY vs the brain).

P3 (REPORT-20260811): ret-012 "new wave 80s" scores 1.00 on mood-index but the
decade guard routes it to main (0.35). P3 = decade token in moodText() + relax
the decade guard. The 07-03 era NO-GO was identity-index-only; mood text has no
year, so this is genuinely untested. Tonight: measure it offline.

Method (the 08-07 counterfactual playbook):
 1. FIDELITY GATE — reconstruct mood text via the trainer's own functions
    (mood_texts_reconstruct.mjs), re-embed a sample, cosine vs the frozen
    mood-index.bin vectors. Reconstruction must be faithful or we stop.
 2. Embed full recon-BASE and recon-DECADE mood spaces (cached to .npy).
 3. Score all 15 ret probes on identity / frozen-mood / recon-base /
    recon-decade; emulate the router under the CURRENT guard and a RELAXED
    guard (decade queries no longer force main), in all combinations.

Pre-registered decision rule: P3 advances only if
   routerTruth(relaxed, recon-decade) > routerTruth(current, recon-base)
 AND no probe drops >0.05 between those two configs.
Comparisons are recon-vs-recon so reconstruction noise cancels.

Writes only: mood-recon-*.npy caches + stdout. Never touches the brain.
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np  # noqa: E402

import run_eval as R  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
CHUNK = 256

DECADE_QUERY_RE = re.compile(
    r"\b(19|20)\d{2}s?\b|(^|\D)['’]?[1-9]0s\b|"
    r"\b(fifties|sixties|seventies|eighties|nineties|noughties|aughts|2000s)\b",
    re.I,
)
GENRE_WORD_ARTISTS = {"house", "gospel", "punk", "disco", "funk", "soul", "jazz", "blues"}


def route(query, artist_norms, mood_count, main_count, relaxed):
    if not relaxed and DECADE_QUERY_RE.search(query):
        return "main"
    qnorm = " " + re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", query.lower())).strip() + " "
    for a in artist_norms:
        if f" {a} " in qnorm:
            return "main"
    if mood_count >= main_count * 0.5 and mood_count > 0:
        return "mood"
    return "main"


def embed_all(texts, cache):
    path = os.path.join(HERE, cache)
    if os.path.exists(path):
        v = np.load(path)
        if len(v) == len(texts):
            return v
    out = []
    for i in range(0, len(texts), CHUNK):
        out.append(R.embed_texts(texts[i:i + CHUNK]))
        print(f"  embedded {min(i + CHUNK, len(texts))}/{len(texts)} ({cache})", flush=True)
    v = np.vstack(out)
    np.save(path, v)
    return v


def main():
    rows = [json.loads(l) for l in open(os.path.join(HERE, "mood-texts.jsonl"))]
    ids_recon = np.array([r["id"] for r in rows], dtype=np.uint32)

    ids_m, vecs_m, meta_m = R.read_embeddings(R.EMB_PATH)
    mood_path = os.path.join(R.STATE_DIR, "mood-index.bin")
    ids_x, vecs_x, meta_x = R.read_embeddings(mood_path)
    tracks, by_id, titles, artists = R.load_library()
    print(f"identity {meta_m['count']} vecs sha {R.sha_of(R.EMB_PATH)} | "
          f"mood {meta_x['count']} vecs sha {R.sha_of(mood_path)} | recon rows {len(rows)}")

    # ---- 1. fidelity gate (sample, cheap) ----
    mood_by_id = {int(i): vecs_x[n] for n, i in enumerate(ids_x)}
    sample = [(r, mood_by_id[r["id"]]) for r in rows[:: max(1, len(rows) // 60)] if r["id"] in mood_by_id][:60]
    qs = R.embed_texts([r["base"] for r, _ in sample])
    cos = np.array([float(q @ v) for q, (_, v) in zip(qs, sample)])
    faithful = int((cos >= 0.999).sum())
    print(f"fidelity gate: {faithful}/{len(sample)} sample cosines >=0.999 "
          f"(median {np.median(cos):.4f}, min {cos.min():.4f})")
    if faithful < 0.90 * len(sample):
        print("[abort] reconstruction unfaithful — counterfactual would be meaningless")
        sys.exit(2)

    # ---- 2. full counterfactual spaces ----
    vb = embed_all([r["base"] for r in rows], "mood-recon-base.npy")
    vd = embed_all([r["decade"] for r in rows], "mood-recon-decade.npy")

    # ---- 3. score ----
    artist_norms = set()
    for t in tracks:
        a = re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", (t.get("artist") or "").lower())).strip()
        if len(a) >= 4 and a not in GENRE_WORD_ARTISTS:
            artist_norms.add(a)

    prompts = [p for p in json.load(open(os.path.join(HERE, "eval_set.json")))["prompts"]
               if p["bucket"] == "retrieval"]
    qvecs = R.embed_texts([p["query"] for p in prompts])

    spaces = {"identity": (ids_m, vecs_m), "frozen-mood": (ids_x, vecs_x),
              "recon-base": (ids_recon, vb), "recon-decade": (ids_recon, vd)}
    configs = [  # (label, guard-relaxed?, mood space for routing)
        ("A cur-guard + frozen-mood", False, "frozen-mood"),
        ("A' cur-guard + recon-base", False, "recon-base"),
        ("B cur-guard + recon-decade", False, "recon-decade"),
        ("C relaxed + recon-base", True, "recon-base"),
        ("D relaxed + recon-decade", True, "recon-decade"),
    ]

    per_probe = {}
    hdr = f"{'probe':<9} {'k':>3} {'ident':>6} {'frozM':>6} {'reconB':>7} {'reconD':>7}  route cur/rel"
    print("\n" + hdr)
    for p, qv in zip(prompts, qvecs):
        expected = R.expected_ids(p["expected"], tracks)
        k = p["k"]
        s = {name: R.recall_at_k(R.retrieve_topk(qv, i_, v_, k), expected, k)
             for name, (i_, v_) in spaces.items()}
        rc = route(p["query"], artist_norms, meta_x["count"], meta_m["count"], relaxed=False)
        rr = route(p["query"], artist_norms, meta_x["count"], meta_m["count"], relaxed=True)
        per_probe[p["id"]] = (p, s, rc, rr)
        print(f"{p['id']:<9} {k:>3} {s['identity']:>6.2f} {s['frozen-mood']:>6.2f} "
              f"{s['recon-base']:>7.2f} {s['recon-decade']:>7.2f}  {rc}/{rr}  \"{p['query']}\"")

    print(f"\n{'config':<30} {'router-truth mean':>17}")
    means = {}
    for label, relaxed, mspace in configs:
        vals = []
        for pid, (p, s, rc, rr) in per_probe.items():
            r_ = rr if relaxed else rc
            vals.append(s[mspace] if r_ == "mood" else s["identity"])
        means[label] = np.mean(vals)
        print(f"{label:<30} {means[label]:>17.3f}")

    # ---- decision rule ----
    base_label, full_label = "A' cur-guard + recon-base", "D relaxed + recon-decade"
    regress = []
    for pid, (p, s, rc, rr) in per_probe.items():
        a = s["recon-base"] if rc == "mood" else s["identity"]
        d = s["recon-decade"] if rr == "mood" else s["identity"]
        if d < a - 0.05:
            regress.append((pid, a, d))
    print(f"\ndecision: D-A' delta = {means[full_label] - means[base_label]:+.3f}; "
          f"probes regressing >0.05: {regress if regress else 'none'}")
    verdict = means[full_label] > means[base_label] and not regress
    print("VERDICT:", "P3 SUPPORTED (advance proposal)" if verdict else "P3 NOT SUPPORTED at this bar")


if __name__ == "__main__":
    main()
