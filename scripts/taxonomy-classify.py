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

Brief 182: the write path re-reads metadata-overrides.json from disk and
merges additively at write time (a concurrent override written during the
minutes-long classify is never lost), re-checks app_running() immediately
before os.replace, keeps 5 rotated .bak-classify generations, and when the
app is running at write time leaves taxonomy-deferred.json {at,
pendingCount} beside the overrides + exits 3 (deferred) instead of the old
silent exit 0 — silent deferral ends. Dry-run writes ONLY its /tmp preview:
no deferred file, no backup rotation, no live writes.
Exit codes: 0 = written / handed to the app / fully classified / dry-run;
3 = deferred (the app started mid-write, or the hand-off file could not be written).

2026-10-19 (taste-engine repairs): the app is open around the clock, so the
deferral above became permanent — 104 of 110 nights deferred, nothing written
after 2026-09-06, 1,220 songs waiting. When the app is running the script now
HANDS the staged subgenres to it: `taxonomy-staged.json` beside the overrides,
which the app folds in through its own serialized writer within ~5 minutes
(src/main/taxonomy-staged.ts — ⚠️ TWIN of merge_staged below). The overrides
file keeps one writer. The quit-app direct write is unchanged.

The --reembed-all that used to follow a write is gone: the main brain is
plain since 2026-10-10 (no subgenre line — PR #66) and homemini owns and
rebuilds it; this laptop re-embed only rewrote a local copy that brain-pull
replaces from the NAS.
"""
import json, os, re, struct, time, sys, subprocess, shutil, datetime
import numpy as np
from collections import defaultdict, Counter
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

# --- candidate-augment context (2026-07-01, the Matchbox Twenty bug) --------
# The embedding top-6 shortlist can miss a track's obvious home shelf entirely
# ("If You're Gone": 4 siblings in Rock › Alternative, yet no Alternative shelf
# was ever offered — Sonnet picked the least-wrong of six wrong options). Two
# soft hints fix the MENU without forcing the pick; Sonnet still judges:
#   (a) tag-hint — best shelves whose path mentions the track's raw genre tag
#   (b) artist-home — shelves where this artist's other classified tracks live
byid = {str(t.get('id')): t for t in tracks}
artist_home = defaultdict(Counter)   # artist(lower) -> Counter{subgenrePath}
for _k, _v in ov.items():
    _f = (_v or {}).get('fields') or {}
    _p = _f.get('subgenrePath')
    _t = byid.get(_k)
    if _p and _t and aname(_t): artist_home[aname(_t).lower()][_p] += 1
path_idx = {p: j for j, p in enumerate(paths)}

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
        return top, force
    top = list(map(int, np.argsort(-(L @ v))[:6]))
    extra = []
    if tag:   # (a) tag-hint: whole tag first, else its words (>=4 chars)
        ti = [j for j, pp in enumerate(paths) if tag in pp.lower()]
        if not ti:
            words = [w for w in re.split(r'[^a-z]+', tag) if len(w) >= 4]
            ti = [j for j, pp in enumerate(paths) if any(w in pp.lower() for w in words)]
        extra += sorted(ti, key=lambda j: -float(L[j] @ v))[:2]
    home = artist_home.get(aname(t).lower())   # (b) artist-home top-2 shelves
    if home:
        extra += [path_idx[p] for p, _ in home.most_common(2) if p in path_idx]
    aug = list(top)
    for j in extra:
        if j not in aug: aug.append(j)
    return aug[:10], force

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
def fp_of(t):
    return f"{(t.get('title') or '').lower().strip()}|{(t.get('artist') or '').lower().strip()}|{t.get('duration') or 0}"

def has_subgenre_in(ovmap, tid):
    e = ovmap.get(str(tid))
    return bool(e and (e.get('fields') or {}).get('subgenre'))

def merge_staged(ovmap, cachemap, byidmap):
    """Brief 182: apply the staged additive subgenre writes onto `ovmap`
    (the overrides AS THEY ARE ON DISK at write time — not the copy loaded
    when this run started). The discipline is the script's existing one,
    preserved exactly: only add subgenre/subgenrePath/subgenreLean where a
    subgenre is still absent; preserve every existing field and each
    entry's accepted fp (compute fp only for brand-new entries). Anything
    another writer changed since load survives, because nothing here ever
    overwrites an existing field. Returns the number staged."""
    staged = 0
    for tid, a in cachemap.items():
        t = byidmap.get(tid)
        if not t or has_subgenre_in(ovmap, tid) or not a.get('subgenre'): continue
        e = ovmap.get(tid) or {}
        fields = dict(e.get('fields') or {})
        fields['subgenre'] = a['subgenre']
        fields['subgenrePath'] = a.get('path') or a['subgenre']
        if a.get('lean'): fields['subgenreLean'] = a['lean']
        ovmap[tid] = {'fp': (e.get('fp') or fp_of(t)), 'fields': fields}   # keep accepted fp; compute only for new entries
        staged += 1
    return staged

DEFERRED = os.path.join(SD, 'taxonomy-deferred.json')
BACKUP_GENERATIONS = 5

def write_deferred(pending):
    """Brief 182: deferral becomes a visible state, not a log line nobody
    reads — {at, pendingCount} beside the overrides, for Brief 178/183
    surfacing. Best-effort: a failed marker write must not mask the defer."""
    try:
        tmp = DEFERRED + '.tmp'
        json.dump({'at': datetime.datetime.now().isoformat(timespec='seconds'), 'pendingCount': pending},
                  open(tmp, 'w'))
        os.replace(tmp, DEFERRED)
    except Exception as e:
        log(f"could not write deferred marker: {e}")

def clear_deferred():
    try:
        if os.path.exists(DEFERRED): os.remove(DEFERRED)
    except Exception:
        pass

def rotate_backups():
    """Keep several .bak-classify generations (Brief 182) instead of one
    overwritten backup: .bak-classify.1 is newest … .5 oldest."""
    for i in range(BACKUP_GENERATIONS - 1, 0, -1):
        src = OVP + f'.bak-classify.{i}'
        if os.path.exists(src): os.replace(src, OVP + f'.bak-classify.{i + 1}')
    if os.path.exists(OVP + '.bak-classify'):
        os.replace(OVP + '.bak-classify', OVP + '.bak-classify.1')
    shutil.copy(OVP, OVP + '.bak-classify')

# First pass against the load-time copy — only to know whether there is
# anything to write at all (the authoritative merge happens at write time).
_preview = {k: (dict(v) if isinstance(v, dict) else v) for k, v in ov.items()}
staged_preview = merge_staged(_preview, cache, byid)

if staged_preview == 0:
    log("library fully classified — nothing to write."); sys.exit(0)
log(f"{staged_preview} track(s) staged for an additive subgenre write")

if DRY:
    json.dump(_preview, open('/tmp/overrides-preview.json', 'w'))
    log(f"DRY-RUN: preview at /tmp/overrides-preview.json (live file untouched — no deferred marker, no backup rotation)")
    sys.exit(0)

STAGED = os.path.join(SD, 'taxonomy-staged.json')

def stage_for_app():
    """Hand every pending subgenre to the running app (src/main/taxonomy-staged.ts).
    The file always carries the WHOLE pending set, so a newer run simply
    replaces an older, still-unapplied one."""
    entries = {}
    for tid, a in cache.items():
        if tid in byid and a.get('subgenre') and not has_subgenre_in(ov, tid):
            e = {'subgenre': a['subgenre'], 'subgenrePath': a.get('path') or a['subgenre']}
            if a.get('lean'): e['subgenreLean'] = a['lean']
            entries[tid] = e
    tmp = STAGED + '.tmp'
    json.dump({'version': 1, 'at': datetime.datetime.now().isoformat(timespec='seconds'), 'entries': entries},
              open(tmp, 'w'))
    os.replace(tmp, STAGED)
    return len(entries)

if app_running():
    write_deferred(staged_preview)   # cleared by the app once it has applied the hand-off
    try:
        n = stage_for_app()
    except Exception as e:
        log(f"JakeTunes is RUNNING and the hand-off file could not be written ({e}) — deferring {staged_preview} subgenre(s).")
        sys.exit(3)
    log(f"JakeTunes is RUNNING — handed {n} subgenre(s) to the app (taxonomy-staged.json); "
        f"it files them through its own writer within ~5 minutes.")
    sys.exit(0)

# Brief 182: RE-READ the overrides from disk and merge onto the CURRENT
# file. The classify above ran for minutes over the load-time copy; any
# override the app (or another writer) landed in between is in this fresh
# copy and survives, because merge_staged only ADDS absent subgenres.
ov_now = json.load(open(OVP)) if os.path.exists(OVP) else {}
staged = merge_staged(ov_now, cache, byid)
if staged == 0:
    log("nothing left to write after the write-time re-read (a concurrent writer already landed these).")
    clear_deferred()
    sys.exit(0)

# safe write: backup (rotated) -> atomic replace -> verify (parse + count +
# size guard). indent=2 matches the app's own on-disk format — the app
# pretty-prints this file, so a compact json.dump() of identical data reads
# as an ~16% "shrink" and false-trips the size guard below even though the
# count check already proved nothing was lost. Matching format keeps the
# size check meaningful.
old_size = os.path.getsize(OVP) if os.path.exists(OVP) else 0
rotate_backups()
tmp = OVP + '.classify.tmp'
json.dump(ov_now, open(tmp, 'w'), indent=2)
chk = json.load(open(tmp))                      # parses?
assert len(chk) == len(ov_now), f"verify: count {len(chk)} != {len(ov_now)}"
if old_size:
    assert os.path.getsize(tmp) >= old_size * 0.95, "verify: file shrank unexpectedly"
# Brief 182: re-check the app gate IMMEDIATELY before the replace — the
# app may have launched during the merge/verify above, and a running app
# clobbers external override writes on its next play-event save.
if app_running():
    log(f"JakeTunes STARTED during the write — deferring {staged} subgenre(s) rather than racing it. "
        f"Classifications are cached; will write next eligible run.")
    try: os.remove(tmp)
    except Exception: pass
    write_deferred(staged)
    sys.exit(3)
os.replace(tmp, OVP)
clear_deferred()
log(f"wrote {staged} subgenre(s) into metadata-overrides.json (backups: .bak-classify + .1-.4 rotations)")

# A direct write supersedes any older hand-off the app has not picked up yet.
try: os.remove(os.path.join(SD, 'taxonomy-staged.json'))
except FileNotFoundError: pass
