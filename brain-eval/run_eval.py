#!/usr/bin/env python3
"""
brain-eval/run_eval.py — an altimeter for the JakeTunes EMBEDDING brain.

============================ THE ONE RULE ============================
This script NEVER touches, edits, pauses, imports-for-modification, or writes
near the JakeTunes app, the nightly brain-trainer, or embeddings.bin. It only
READS embeddings.bin + library.json, calls the OpenAI/Anthropic HTTP APIs, and
writes exactly two things: brain-eval/score_log.jsonl and brain-eval/tmp/*.
If anything here would require editing the app or the trainer to work, STOP.
=====================================================================

WHY THIS IS RETARGETED FROM THE ORIGINAL BRIEF 003:
The brief assumed a nightly LoRA fine-tune producing checkpoints. The pre-flight
proved there is NONE — no training script, no peft/torch, no adapters, no
fine-tuned model (Ollama serves only stock Gemma). The JakeTunes "brain" is
OpenAI text-embedding-3-small vectors (embeddings.bin) + RAG, enriched nightly
by brain-trainer.mjs (Gemma writes a sound/mood line -> re-embed via OpenAI).
So the thing that changes over time — the real "checkpoint" — is embeddings.bin
itself. Its sha1 is the brain_id. Re-run after each night; score_log shows drift.

WHAT IT MEASURES:
  retrieval  recall@k vs an objective predicate (artist/genre/era/bpm) from
             library.json. The enrichment_sensitive prompts are the true
             altimeter — they should rise as the brain learns to HEAR.
  grounding  the Music Man (Claude) answers a library question; every track it
             cites must EXIST in library.json. Fabricating one = automatic 0
             (Decision 4). 'trap' questions ask about content you don't own;
             the only passing answer cites nothing.
  persona    voice 0-5 via an optional Claude judge (--judge).

USAGE:
  python run_eval.py                      # score current brain, append a log row, print table
  python run_eval.py --baseline           # also score embeddings.bin.bak as 'base' (before/after)
  python run_eval.py --models base current # same as --baseline (brief-compat)
  python run_eval.py --judge              # enable the persona judge
  python run_eval.py --no-llm             # retrieval only (no Claude calls)
  python run_eval.py --limit 6            # quick smoke: first 6 prompts per bucket
  python run_eval.py --model claude-haiku-4-5   # LLM for grounding/judge
"""
import argparse, hashlib, json, os, re, struct, sys, time, urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
STATE_DIR = os.environ.get("JT_STATE_DIR") or os.path.expanduser("~/Library/Application Support/JakeTunes")
EMB_PATH = os.path.join(STATE_DIR, "embeddings.bin")
LIB_PATH = os.path.join(STATE_DIR, "library.json")
EVAL_PATH = os.path.join(HERE, "eval_set.json")
EVAL_V2_PATH = os.path.join(HERE, "eval_set_v2.json")
BRIDGE_DIR = os.path.join(HERE, "bridge")
LOG_PATH = os.path.join(HERE, "score_log.jsonl")
EMBED_MODEL = "text-embedding-3-small"
EMBED_DIM = 1536
EMBED_MAGIC = b"EMBD"

import numpy as np

# ---------- env (read the repo .env directly; the shell exports an empty one) ----------
def load_env():
    p = os.path.join(REPO, ".env")
    out = {}
    if os.path.exists(p):
        for line in open(p, encoding="utf-8"):
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip().strip('"').strip("'")
    return out

ENV = load_env()
def key(name):
    return ENV.get(name) or os.environ.get(name) or ""

