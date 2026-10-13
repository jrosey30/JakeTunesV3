#!/usr/bin/env python3
"""
brain-eval/scorecard.py — shared machinery for scorecard v3.

What lives here (imported by run_eval.py --ruler v3, gen_probes.py, gate.py,
pick_experiment.py and the tests):

  * the VOCAB-RESOLVED ruler: vocab_snapshot.json (exported from the app's
    src/common/genre-vocab.ts + genre-iceberg.ts) and the v3 predicate kinds
    genre_leaf / genre_family / genre_umbrella (exact names through the
    vocab — never substrings) plus year_range, bpm_min, bpm_max, artist;
  * the RULER-STALE guard: if more than 0.5% of the library's genre tags do
    not resolve in the vocab, scoring aborts. A ruler that silently scores
    zeros is how the 10-12 taxonomy night read as a 0.05 "regression";
  * the FROZEN query-vector cache (eval_set_v3.qvec.json): the ruler's query
    texts are embedded once and frozen, so baseline vs candidate — and night
    N vs N+1 — see bit-identical query vectors. Shared on-disk format with
    bridge/rag-bridge.ts;
  * the PRODUCTION-PATH bridge runner (a git-archive of origin/main's src/
    executed through tsx + the electron stub) and the Python router port it
    falls back to when the bridge cannot run.

READ-ONLY on the brain: everything here reads library.json / embeddings.bin /
mood-index.bin; the only writes are brain-eval/tmp/* and, when you ask for
it (--freeze-qvec / export_vocab), the two committed ruler files.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import math
import os
import re
import struct
import subprocess
import sys
import tarfile
import time
import unicodedata
import urllib.error
import urllib.request

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
VOCAB_PATH = os.path.join(HERE, "vocab_snapshot.json")
EVAL_V3_PATH = os.path.join(HERE, "eval_set_v3.json")
QVEC_FROZEN = os.path.join(HERE, "eval_set_v3.qvec.json")
TMP_DIR = os.path.join(HERE, "tmp")
QVEC_OVERFLOW = os.path.join(TMP_DIR, "qvec-overflow.json")
BRIDGE_DIR = os.path.join(HERE, "bridge")
MAIN_SRC_ROOT = os.path.join(BRIDGE_DIR, ".main-src")
EMBED_MODEL = "text-embedding-3-small"
EMBED_DIM = 1536
RULER_STALE_MAX = 0.005          # >0.5% unresolved genre tags = the ruler is stale
RULER_STALE_EXIT = 3

# The live brains. Nothing in brain-eval may write to these (tools refuse).
LIVE_STATE_DIRS = (
    os.path.expanduser("~/Library/Application Support/JakeTunes"),
    "/Volumes/JakeShared/JakeTunesState",
)


# ---------------------------------------------------------------- text keys
def fold(s) -> str:
    """Accent-fold, lowercase, collapse every non-word run to one space.
    Unicode-aware (\\w keeps Hebrew/Cyrillic letters, unlike v1's [a-z0-9])."""
    s = unicodedata.normalize("NFKD", str(s or ""))
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    s = re.sub(r"[^\w]+", " ", s.replace("_", " "))
    return re.sub(r"\s+", " ", s).strip()


def cite_key(s) -> str:
    """Citation key: fold() after dropping (feat ...), [remaster], 'feat. X'."""
    s = re.sub(r"\(.*?\)|\[.*?\]", "", str(s or ""))
    s = re.sub(r"\b(feat|ft|featuring)\b\.?.*$", "", s, flags=re.I)
    return fold(s)


def artist_keys(t) -> set:
    keys = {fold(t.get("artist"))}
    for a in t.get("contributingArtists") or []:
        keys.add(fold(a))
    keys.discard("")
    return keys


def year_of(t):
    try:
        y = int(t.get("year"))
    except (TypeError, ValueError):
        return None
    return y if y > 0 else None


def real_bpm(t):
    """A MEASURED bpm: a finite number > 0. Null/0/strings are 'no bpm'."""
    b = t.get("bpm")
    if isinstance(b, bool) or not isinstance(b, (int, float)):
        return None
    b = float(b)
    return b if math.isfinite(b) and b > 0 else None


def file_sha(path, n=12) -> str:
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:n]


