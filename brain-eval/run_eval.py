#!/usr/bin/env python3
"""
brain-eval/run_eval.py — an altimeter for the JakeTunes EMBEDDING brain.

============================ THE ONE RULE ============================
This script NEVER touches, edits, pauses, imports-for-modification, or writes
near the JakeTunes app, the nightly brain-trainer, or embeddings.bin. It only
READS embeddings.bin + library.json, calls the OpenAI/Anthropic HTTP APIs, and
writes brain-eval/score_log.jsonl, brain-eval/score_rows.jsonl and brain-eval/tmp/*.
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

TWO RULERS (2026-10-12, scorecard v3):
  --ruler v1   (default) eval_set.json — FROZEN, scored exactly as before. Kept
               for continuity; its headline (retrieval/overall) is unchanged.
  --ruler v3   eval_set_v3.json (gen_probes.py): ~155 vocab-resolved probes in
               six groups, scored on the PRODUCTION retrieval path (the
               main-branch bridge), main/mood index readings as diagnostics,
               20 grounding questions where a citation must match the
               question's predicate. Headline = mean of the group means.
               Aborts with "ruler stale" if >0.5% of genre tags don't resolve.
  Every score_log row carries "ruler" (rows without one are v1); every probe
  lands in score_rows.jsonl under the run's run_id, which gate.py compares.

  python run_eval.py --ruler v3 --no-llm                 # retrieval only
  python run_eval.py --ruler v3 --label baseline         # + grounding (Claude)
  JT_STATE_DIR=/tmp/cand python run_eval.py --ruler v3 --label candidate
  python run_eval.py --ruler v3 --state-dir /tmp/snap --log-dir /tmp/out
"""
import argparse, hashlib, json, os, re, struct, sys, time, urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
STATE_DIR = os.environ.get("JT_STATE_DIR") or os.path.expanduser("~/Library/Application Support/JakeTunes")
EMB_PATH = os.path.join(STATE_DIR, "embeddings.bin")
LIB_PATH = os.path.join(STATE_DIR, "library.json")
EVAL_PATH = os.path.join(HERE, "eval_set.json")
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
              "specific tracks by their EXACT title and artist, written exactly as listed (\"Title\" by Artist). If the library has "
              "none that fit, say so plainly and cite nothing — never invent a track. "
              'Return ONLY JSON: {"tracks":[{"title":"...","artist":"..."}],"answer":"..."}')

def run_grounding(entry, ids, vecs, qvec, by_id, titles, artists, model):
    topk = retrieve_topk(qvec, ids, vecs, 14)
    ctx = []
    for tid in topk:
        t = by_id.get(tid)
        if t:
            ctx.append(f"- \"{t.get('title','?')}\" by {t.get('artist','?')} [{t.get('genre','')}, {t.get('year','')}]")
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

# ---------- per-brain evaluation ----------
def eval_brain(label, emb_path, prompts, by_id, tracks, titles, artists, args, embed_cache):
    ids, vecs, meta = read_embeddings(emb_path)
    brain_id = sha_of(emb_path)
    print(f"\n=== brain '{label}'  ({os.path.basename(emb_path)}, {meta['count']} vectors, sha {brain_id}) ===")
    R = {"retrieval": [], "grounding": [], "persona": []}
    rows = []  # per-probe detail for score_rows.jsonl (additive; never feeds a mean)

    # retrieval
    for e in [p for p in prompts if p["bucket"] == "retrieval"]:
        exp = expected_ids(e["expected"], tracks)
        if not exp:
            print(f"  [skip] {e['id']}: predicate matched 0 library tracks")
            continue
        topk = retrieve_topk(embed_cache[e["query"]], ids, vecs, e.get("k", 20))
        rec = recall_at_k(topk, exp, e.get("k", 20))
        R["retrieval"].append(rec)
        rows.append({"probe_id": e["id"], "group": "retrieval", "k": e.get("k", 20),
                     "n_expected": len(exp), "score": rec})
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
            rows.append({"probe_id": e["id"], "group": "grounding", "kind": e.get("kind", "normal"),
                         "score": res["score"], "reason": res["reason"]})
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
        "retrieval": mean(R["retrieval"]), "grounding": mean(R["grounding"]),
        "persona": mean(R["persona"]),
    }
    bucket_means = [summary[b] for b in ("retrieval", "grounding", "persona") if summary[b] is not None]
    summary["overall"] = round(sum(bucket_means) / len(bucket_means), 4) if bucket_means else None
    summary["n"] = {b: len([x for x in R[b] if x is not None]) for b in R}
    summary["_rows"] = rows
    return summary

