#!/usr/bin/env python3
import json, os, subprocess, sys

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
cl=cn=lk=ev=ms=0
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
            try: os.remove(lp); ev+=1
            except Exception: pass
        try: os.symlink(nas,lp); lk+=1
        except Exception: ms+=1
print(f"HOT={len(hot)} (pins={len(pins)}) ~{tot//1024**3}GB | cloned_local={cl} copied_nas={cn} symlinks={lk} evicted={ev} missing={ms}")
