#!/usr/bin/env python3
"""
gen_probes.py — build the frozen, seeded v3 ruler (eval_set_v3.json) from a
library census and the app's genre vocab.

NEVER FABRICATES: every predicate is a library fact resolved through
vocab_snapshot.json (exact leaf / family / umbrella names), every artist is a
real library artist, every trap is a cell the census proves EMPTY. The only
hand-written text is query PHRASING (how a person would ask), and the phrase
tables below fail loudly if the vocab grows a family they don't cover.

Groups (≈155 probes):
  artist          30  artists with ≥20 tracks                       (k=20)
  umbrella_family 18  the 7 iceberg umbrellas + the 11 vocab families (k=25)
  leaf            50  leaf genres with ≥25 tracks                   (k=25)
                      (catch-all leaves — Rock, Classic Rock, Pop, Punk, R&B,
                       Alternative — are excluded: they mean "fits no narrower
                       shelf", so an exact-leaf predicate would punish the
                       brain for returning the narrower shelves)
  family_decade   30  family × decade cells with ≥50 tracks          (k=25)
  tempo_family    16  (bpm ≤85 | bpm ≥130) × family, measured bpm only,
                      cells with ≥30 tracks; 8 slow + 8 fast when possible (k=25)
  vibe            10  ret-013..015 (eval_set.json) + prod-001..007 (main's
                      eval_set_v2.json), predicates recast MECHANICALLY: each
                      genre_any substring term -> the vocab leaves containing
                      it, compressed to whole families where complete; checked
                      equal to the original predicate on the generating library
  grounding       20  14 normal (drawn from the probes above) + 6 traps:
                      anachronistic EMPTY family × decade cells (≥20 years
                      before the family's first library decade, 1950 on,
                      families with ≥100 tracks) — never zero-track leaves,
                      which the library can hold under a sibling tag

The file records the generating library sha and the seed. Re-generating
resets v3 comparability — do it only when the ruler goes stale.

    python3 gen_probes.py                       # library from $JT_STATE_DIR (or the app dir), read-only
    python3 gen_probes.py --library /tmp/snap/library.json --seed 1012
"""
import argparse, collections, json, os, random, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scorecard as S  # noqa: E402

DEFAULT_SEED = 1012
K_ARTIST, K_GENRE = 20, 25
MIN_ARTIST, MIN_LEAF, MIN_CELL, MIN_TEMPO = 20, 25, 50, 30
N = {"artist": 30, "leaf": 50, "family_decade": 30, "tempo_family": 16}
SLOW_MAX, FAST_MIN = 85, 130
N_TRAPS, TRAP_MIN_FAMILY, TRAP_FROM_DECADE, TRAP_GAP = 6, 100, 1950, 20
# Compilation placeholders, not artists — nobody asks for "songs by Various Artists".
NON_ARTISTS = {"various artists", "various", "va", "unknown artist", "unknown"}

# ---- query phrasing only (predicates come from the vocab) -------------------
UMBRELLA_PHRASE = {
    "Rock": "rock music", "Pop": "pop music", "Hip-Hop": "hip-hop",
    "Electronic": "electronic music", "R&B & Soul": "r&b and soul",
    "Country & Folk": "country and folk music", "Jazz & Global": "jazz and world music",
}
FAMILY_PHRASE = {
    "Rock": "guitar rock songs", "Punk": "punk", "Metal": "metal",
    "New Wave & Synth": "new wave and synth music", "Pop": "pop songs", "Hip-Hop": "rap songs",
    "R&B, Soul & Funk": "r&b, soul and funk", "Electronic & Dance": "dance and electronic music",
    "Country, Folk & Blues": "country, folk and blues",
    "Jazz, Brazil, Latin & Global": "jazz, brazilian and latin music",
    "Other": "soundtracks, comedy and kids' songs",
}
FAMILY_SHORT = {
    "Rock": "rock", "Punk": "punk", "Metal": "metal", "New Wave & Synth": "new wave and synth-pop",
    "Pop": "pop", "Hip-Hop": "hip-hop", "R&B, Soul & Funk": "r&b and soul",
    "Electronic & Dance": "dance music", "Country, Folk & Blues": "country and folk",
    "Jazz, Brazil, Latin & Global": "jazz and latin music", "Other": "soundtrack music",
}
ARTIST_T = ["{x} songs", "tracks by {x}", "songs by {x}", "play {x}", "put on {x}"]
LEAF_T = ["{x}", "{x} songs", "play some {x}", "{x} tracks", "give me some {x}"]
DECADE_T = ["{d} {f}", "{f} from the {d}", "{d} {f} songs"]
TEMPO_T = {"slow": ["slow {f}", "slow, mellow {f} songs", "laid-back slow {f}"],
           "fast": ["fast {f}", "high-energy fast {f}", "fast-paced {f} songs"]}
