#!/usr/bin/env python3
import hashlib, http.client, json, os, subprocess, sys, urllib.error, urllib.parse, urllib.request

# Remote-mode gate (2026-08-28, the blip incident): away from the home LAN
# the warm's NAS copies ride the WAN (or hang on a wedged mount) and starve
# the very streaming this cache exists to serve. Not home = don't warm.
if subprocess.run(["ping", "-c", "1", "-t", "2", "homemini.local"],
                  capture_output=True).returncode != 0:
    print("cache-manager: not on the home LAN — warm skipped (runs next time we're home)")
    sys.exit(0)
HOME=os.path.expanduser("~")
LIB=f"{HOME}/Library/Application Support/JakeTunes/library.json"
DLS=f"{HOME}/Library/Application Support/JakeTunes/downloads-state.json"
NAS=f"{HOME}/JakeShareNAS/JakeTunesLibrary"
OLD=f"{HOME}/Music/JakeTunesLibrary"
DST=f"{HOME}/JakeTunesLib/JakeTunesLibrary"
CAP=int(os.environ.get("CAP_GB","40"))*1024**3
rel=lambda p:p.lstrip(':').replace(':','/')

# Eviction guard (2026-10-19). Evicting deletes the real local file and leaves
# a NAS symlink in its place, and it used to do that on "not hot" alone. A song
# imported on workmini, or one that never reached the vault, would lose its
# only audio the first time this ran at home. Now an eviction must PROVE that
# homemini serves the same bytes for that track id: exact size, plus sha1 of the
# first 256 KB (the audioFingerprint window: tags and the start of the audio)
# and of the last 64 KB. homemini's /audio/:id reads its local library first,
# then the NAS vault, so a match covers both. The id picks the remote file and
# its bytes decide; never a filename. Anything short of a full match (404,
# other bytes, a timeout, homemini down) keeps the local file and says why.
# /healthz and /audio are unsigned GETs, so no companion token is needed here.
HEAD_WIN=256*1024; TAIL_WIN=64*1024
gb={"base":False,"fails":0}   # base: False = not looked up yet, None = unreachable
def pick_backend():
    env=os.environ.get("JAKETUNES_MOBILE_BACKEND")
    for b in ([env] if env else ["http://homemini:3000","http://homemini.local:3000"]):
        try:
            with urllib.request.urlopen(b.rstrip("/")+"/healthz",timeout=5) as r:
                if r.status==200: return b.rstrip("/")
        except Exception: pass
    return None
def fetch_range(tid,rng):
    q=urllib.request.Request(f"{gb['base']}/audio/{urllib.parse.quote(str(tid),safe='')}",
                             headers={"Range":rng,"Accept-Encoding":"identity"})
    try:
        with urllib.request.urlopen(q,timeout=15) as r:
            return r.status, r.headers.get("Content-Range") or "", r.read(HEAD_WIN+1)
    except urllib.error.HTTPError as e: return e.code, "", b""
def unproven(t,lp):
    """None when homemini provably holds the same audio as lp, else the reason."""
    tid=t.get("id")
    if tid is None or str(tid)=="": return "track has no id"
    if gb["base"] is False: gb["base"]=pick_backend()
    if not gb["base"]: return "homemini unreachable"
    try:
        size=os.path.getsize(lp)
        with open(lp,"rb") as f:
            lh=hashlib.sha1(f.read(HEAD_WIN)).hexdigest()
            f.seek(max(0,size-TAIL_WIN)); lt=hashlib.sha1(f.read(TAIL_WIN)).hexdigest()
    except OSError as e: return f"local file unreadable ({e.__class__.__name__})"
    for rng,want,part in ((f"bytes=0-{HEAD_WIN-1}",lh,"first 256 KB"),(f"bytes=-{TAIL_WIN}",lt,"last 64 KB")):
        try: st,cr,body=fetch_range(tid,rng)
        except (OSError,http.client.HTTPException) as e:
            gb["fails"]+=1
            if gb["fails"]>=3: gb["base"]=None   # stop asking a dead backend
            return f"homemini request failed ({e.__class__.__name__})"
        gb["fails"]=0
        if st!=206: return f"homemini answered {st}"
        try: total=int(cr.rsplit("/",1)[1])
        except ValueError: return "homemini sent no file size"
        if total!=size: return f"size differs (local {size}, homemini {total})"
        if hashlib.sha1(body).hexdigest()!=want: return f"{part} differs from homemini's copy"
    return None
tr=(json.load(open(LIB)).get("tracks") or [])
pins=set()
try: pins=set(json.load(open(DLS)).get("pinned") or [])
except Exception: pass
bypath={t["path"]: t for t in tr}
hot=set(); tot=0
for p in pins:
    if p in bypath and p not in hot:
        hot.add(p); tot+=(bypath[p].get("fileSize") or 0)
rk=sorted(tr,key=lambda t:((t.get("playCount") or 0),(t.get("dateAdded") or ""),(t.get("rating") or 0),(t.get("path") or "")),reverse=True)
for t in rk:
    if t["path"] in hot: continue
    s=t.get("fileSize") or 0
    if tot+s<=CAP: hot.add(t["path"]); tot+=s
cl=cn=lk=ev=ms=kp=dn=0
for t in tr:
    rp=rel(t["path"]); lp=f"{DST}/{rp}"; nas=f"{NAS}/{rp}"; old=f"{OLD}/{rp}"
    d=os.path.dirname(lp)
    if not os.path.isdir(d): os.makedirs(d,exist_ok=True)
    if t["path"] in hot:
        if os.path.exists(lp) and not os.path.islink(lp): continue
        if os.path.islink(lp):
            try: os.unlink(lp)
            except Exception: pass
        if os.path.exists(old) and not os.path.islink(old):
            try: subprocess.run(["cp","-c",old,lp],check=True,capture_output=True); cl+=1; continue
            except Exception: pass
        if os.path.exists(nas):
            try: subprocess.run(["cp",nas,lp],check=True,capture_output=True); cn+=1; continue
            except Exception: pass
        try: os.symlink(nas,lp); lk+=1
        except Exception: ms+=1
    else:
        if os.path.islink(lp): continue
        if os.path.exists(lp) and not os.path.isdir(lp):
            why=unproven(t,lp)
            if why:
                kp+=1
                if why=="homemini unreachable": dn+=1
                else: print(f"KEPT {rp} (id {t.get('id')}): {why}")
                continue
            try: os.remove(lp); ev+=1
            except Exception: pass
        try: os.symlink(nas,lp); lk+=1
        except Exception: ms+=1
if dn: print(f"KEPT {dn} eviction candidates: homemini unreachable, so no copy could be proven")
print(f"HOT={len(hot)} (pins={len(pins)}) ~{tot//1024**3}GB | cloned_local={cl} copied_nas={cn} symlinks={lk} evicted={ev} kept_unproven={kp} missing={ms}")