def load_tracks(lib_path):
    d = json.load(open(lib_path, encoding="utf-8"))
    tracks = d["tracks"] if isinstance(d, dict) and "tracks" in d else d
    out = []
    for t in tracks:
        try:
            int(t["id"])
        except Exception:
            continue
        out.append(t)
    return out


# ---------------------------------------------------------------- the vocab
class Vocab:
    """leaf -> family (genre-vocab 'area') -> umbrella (genre-iceberg)."""

    def __init__(self, d):
        self.meta = d.get("_meta", {})
        self.leaf_family = {k: v["family"] for k, v in d["leaves"].items()}
        self.leaf_umbrella = {k: v.get("umbrella") for k, v in d["leaves"].items()}
        self.families = {k: list(v["leaves"]) for k, v in d["families"].items()}
        self.family_umbrella = {k: v.get("umbrella") for k, v in d["families"].items()}
        self.umbrellas = {k: list(v["families"]) for k, v in d["umbrellas"].items()}
        self.catch_all = set(d.get("catch_all", []))

    def umbrella_leaves(self, u):
        out = []
        for f in self.umbrellas[u]:
            out.extend(self.families[f])
        return out


def load_vocab(path=VOCAB_PATH) -> Vocab:
    if not os.path.exists(path):
        raise SystemExit(f"[fatal] {path} missing — run export_vocab.py first")
    return Vocab(json.load(open(path, encoding="utf-8")))


def ruler_check(tracks, vocab, max_frac=RULER_STALE_MAX):
    """Fraction of library genre tags the vocab can't resolve. Tracks with no
    genre carry no tag and are reported, not counted."""
    tagged = [str(t.get("genre") or "").strip() for t in tracks]
    untagged = sum(1 for g in tagged if not g)
    tagged = [g for g in tagged if g]
    bad = [g for g in tagged if g not in vocab.leaf_family]
    frac = len(bad) / max(1, len(tagged))
    top = {}
    for g in bad:
        top[g] = top.get(g, 0) + 1
    return {
        "tagged": len(tagged), "untagged": untagged, "unresolved": len(bad),
        "frac": round(frac, 6), "max_frac": max_frac, "stale": frac > max_frac,
        "top_unresolved": sorted(top.items(), key=lambda kv: -kv[1])[:10],
    }


def assert_ruler_fresh(tracks, vocab, max_frac=RULER_STALE_MAX):
    rc = ruler_check(tracks, vocab, max_frac)
    if rc["stale"]:
        print(f"[FATAL] RULER STALE: {rc['unresolved']}/{rc['tagged']} library genre tags "
              f"({rc['frac']:.2%}) don't resolve in vocab_snapshot.json (limit {max_frac:.1%}). "
              f"Top unresolved: {rc['top_unresolved']}. Re-export the vocab (export_vocab.py) "
              f"and regenerate the probes before scoring — never score a stale ruler.",
              file=sys.stderr)
        sys.exit(RULER_STALE_EXIT)
    return rc


# ---------------------------------------------------------------- predicates
GENRE_KEYS = ("genre_leaf", "genre_family", "genre_umbrella")
PRED_KEYS = set(GENRE_KEYS) | {"year_range", "bpm_min", "bpm_max", "artist"}


def _as_list(v):
    return [v] if isinstance(v, str) else list(v)