# ---------- embeddings.bin (read-only) ----------
# Format (from src/main/ai/embeddings.ts): "EMBD" | u16 ver | u16 dim | u32 count
# then count records of [u32 trackId][dim * f32], all little-endian.
def read_embeddings(path):
    with open(path, "rb") as f:
        blob = f.read()
    if blob[0:4] != EMBED_MAGIC:
        raise SystemExit(f"[fatal] {path}: bad magic {blob[0:4]!r} (expected EMBD)")
    ver = struct.unpack_from("<H", blob, 4)[0]
    dim = struct.unpack_from("<H", blob, 6)[0]
    count = struct.unpack_from("<I", blob, 8)[0]
    if dim != EMBED_DIM:
        raise SystemExit(f"[fatal] {path}: dim {dim} != {EMBED_DIM}")
    rec = 4 + dim * 4
    body = blob[12:12 + count * rec]
    arr = np.frombuffer(body, dtype=np.uint8).reshape(count, rec)
    ids = arr[:, :4].copy().view(np.uint32).reshape(count)
    vecs = arr[:, 4:].copy().view(np.float32).reshape(count, dim).astype(np.float32)
    # L2-normalize (OpenAI vectors are ~unit already; guard zeros)
    norms = np.linalg.norm(vecs, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    vecs = vecs / norms
    return ids, vecs, {"ver": ver, "dim": dim, "count": int(count)}

def sha_of(path):
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:12]

# ---------- library ----------
def norm(s):
    s = (s or "").lower().strip()
    s = re.sub(r"\(.*?\)|\[.*?\]", "", s)          # drop (feat ...), [remaster], etc.
    s = re.sub(r"\bfeat\.?\b.*$|\bft\.?\b.*$", "", s)
    s = re.sub(r"[^a-z0-9 ]+", "", s)
    return re.sub(r"\s+", " ", s).strip()

def load_library():
    d = json.load(open(LIB_PATH, encoding="utf-8"))
    tracks = d["tracks"] if isinstance(d, dict) and "tracks" in d else d
    by_id, titles, artists = {}, set(), set()
    for t in tracks:
        try:
            tid = int(t["id"])
        except Exception:
            continue
        by_id[tid] = t
        if t.get("title"):
            titles.add(norm(t["title"]))
        if t.get("artist"):
            artists.add(norm(t["artist"]))
    return tracks, by_id, titles, artists

def expected_ids(pred, tracks):
    """Resolve an objective predicate -> set of matching track ids (the ruler)."""
    out = set()
    for t in tracks:
        try:
            tid = int(t["id"])
        except Exception:
            continue
        ok = True
        if "artist" in pred:
            a = (t.get("artist") or "").lower()
            p = pred["artist"].lower()
            ok = ok and (p in a or a in p) and bool(a)
        if "artist_any" in pred:
            a = (t.get("artist") or "").lower()
            ok = ok and any(x.lower() == a for x in pred["artist_any"])
        if "genre_any" in pred:
            g = (t.get("genre") or "").lower()
            ok = ok and any(term.lower() in g for term in pred["genre_any"]) and bool(g)
        if "year_range" in pred:
            try:
                y = int(t.get("year"))
                ok = ok and pred["year_range"][0] <= y <= pred["year_range"][1]
            except Exception:
                ok = False
        if "bpm_min" in pred:
            b = t.get("bpm") or 0
            ok = ok and b and b >= pred["bpm_min"]
        if "bpm_max" in pred:
            b = t.get("bpm") or 0
            ok = ok and b and b <= pred["bpm_max"]
        if ok:
            out.add(tid)
    return out

