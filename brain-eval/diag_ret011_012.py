#!/usr/bin/env python3
"""diag_ret011_012 — 2026-08-11 nightly diagnostic (READ-ONLY).

Question (queued 08-10): the stable weak NON-enrich genre probes
ret-011 "funk and soul" (recall 0.40) and ret-012 "new wave 80s" (0.35)
— does mood-index.bin already serve them better than the identity index
(the ret-014 lesson)? And which index does the PRODUCTION router
(pickRetrievalIndex, src/main/index.ts:11830) actually send each eval
query to?

Reads embeddings.bin + mood-index.bin + library.json from JT_STATE_DIR.
Writes nothing. Reuses run_eval's loaders so the ruler is identical.
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np  # noqa: E402

import run_eval as R  # noqa: E402

# Python port of the app's router (src/main/index.ts:11804/11830).
DECADE_QUERY_RE = re.compile(
    r"\b(19|20)\d{2}s?\b|(^|\D)['’]?[1-9]0s\b|"
    r"\b(fifties|sixties|seventies|eighties|nineties|noughties|aughts|2000s)\b",
    re.I,
)
GENRE_WORD_ARTISTS = {"house", "gospel", "punk", "disco", "funk", "soul", "jazz", "blues"}


def route(query, artist_norms, mood_count, main_count):
    if DECADE_QUERY_RE.search(query):
        return "main", "decade"
    qnorm = " " + re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", query.lower())).strip() + " "
    for a in artist_norms:
        if f" {a} " in qnorm:
            return "main", f"artist:{a}"
    if mood_count >= main_count * 0.5 and mood_count > 0:
        return "mood", "vibe"
    return "main", "mood-uncovered"


def main():
    ids_m, vecs_m, meta_m = R.read_embeddings(R.EMB_PATH)
    mood_path = os.path.join(R.STATE_DIR, "mood-index.bin")
    ids_x, vecs_x, meta_x = R.read_embeddings(mood_path)
    tracks, by_id, titles, artists = R.load_library()
    print(f"identity: {meta_m['count']} vecs sha {R.sha_of(R.EMB_PATH)}")
    print(f"mood:     {meta_x['count']} vecs sha {R.sha_of(mood_path)}")

    # Router artist set — same normalization as the app (len>=4, guard genre words).
    artist_norms = set()
    for t in tracks:
        a = re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", (t.get("artist") or "").lower())).strip()
        if len(a) >= 4 and a not in GENRE_WORD_ARTISTS:
            artist_norms.add(a)

    prompts = [p for p in json.load(open(os.path.join(R.HERE, "eval_set.json")))["prompts"]
               if p["bucket"] == "retrieval"]
    qvecs = R.embed_texts([p["query"] for p in prompts])

    print(f"\n{'probe':<9} {'k':>3} {'identity':>8} {'mood':>6} {'delta':>7}  route(reason)")
    rows = []
    for p, qv in zip(prompts, qvecs):
        expected = R.expected_ids(p["expected"], tracks)
        k = p["k"]
        r_main = R.recall_at_k(R.retrieve_topk(qv, ids_m, vecs_m, k), expected, k)
        r_mood = R.recall_at_k(R.retrieve_topk(qv, ids_x, vecs_x, k), expected, k)
        rt, why = route(p["query"], artist_norms, meta_x["count"], meta_m["count"])
        rows.append((p, r_main, r_mood, rt, why))
        print(f"{p['id']:<9} {k:>3} {r_main:>8.2f} {r_mood:>6.2f} {r_mood - r_main:>+7.2f}  {rt}({why})  \"{p['query']}\"")

    # Production-truth score: each probe scored on the index the router picks.
    prod = [rm if rt == "mood" else rmain for (_, rmain, rm, rt, _) in rows]
    print(f"\nmean identity-only : {np.mean([r[1] for r in rows]):.3f}  (what run_eval reports)")
    print(f"mean router-truth  : {np.mean(prod):.3f}  (what production actually retrieves)")

    # Qualitative top-30 for the two probes under diagnosis, on each index.
    for pid in ("ret-011", "ret-012"):
        p, qv = next((pp, qq) for pp, qq in zip(prompts, qvecs) if pp["id"] == pid)
        expected = R.expected_ids(p["expected"], tracks)
        for label, ids_, vecs_ in (("identity", ids_m, vecs_m), ("mood", ids_x, vecs_x)):
            top = R.retrieve_topk(qv, ids_, vecs_, 30)
            print(f"\n--- {pid} \"{p['query']}\" top-30 on {label} ---")
            for tid in top:
                t = by_id.get(tid)
                if not t:
                    print(f"  [{tid}] <orphan vector — not in library>")
                    continue
                mark = "*" if tid in expected else " "
                print(f" {mark} {t.get('genre') or '?':<28.28} {t.get('artist') or '?':<24.24} {t.get('title') or '?'}")


if __name__ == "__main__":
    main()