def predicate_leaves(pred, vocab):
    """The exact vocab leaves a predicate's genre clause admits (None = no
    genre clause). Unknown names are a hard error — a probe naming a genre
    the vocab doesn't have is a broken ruler, not a zero."""
    if not any(k in pred for k in GENRE_KEYS):
        return None
    leaves = set()
    for name in _as_list(pred.get("genre_leaf", [])):
        if name not in vocab.leaf_family:
            raise ValueError(f"genre_leaf {name!r} is not in the vocab")
        leaves.add(name)
    for name in _as_list(pred.get("genre_family", [])):
        if name not in vocab.families:
            raise ValueError(f"genre_family {name!r} is not in the vocab")
        leaves.update(vocab.families[name])
    for name in _as_list(pred.get("genre_umbrella", [])):
        if name not in vocab.umbrellas:
            raise ValueError(f"genre_umbrella {name!r} is not in the vocab")
        leaves.update(vocab.umbrella_leaves(name))
    return leaves


def compile_predicate(pred, vocab):
    """v3 predicate -> match(track) -> bool.

    Semantics: the genre clause is the UNION of every genre_leaf /
    genre_family / genre_umbrella named (a track's genre tag must be one of
    those exact leaves); every other clause is ANDed onto it.
      year_range [a, b]  inclusive, a missing year never matches
      bpm_min / bpm_max  MEASURED bpm only (finite, > 0) — no bpm never matches
      artist             exact folded name vs the track's artist or any of its
                         contributingArtists ("Eminem" matches "Eminem & Dr. Dre")
    """
    unknown = set(pred) - PRED_KEYS
    if unknown:
        raise ValueError(f"unknown predicate keys {sorted(unknown)} (v3 knows {sorted(PRED_KEYS)})")
    leaves = predicate_leaves(pred, vocab)
    yr = pred.get("year_range")
    bmin, bmax = pred.get("bpm_min"), pred.get("bpm_max")
    artist = fold(pred["artist"]) if "artist" in pred else None
    if "artist" in pred and not artist:
        raise ValueError("artist predicate folds to empty")

    def match(t):
        if leaves is not None and str(t.get("genre") or "").strip() not in leaves:
            return False
        if yr is not None:
            y = year_of(t)
            if y is None or not (yr[0] <= y <= yr[1]):
                return False
        if bmin is not None or bmax is not None:
            b = real_bpm(t)
            if b is None:
                return False
            if bmin is not None and b < bmin:
                return False
            if bmax is not None and b > bmax:
                return False
        if artist is not None and artist not in artist_keys(t):
            return False
        return True

    return match


def expected_ids(pred, tracks, vocab) -> set:
    m = compile_predicate(pred, vocab)
    return {int(t["id"]) for t in tracks if m(t)}


# ---------------------------------------------------------------- embeddings
def read_embeddings(path):
    """EMBD | u16 ver | u16 dim | u32 count | count × ([u32 id][dim f32]).
    Same reader as run_eval.read_embeddings (L2-normalized copy)."""
    with open(path, "rb") as f:
        blob = f.read()
    if blob[0:4] != b"EMBD":
        raise SystemExit(f"[fatal] {path}: bad magic {blob[0:4]!r}")
    dim = struct.unpack_from("<H", blob, 6)[0]
    count = struct.unpack_from("<I", blob, 8)[0]
    if dim != EMBED_DIM:
        raise SystemExit(f"[fatal] {path}: dim {dim} != {EMBED_DIM}")
    rec = 4 + dim * 4
    if len(blob) < 12 + count * rec:
        raise SystemExit(f"[fatal] {path}: truncated ({len(blob)} B < {12 + count * rec})")
    arr = np.frombuffer(blob[12:12 + count * rec], dtype=np.uint8).reshape(count, rec)
    ids = arr[:, :4].copy().view(np.uint32).reshape(count)
    vecs = arr[:, 4:].copy().view(np.float32).reshape(count, dim).astype(np.float32)
    n = np.linalg.norm(vecs, axis=1, keepdims=True)
    n[n == 0] = 1.0
    return ids, vecs / n


def topk_ids(qvec, ids, vecs, k):
    # numpy 2 + macOS Accelerate raises spurious FP flags on float32 matmul;
    # the scores are fine — assert finiteness instead of trusting the flags.
    with np.errstate(all="ignore"):
        scores = vecs @ qvec
    if not np.isfinite(scores).all():
        raise SystemExit("[fatal] non-finite cosine scores — corrupt vectors?")
    k = min(k, len(scores))
    idx = np.argpartition(-scores, k - 1)[:k]
    idx = idx[np.argsort(-scores[idx], kind="stable")]
    return [int(ids[i]) for i in idx]


