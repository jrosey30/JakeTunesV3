import sys; sys.path.insert(0, "/Users/jakerosenbaumnas/brain-eval-wt-20260816/brain-eval")
import taste_weight_drift as twd
import json, os, datetime, numpy as np
from collections import defaultdict
from sklearn.model_selection import RepeatedStratifiedKFold
from sklearn.metrics import roc_auc_score

lib = json.load(open(twd.LIB))["tracks"]
play_max = max((np.log1p(float(t.get("playCount") or 0)) for t in lib), default=0.0)
now_ms = int(datetime.datetime.now().timestamp() * 1000)
pos = [t for t in lib if (t.get("artist") or t.get("title")) and (t.get("rating",0) or 0) >= 1]
neg = [t for t in lib if (t.get("artist") or t.get("title")) and (t.get("rating",0) or 0) == 0 and t.get("dateAdded","") < "2026-05-25"]
rng = np.random.default_rng(42)
neg = list(rng.choice(neg, size=min(1600, len(neg)), replace=False))
tracks = pos + neg; y = np.array([1]*len(pos)+[0]*len(neg)); prior = float(y.mean())
arts=[twd.k_artist(t) for t in tracks]; albs=[twd.k_album(t) for t in tracks]
gens=[twd.k_genre(t) for t in tracks]; decs=[twd.k_dec(t) for t in tracks]
pn = np.array([(np.log1p(float(t.get("playCount") or 0))/play_max) if play_max>0 else 0.0 for t in tracks])
rn = np.array([1.0 - (min((now_ms-lp)/86400000.0,3650.0) if (lp:=(t.get("lastPlayedAt") or 0))>0 else 3650.0)/3650.0 for t in tracks])
def rate(idx, keys, kk=4.0):
    s,c=defaultdict(float),defaultdict(float)
    for i in idx: s[keys[i]]+=y[i]; c[keys[i]]+=1
    return lambda k:(s.get(k,0)+kk*prior)/(c.get(k,0)+kk)
W_ROUNDED = {"album":6.275,"artist":3.493,"genre":0.548,"decade":0.060,"plays":0.525,"recency":0.629,"bias":-4.816}
a,c=[],[]
for tr,te in RepeatedStratifiedKFold(n_splits=5,n_repeats=5,random_state=0).split(y,y):
    ar,al,gr,dr = rate(tr,arts),rate(tr,albs),rate(tr,gens),rate(tr,decs)
    Xte = np.column_stack([[al(albs[i]) for i in te],[ar(arts[i]) for i in te],
                           [gr(gens[i]) for i in te],[dr(decs[i]) for i in te], pn[te], rn[te]])
    def fa(w):
        z=(w["bias"]+Xte[:,0]*w["album"]+Xte[:,1]*w["artist"]+Xte[:,2]*w["genre"]
           +Xte[:,3]*w["decade"]+Xte[:,4]*w["plays"]+Xte[:,5]*w["recency"])
        return roc_auc_score(y[te],z)
    a.append(fa(twd.W_DEPLOYED)); c.append(fa(W_ROUNDED))
a,c=np.array(a),np.array(c); d=c-a; se=d.std(ddof=1)/np.sqrt(len(d))
print(f"ROUNDED candidate on FULL task: C {c.mean():.4f} vs A {a.mean():.4f}  paired {d.mean():+.4f} (SE {se:.4f}, t {d.mean()/se:+.2f})")