def fmt(v):
    return "  —  " if v is None else f"{v:.3f}"

def set_state_dir(path):
    """--state-dir: point every brain read at a snapshot (same as JT_STATE_DIR)."""
    global STATE_DIR, EMB_PATH, LIB_PATH
    STATE_DIR = os.path.abspath(path)
    EMB_PATH = os.path.join(STATE_DIR, "embeddings.bin")
    LIB_PATH = os.path.join(STATE_DIR, "library.json")


def new_run_id(label, ruler):
    return f"{time.strftime('%Y%m%dT%H%M%S')}-{ruler}-{label}-{os.getpid()}"


def append_jsonl(path, rows):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")


def v1_mood_diag(prompts, tracks, embed_cache):
    """Per-probe recall of the v1 retrieval prompts on mood-index.bin — the
    reading the nightly reports track as 'ret-007 mood'. Additive diagnostic:
    it never enters a v1 mean. Returns ({probe_id: recall}, mood_sha|None)."""
    path = os.path.join(STATE_DIR, "mood-index.bin")
    if not os.path.exists(path):
        return {}, None
    ids, vecs, _ = read_embeddings(path)
    out = {}
    for e in [p for p in prompts if p["bucket"] == "retrieval"]:
        exp = expected_ids(e["expected"], tracks)
        if exp:
            out[e["id"]] = recall_at_k(retrieve_topk(embed_cache[e["query"]], ids, vecs, e.get("k", 20)), exp, e.get("k", 20))
    return out, sha_of(path)


def v1_production_routes(prompts, args):
    """Where production sends each v1 retrieval query ('main' | 'mood'), from
    main's real router through the bridge. Additive: it never changes a v1
    score. gate.py's v1 mood rule counts only the mood-routed probes (Jake,
    2026-10-13: "yes change the rule"), and falls back to EVERY probe when
    this is unavailable, so a bridge failure can only make the bar stricter."""
    if args.no_bridge:
        return {}, None
    try:
        import scorecard as S  # noqa: N812 — same local import the v3 path uses
        src_dir, main_sha = S.extract_main_src(args.main_ref)
        ret = [e for e in prompts if e["bucket"] == "retrieval"]
        bres, _ = S.run_bridge([{"query": e["query"], "k": e.get("k", 20)} for e in ret],
                               STATE_DIR, src_dir, key("OPENAI_API_KEY"))
        return {e["id"]: bres[(e["query"], int(e.get("k", 20)))]["index"] for e in ret}, main_sha
    except Exception as ex:  # noqa: BLE001 — unavailable routes = the strict fallback
        print(f"[v1] production routes unavailable ({str(ex)[:200]}) — gate's v1 mood rule will count every probe",
              file=sys.stderr)
        return {}, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ruler", choices=("v1", "v3"), default="v1",
                    help="v1 = frozen eval_set.json (default, unchanged); v3 = eval_set_v3.json")
    ap.add_argument("--baseline", action="store_true", help="v1 only: also score embeddings.bin.bak as 'base'")
    ap.add_argument("--models", nargs="*", default=None, help="brief-compat: 'base current'")
    ap.add_argument("--judge", action="store_true", help="v1 only: enable persona judge (Claude)")
    ap.add_argument("--no-llm", action="store_true", help="retrieval only (no Claude calls)")
    ap.add_argument("--model", default="claude-haiku-4-5", help="LLM for grounding/judge")
    ap.add_argument("--limit", type=int, default=0, help="first N prompts per bucket/group (smoke test)")
    ap.add_argument("--state-dir", default=None, help="read the brain from this dir (a snapshot); same as JT_STATE_DIR")
    ap.add_argument("--log-dir", default=HERE, help="where score_log.jsonl / score_rows.jsonl are appended")
    ap.add_argument("--label", default=None, help="run label (v3 default 'current'; v1 labels stay base/current)")
    ap.add_argument("--run-id", default=None, help="override the generated run id (gate.py keys on it)")
    ap.add_argument("--no-bridge", action="store_true", help="v3: skip the production bridge (py-router fallback)")
    ap.add_argument("--main-src", default=None, help="v3: a main-branch tree (containing src/) for the bridge")
    ap.add_argument("--main-ref", default="origin/main", help="v3: git ref whose src/ the bridge runs (default origin/main)")
    ap.add_argument("--freeze-qvec", action="store_true", help="v3: rewrite eval_set_v3.qvec.json from this run's query texts")
    args = ap.parse_args()
    if args.state_dir:
        set_state_dir(args.state_dir)
    if args.ruler == "v3":
        return main_v3(args)

    do_base = args.baseline or (args.models and "base" in args.models)
    run_id = args.run_id or new_run_id("current", "v1")

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

    # additive diagnostics (never part of a v1 mean): per-probe mood-index readings
    mood_diag, mood_id = v1_mood_diag(prompts, tracks, embed_cache)
    v1_routes, routes_src = v1_production_routes(prompts, args)
    if v1_routes:
        print(f"[v1] production routes (main src {routes_src[:12]}): "
              f"{sum(1 for v in v1_routes.values() if v == 'mood')} mood / {sum(1 for v in v1_routes.values() if v != 'mood')} main")
    lib_sha = sha_of(LIB_PATH)

    # append one row per brain (+ its per-probe rows)
    now = time.time()
    log_path = os.path.join(args.log_dir, "score_log.jsonl")
    rows_path = os.path.join(args.log_dir, "score_rows.jsonl")
    log_rows, probe_rows = [], []
    for s in summaries:
        rows = s.pop("_rows")
        log_rows.append({
            "at": int(now * 1000),
            "iso": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(now)),
            "model": args.model, "judged": bool(args.judge), "no_llm": bool(args.no_llm),
            "limit": args.limit, **s,
            "ruler": "v1", "run_id": run_id, "mood_id": mood_id, "library_sha": lib_sha,
        })
        for r in rows:
            if r["group"] == "retrieval":
                r["score_mood"] = mood_diag.get(r["probe_id"])
                if v1_routes.get(r["probe_id"]):
                    r["route"] = v1_routes[r["probe_id"]]
            probe_rows.append({"run_id": run_id, "ruler": "v1", "label": s["label"], "at": int(now * 1000),
                               "brain_id": s["brain_id"], "mood_id": mood_id, "library_sha": lib_sha, **r})
    append_jsonl(log_path, log_rows)
    append_jsonl(rows_path, probe_rows)
    print(f"\nappended {len(log_rows)} row(s) to {log_path} (ruler v1, run_id {run_id}); "
          f"{len(probe_rows)} probe row(s) to {rows_path}")


