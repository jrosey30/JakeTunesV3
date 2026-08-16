# symmetric-task robustness check: BOTH classes restricted to dateAdded<2026-05-25
import sys; sys.path.insert(0, "/Users/jakerosenbaumnas/brain-eval-wt-20260816/brain-eval")
import taste_weight_drift as twd
import json, os, datetime, numpy as np
from collections import defaultdict
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import RepeatedStratifiedKFold
from sklearn.metrics import roc_auc_score

lib = json.load(open(twd.LIB))["tracks"]
play_max = max((np.log1p(float(t.get("playCount") or 0)) for t in lib), default=0.0)
now_ms = int(datetime.datetime.now().timestamp() * 1000)
old = lambda t: t.get("dateAdded", "") < "2026-05-25"
pos = [t for t in lib if (t.get("artist") or t.get("title")) and (t.get("rating",0) or 0) >= 1 and old(t)]
neg = [t for t in lib if (t.get("artist") or t.get("title")) and (t.get("rating",0) or 0) == 0 and old(t)]
rng = np.random.default_rng(42)
neg = list(rng.choice(neg, size=min(1600, len(neg)), replace=False))
tracks = pos + neg
y = np.array([1]*len(pos) + [0]*len(neg)); prior = float(y.mean())
print(f"SYMMETRIC task: ★{len(pos)} (old only) vs {len(neg)} unstarred-old")
arts=[twd.k_artist(t) for t in tracks]; albs=[twd.k_album(t) for t in tracks]
gens=[twd.k_genre(t) for t in tracks]; decs=[twd.k_dec(t) for t in tracks]
pn = np.array([(np.log1p(float(t.get("playCount") or 0))/play_max) if play_max>0 else 0.0 for t in tracks])
rn = np.array([1.0 - (min((now_ms-lp)/86400000.0,3650.0) if (lp:=(t.get("lastPlayedAt") or 0))>0 else 3650.0)/3650.0 for t in tracks])
def rate(idx, keys, kk=4.0):
    s,c=defaultdict(float),defaultdict(float)
    for i in idx: s[keys[i]]+=y[i]; c[keys[i]]+=1
    return lambda k:(s.get(k,0)+kk*prior)/(c.get(k,0)+kk)
def feats(idx, ar, al, gr, dr):
    return np.column_stack([[al(albs[i]) for i in idx],[ar(arts[i]) for i in idx],
                            [gr(gens[i]) for i in idx],[dr(decs[i]) for i in idx], pn[idx], rn[idx]])
def fixed_auc(X, yy, w):
    z = (w["bias"] + X[:,0]*w["album"] + X[:,1]*w["artist"] + X[:,2]*w["genre"]
         + X[:,3]*w["decade"] + X[:,4]*w["plays"] + X[:,5]*w["recency"])
    return roc_auc_score(yy, z)
# candidate from the FULL (asymmetric) task, as derived in the main run:
W_CAND = {"album":6.275,"artist":3.493,"genre":0.548,"decade":0.060,"plays":0.525,"recency":0.629,"bias":-4.816}
a,c,b,coefs=[],[],[],[]
for tr,te in RepeatedStratifiedKFold(n_splits=5,n_repeats=5,random_state=0).split(y,y):
    ar,al,gr,dr = rate(tr,arts),rate(tr,albs),rate(tr,gens),rate(tr,decs)
    Xtr,Xte = feats(tr,ar,al,gr,dr), feats(te,ar,al,gr,dr)
    a.append(fixed_auc(Xte,y[te],twd.W_DEPLOYED)); c.append(fixed_auc(Xte,y[te],W_CAND))
    clf = LogisticRegression(C=0.2,class_weight="balanced",max_iter=4000).fit(Xtr,y[tr])
    b.append(roc_auc_score(y[te],clf.decision_function(Xte)))
    coefs.append(np.concatenate([clf.coef_[0],clf.intercept_]))
a,c,b=np.array(a),np.array(c),np.array(b); d=c-a; se=d.std(ddof=1)/np.sqrt(len(d))
mc=np.array(coefs).mean(axis=0)
print(f"A deployed : {a.mean():.4f}   B refit ceiling: {b.mean():.4f}   C candidate(from-full-task): {c.mean():.4f}")
print(f"paired C-A : {d.mean():+.4f}  (SE {se:.4f}, t {d.mean()/se:+.2f})")
print("symmetric-task refit W: album %+.3f artist %+.3f genre %+.3f decade %+.3f plays %+.3f recency %+.3f bias %+.3f" % tuple(mc))
