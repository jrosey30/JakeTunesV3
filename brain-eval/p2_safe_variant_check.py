#!/usr/bin/env python3
"""p2_safe_variant_check — 2026-08-17 (READ-ONLY, route-level, no API calls).

Companion to p2_stripped_artist_audit.py. The naive P2 ("add every
'the'-stripped artist variant") hijacks vibe queries — 57 of the 142 variants
are ordinary English words ('beat', 'band', 'sleeping', 'cars', 'doors'…).
This quantifies two safer rules against three route-level metrics:

  naive  add all 142 variants                       (the 08-11 proposal)
  S1     add only the 85 non-dictionary variants    (drops The Cure/Doors/Smiths…)
  S2     add all 142, but dictionary-word variants match ONLY when the query
         is an artist-intent template ("<x>", "<x> songs", "play <x>", …)

Result (2026-08-17, 9,583-track library):
  naive: 10/12 demo vibe queries hijacked, 142/142 bare-name coverage
  S1:     0/12 hijacked,                    85/142 coverage
  S2:     0/12 hijacked,                   142/142 coverage   <-- recommended
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import p2_stripped_artist_audit as A  # noqa: E402
import run_eval as R  # noqa: E402

TEMPLATES = ["{x}", "{x} songs", "{x} tracks", "{x} music", "play {x}",
             "play some {x}", "songs by {x}", "tracks by {x}", "music by {x}",
             "best {x} songs"]

DEMO_VIBE = ["music for sleeping", "songs with a heavy beat", "big band music",
             "songs about cars", "faint dreamy vocals", "something to cure a bad mood",
             "halloween party zombies and monsters", "upbeat dance beat",
             "animals and nature sounds", "behind closed doors vibes",
             "driving music", "late night chill"]

FLAGSHIP = ["clash songs", "cure songs", "doors songs", "smiths songs",
            "police", "killers songs", "beatles tracks"]


def main():
    tracks, *_ = R.load_library()
    base, variants = A.build_sets(tracks)
    words = {w.strip().lower() for w in open("/usr/share/dict/words")}

    def is_dictish(v):
        return " " not in v and (v in words or (v.endswith("s") and v[:-1] in words))

    risky = {v for v in variants if is_dictish(v)}
    safe = set(variants) - risky
    print(f"dictionary-word risk class: {len(risky)}; safe: {len(safe)}")
    print(sorted(risky))

    def route(q, rule):
        if A.DECADE_QUERY_RE.search(q):
            return "main"
        qn = " " + A.norm(q) + " "
        for a in base:
            if f" {a} " in qn:
                return "main"
        vs = safe if rule == "S1" else set(variants)
        for v in vs:
            if f" {v} " in qn:
                if rule == "S2" and v in risky and \
                        qn.strip() not in [t.format(x=v) for t in TEMPLATES]:
                    continue
                return "main"
        return "mood"

    for rule in ("naive", "S1", "S2"):
        hij = [q for q in DEMO_VIBE if route(q, rule) == "main"]
        cov = sum(1 for v in variants if route(f"{v} songs", rule) == "main")
        print(f"{rule:<6} demo hijacks {len(hij)}/12  bare-name coverage {cov}/{len(variants)}"
              + (f"  hijacked: {hij}" if rule != "naive" and hij else ""))
    print("\nS2 flagship routes (all should be main):")
    for q in FLAGSHIP:
        print(f"  {q!r:<18} -> {route(q, 'S2')}")


if __name__ == "__main__":
    main()
