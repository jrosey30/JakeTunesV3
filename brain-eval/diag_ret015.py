#!/usr/bin/env python3
"""Read-only diagnostic for ret-015 (per PROPOSAL-ret015 'Open risk to check first').

Dumps the top-30 tracks the brain returns for the ret-015 query, with genre/bpm,
plus a genre histogram, to distinguish:
  - descriptor gap (top-30 dominated by unrelated/mellow genres)
  - proxy-too-narrow (top-30 dominated by OTHER aggressive genres like metal/hard rock)
Writes nothing. Reads embeddings.bin + library.json via run_eval helpers.
"""
import json, os, sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import run_eval as re_

QUERY = "aggressive heavy intense music"
K = 30

def main():
    ids, vecs, meta = re_.read_embeddings(re_.EMB_PATH)
    tracks, by_id, _, _ = re_.load_library()
    qvec = re_.embed_texts([QUERY])[0]
    topk = re_.retrieve_topk(qvec, ids, vecs, K)
    hist = Counter()
    print(f"brain: {meta['count']} vectors | query: {QUERY!r} | k={K}\n")
    for rank, tid in enumerate(topk, 1):
        t = by_id.get(tid) or {}
        g = (t.get("genre") or "?").strip() or "?"
        hist[g.lower()] += 1
        print(f"{rank:>2}. {t.get('artist','?')} — {t.get('title','?')}  [{g}] bpm={t.get('bpm','?')}")
    print("\ngenre histogram (top-30):")
    for g, n in hist.most_common():
        print(f"  {n:>2}  {g}")
    # how many are punk/grunge (the scored proxy) vs broader-aggressive
    AGG = ("punk","grunge","metal","hardcore","hard rock","thrash","industrial","emo","screamo")
    proxy = sum(n for g, n in hist.items() if "punk" in g or "grunge" in g)
    agg = sum(n for g, n in hist.items() if any(a in g for a in AGG))
    print(f"\nproxy (punk/grunge) in top-30: {proxy}/{K}")
    print(f"broader aggressive genres in top-30: {agg}/{K}")

if __name__ == "__main__":
    main()