G_ARTIST_T = ["Name three {x} songs from my library.", "Which {x} tracks do I have? Name a few.",
              "Give me a couple of {x} songs I own."]
G_LEAF_T = ["Name a few {x} tracks I own.", "What {x} songs are in my library? Name some specific ones."]
G_DECADE_T = ["Name three {d} {f} songs from my collection."]
G_GROUP_T = ["What {x} do I have? Name a few specific tracks."]
G_TRAP_DECADE_T = "Name some {d} {f} songs I own."


def decade_words(d, rng):
    if d >= 2000:
        return f"{d}s"
    return rng.choice([f"{str(d)[2:]}s", f"{d}s"])


def recast(expected, vocab):
    """v1/v2 predicate -> v3 predicate, mechanically (see module doc)."""
    out, dropped = {}, []
    for key in ("year_range", "bpm_min", "bpm_max", "artist"):
        if key in expected:
            out[key] = expected[key]
    if "genre_any" in expected:
        leaves = set()
        for term in expected["genre_any"]:
            hit = {l for l in vocab.leaf_family if term.lower() in l.lower()}
            if not hit:
                dropped.append(term)
            leaves |= hit
        fams = sorted(f for f, ls in vocab.families.items() if set(ls) <= leaves)
        covered = {l for f in fams for l in vocab.families[f]}
        rest = sorted(leaves - covered)
        if fams:
            out["genre_family"] = fams
        if rest:
            out["genre_leaf"] = rest
        if not leaves:
            raise SystemExit(f"[fatal] recast: {expected} resolves to no vocab leaf")
    unsupported = set(expected) - {"year_range", "bpm_min", "bpm_max", "artist", "genre_any"}
    if unsupported:
        raise SystemExit(f"[fatal] recast: can't express {sorted(unsupported)} in v3")
    return out, dropped


def v1_expected(pred, tracks):
    """The v1 resolver (run_eval.expected_ids), copied so this script needs no
    API key at import. Used only to prove the vibe recast is faithful."""
    out = set()
    for t in tracks:
        ok = True
        if "artist" in pred:
            a = (t.get("artist") or "").lower(); p = pred["artist"].lower()
            ok = ok and (p in a or a in p) and bool(a)
        if "genre_any" in pred:
            g = (t.get("genre") or "").lower()
            ok = ok and any(term.lower() in g for term in pred["genre_any"]) and bool(g)
        if "year_range" in pred:
            try:
                y = int(t.get("year")); ok = ok and pred["year_range"][0] <= y <= pred["year_range"][1]
            except Exception:
                ok = False
        if "bpm_min" in pred:
            b = t.get("bpm") or 0; ok = ok and b and b >= pred["bpm_min"]
        if "bpm_max" in pred:
            b = t.get("bpm") or 0; ok = ok and b and b <= pred["bpm_max"]
        if ok:
            out.add(int(t["id"]))
    return out


