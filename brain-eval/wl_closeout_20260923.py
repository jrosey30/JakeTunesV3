"""wl_closeout_20260923 — READ-ONLY. Falsifiable close-out #2 (pre-registered 09-22):
watchlist 33/34 (11467-11499 + 454) sat at queue pos 488-492 and should drain on
the 09-23 tempo catch-up. Verify by id, not by count."""
import json

OLD = "/tmp/brain-snap-20260922"
NEW = "/tmp/brain-snap-20260923"

def dd(snap):
    d = json.load(open(snap + "/brain-descriptors.json"))
    return d.get("descriptors", d)

do, dn = dd(OLD), dd(NEW)
wl = [str(x) for x in list(range(11467, 11500)) + [454]]

drained, survived, absent = [], [], []
for t in wl:
    if t not in dn:
        absent.append(t); continue
    te_old = do.get(t, {}).get("te")
    te_new = dn[t].get("te")
    if te_old not in (3, True) and te_new in (3, True):
        drained.append((t, te_old, te_new))
    elif te_new not in (3, True):
        survived.append((t, te_old, te_new))
print(f"watchlist: drained tonight={len(drained)} survived={len(survived)} absent={len(absent)}")
print("drained:", [t for t, *_ in drained])
print("survived:", [(t, o, n) for t, o, n in survived])

# survivor queue positions tonight (library order among te!=3, same as precheck)
lib = json.load(open(NEW + "/library.json"))
tracks = lib.get("tracks", lib)
q = [str(t["id"]) for t in tracks if str(t["id"]) in dn and dn[str(t["id"])].get("te") not in (3, True)]
pos = {tid: i for i, tid in enumerate(q)}
print("survivor queue pos:", [(t, pos.get(t)) for t, *_ in survived])
print(f"total te!=3 queue length tonight: {len(q)}")

# old-night queue positions of ALL watchlist ids (was the 488-492 sample representative?)
lib_o = json.load(open(OLD + "/library.json"))
tr_o = lib_o.get("tracks", lib_o)
q_o = [str(t["id"]) for t in tr_o if str(t["id"]) in do and do[str(t["id"])].get("te") not in (3, True)]
pos_o = {tid: i for i, tid in enumerate(q_o)}
wl_pos_o = sorted((pos_o[t], t) for t in wl if t in pos_o)
print(f"old queue length={len(q_o)}; watchlist old positions: {wl_pos_o}")
