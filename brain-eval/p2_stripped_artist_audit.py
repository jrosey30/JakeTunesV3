#!/usr/bin/env python3
"""p2_stripped_artist_audit — 2026-08-17 nightly experiment (READ-ONLY).

P2 (proposed 08-11, never quantified): in ragLibraryArtistSet, also add the
leading-"the"-stripped variant of each artist name so "Beatles tracks"-shaped
queries route to the identity index. Before Jake builds it, answer:

  1. BENEFIT — how many library artists does it make bare-name-routable,
     and does the identity index actually beat mood for those queries?
  2. RISK — which stripped variants are common words that could hijack a
     vibe query (the "The Weekend"→"weekend" class)? Does any eval probe
     flip route under P2?
  3. Router-truth on the 15 eval probes with P2 OFF vs ON.

Faithful to the CURRENT app router (src/main/index.ts:11804-11841): artist +
albumArtist, len>=4 guard, the full 24-word GENRE_WORD_ARTISTS (the 08-11 diag
used a stale 8-word set — both are computed below so the series stays legible).

Reads embeddings.bin + mood-index.bin + library.json from JT_STATE_DIR.
Writes nothing.
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np  # noqa: E402

import run_eval as R  # noqa: E402

DECADE_QUERY_RE = re.compile(
    r"\b(19|20)\d{2}s?\b|(^|\D)['’]?[1-9]0s\b|"
    r"\b(fifties|sixties|seventies|eighties|nineties|noughties|aughts|2000s)\b",
    re.I,
)
# App-faithful guard set (src/main/index.ts:11808).
GENRE_WORD_ARTISTS = {
    "house", "dance", "funk", "soul", "punk", "metal", "grunge", "jazz", "blues",
    "rock", "pop", "disco", "techno", "ambient", "folk", "country", "rap",
    "reggae", "ska", "indie", "emo", "hardcore", "trance", "garage", "gospel",
}
LEGACY_GUARD = {"house", "gospel", "punk", "disco", "funk", "soul", "jazz", "blues"}


def norm(s):
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", (s or "").lower())).strip()


def build_sets(tracks):
    """Returns (baseline_set, stripped_variants dict variant->full-name)."""
    base = set()
    for t in tracks:
        for a in (t.get("artist"), t.get("albumArtist")):
            n = norm(a)
            if len(n) >= 4 and n not in GENRE_WORD_ARTISTS:
                base.add(n)
    variants = {}
    for n in sorted(base):
        if n.startswith("the ") and len(n) > 4:
            v = n[4:]
            if len(v) >= 4 and v not in GENRE_WORD_ARTISTS and v not in base:
                variants[v] = n
    return base, variants


def route(query, artist_set, mood_count, main_count):
    if DECADE_QUERY_RE.search(query):
        return "main", "decade"
    q = f" {norm(query)} "
    for a in artist_set:
        if f" {a} " in q:
            return "main", f"artist:{a}"
    if mood_count >= main_count * 0.5 and mood_count > 0:
        return "mood", "vibe"
    return "main", "mood-uncovered"


def main():
    ids_m, vecs_m, meta_m = R.read_embeddings(R.EMB_PATH)
    ids_x, vecs_x, meta_x = R.read_embeddings(os.path.join(R.STATE_DIR, "mood-index.bin"))
    tracks, by_id, titles, artists = R.load_library()
    base, variants = build_sets(tracks)
    p2 = base | set(variants)

    print(f"identity {meta_m['count']} vecs sha {R.sha_of(R.EMB_PATH)}; "
          f"mood {meta_x['count']} vecs; {len(tracks)} tracks")
    print(f"artist set (app-faithful): {len(base)} names; "
          f"'the '-prefixed: {sum(1 for n in base if n.startswith('the '))}; "
          f"P2 adds {len(variants)} stripped variants")
    saved = [n[4:] for n in base
             if n.startswith("the ") and (n[4:] in GENRE_WORD_ARTISTS or len(n[4:]) < 4)]
    print(f"guard-dropped variants (len<4 or genre word): {sorted(saved)}")

    # dict-word flag: which variants are ordinary English words (hijack risk pool)
    words = set()
    try:
        words = {w.strip().lower() for w in open("/usr/share/dict/words")}
    except OSError:
        pass
    risky = sorted(v for v in variants if " " not in v and v in words)
    print(f"\nvariants that are single ordinary English words ({len(risky)}):")
    for v in risky:
        print(f"  {v!r:<20} <- {variants[v]!r}")
    multi = sorted(v for v in variants if v not in risky)
    print(f"\nremaining variants ({len(multi)}): {multi}")

    # --- eval probes: route P2 off vs on, router-truth both ways -------------
    prompts = [p for p in json.load(open(os.path.join(R.HERE, "eval_set.json")))["prompts"]
               if p["bucket"] == "retrieval"]
    qvecs = R.embed_texts([p["query"] for p in prompts])
    print(f"\n{'probe':<9} {'ident':>6} {'mood':>6}  off-route -> on-route")
    off_scores, on_scores = [], []
    for p, qv in zip(prompts, qvecs):
        expected = R.expected_ids(p["expected"], tracks)
        k = p["k"]
        rm = R.recall_at_k(R.retrieve_topk(qv, ids_m, vecs_m, k), expected, k)
        rx = R.recall_at_k(R.retrieve_topk(qv, ids_x, vecs_x, k), expected, k)
        r_off, why_off = route(p["query"], base, meta_x["count"], meta_m["count"])
        r_on, why_on = route(p["query"], p2, meta_x["count"], meta_m["count"])
        off_scores.append(rx if r_off == "mood" else rm)
        on_scores.append(rx if r_on == "mood" else rm)
        flip = "   <-- FLIP" if r_off != r_on else ""
        print(f"{p['id']:<9} {rm:>6.2f} {rx:>6.2f}  {r_off}({why_off}) -> {r_on}({why_on}){flip}")
    print(f"\nrouter-truth P2 OFF: {np.mean(off_scores):.3f}   P2 ON: {np.mean(on_scores):.3f}   "
          f"delta {np.mean(on_scores) - np.mean(off_scores):+.3f}")

    # legacy-guard router-truth (comparability with the 08-11/15/16 series)
    base_leg = set()
    for t in tracks:
        n = norm(t.get("artist"))
        if len(n) >= 4 and n not in LEGACY_GUARD:
            base_leg.add(n)
    leg = [
        (R.recall_at_k(R.retrieve_topk(qv, ids_x, vecs_x, p["k"]), R.expected_ids(p["expected"], tracks), p["k"])
         if route(p["query"], base_leg, meta_x["count"], meta_m["count"])[0] == "mood"
         else R.recall_at_k(R.retrieve_topk(qv, ids_m, vecs_m, p["k"]), R.expected_ids(p["expected"], tracks), p["k"]))
        for p, qv in zip(prompts, qvecs)
    ]
    print(f"router-truth (legacy 08-11 emulation, series ruler): {np.mean(leg):.3f}")

    # --- bare-name benefit: which "The X" artists become routable ------------
    flips = [v for v in variants
             if route(f"{v} songs", base, meta_x["count"], meta_m["count"])[0] == "mood"
             and route(f"{v} songs", p2, meta_x["count"], meta_m["count"])[0] == "main"]
    print(f"\nbare-name queries '<X> songs' that flip mood->main under P2: "
          f"{len(flips)}/{len(variants)}")

    # --- scored sample: does identity actually beat mood for those? ----------
    counts = {}
    for t in tracks:
        for a in (t.get("artist"), t.get("albumArtist")):
            n = norm(a)
            if n in {variants[v] for v in variants}:
                counts[n] = counts.get(n, 0) + 1
    sample_fulls = [f for f, c in sorted(counts.items(), key=lambda kv: -kv[1]) if c >= 5][:8]
    sample = [(v, f) for v, f in variants.items() if f in sample_fulls][:8]
    if sample:
        svecs = R.embed_texts([f"{v} songs" for v, _ in sample])
        print(f"\nscored sample (recall@20 of '<X> songs' vs tracks by 'The X'):")
        print(f"{'variant query':<28} {'n':>4} {'ident':>6} {'mood':>6}")
        gains = []
        for (v, full), qv in zip(sample, svecs):
            exp = {t["id"] for t in tracks
                   if norm(t.get("artist")) == full or norm(t.get("albumArtist")) == full}
            k = 20
            rm = R.recall_at_k(R.retrieve_topk(qv, ids_m, vecs_m, k), exp, k)
            rx = R.recall_at_k(R.retrieve_topk(qv, ids_x, vecs_x, k), exp, k)
            gains.append(rm - rx)
            print(f"{v + ' songs':<28} {len(exp):>4} {rm:>6.2f} {rx:>6.2f}")
        print(f"mean identity-minus-mood on sample: {np.mean(gains):+.3f}")


if __name__ == "__main__":
    main()