def recall_at_k(topk, expected, k):
    """|topk[:k] ∩ expected| / min(k, |expected|) — the v1 formula, unchanged."""
    if not expected:
        return None
    return len(set(topk[:k]) & expected) / min(k, len(expected))


# ---------------------------------------------------------------- query-vector cache
def qvec_key(text, model=EMBED_MODEL) -> str:
    return hashlib.sha1(f"{model}\n{text}".encode("utf-8")).hexdigest()


def _b64_to_vec(b64):
    return np.frombuffer(base64.b64decode(b64), dtype="<f4").astype(np.float32)


def _vec_to_b64(v):
    return base64.b64encode(np.asarray(v, dtype="<f4").tobytes()).decode("ascii")


def openai_embed_raw(texts, api_key):
    """RAW (un-normalized) float32 vectors, exactly as production stores them."""
    if not api_key:
        raise SystemExit("[fatal] OPENAI_API_KEY missing in .env — query embeds need it.")
    out = []
    for i in range(0, len(texts), 100):
        chunk = texts[i:i + 100]
        payload = json.dumps({"model": EMBED_MODEL, "input": chunk}).encode()
        req = urllib.request.Request(
            "https://api.openai.com/v1/embeddings", data=payload,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"})
        for attempt in range(3):
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    data = json.loads(r.read())
                rows = sorted(data["data"], key=lambda d: d["index"])
                out.extend(np.asarray(d["embedding"], dtype=np.float32) for d in rows)
                break
            except urllib.error.HTTPError as e:
                if attempt == 2:
                    raise SystemExit(f"[fatal] OpenAI embed failed: {e.code}")
                time.sleep(1.5 * (attempt + 1))
    return out


class QvecCache:
    """Frozen (committed) + overflow (tmp/) query vectors, keyed by
    sha1(model + '\\n' + text). Same file format as bridge/rag-bridge.ts."""

    def __init__(self, frozen_path=QVEC_FROZEN, overflow_path=QVEC_OVERFLOW):
        self.frozen_path, self.overflow_path = frozen_path, overflow_path
        self.frozen = self._load(frozen_path)
        self.overflow = self._load(overflow_path)
        self.fresh = 0
        self.cached = 0

    @staticmethod
    def _load(path):
        if path and os.path.exists(path):
            return json.load(open(path, encoding="utf-8")).get("vectors", {})
        return {}

    def reload_overflow(self):
        self.overflow = self._load(self.overflow_path)

    def lookup(self, text):
        return self.frozen.get(qvec_key(text)) or self.overflow.get(qvec_key(text))

    def get_many(self, texts, api_key):
        """Normalized float32 query vectors; misses are embedded and parked in
        the overflow file (never in the frozen one — that needs --freeze-qvec)."""
        missing = [t for t in dict.fromkeys(texts) if not self.lookup(t)]
        if missing:
            for t, v in zip(missing, openai_embed_raw(missing, api_key)):
                self.overflow[qvec_key(t)] = {"text": t, "b64": _vec_to_b64(v)}
            self.fresh += len(missing)
            self.save_overflow()
        self.cached += len(texts) - len(missing)
        out = {}
        for t in texts:
            v = _b64_to_vec(self.lookup(t)["b64"])
            n = float(np.linalg.norm(v)) or 1.0
            out[t] = v / n
        return out

    @staticmethod
    def _write(path, vectors):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"model": EMBED_MODEL, "dim": EMBED_DIM,
                       "vectors": {k: vectors[k] for k in sorted(vectors)}}, f, indent=0)
        os.replace(tmp, path)

    def save_overflow(self):
        self._write(self.overflow_path, self.overflow)

    def freeze(self, texts):
        """Rewrite the frozen file to hold exactly `texts` (the ruler's)."""
        keep = {}
        for t in dict.fromkeys(texts):
            hit = self.lookup(t)
            if not hit:
                raise SystemExit(f"[fatal] freeze: no vector for {t!r}")
            keep[qvec_key(t)] = {"text": t, "b64": hit["b64"]}
        self._write(self.frozen_path, keep)
        self.frozen = keep
        return len(keep)


