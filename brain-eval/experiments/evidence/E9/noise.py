import json, sys, random, statistics as st
sys.path.insert(0, '.')
from be import *
from homemini_emul import *
T = json.load(open('library.json'))['tracks']
A_D, B_D = edt(2026,8,28), edt(2026,10,9)
Alib = {t['id']: t for t in emulate(as_of(T, A_D), A_D, use_mstars=False)}
Blib = {t['id']: t for t in emulate(as_of(T, B_D), B_D, use_mstars=False)}
Apop = population(list(Alib.values()), A_D); Bpop = population(list(Blib.values()), B_D)
# run-to-run: identical inputs twice
print('repeat identical run A:', cv(Apop, A_D), cv(Apop, A_D))
# fold-partition noise: salted djb2
ra, rb, rd = [], [], []
for salt in range(60):
    fo = lambda t, s=salt: djb2(f'{s}:{t["id"]}') % 5
    a, b = cv(Apop, A_D, fold_of=fo), cv(Bpop, B_D, fold_of=fo)
    ra.append(a); rb.append(b); rd.append(b - a)
print('fold-partition (60 salts): A %.4f±%.4f  B %.4f±%.4f  delta %.4f±%.4f  (min delta %.4f max %.4f)' % (st.mean(ra), st.stdev(ra), st.mean(rb), st.stdev(rb), st.mean(rd), st.stdev(rd), min(rd), max(rd)))
# paired bootstrap over track ids (union), 200 reps
rng = random.Random(7)
ids = sorted(set(Alib) | set(Blib))
Aset = {t['id'] for t in Apop}; Bset = {t['id'] for t in Bpop}
bd, ba = [], []
for r in range(200):
    samp = [rng.choice(ids) for _ in ids]
    pa, pb = [], []
    for k, i in enumerate(samp):
        if i in Aset: u = dict(Alib[i]); u['id'] = f'{i}#{k}'; pa.append(u)
        if i in Bset: u = dict(Blib[i]); u['id'] = f'{i}#{k}'; pb.append(u)
    a, b = cv(pa, A_D), cv(pb, B_D); ba.append(a); bd.append(b - a)
bd.sort()
print('bootstrap A sd %.4f ; delta mean %.4f sd %.4f 95%% CI [%.4f, %.4f]' % (st.stdev(ba), st.mean(bd), st.stdev(bd), bd[4], bd[194]))
