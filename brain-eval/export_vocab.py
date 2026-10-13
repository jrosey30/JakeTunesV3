#!/usr/bin/env python3
"""
export_vocab.py — freeze the app's genre vocab into brain-eval/vocab_snapshot.json.

The v3 ruler resolves genres through the SAME list the app files songs with
(src/common/genre-vocab.ts: leaf name + area, which v3 calls the FAMILY) and
the Genre Iceberg's seven umbrellas (src/common/genre-iceberg.ts: UMBRELLAS,
each a set of families). This script executes those two TS modules from a
`git archive` of --ref (default origin/main) via tsx — it never parses TS with
regexes and never checks anything out — and records where they came from.

    python3 export_vocab.py                 # from origin/main
    python3 export_vocab.py --ref <sha>     # pin a revision
    python3 export_vocab.py --check         # exit 1 if the snapshot is out of date

Re-export whenever genre-vocab.ts changes; run_eval --ruler v3 aborts with
"ruler stale" once >0.5% of library tags stop resolving.
"""
import argparse, json, os, subprocess, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scorecard as S  # noqa: E402


def build(ref):
    src, sha = S.extract_main_src(ref)
    env = dict(os.environ, JT_MAIN_SRC=src)
    r = subprocess.run(S.tsx_command() + [os.path.join(S.BRIDGE_DIR, "export-vocab.ts")],
                       capture_output=True, text=True, cwd=S.BRIDGE_DIR, env=env, timeout=300)
    if r.returncode != 0:
        raise SystemExit(f"[fatal] export-vocab.ts failed: {r.stderr[-800:]}")
    raw = json.loads(r.stdout.strip().splitlines()[-1])
    fam_umb = {}
    for u in raw["umbrellas"]:
        for f in u["families"]:
            fam_umb[f] = u["name"]
    leaves, families = {}, {}
    for g in raw["genres"]:
        fam = g["area"]
        leaves[g["name"]] = {"family": fam, "umbrella": fam_umb.get(fam), "strict": bool(g.get("strict"))}
        families.setdefault(fam, {"umbrella": fam_umb.get(fam), "leaves": []})["leaves"].append(g["name"])
    umbrellas = {u["name"]: {"families": list(u["families"]), "shelf": u.get("shelf")} for u in raw["umbrellas"]}
    for u, info in umbrellas.items():
        for f in info["families"]:
            if f not in families:
                raise SystemExit(f"[fatal] umbrella {u} names family {f!r} that has no genres")
    blob = lambda p: S.git("rev-parse", f"{ref}:{p}").decode().strip()  # noqa: E731
    return {
        "_meta": {
            "what": "Frozen copy of the app's genre vocab for the v3 eval ruler (leaf -> family -> umbrella).",
            "source_ref": ref, "source_sha": sha,
            "source_files": {
                "src/common/genre-vocab.ts": blob("src/common/genre-vocab.ts"),
                "src/common/genre-iceberg.ts": blob("src/common/genre-iceberg.ts"),
            },
            "exported_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "counts": {"leaves": len(leaves), "families": len(families), "umbrellas": len(umbrellas)},
            "family_note": "family = genre-vocab 'area'. 'Other' (Soundtrack, Comedy, ...) has no umbrella — off the berg.",
        },
        "leaves": leaves, "families": families, "umbrellas": umbrellas,
        "catch_all": sorted(raw["catchAll"]),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", default="origin/main")
    ap.add_argument("--out", default=S.VOCAB_PATH)
    ap.add_argument("--check", action="store_true", help="compare with the committed snapshot; write nothing")
    a = ap.parse_args()
    snap = build(a.ref)
    if a.check:
        old = json.load(open(a.out, encoding="utf-8"))
        same = all(old.get(k) == snap[k] for k in ("leaves", "families", "umbrellas", "catch_all"))
        print("vocab snapshot " + ("UP TO DATE" if same else f"OUT OF DATE vs {a.ref} ({snap['_meta']['source_sha'][:12]})"))
        sys.exit(0 if same else 1)
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(snap, f, indent=1, ensure_ascii=False)
        f.write("\n")
    c = snap["_meta"]["counts"]
    print(f"wrote {os.path.relpath(a.out)}: {c['leaves']} leaves / {c['families']} families / "
          f"{c['umbrellas']} umbrellas from {a.ref} {snap['_meta']['source_sha'][:12]}")


if __name__ == "__main__":
    main()