# ---------------------------------------------------------------- main-branch source
def git(*args, check=True):
    r = subprocess.run(["git", "-C", REPO, *args], capture_output=True)
    if check and r.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)}: {r.stderr.decode(errors='replace')[:300]}")
    return r.stdout


def extract_main_src(ref="origin/main"):
    """`git archive <ref> src` into bridge/.main-src/<sha12>/ (once per sha).
    No checkout, no working-tree change: reads git objects only. Lives under
    bridge/ so node's resolver walks up to the electron stub."""
    sha = git("rev-parse", ref).decode().strip()
    dest = os.path.join(MAIN_SRC_ROOT, sha[:12])
    probe = os.path.join(dest, "src", "main", "ai", "rag-retrieval.ts")
    if not os.path.exists(probe):
        blob = git("archive", "--format=tar", ref, "src")
        os.makedirs(dest, exist_ok=True)
        with tarfile.open(fileobj=io.BytesIO(blob)) as tf:
            for m in tf.getmembers():
                p = os.path.normpath(m.name)
                if p.startswith("..") or os.path.isabs(p) or m.issym() or m.islnk():
                    raise SystemExit(f"[fatal] refusing odd tar member {m.name!r}")
            tf.extractall(dest)
    if not os.path.exists(probe):
        raise RuntimeError(f"{ref} has no src/main/ai/rag-retrieval.ts")
    return dest, sha


def git_show(ref, path) -> str:
    return git("show", f"{ref}:{path}").decode("utf-8")


# ---------------------------------------------------------------- production bridge
class BridgeError(RuntimeError):
    pass


def tsx_command():
    """JT_TSX overrides (e.g. 'node /path/to/tsx/dist/cli.mjs'); default npx."""
    return (os.environ.get("JT_TSX") or "npx --yes tsx").split()


def run_bridge(rows, state_dir, main_src, api_key, timeout=900, script="rag-bridge.ts", extra_env=None):
    """rows: [{query, k}]. Returns ({(query, k): row}, stats). Raises
    BridgeError with the reason when the bridge can't run cleanly — the caller
    falls back LOUDLY, never silently."""
    os.makedirs(TMP_DIR, exist_ok=True)
    qpath = os.path.join(TMP_DIR, f"bridge-rows-{os.getpid()}.json")
    with open(qpath, "w", encoding="utf-8") as f:
        json.dump(rows, f)
    env = dict(os.environ)
    env.update({"JT_STATE_DIR": state_dir, "JT_MAIN_SRC": main_src,
                "JT_QVEC_FROZEN": QVEC_FROZEN, "JT_QVEC_OVERFLOW": QVEC_OVERFLOW,
                "OPENAI_API_KEY": api_key})
    env.update(extra_env or {})
    cmd = tsx_command() + [os.path.join(BRIDGE_DIR, script), qpath, "25"]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=BRIDGE_DIR, env=env)
    except Exception as e:  # noqa: BLE001 — any launch failure is a bridge failure
        raise BridgeError(f"launch failed: {e}")
    finally:
        try:
            os.remove(qpath)
        except OSError:
            pass
    if r.returncode != 0:
        raise BridgeError(f"exit {r.returncode}: {r.stderr[-1200:]}")
    out, stats = {}, None
    for line in r.stdout.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        row = json.loads(line)
        if "_stats" in row:
            stats = row["_stats"]
        elif "query" in row and "hits" in row:
            out[(row["query"], int(row["k"]))] = row
    missing = [r_ for r_ in rows if (r_["query"], int(r_["k"])) not in out]
    if missing or stats is None:
        raise BridgeError(f"{len(missing)} row(s) came back empty; stats={stats}; stderr tail: {r.stderr[-600:]}")
    return out, stats


