#!/usr/bin/env /usr/bin/python3
"""Read-only flake forensic 2026-11-28: v1 grd-005 + v3-grd-07 both scored 0
"unparseable (reply was not JSON)" tonight. Rebuild each probe's exact
grounding context from the night's snapshot, call the grounding model x3,
persist FULL raws, and mechanically classify every reply against the two
proven parser-flake classes (PROPOSAL-grd16):
  class 1 = unescaped inner double quotes inside a JSON string (10-22)
  class 2 = valid object + self-correction second object truncated at
            max_tokens -> greedy {.*} fallback spans both -> None (11-25)
Writes /tmp/grd-flake-raws-20261128.txt only. Touches no brain file.
"""
import json, re, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import run_eval as R
import scorecard as S

SNAP = "/tmp/brain-snap-20261128"
NIGHT = "20261128"
MODEL = "claude-haiku-4-5"
OUT = f"/tmp/grd-flake-raws-{NIGHT}.txt"

def classify(raw):
    """Return (parse_ok, klass, note). Mirrors parse_json_obj, then probes."""
    obj = R.parse_json_obj(raw)
    if obj is not None:
        return True, None, f"parsed OK ({len(obj.get('tracks') or [])} tracks)"
    t = raw.strip()
    t = re.sub(r"^```(?:json)?|```$", "", t, flags=re.MULTILINE).strip()
    # class 2 probe: does raw_decode recover a leading valid object?
    try:
        obj1, end = json.JSONDecoder().raw_decode(t)
        tail = t[end:].strip()
        note = (f"raw_decode recovers obj1 ({len(obj1.get('tracks') or [])} tracks); "
                f"tail {len(tail)} chars begins {tail[:60]!r}")
        return False, 2, note
    except Exception as e2:
        pass
    # class 1 probe: single object, json.loads fails mid-string
    try:
        json.loads(t)
    except json.JSONDecodeError as e1:
        frag = t[max(0, e1.pos - 60):e1.pos + 60]
        truncated = not t.rstrip().endswith("}")
        return False, 1 if not truncated else "1-or-truncated", (
            f"json.loads: {e1.msg} at pos {e1.pos}; frag ...{frag!r}...; "
            f"ends-with-brace={not truncated}")
    return False, "unknown", "fence-stripped text parses?! (should not reach)"

def check_fab(obj, titles, artists):
    cited = (obj or {}).get("tracks") or []
    real, fab, details = R.check_citations(cited, titles, artists)
    return real, fab

def main():
    tracks = S.load_tracks(os.path.join(SNAP, "library.json"))
    by_id = {int(t["id"]): t for t in tracks}
    titles = {R.norm(t.get("title", "")) for t in tracks}
    artists = set()
    for t in tracks:
        artists |= {R.norm(a) for a in S.artist_keys(t)} if hasattr(S, "artist_keys") else {R.norm(t.get("artist", ""))}
    log = open(OUT, "w", encoding="utf-8")

    def ctx_lines(hit_ids, k):
        out = []
        for tid in hit_ids[:k]:
            t = by_id.get(tid)
            if t:
                out.append(f"- \"{t.get('title','?')}\" by {t.get('artist','?')} [{t.get('genre','')}, {t.get('year','')}]")
        return out

    jobs = []

    # --- v1 grd-005: main-index top-14, question embedded fresh (as run_eval does)
    es = json.load(open("eval_set.json"))
    g5 = [e for e in es["prompts"] if e.get("id") == "grd-005"][0]
    ids, vecs, meta = R.read_embeddings(os.path.join(SNAP, "embeddings.bin"))
    qv = R.embed_texts([g5["question"]])[0]
    hits5 = R.retrieve_topk(qv, ids, vecs, 14)
    jobs.append(("v1 grd-005", g5["question"], ctx_lines(hits5, 14)))

    # --- v3-grd-07: production bridge, k=14
    v3 = json.load(open("eval_set_v3.json"))
    g7 = [e for e in v3["grounding"] if e["id"] == "v3-grd-07"][0]
    main_src, main_sha = S.extract_main_src("origin/main")
    api_key = R.key("OPENAI_API_KEY")
    bres, stats = S.run_bridge([{"query": g7["question"], "k": g7.get("k", 14)}],
                               SNAP, main_src, api_key)
    row = bres[(g7["question"], g7.get("k", 14))]
    hits7 = [int(h["trackId"]) for h in row["hits"]]
    jobs.append(("v3-grd-07", g7["question"], ctx_lines(hits7, g7.get("k", 14))))

    summary = []
    for name, question, ctx in jobs:
        user = "Retrieved library context:\n" + "\n".join(ctx) + f"\n\nUser question: {question}"
        print(f"\n== {name} ({len(ctx)} ctx lines) ==")
        log.write(f"\n\n######## {name} ########\nQUESTION: {question}\nCTX:\n" + "\n".join(ctx) + "\n")
        for i in range(3):
            raw = R.claude(R.GROUND_SYS, user, MODEL, max_tokens=500) or ""
            ok, klass, note = classify(raw)
            obj = R.parse_json_obj(raw)
            real, fab = check_fab(obj, titles, artists) if obj else (None, None)
            line = (f"replay {i+1}: parse={'OK' if ok else 'FAIL'} class={klass} "
                    f"real={real} fab={fab} len={len(raw)} :: {note}")
            print("  " + line)
            summary.append(f"{name} {line}")
            log.write(f"\n---- replay {i+1} (parse={'OK' if ok else 'FAIL'}, class={klass}, len={len(raw)}) ----\n{raw}\n")
    log.close()
    print(f"\nfull raws -> {OUT}")
    print("\nSUMMARY:")
    for s in summary:
        print(" ", s)

if __name__ == "__main__":
    main()