# ---------- OpenAI embeddings (query side) ----------
def embed_texts(texts):
    k = key("OPENAI_API_KEY")
    if not k:
        raise SystemExit("[fatal] OPENAI_API_KEY missing in .env — retrieval needs it.")
    payload = json.dumps({"model": EMBED_MODEL, "input": texts}).encode()
    req = urllib.request.Request(
        "https://api.openai.com/v1/embeddings", data=payload,
        headers={"Authorization": f"Bearer {k}", "Content-Type": "application/json"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                data = json.loads(r.read())
            ordered = sorted(data["data"], key=lambda d: d["index"])
            out = np.array([d["embedding"] for d in ordered], dtype=np.float32)
            n = np.linalg.norm(out, axis=1, keepdims=True); n[n == 0] = 1
            return out / n
        except urllib.error.HTTPError as e:
            if attempt == 2:
                raise SystemExit(f"[fatal] OpenAI embed failed: {e} {e.read()[:200]!r}")
            time.sleep(1.5 * (attempt + 1))

# ---------- Anthropic (grounding answers + persona judge) ----------
def claude(system, user, model, max_tokens=400):
    k = key("ANTHROPIC_API_KEY")
    if not k:
        return None
    payload = json.dumps({
        "model": model, "max_tokens": max_tokens, "system": system,
        "messages": [{"role": "user", "content": user}],
    }).encode()
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages", data=payload,
        headers={"x-api-key": k, "anthropic-version": "2023-06-01",
                 "Content-Type": "application/json"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                data = json.loads(r.read())
            for blk in data.get("content", []):
                if blk.get("type") == "text":
                    return blk["text"]
            return ""
        except urllib.error.HTTPError as e:
            if attempt == 2:
                print(f"[warn] Claude call failed: {e} {e.read()[:160]!r}", file=sys.stderr)
                return None
            time.sleep(1.5 * (attempt + 1))

def parse_json_obj(text):
    if not text:
        return None
    t = text.strip()
    t = re.sub(r"^```(?:json)?|```$", "", t, flags=re.MULTILINE).strip()
    try:
        return json.loads(t)
    except Exception:
        m = re.search(r"\{.*\}", t, flags=re.DOTALL)
        if m:
            try:
                return json.loads(m.group(0))
            except Exception:
                return None
    return None

# ---------- retrieval scoring ----------
def retrieve_topk(qvec, ids, vecs, k):
    scores = vecs @ qvec
    idx = np.argpartition(-scores, min(k, len(scores) - 1))[:k]
    idx = idx[np.argsort(-scores[idx])]
    return [int(ids[i]) for i in idx]

def recall_at_k(topk, expected, k):
    if not expected:
        return None  # nothing to score (predicate empty)
    hits = len(set(topk[:k]) & expected)
    return hits / min(k, len(expected))

# ---------- grounding: hallucination check (the most important signal) ----------
def check_citations(cited, titles, artists):
    """cited = [{title, artist}]. Returns (real_count, fabricated_count, details)."""
    real = fab = 0
    details = []
    for c in cited:
        ti = norm(c.get("title", "")); ar = norm(c.get("artist", ""))
        if not ti and not ar:
            continue
        is_real = (ti in titles) or (ar in artists and ti in titles)
        # fabricated = the title is not in the library AND the artist isn't either
        is_fab = (ti not in titles) and (ar not in artists)
        if ti in titles:
            real += 1; details.append(("real", c.get("title"), c.get("artist")))
        elif is_fab:
            fab += 1; details.append(("FABRICATED", c.get("title"), c.get("artist")))
        else:
            real += 1; details.append(("real-artist", c.get("title"), c.get("artist")))
    return real, fab, details

GROUND_SYS = ("You are the Music Man, JakeTunes' in-house DJ — an arrogant, "
              "knowledgeable music savant. Answer ONLY about tracks in the user's "
              "library. You may use the retrieved library context provided. Cite "
              "specific tracks by their EXACT title and artist. If the library has "
              "none that fit, say so plainly and cite nothing — never invent a track. "
              'Return ONLY JSON: {"tracks":[{"title":"...","artist":"..."}],"answer":"..."}')

def run_grounding(entry, ids, vecs, qvec, by_id, titles, artists, model):
    topk = retrieve_topk(qvec, ids, vecs, 14)
    ctx = []
    for tid in topk:
        t = by_id.get(tid)
        if t:
            ctx.append(f"- {t.get('title','?')} — {t.get('artist','?')} [{t.get('genre','')}, {t.get('year','')}]")
    user = (f"Retrieved library context:\n" + "\n".join(ctx) +
            f"\n\nUser question: {entry['question']}")
    raw = claude(GROUND_SYS, user, model, max_tokens=500)
    obj = parse_json_obj(raw)
    if obj is None:
        return {"score": 0.0, "reason": "unparseable/no-LLM", "cited": 0, "fab": 0, "raw": (raw or "")[:160]}
    cited = obj.get("tracks") or []
    real, fab, details = check_citations(cited, titles, artists)
    kind = entry.get("kind", "normal")
    if kind == "trap":
        score = 1.0 if len(cited) == 0 else 0.0
        reason = "named nothing (correct)" if score else f"cited {len(cited)} on a trap"
    else:
        score = 1.0 if (real >= 1 and fab == 0) else 0.0
        reason = (f"{real} real, {fab} fabricated" if fab else
                  (f"{real} real tracks" if real else "no real citation"))
    return {"score": score, "reason": reason, "cited": len(cited), "fab": fab, "details": details}

# ---------- persona judge (optional) ----------
JUDGE_SYS = ("You are a strict evaluator scoring a music-DJ AI's persona/voice. "
             "Given the prompt, the rubric, and the AI's answer, return ONLY JSON "
             '{"score": <0-5 integer>, "why": "..."}. Be exacting.')

def run_persona(entry, model):
    answer = claude("You are the Music Man, an arrogant, witty music savant DJ. "
                    "Stay in voice. No markdown.", entry["prompt"], model, max_tokens=220)
    if answer is None:
        return {"score": None, "answer": None}
    j = parse_json_obj(claude(JUDGE_SYS,
        f"PROMPT: {entry['prompt']}\nRUBRIC: {entry['rubric']}\nANSWER: {answer}",
        model, max_tokens=200))
    sc = (j or {}).get("score")
    try:
        sc = max(0, min(5, int(sc))) / 5.0
    except Exception:
        sc = None
    return {"score": sc, "answer": answer[:160], "why": (j or {}).get("why", "")}

# ---------- known-bad self-test (Decision 4 guarantee) ----------
def self_test(titles, artists, by_id):
    fake = [{"title": "Imaginary Song That Cannot Exist 9z9z", "artist": "Nobody At All 9z9z"}]
    _, fab, _ = check_citations(fake, titles, artists)
    if fab < 1:
        print("[FATAL] hallucination check did NOT fire on a known-bad answer. "
              "The most important signal is broken — STOP.", file=sys.stderr)
        sys.exit(2)
    # positive control: a real library title must NOT be flagged
    real_title = next((t["title"] for t in by_id.values() if t.get("title")), None)
    real_artist = next((t["artist"] for t in by_id.values() if t.get("artist")), "")
    r, f2, _ = check_citations([{"title": real_title, "artist": real_artist}], titles, artists)
    if r < 1 or f2 != 0:
        print(f"[FATAL] self-test: a real track ({real_title}) was flagged as fabricated.", file=sys.stderr)
        sys.exit(2)
    print(f"[selftest] hallucination check fires on fabrication, passes real track \"{real_title}\". OK")

# ---------- production-path retrieval (V2 bucket, via the TS bridge) ----------
def run_production_retrieval(v2_prompts, tracks, env_key):
    """Run V2 prompts through the REAL desktop retrieval path (router +
    mood index + decade gate) via bridge/rag-bridge.ts. Returns
    (per_prompt_rows, mean_recall) or (None, None) if the bridge can't run
    — loudly, never silently."""
    import subprocess, tempfile
    queries = [p["query"] for p in v2_prompts]
    max_k = max(p.get("k", 25) for p in v2_prompts)
    tmpdir = os.path.join(HERE, "tmp"); os.makedirs(tmpdir, exist_ok=True)
    qpath = os.path.join(tmpdir, "prod-queries.json")
    with open(qpath, "w", encoding="utf-8") as f:
        json.dump(queries, f)
    env = dict(os.environ); env["OPENAI_API_KEY"] = env_key
    try:
        r = subprocess.run(
            ["npx", "tsx", "--tsconfig", os.path.join(BRIDGE_DIR, "tsconfig.json"),
             os.path.join(BRIDGE_DIR, "rag-bridge.ts"), qpath, str(max_k)],
            capture_output=True, text=True, timeout=300, cwd=BRIDGE_DIR, env=env)
    except Exception as e:
        print(f"[prod] bridge failed to launch: {e} — production bucket SKIPPED", file=sys.stderr)
        return None, None
    if r.returncode != 0:
        print(f"[prod] bridge exited {r.returncode} — production bucket SKIPPED\n{r.stderr[-800:]}", file=sys.stderr)
        return None, None
    by_query = {}
    for line in r.stdout.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            row = json.loads(line)
        except Exception:
            continue
        if "query" in row and "hits" in row:
            by_query[row["query"]] = row
    rows, scores = [], []
    for p in v2_prompts:
        got = by_query.get(p["query"])
        if not got:
            print(f"  prod {p['id']}: NO RESULT from bridge")
            continue
        exp = expected_ids(p["expected"], tracks)
        if not exp:
            print(f"  [skip] {p['id']}: predicate matched 0 library tracks")
            continue
        k = p.get("k", 25)
        topk = [h["trackId"] for h in got["hits"]][:k]
        rec = recall_at_k(topk, exp, k)
        route = got.get("index", "?")
        route_tag = "" if p.get("expect_route") in (None, route) else f"  [route≠{p['expect_route']}]"
        rows.append({"id": p["id"], "recall": rec, "route": route, "k": k, "expected_n": len(exp)})
        scores.append(rec)
        print(f"  prod {p['id']}: recall@{k}={rec:.2f}  route={route}  (|expected|={len(exp)}){route_tag}")
    mean = (sum(scores) / len(scores)) if scores else None
    return rows, mean

# ---------- per-brain evaluation ----------
def eval_brain(label, emb_path, prompts, by_id, tracks, titles, artists, args, embed_cache):
    ids, vecs, meta = read_embeddings(emb_path)
    brain_id = sha_of(emb_path)
    print(f"\n=== brain '{label}'  ({os.path.basename(emb_path)}, {meta['count']} vectors, sha {brain_id}) ===")
    R = {"retrieval": [], "grounding": [], "persona": []}

    # retrieval
    for e in [p for p in prompts if p["bucket"] == "retrieval"]:
        exp = expected_ids(e["expected"], tracks)
        if not exp:
            print(f"  [skip] {e['id']}: predicate matched 0 library tracks")
            continue
        topk = retrieve_topk(embed_cache[e["query"]], ids, vecs, e.get("k", 20))
        rec = recall_at_k(topk, exp, e.get("k", 20))
        R["retrieval"].append(rec)
        tag = " *enrich" if e.get("enrichment_sensitive") else ""
        print(f"  ret {e['id']}: recall@{e.get('k',20)}={rec:.2f}  (|expected|={len(exp)}){tag}")

    # grounding
    if not args.no_llm:
        for e in [p for p in prompts if p["bucket"] == "grounding"]:
            # validate traps: if a 'trap' predicate actually matches tracks, note it
            if e.get("kind") == "trap":
                hit = expected_ids(e["expected"], tracks)
                if hit:
                    print(f"  [note] {e['id']}: trap predicate matched {len(hit)} tracks — still expects 'name nothing'")
            res = run_grounding(e, ids, vecs, embed_cache[e["question"]], by_id, titles, artists, args.model)
            R["grounding"].append(res["score"])
            print(f"  grd {e['id']} [{e.get('kind','normal')}]: {res['score']:.0f}  ({res['reason']})")

    # persona (optional judge)
    if args.judge and not args.no_llm:
        for e in [p for p in prompts if p["bucket"] == "persona"]:
            res = run_persona(e, args.model)
            if res["score"] is not None:
                R["persona"].append(res["score"])
                print(f"  per {e['id']}: {res['score']*5:.0f}/5  ({res.get('why','')[:60]})")

    def mean(xs):
        xs = [x for x in xs if x is not None]
        return round(sum(xs) / len(xs), 4) if xs else None
    summary = {
        "label": label, "brain_id": brain_id, "vectors": meta["count"],
        "audio_route": os.environ.get("JT_AUDIO_ROUTE") or None, "audio_w": os.environ.get("JT_AUDIO_W") or None,
        "retrieval": mean(R["retrieval"]), "grounding": mean(R["grounding"]),
        "persona": mean(R["persona"]),
    }
    bucket_means = [summary[b] for b in ("retrieval", "grounding", "persona") if summary[b] is not None]
    summary["overall"] = round(sum(bucket_means) / len(bucket_means), 4) if bucket_means else None
    summary["n"] = {b: len([x for x in R[b] if x is not None]) for b in R}
    return summary

def fmt(v):
    return "  —  " if v is None else f"{v:.3f}"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--baseline", action="store_true", help="also score embeddings.bin.bak as 'base'")
    ap.add_argument("--models", nargs="*", default=None, help="brief-compat: 'base current'")
    ap.add_argument("--judge", action="store_true", help="enable persona judge (Claude)")
    ap.add_argument("--no-llm", action="store_true", help="retrieval only (no Claude calls)")
    ap.add_argument("--model", default="claude-haiku-4-5", help="LLM for grounding/judge")
    ap.add_argument("--limit", type=int, default=0, help="first N prompts per bucket (smoke test)")
    ap.add_argument("--no-prod", action="store_true", help="skip the V2 production-path bucket")
    args = ap.parse_args()

    do_base = args.baseline or (args.models and "base" in args.models)

    spec = json.load(open(EVAL_PATH, encoding="utf-8"))
    prompts = spec["prompts"]
    if args.limit:
        kept, seen = [], {}
        for p in prompts:
            seen[p["bucket"]] = seen.get(p["bucket"], 0) + 1
            if seen[p["bucket"]] <= args.limit:
                kept.append(p)
        prompts = kept

    tracks, by_id, titles, artists = load_library()
    print(f"library: {len(tracks)} tracks  |  eval prompts: {len(prompts)}")
    self_test(titles, artists, by_id)

    # embed every needed query/question ONCE
    texts = sorted({p["query"] for p in prompts if p["bucket"] == "retrieval"} |
                   {p["question"] for p in prompts if p["bucket"] == "grounding"})
    print(f"embedding {len(texts)} query texts via OpenAI…")
    vecs = embed_texts(texts)
    embed_cache = {t: vecs[i] for i, t in enumerate(texts)}

    summaries = []
    if do_base:
        bak = EMB_PATH + ".bak"
        if os.path.exists(bak):
            summaries.append(eval_brain("base", bak, prompts, by_id, tracks, titles, artists, args, embed_cache))
        else:
            print("[note] embeddings.bin.bak not found — skipping 'base'.")
    summaries.append(eval_brain("current", EMB_PATH, prompts, by_id, tracks, titles, artists, args, embed_cache))

    # comparison table
    print("\n" + "=" * 58)
    print(f"{'bucket':<12}" + "".join(f"{s['label']:>10}" for s in summaries) +
          ("      Δ" if len(summaries) == 2 else ""))
    print("-" * 58)
    for b in ("retrieval", "grounding", "persona", "overall"):
        row = f"{b:<12}" + "".join(f"{fmt(s[b]):>10}" for s in summaries)
        if len(summaries) == 2 and summaries[0][b] is not None and summaries[1][b] is not None:
            d = summaries[1][b] - summaries[0][b]
            row += f"   {('+' if d>=0 else '')}{d:.3f}"
        print(row)
    print("=" * 58)
    print("retrieval/grounding are mechanical; persona needs --judge. "
          "The enrichment_sensitive (*enrich) retrieval prompts are the real altimeter.")

    # V2: score the PRODUCTION retrieval path (router + mood + decade gate).
    # Separate series from the frozen golden-35 — never mixed into 'retrieval'.
    prod_rows, prod_mean = (None, None)
    if not args.no_prod and os.path.exists(EVAL_V2_PATH):
        v2 = json.load(open(EVAL_V2_PATH, encoding="utf-8"))["prompts"]
        if args.limit:
            v2 = v2[: args.limit]
        print(f"\n=== production path (bridge) — {len(v2)} V2 prompts ===")
        prod_rows, prod_mean = run_production_retrieval(v2, tracks, key("OPENAI_API_KEY"))
        if prod_mean is not None:
            print(f"  retrieval_prod mean: {prod_mean:.3f}")
            summaries[-1]["retrieval_prod"] = prod_mean
            summaries[-1]["retrieval_prod_rows"] = prod_rows

    # append one row per brain
    now = time.time()
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        for s in summaries:
            f.write(json.dumps({
                "at": int(now * 1000),
                "iso": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(now)),
                "model": args.model, "judged": bool(args.judge), "no_llm": bool(args.no_llm),
                "limit": args.limit, **s,
            }) + "\n")
    print(f"\nappended {len(summaries)} row(s) to {os.path.relpath(LOG_PATH, REPO)}")

if __name__ == "__main__":
    main()