# ====================================================================== v3
GROUP_ORDER = ("artist", "umbrella_family", "leaf", "family_decade", "tempo_family", "vibe")


def check_citations_v3(cited, title_idx, match):
    """Every citation must (1) resolve to a library track by title AND artist
    and (2) satisfy the question's predicate. Returns (n_cited, n_bad, details)."""
    import scorecard as S
    n = bad = 0
    details = []
    for c in cited:
        if not isinstance(c, dict):
            n += 1; bad += 1; details.append(("UNPARSEABLE", str(c)[:60], "")); continue
        ti, ar = S.cite_key(c.get("title")), S.cite_key(c.get("artist"))
        if not ti and not ar:
            continue
        n += 1
        cands = title_idx.get(ti, [])
        if not cands:
            bad += 1; details.append(("FABRICATED", c.get("title"), c.get("artist"))); continue
        if ar:
            def amatch(t):
                keys = {S.cite_key(t.get("artist"))} | {S.cite_key(a) for a in (t.get("contributingArtists") or [])}
                keys.discard("")
                return any(ar == k or (min(len(ar), len(k)) >= 4 and (ar in k or k in ar)) for k in keys)
            cands = [t for t in cands if amatch(t)]
            if not cands:
                bad += 1; details.append(("MISATTRIBUTED", c.get("title"), c.get("artist"))); continue
        if not any(match(t) for t in cands):
            t0 = cands[0]
            bad += 1; details.append(("OFF-PREDICATE", c.get("title"), f"{c.get('artist')} [{t0.get('genre')}, {t0.get('year')}]"))
            continue
        details.append(("ok", c.get("title"), c.get("artist")))
    return n, bad, details


def title_index(tracks):
    import scorecard as S
    idx = {}
    for t in tracks:
        k = S.cite_key(t.get("title"))
        if k:
            idx.setdefault(k, []).append(t)
    return idx


