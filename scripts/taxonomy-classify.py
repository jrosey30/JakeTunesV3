#!/usr/bin/env python3
"""Nightly taxonomy classifier — keeps the AI brain a connoisseur as the library
grows. Assigns a subgenre to any library track that doesn't have one yet, writing
it (additively) into metadata-overrides.json. The subgenre then folds into the
track's embedding via brain-trainer.mjs baseText()/subgenreText() on the
--reembed-all this script triggers after a successful write.

PIPELINE (mirrors /tmp/classify_all.py, now durable + delta + self-writing):
  embeddings shortlist 6 candidate shelves per song (punk-tagged locked to the
  Punk subtree, grunge to Grunge) -> Sonnet picks the single most precise shelf +
  names the runner-up "lean" -> hard post-check re-locks punk/grunge.

SAFE-WRITE (metadata-overrides.json is the app's file):
  - gated on the app being QUIT — a running JakeTunes clobbers external override
    writes on its next play-event save (see reference_jaketunes_metadata_overrides_apply);
  - durable assignment cache (taxonomy-assignments.json) so a deferred write never
    re-burns Sonnet on the same tracks;
  - keeps each track's existing accepted fp (only computes fp for brand-new entries:
    fp = `${title.toLowerCase().trim()}|${artist.toLowerCase().trim()}|${duration||0}`,
    matching App.tsx:714 — duration is ms);
  - backup + atomic replace + size/parse/count verify before going live.

Usage: python3 taxonomy-classify.py [--dry-run]
  --dry-run classifies + stages but writes ONLY a /tmp preview, never the live file.
"""
import json, os, struct, time, sys, subprocess, shutil
import numpy as np
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
import urllib.request

DRY  = '--dry-run' in sys.argv
SD   = os.path.expanduser('~/Library/Application Support/JakeTunes')
HERE = os.path.dirname(os.path.abspath(__file__))
TAX  = os.path.join(HERE, 'taxonomy.json')
OVP  = os.path.join(SD, 'metadata-overrides.json')
CACHE = os.path.join(SD, 'taxonomy-assignments.json')   # durable classify memory (desktop-only, not synced)
ENVP = os.path.expanduser('~/JakeTunesV3/.env')
EMB  = os.path.join(SD, 'embeddings.bin')

def log(*a): print('[taxonomy-classify]', *a, flush=True)

def app_running():
    try:
        r = subprocess.run(['pgrep', '-f', 'JakeTunes.app/Contents/MacOS/JakeTunes'],
                           capture_output=True)
        return r.returncode == 0
    except Exception:
        return False

lib = json.load(open(SD + '/library.json')); tracks = lib['tracks'] if isinstance(lib, dict) else lib
try: desc = json.load(open(SD + '/brain-descriptors.json'))
except Exception: desc = {}
tax = json.load(open(TAX))['taxonomy']
ov  = json.load(open(OVP)) if os.path.exists(OVP) else {}
cache = json.load(open(CACHE)) if os.path.exists(CACHE) else {}

# --- embeddings.bin (same binary format the desktop/trainer produce) ---
buf = open(EMB, 'rb').read()
dim = struct.unpack('<H', buf[6:8])[0]; cnt = struct.unpack('<I', buf[8:12])[0]; rec = 4 + dim * 4
id2vec = {}; off = 12
for _ in range(cnt):
    if off + rec > len(buf): break
    tid = struct.unpack('<I', buf[off:off + 4])[0]
    id2vec[tid] = np.frombuffer(buf, dtype='<f4', count=dim, offset=off + 4).copy(); off += rec

def aname(t): return (t.get('albumArtist') or t.get('artist') or '').strip()
artist_vecs = defaultdict(list)
for t in tracks:
    v = id2vec.get(int(t.get('id', -1)))
    if v is not None and aname(t): artist_vecs[aname(t).lower()].append(v)

# leaf shelf centroids from anchor artists
leaves = []
def walk(node, path):
    p = path + [node['name']]
    if node.get('children'):
        for c in node['children']: walk(c, p)
    else:
        vs = [v for a in node.get('anchors', []) for v in artist_vecs.get(a.strip().lower(), [])]
        if vs:
            c = np.mean(vs, axis=0); leaves.append((" › ".join(p), c / (np.linalg.norm(c) + 1e-9)))
for r in tax: walk(r, [])
paths = [p for p, _ in leaves]
L = np.array([c for _, c in leaves], dtype='f4')
log(f"{len(leaves)} shelf-centroids")

def has_subgenre(tid):
    e = ov.get(str(tid))
    return bool(e and (e.get('fields') or {}).get('subgenre'))

# delta: classifiable (has embedding) + no subgenre override + not already cached
todo = [t for t in tracks
        if id2vec.get(int(t.get('id', -1))) is not None
        and not has_subgenre(t.get('id'))
        and str(t.get('id')) not in cache]
log(f"{len(tracks)} tracks | {len(cache)} cached | {len(todo)} to classify")

key = ''
for line in open(ENVP):
    if line.startswith('ANTHROPIC_API_KEY='): key = line.split('=', 1)[1].strip().strip('"\'')

def cands_for(t):
    v = id2vec[int(t['id'])]
    tag = (t.get('genre') or '').lower()
    force = 'punk' if 'punk' in tag else ('grunge' if 'grunge' in tag else None)
    if force:
        ci = [j for j, pp in enumerate(paths) if force in pp.lower()]
        top = sorted(ci, key=lambda j: -float(L[j] @ v))[:6] if ci else list(map(int, np.argsort(-(L @ v))[:6]))
    else:
        top = list(map(int, np.argsort(-(L @ v))[:6]))
    return top, force

