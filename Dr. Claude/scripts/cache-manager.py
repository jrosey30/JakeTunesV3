#!/usr/bin/env python3
# cache-manager — decides which tracks live LOCALLY on a streaming host.
#
# workmini streams from the NAS: every track gets an entry under musicRoot
# (~/JakeTunesLib/JakeTunesLibrary) that is either a REAL local copy (plays
# instantly) or a SYMLINK to the NAS (plays only as fast as the mount). The
# hot set is whatever fits in CAP_GB.
#
# ⚠️ Jake, 2026-08-10: "music doesnt play on workmini, this happens too much
# after a new song update." The ranking below sorts by playCount FIRST,
# descending — so a track imported five minutes ago has playCount 0 and sorts
# BELOW all 9,000 others. It never made the hot set, so every newly-added song
# became a symlink to the NAS. And the NAS was slow enough that listing one
# directory took 43 seconds, so those songs simply did not start.
#
# The ranking wasn't wrong about popularity, it was wrong about intent: a song
# Jake just added is the MOST likely thing he is about to play, and the least
# likely to have a play count. So recent imports are now reserved into the hot
# set up front, the same way pinned downloads are, before the popularity fill
# gets the remaining space.
#
# Source of truth is this repo copy — it used to exist ONLY on workmini, with
# no version control and no review path, which is why a load-bearing ranking
# bug sat here unseen. The deploy pushes it.
import json, os, subprocess
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
# Recently-added tracks: reserved BEFORE the popularity fill, like pins.
# Without this, playCount==0 sends every new import to the bottom of rk and
# it lands as a NAS symlink — the exact "new songs don't play" failure.
NEW_N=int(os.environ.get("NEW_N","500"))
for t in sorted((x for x in tr if x.get("dateAdded")),key=lambda x:x["dateAdded"],reverse=True)[:NEW_N]:
    if t["path"] not in hot:
        hot.add(t["path"]); tot+=(t.get("fileSize") or 0)
newly_reserved=len(hot)-len(pins & set(bypath))
rk=sorted(tr,key=lambda t:((t.get("playCount") or 0),(t.get("dateAdded") or ""),(t.get("rating") or 0),(t.get("path") or "")),reverse=True)
for t in rk:
    if t["path"] in hot: continue
    s=t.get("fileSize") or 0
    if tot+s<=CAP: hot.add(t["path"]); tot+=s

# ── Throttled NAS copy ──────────────────────────────────────────────
# Jake, 2026-08-10: "music doesnt play on workmini... happens too much
# after a new song update." Measured: a NAS-streamed track starts in 3
# SECONDS when the link is idle, and 160 seconds while this script is
# bulk-copying. The link is ~1 MB/s; streaming 256kbps AAC needs ~32 KB/s,
# so there is plenty of room — but an unthrottled `cp` takes all of it and
# playback starves. Nothing was wrong with streaming. The cache filler was
# standing on it.
#
# So the fill is rate-limited and always leaves headroom. Slower to warm
# the cache, but it can no longer take the music down while it runs. Same
# rule the media pipeline already learned: a batch job yields to playback.
BW=int(os.environ.get("CACHE_BW_KBPS","300"))*1024   # bytes/sec for the fill
def copy_throttled(src,dst):
    import time
    chunk=64*1024
    with open(src,"rb") as i, open(dst+".part","wb") as o:
        while True:
            t0=time.time()
            b=i.read(chunk)
            if not b: break
            o.write(b)
            want=len(b)/BW
            spent=time.time()-t0
            if want>spent: time.sleep(want-spent)
    os.replace(dst+".part",dst)

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
            try: copy_throttled(nas,lp); cn+=1; continue
            except Exception:
                try: os.remove(lp+".part")
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
print(f"HOT={len(hot)} (pins={len(pins)}, newest={min(NEW_N,len(tr))}) ~{tot//1024**3}GB | cloned_local={cl} copied_nas={cn} symlinks={lk} evicted={ev} missing={ms}")