def v3_self_test(tracks, vocab):
    """The v3 grounding check must catch fabrication AND off-predicate citations
    before anything is scored (exit 2 otherwise)."""
    import scorecard as S
    idx = title_index(tracks)
    t = next(t for t in tracks if t.get("title") and t.get("artist") and str(t.get("genre") or "") in vocab.leaf_family)
    leaf = str(t["genre"]).strip()
    other = next(l for l in vocab.leaf_family if l != leaf)
    on, off = S.compile_predicate({"genre_leaf": leaf}, vocab), S.compile_predicate({"genre_leaf": other}, vocab)
    real = [{"title": t["title"], "artist": t["artist"]}]
    fake = [{"title": "Imaginary Song That Cannot Exist 9z9z", "artist": "Nobody At All 9z9z"}]
    checks = [
        (check_citations_v3(fake, idx, on)[1] == 1, "fabricated citation not flagged"),
        (check_citations_v3(real, idx, on)[1] == 0, f"real on-predicate track {t['title']!r} flagged"),
        (check_citations_v3(real, idx, off)[1] == 1, "off-predicate citation not flagged"),
    ]
    for ok, why in checks:
        if not ok:
            print(f"[FATAL] v3 self-test: {why} — the grounding check is broken. STOP.", file=sys.stderr)
            sys.exit(2)
    print(f"[selftest v3] fabricated -> flagged, \"{t['title']}\" on-predicate -> ok, off-predicate -> flagged. OK")


def _mean(xs):
    xs = [x for x in xs if x is not None]
    return round(sum(xs) / len(xs), 4) if xs else None


def group_summary(rows, field):
    groups = {}
    for g in GROUP_ORDER:
        vals = [r[field] for r in rows if r["group"] == g and r.get(field) is not None]
        if vals:
            groups[g] = _mean(vals)
    head = _mean(list(groups.values()))
    return head, groups