def classify_batch(batch):
    lines = []; meta = {}
    for i, t in enumerate(batch):
        top, force = cands_for(t); meta[i + 1] = (t, [paths[j] for j in top], force)
        d = desc.get(str(t['id'])); dt = (d.get('d') if isinstance(d, dict) else d) if d else ''
        sound = f" | sound: {dt[:110]}" if dt else ""
        cands = " // ".join(paths[j] for j in top)
        lines.append(f"{i+1}. {aname(t)} — {t.get('title','')} | tag:{t.get('genre','?')} | {t.get('bpm') or '?'}bpm{sound}\n   candidates: {cands}")
    prompt = """Music genre connoisseur. For each song pick the SINGLE most precise shelf from ITS candidate shelves (shortlisted by sound). Judge the MUSIC; 'tag' is a vague user label. Name the runner-up "lean" (close second leaf). If none fit, pick the closest.
STRICT JSON only: [{"n":1,"path":"<chosen candidate path verbatim>","lean":"<leaf name>"}]
SONGS:
""" + "\n".join(lines)
    for attempt in range(4):
        try:
            req = urllib.request.Request("https://api.anthropic.com/v1/messages",
                data=json.dumps({"model": "claude-sonnet-4-6", "max_tokens": 8000,
                                 "messages": [{"role": "user", "content": prompt}]}).encode(),
                headers={"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"})
            out = json.load(urllib.request.urlopen(req, timeout=220))['content'][0]['text']
            picks = json.loads(out[out.index('['):out.rindex(']') + 1])
            res = {}
            for p in picks:
                n = p.get('n'); t, cl, force = meta.get(n, (None, [], None))
                if not t: continue
                path = p.get('path', '') or (cl[0] if cl else '')
                if force and force not in path.lower(): path = cl[0] if cl else path
                parts = path.split(' › ')
                res[str(t['id'])] = {"path": path,
                                     "subgenre": parts[1] if len(parts) > 1 else (parts[0] if parts else ''),
                                     "leaf": parts[-1] if parts else '', "lean": p.get('lean', '')}
            return res
        except Exception as e:
            log(f"  batch retry: {e}"); time.sleep(4)
    return {}

if todo:
    B = 40
    batches = [todo[i:i + B] for i in range(0, len(todo), B)]
    log(f"{len(batches)} batch(es) of {B}, up to 10 parallel")
    with ThreadPoolExecutor(max_workers=10) as ex:
        for f in as_completed([ex.submit(classify_batch, b) for b in batches]):
            cache.update(f.result())
    json.dump(cache, open(CACHE + '.tmp', 'w')); os.replace(CACHE + '.tmp', CACHE)
    log(f"classified -> cache now {len(cache)}")

# --- stage subgenres for any cached track that still lacks a subgenre override ---
byid = {str(t.get('id')): t for t in tracks}
def fp_of(t):
    return f"{(t.get('title') or '').lower().strip()}|{(t.get('artist') or '').lower().strip()}|{t.get('duration') or 0}"
staged = 0
for tid, a in cache.items():
    t = byid.get(tid)
    if not t or has_subgenre(tid) or not a.get('subgenre'): continue
    e = ov.get(tid) or {}
    fields = dict(e.get('fields') or {})
    fields['subgenre'] = a['subgenre']
    fields['subgenrePath'] = a.get('path') or a['subgenre']
    if a.get('lean'): fields['subgenreLean'] = a['lean']
    ov[tid] = {'fp': (e.get('fp') or fp_of(t)), 'fields': fields}   # keep accepted fp; compute only for new entries
    staged += 1

if staged == 0:
    log("library fully classified — nothing to write."); sys.exit(0)
log(f"{staged} track(s) staged for an additive subgenre write")

if DRY:
    json.dump(ov, open('/tmp/overrides-preview.json', 'w'))
    log(f"DRY-RUN: preview at /tmp/overrides-preview.json (live file untouched)"); sys.exit(0)

if app_running():
    log(f"JakeTunes is RUNNING — deferring write of {staged} subgenre(s) to a run when it's quit "
        f"(a live app clobbers external override writes). Classifications are cached; will write next eligible run.")
    sys.exit(0)

# safe write: backup -> atomic replace -> verify (parse + count + size guard).
# indent=2 matches the app's own on-disk format — the app pretty-prints this
# file, so a compact json.dump() of identical data reads as an ~16% "shrink"
# and false-trips the size guard below even though the count check already
# proved nothing was lost. Matching format keeps the size check meaningful.
shutil.copy(OVP, OVP + '.bak-classify')
old_size = os.path.getsize(OVP)
tmp = OVP + '.classify.tmp'
json.dump(ov, open(tmp, 'w'), indent=2)
chk = json.load(open(tmp))                      # parses?
assert len(chk) == len(ov), f"verify: count {len(chk)} != {len(ov)}"
assert os.path.getsize(tmp) >= old_size * 0.95, "verify: file shrank unexpectedly"
os.replace(tmp, OVP)
log(f"wrote {staged} subgenre(s) into metadata-overrides.json (backup .bak-classify)")

# fold the new subgenres into embeddings via the existing (subgenre-aware) re-embed
log("re-embedding so the new subgenres land in the brain...")
node_bin = shutil.which('node') or '/opt/homebrew/bin/node'   # launchd PATH can be sparse
r = subprocess.run([node_bin, os.path.join(HERE, 'brain-trainer.mjs'), '--reembed-all'],
                   capture_output=True, text=True)
sys.stdout.write(r.stdout[-400:]); sys.stderr.write(r.stderr[-400:])
log("done." if r.returncode == 0 else f"re-embed exited {r.returncode} (subgenres still written; next nightly trainer will fold them)")