def route_mode(rag_lines, index):
    """What the production path actually did for one query, from its [rag] lines."""
    txt = " ".join(rag_lines or [])
    if "route=fusion" in txt:
        mode = "fusion"
    elif "route=audio" in txt:
        mode = "audio"
    else:
        mode = index or "?"
    if "decade hard-gate" in txt:
        mode += "+decade"
    if "lexicon" in txt:
        mode += "+lexicon"
    return mode


# ---------------------------------------------------------------- python router (fallback only)
DECADE_QUERY_RE = re.compile(
    r"\b(19|20)\d{2}s?\b|(^|\D)['’]?[1-9]0s\b|"
    r"\b(fifties|sixties|seventies|eighties|nineties|noughties|aughts|2000s)\b", re.I)
GENRE_WORD_ARTISTS = {
    "house", "dance", "funk", "soul", "punk", "metal", "grunge", "jazz", "blues",
    "rock", "pop", "disco", "techno", "ambient", "folk", "country", "rap",
    "reggae", "ska", "indie", "emo", "hardcore", "trance", "garage", "gospel"}


def router_artist_set(tracks):
    """Port of rag-route.ts routeArtistKey over artist + albumArtist."""
    out = set()
    for t in tracks:
        for a in (t.get("artist"), t.get("albumArtist")):
            k = fold(a)
            if len(k) >= 4 and k not in GENRE_WORD_ARTISTS:
                out.add(k)
    return out


def py_route(query, artist_set, mood_count, main_count):
    """FALLBACK ONLY — the Python port of pickRetrievalIndex. It has no
    reranker, no audio fusion, no decade hard-gate and no subgenre lexicon, so
    it is NOT the production path; rows scored this way say so."""
    if DECADE_QUERY_RE.search(query):
        return "main"
    q = f" {fold(query)} "
    for a in artist_set:
        if f" {a} " in q:
            return "main"
    return "mood" if (mood_count > 0 and mood_count >= main_count * 0.5) else "main"


# ---------------------------------------------------------------- brain-file facts (queue preconditions)
def embd_ids(path):
    """Track ids in an EMBD file, without loading the vectors' floats."""
    with open(path, "rb") as f:
        head = f.read(12)
        if head[0:4] != b"EMBD":
            raise SystemExit(f"[fatal] {path}: bad magic")
        dim = struct.unpack_from("<H", head, 6)[0]
        count = struct.unpack_from("<I", head, 8)[0]
        blob = f.read(count * (4 + dim * 4))
    rec = 4 + dim * 4
    if len(blob) < count * rec:
        raise SystemExit(f"[fatal] {path}: truncated")
    arr = np.frombuffer(blob, dtype=np.uint8).reshape(count, rec)
    return [int(x) for x in arr[:, :4].copy().view("<u4").reshape(count)]


def load_descriptors(state_dir):
    p = os.path.join(state_dir, "brain-descriptors.json")
    return json.load(open(p, encoding="utf-8")) if os.path.exists(p) else {}


def bare_mood_ids(state_dir):
    """In-library tracks that HAVE a mood vector but NO Gemma descriptor — their
    mood text was tempo + genre only ("bare"). Measured harmful on 10-12
    (ret-007 mood 0.44 with 14/25 bare slots)."""
    lib = {int(t["id"]) for t in load_tracks(os.path.join(state_dir, "library.json"))}
    desc = load_descriptors(state_dir)
    mood = embd_ids(os.path.join(state_dir, "mood-index.bin"))
    return sorted(i for i in mood if i in lib and not str((desc.get(str(i)) or {}).get("d") or "").strip())


def refuse_live_dir(state_dir):
    """Scratch-only tools call this first: never write a live brain."""
    real = os.path.realpath(state_dir)
    for live in LIVE_STATE_DIRS:
        if os.path.exists(live) and os.path.realpath(live) == real:
            raise SystemExit(f"[fatal] {state_dir} is a LIVE brain dir — scratch copies only")
    return real