def main_v3(args):
    import scorecard as S
    label = args.label or "current"
    run_id = args.run_id or new_run_id(label, "v3")
    vocab = S.load_vocab()
    spec = json.load(open(S.EVAL_V3_PATH, encoding="utf-8"))
    probes, gq = spec["probes"], spec["grounding"]
    if args.limit:
        seen, kept = {}, []
        for p in probes:
            seen[p["group"]] = seen.get(p["group"], 0) + 1
            if seen[p["group"]] <= args.limit:
                kept.append(p)
        probes = kept
        gq = [g for g in gq if g["kind"] == "normal"][:args.limit] + [g for g in gq if g["kind"] == "trap"][:args.limit]

    tracks = S.load_tracks(LIB_PATH)
    rc = S.assert_ruler_fresh(tracks, vocab)
    lib_sha = sha_of(LIB_PATH)
    print(f"[v3] state {STATE_DIR}\n[v3] library {len(tracks)} tracks sha {lib_sha} | ruler check "
          f"{rc['unresolved']}/{rc['tagged']} unresolved ({rc['frac']:.3%}) | probes {len(probes)} | grounding {len(gq)}")
    _, by_id1, titles, artists = load_library()
    self_test(titles, artists, by_id1)
    v3_self_test(tracks, vocab)

    exp = {p["id"]: S.expected_ids(p["expected"], tracks, vocab) for p in probes}
    gexp = {g["id"]: S.expected_ids(g["expected"], tracks, vocab) for g in gq}

    # query vectors: frozen cache first; misses embedded once and parked in tmp/
    qc = S.QvecCache()
    texts = [p["query"] for p in probes] + [g["question"] for g in gq]
    qv = qc.get_many(texts, key("OPENAI_API_KEY"))
    print(f"[v3] query vectors: {qc.cached} frozen/cached, {qc.fresh} embedded fresh")

    ids_m, vecs_m, meta_m = read_embeddings(EMB_PATH)
    brain_id = sha_of(EMB_PATH)
    mood_path = os.path.join(STATE_DIR, "mood-index.bin")
    has_mood = os.path.exists(mood_path)
    ids_x, vecs_x, meta_x = read_embeddings(mood_path) if has_mood else (None, None, {"count": 0})
    mood_id = sha_of(mood_path) if has_mood else None
    audio_path = os.path.join(STATE_DIR, "audio-index.bin")
    audio_id = sha_of(audio_path) if os.path.exists(audio_path) else None
    print(f"[v3] main {brain_id} ({meta_m['count']} vec) | mood {mood_id} ({meta_x['count']} vec) | audio {audio_id}")

    # ---- primary: the production path through the main-branch bridge
    source, bridge_err, main_sha, bstats, bres = None, None, None, None, {}
    if not args.no_bridge:
        try:
            if args.main_src:
                src_dir, main_sha = os.path.abspath(args.main_src), "custom:" + os.path.abspath(args.main_src)
            else:
                src_dir, main_sha = S.extract_main_src(args.main_ref)
            brows, seen = [], set()
            for q, k in [(p["query"], p["k"]) for p in probes] + \
                        ([(g["question"], g.get("k", 14)) for g in gq] if not args.no_llm else []):
                if (q, k) not in seen:
                    seen.add((q, k)); brows.append({"query": q, "k": k})
            t0 = time.time()
            bres, bstats = S.run_bridge(brows, STATE_DIR, src_dir, key("OPENAI_API_KEY"))
            source = "bridge"
            print(f"[v3] bridge OK: {len(bres)} rows in {time.time() - t0:.1f}s, main src {main_sha[:12]}, "
                  f"qvec cached {bstats.get('cached')} fresh {bstats.get('fresh')}")
        except (S.BridgeError, RuntimeError) as e:
            bridge_err = str(e)[:2000]
            print(f"\n[v3] !!! PRODUCTION BRIDGE FAILED — falling back to the Python router port, which has "
                  f"NO reranker / audio fusion / decade gate / lexicon. Primary scores below are NOT the "
                  f"production path.\n[v3] reason: {bridge_err[:600]}\n", file=sys.stderr)
    if source is None:
        source = "py-router"
        qc.reload_overflow()
        artist_set = S.router_artist_set(tracks)

    def primary_hits(q, k):
        if source == "bridge":
            row = bres[(q, k)]
            return row["index"], S.route_mode(row.get("rag"), row["index"]), [int(h["trackId"]) for h in row["hits"]]
        route = S.py_route(q, artist_set, meta_x["count"], meta_m["count"])
        ids, vecs = (ids_x, vecs_x) if (route == "mood" and has_mood) else (ids_m, vecs_m)
        return route, f"py-{route}", S.topk_ids(qv[q], ids, vecs, k)

    now = time.time()
    common = {"run_id": run_id, "ruler": "v3", "label": label, "at": int(now * 1000),
              "brain_id": brain_id, "mood_id": mood_id, "library_sha": lib_sha}
    rows = []
    print(f"\n{'probe':<18}{'group':<16}{'k':>3}{'|exp|':>7}  {'PRIMARY':>7} {'main':>5} {'mood':>5}  route")
    for p in probes:
        e, k, q = exp[p["id"]], p["k"], p["query"]
        if not e:
            print(f"  [skip] {p['id']}: predicate matched 0 library tracks (frozen probe went empty) — NOT scored")
            rows.append({**common, "probe_id": p["id"], "group": p["group"], "k": k, "n_expected": 0,
                         "score": None, "note": "predicate-empty"})
            continue
        route, mode, hits = primary_hits(q, k)
        sp = S.recall_at_k(hits, e, k)
        sm = S.recall_at_k(S.topk_ids(qv[q], ids_m, vecs_m, k), e, k)
        sx = S.recall_at_k(S.topk_ids(qv[q], ids_x, vecs_x, k), e, k) if has_mood else None
        rows.append({**common, "probe_id": p["id"], "group": p["group"], "k": k, "n_expected": len(e),
                     "score": sp, "source": source, "route": route, "mode": mode,
                     "score_main": sm, "score_mood": sx})
        print(f"{p['id']:<18}{p['group']:<16}{k:>3}{len(e):>7}  {sp:>7.2f} {sm:>5.2f} "
              f"{(sx if sx is not None else float('nan')):>5.2f}  {mode}")

    # ---- grounding: 20 questions; a citation must exist AND match the predicate
    grows = []
    if not args.no_llm:
        idx = title_index(tracks)
        by_id = {int(t["id"]): t for t in tracks}
        print()
        for g in gq:
            n_now = len(gexp[g["id"]])
            if g["kind"] == "trap" and n_now:
                print(f"  grd {g['id']} [trap]: INVALID — predicate now matches {n_now} tracks; not scored")
                grows.append({**common, "probe_id": g["id"], "group": "grounding", "kind": "trap",
                              "score": None, "reason": f"trap-invalid ({n_now} matches)"})
                continue
            _, _, hits = primary_hits(g["question"], g.get("k", 14))
            ctx = []
            for tid in hits[:g.get("k", 14)]:
                t = by_id.get(tid)
                if t:
                    ctx.append(f"- \"{t.get('title','?')}\" by {t.get('artist','?')} [{t.get('genre','')}, {t.get('year','')}]")
            raw = claude(GROUND_SYS, "Retrieved library context:\n" + "\n".join(ctx) +
                         f"\n\nUser question: {g['question']}", args.model, max_tokens=500)
            obj = parse_json_obj(raw)
            if obj is None:
                score, reason, cited = 0.0, "unparseable/no-LLM", []
                details = []
            else:
                cited = obj.get("tracks") or []
                match = S.compile_predicate(g["expected"], vocab)
                n, bad, details = check_citations_v3(cited, idx, match)
                if g["kind"] == "trap":
                    score = 1.0 if len(cited) == 0 else 0.0
                    reason = "named nothing (correct)" if score else f"cited {len(cited)} on a trap"
                else:
                    score = 1.0 if (n >= 1 and bad == 0) else 0.0
                    reason = (f"{n} cited, all real + on-predicate" if score else
                              ("no citation" if n == 0 else
                               "; ".join(f"{d[0]}: {d[1]} — {d[2]}" for d in details if d[0] != "ok")[:300]))
            grows.append({**common, "probe_id": g["id"], "group": "grounding", "kind": g["kind"],
                          "score": score, "reason": reason, "cited": len(cited)})
            print(f"  grd {g['id']} [{g['kind']}]: {score:.0f}  ({reason})")

    head, groups = group_summary(rows, "score")
    dm_head, dm_groups = group_summary(rows, "score_main")
    dx_head, dx_groups = group_summary(rows, "score_mood")
    g_scored = [r["score"] for r in grows if r.get("score") is not None]
    grounding = _mean(g_scored)
    routes = {}
    for r in rows:
        if r.get("mode"):
            routes[r["mode"]] = routes.get(r["mode"], 0) + 1

    print("\n" + "=" * 72)
    print(f"{'group':<18}{'n':>4}{'PRIMARY':>10}{'main-idx':>10}{'mood-idx':>10}")
    print("-" * 72)
    for g in GROUP_ORDER:
        n = sum(1 for r in rows if r["group"] == g and r.get("score") is not None)
        print(f"{g:<18}{n:>4}{fmt(groups.get(g)):>10}{fmt(dm_groups.get(g)):>10}{fmt(dx_groups.get(g)):>10}")
    print("-" * 72)
    print(f"{'HEADLINE (mean of group means)':<32}{fmt(head):>10}{fmt(dm_head):>10}{fmt(dx_head):>10}")
    print(f"{'grounding':<32}{fmt(grounding):>10}   ({len(g_scored)} scored)")
    print(f"primary source: {source}" + (f"  (bridge error: {bridge_err[:120]})" if bridge_err else ""))
    print(f"routes: {routes}")
    print("=" * 72)

    summary = {
        "at": int(now * 1000), "iso": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(now)),
        "ruler": "v3", "run_id": run_id, "label": label, "model": args.model, "judged": False,
        "no_llm": bool(args.no_llm), "limit": args.limit,
        "brain_id": brain_id, "mood_id": mood_id, "audio_id": audio_id,
        "vectors": meta_m["count"], "mood_vectors": meta_x["count"], "library_sha": lib_sha,
        "eval_set_sha": sha_of(S.EVAL_V3_PATH), "vocab_sha": sha_of(S.VOCAB_PATH),
        "main_src_sha": main_sha, "primary_source": source, "bridge_error": bridge_err,
        "qvec": {"cached": qc.cached + (bstats or {}).get("cached", 0), "fresh": qc.fresh + (bstats or {}).get("fresh", 0)},
        "headline": head, "groups": groups,
        "n": {g: sum(1 for r in rows if r["group"] == g and r.get("score") is not None) for g in GROUP_ORDER},
        "diag_main": {"headline": dm_head, "groups": dm_groups},
        "diag_mood": {"headline": dx_head, "groups": dx_groups},
        "grounding": grounding, "grounding_n": len(g_scored),
        "routes": routes, "ruler_check": {k: rc[k] for k in ("tagged", "unresolved", "frac")},
    }
    log_path = os.path.join(args.log_dir, "score_log.jsonl")
    rows_path = os.path.join(args.log_dir, "score_rows.jsonl")
    append_jsonl(log_path, [summary])
    append_jsonl(rows_path, rows + grows)
    print(f"\nappended 1 row to {log_path} (ruler v3, run_id {run_id}); {len(rows) + len(grows)} probe rows to {rows_path}")

    if args.freeze_qvec:
        qc.reload_overflow()
        extra = (bstats or {}).get("texts", [])
        n = qc.freeze(texts + list(extra))
        print(f"[v3] froze {n} query vectors into {os.path.relpath(S.QVEC_FROZEN, REPO)}")
    return summary


if __name__ == "__main__":
    main()