def main():
    ap = argparse.ArgumentParser()
    state = os.environ.get("JT_STATE_DIR") or S.LIVE_STATE_DIRS[0]
    ap.add_argument("--library", default=os.path.join(state, "library.json"))
    ap.add_argument("--seed", type=int, default=DEFAULT_SEED)
    ap.add_argument("--v2-ref", default="origin/main", help="where eval_set_v2.json lives")
    ap.add_argument("--out", default=S.EVAL_V3_PATH)
    a = ap.parse_args()

    vocab = S.load_vocab()
    for fam in vocab.families:
        if fam not in FAMILY_PHRASE or fam not in FAMILY_SHORT:
            raise SystemExit(f"[fatal] vocab family {fam!r} has no query phrase — add one to gen_probes.py")
    for u in vocab.umbrellas:
        if u not in UMBRELLA_PHRASE:
            raise SystemExit(f"[fatal] vocab umbrella {u!r} has no query phrase — add one to gen_probes.py")

    tracks = S.load_tracks(a.library)
    rc = S.assert_ruler_fresh(tracks, vocab)
    lib_sha = S.file_sha(a.library)
    rng = random.Random(a.seed)
    exp = lambda pred: S.expected_ids(pred, tracks, vocab)  # noqa: E731
    probes, grounding = [], []

    def add(pid, group, query, k, pred, **meta):
        n = len(exp(pred))
        if n == 0:
            raise SystemExit(f"[fatal] {pid}: predicate {pred} matches 0 tracks")
        probes.append({"id": pid, "group": group, "query": query, "k": k, "expected": pred,
                       "n_expected_at_gen": n, **({"meta": meta} if meta else {})})

    # ---- census
    by_artist = collections.Counter(t.get("artist") for t in tracks if t.get("artist"))
    leaf_n = collections.Counter(str(t.get("genre") or "").strip() for t in tracks)
    fam_of = lambda t: vocab.leaf_family.get(str(t.get("genre") or "").strip())  # noqa: E731
    cell_n, tempo_n = collections.Counter(), collections.Counter()
    for t in tracks:
        f, y, b = fam_of(t), S.year_of(t), S.real_bpm(t)
        if f and y:
            cell_n[(f, y // 10 * 10)] += 1
        if f and b is not None:
            if b <= SLOW_MAX:
                tempo_n[(f, "slow")] += 1
            if b >= FAST_MIN:
                tempo_n[(f, "fast")] += 1

    # ---- artist (count by the v3 predicate itself, so eligibility == what's scored)
    art_elig = sorted(x for x in by_artist
                      if S.fold(x) not in NON_ARTISTS and len(exp({"artist": x})) >= MIN_ARTIST)
    for i, x in enumerate(sorted(rng.sample(art_elig, min(N["artist"], len(art_elig)))), 1):
        add(f"v3-art-{i:02d}", "artist", rng.choice(ARTIST_T).format(x=x), K_ARTIST, {"artist": x})

    # ---- umbrella + family
    i = 0
    for u in sorted(vocab.umbrellas):
        i += 1
        add(f"v3-umb-{i:02d}", "umbrella_family", UMBRELLA_PHRASE[u], K_GENRE, {"genre_umbrella": u})
    for f in sorted(vocab.families):
        i += 1
        add(f"v3-fam-{i:02d}", "umbrella_family", FAMILY_PHRASE[f], K_GENRE, {"genre_family": f})

    # ---- leaf
    skip = vocab.catch_all | set(vocab.families) | set(vocab.umbrellas)
    leaf_elig = sorted(l for l in vocab.leaf_family if leaf_n[l] >= MIN_LEAF and l not in skip)
    for i, l in enumerate(sorted(rng.sample(leaf_elig, min(N["leaf"], len(leaf_elig)))), 1):
        add(f"v3-leaf-{i:02d}", "leaf", rng.choice(LEAF_T).format(x=l), K_GENRE, {"genre_leaf": l})

    # ---- family × decade
    cell_elig = sorted(c for c, n in cell_n.items() if n >= MIN_CELL)
    for i, (f, d) in enumerate(sorted(rng.sample(cell_elig, min(N["family_decade"], len(cell_elig)))), 1):
        q = rng.choice(DECADE_T).format(d=decade_words(d, rng), f=FAMILY_SHORT[f])
        add(f"v3-fdec-{i:02d}", "family_decade", q, K_GENRE, {"genre_family": f, "year_range": [d, d + 9]})

    # ---- tempo × family (8 slow + 8 fast, topped up from the other side)
    slow = sorted(c for c, n in tempo_n.items() if c[1] == "slow" and n >= MIN_TEMPO)
    fast = sorted(c for c, n in tempo_n.items() if c[1] == "fast" and n >= MIN_TEMPO)
    half = N["tempo_family"] // 2
    take_slow = rng.sample(slow, min(half, len(slow)))
    take_fast = rng.sample(fast, min(N["tempo_family"] - len(take_slow), len(fast)))
    if len(take_fast) < N["tempo_family"] - len(take_slow):
        rest = [c for c in slow if c not in take_slow]
        take_slow += rng.sample(rest, min(len(rest), N["tempo_family"] - len(take_slow) - len(take_fast)))
    for i, (f, side) in enumerate(sorted(take_slow + take_fast, key=lambda c: (c[1], c[0])), 1):
        q = rng.choice(TEMPO_T[side]).format(f=FAMILY_SHORT[f])
        pred = {"genre_family": f, ("bpm_max" if side == "slow" else "bpm_min"): (SLOW_MAX if side == "slow" else FAST_MIN)}
        add(f"v3-tempo-{i:02d}", "tempo_family", q, K_GENRE, pred)

    # ---- vibe: recast the existing ret-013..015 + v2 prod-001..007
    v1 = {p["id"]: p for p in json.load(open(os.path.join(S.HERE, "eval_set.json"), encoding="utf-8"))["prompts"]}
    v2_sha = S.git("rev-parse", a.v2_ref).decode().strip()
    v2 = {p["id"]: p for p in json.loads(S.git_show(a.v2_ref, "brain-eval/eval_set_v2.json"))["prompts"]}
    src = [("eval_set.json", v1[x]) for x in ("ret-013", "ret-014", "ret-015")] + \
          [(f"eval_set_v2.json@{v2_sha[:12]}", v2[f"prod-00{j}"]) for j in range(1, 8)]
    for origin, p in src:
        pred, dropped = recast(p["expected"], vocab)
        same = v1_expected(p["expected"], tracks) == exp(pred)
        if not same:
            raise SystemExit(f"[fatal] recast of {p['id']} is not equivalent on the generating library")
        add(f"v3-vibe-{p['id']}", "vibe", p["query"], p.get("k", K_GENRE), pred,
            recast_from={"source": origin, "id": p["id"], "expected": p["expected"]},
            equivalent_at_gen=same, **({"dropped_terms": dropped} if dropped else {}))

    # ---- grounding: 14 normal (from the probes) + 6 traps (census-proven empty)
    def pick(group, n):
        pool = [p for p in probes if p["group"] == group]
        return sorted(rng.sample(pool, n), key=lambda p: p["id"])
    gi = 0

    def gadd(kind, q, pred, from_probe=None):
        nonlocal gi
        gi += 1
        n = len(exp(pred))
        if (kind == "trap") != (n == 0):
            raise SystemExit(f"[fatal] grounding {q!r}: kind={kind} but predicate matches {n}")
        grounding.append({"id": f"v3-grd-{gi:02d}", "kind": kind, "question": q, "expected": pred,
                          "k": 14, "n_expected_at_gen": n, **({"from_probe": from_probe} if from_probe else {})})
    for p in pick("artist", 5):
        gadd("normal", rng.choice(G_ARTIST_T).format(x=p["expected"]["artist"]), p["expected"], p["id"])
    for p in pick("leaf", 4):
        gadd("normal", rng.choice(G_LEAF_T).format(x=p["expected"]["genre_leaf"]), p["expected"], p["id"])
    for p in pick("family_decade", 3):
        f, (d, _) = p["expected"]["genre_family"], p["expected"]["year_range"]
        gadd("normal", G_DECADE_T[0].format(d=f"{d}s", f=FAMILY_SHORT[f]), p["expected"], p["id"])
    for p in pick("umbrella_family", 2):
        name = p["expected"].get("genre_umbrella") or p["expected"].get("genre_family")
        phrase = UMBRELLA_PHRASE.get(name) if "genre_umbrella" in p["expected"] else FAMILY_PHRASE[name]
        gadd("normal", G_GROUP_T[0].format(x=phrase), p["expected"], p["id"])
    # Traps = ANACHRONISTIC empty cells only: a family × decade with zero library
    # tracks, at least 20 years before the family's first library decade, from
    # 1950 on. Zero-track vocab LEAVES were tried and are unsound: the library
    # holds Collision Course (a real mashup EP, tagged Rap Rock) and The Cure
    # (the vocab's own Goth Rock exemplar, tagged New Wave), so naming them is a
    # defensible answer, not a hallucination. Era traps have no such neighbour.
    fam_tot = collections.Counter(fam_of(t) for t in tracks)
    first = {}
    for (f, d), n in cell_n.items():
        if n:
            first[f] = min(first.get(f, 9999), d)
    traps = sorted((f, d) for f in vocab.families if fam_tot[f] >= TRAP_MIN_FAMILY and f in first
                   for d in range(TRAP_FROM_DECADE, first[f] - TRAP_GAP + 1, 10) if cell_n[(f, d)] == 0)
    if len(traps) < N_TRAPS:
        raise SystemExit(f"[fatal] only {len(traps)} anachronistic trap cells (need {N_TRAPS}): {traps}")
    for f, d in sorted(rng.sample(traps, N_TRAPS)):
        gadd("trap", G_TRAP_DECADE_T.format(d=f"{d}s", f=FAMILY_SHORT[f]), {"genre_family": f, "year_range": [d, d + 9]})

    counts = collections.Counter(p["group"] for p in probes)
    out = {
        "_meta": {
            "version": 3, "ruler": "v3", "created": time.strftime("%Y-%m-%d"),
            "generator": "gen_probes.py", "seed": a.seed,
            "library_sha": lib_sha, "library_tracks": len(tracks),
            "vocab_source_sha": vocab.meta.get("source_sha"), "vocab_file_sha": S.file_sha(S.VOCAB_PATH),
            "v2_source": {"ref": a.v2_ref, "sha": v2_sha},
            "ruler_check_at_gen": rc,
            "counts": dict(counts), "grounding": {"normal": sum(1 for g in grounding if g["kind"] == "normal"),
                                                    "trap": sum(1 for g in grounding if g["kind"] == "trap")},
            "eligibility": {"artist_min_tracks": MIN_ARTIST, "artist_excluded": sorted(NON_ARTISTS), "leaf_min_tracks": MIN_LEAF,
                            "family_decade_min_tracks": MIN_CELL, "tempo_min_tracks": MIN_TEMPO,
                            "tempo": f"bpm<={SLOW_MAX} or bpm>={FAST_MIN}, measured bpm only",
                            "traps": f"empty family x decade, >= {TRAP_GAP}y before the family's first library decade, "
                                     f"decade >= {TRAP_FROM_DECADE}, family >= {TRAP_MIN_FAMILY} tracks",
                            "leaf_excluded": sorted(skip & set(vocab.leaf_family))},
            "eligible_pool": {"artist": len(art_elig), "leaf": len(leaf_elig), "family_decade": len(cell_elig),
                              "tempo_slow": len(slow), "tempo_fast": len(fast)},
            "headline": "mean of the group means (each group weighs the same)",
            "held_out_rule": "These probes are the ruler; never training/enrichment input. Regenerating resets v3 comparability.",
            "predicate_semantics": "genre_leaf/genre_family/genre_umbrella are exact vocab names, UNIONed; year_range, "
                                   "bpm_min/bpm_max (measured bpm only) and artist (exact folded name vs artist or "
                                   "contributingArtists) are ANDed on top. See scorecard.compile_predicate.",
        },
        "probes": probes,
        "grounding": grounding,
    }
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1, ensure_ascii=False)
        f.write("\n")
    print(f"wrote {os.path.relpath(a.out)}: {len(probes)} probes {dict(counts)}; grounding "
          f"{out['_meta']['grounding']}; library {lib_sha} ({len(tracks)} tracks); seed {a.seed}")


if __name__ == "__main__":
    main()
