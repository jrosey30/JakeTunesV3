import json, sys, collections, statistics as st
sys.path.insert(0, '.')
from be import *
from homemini_emul import *
T = json.load(open('library.json'))['tracks']
A_D, B_D = edt(2026,8,28), edt(2026,10,9)
G = json.load(open('groups.json'))
def stt(D): return population(emulate(as_of(T, D), D, use_mstars=False), D)
for lab, D in [('A 8/28', A_D), ('B 10/9', B_D)]:
    pop = stt(D)
    a, pairs = cv(pop, D, return_pairs=True)
    fd = lambda t: t.get('source') in FINDS
    def sub(pp, nn): return auc([(s, y) for s, y, t in pairs if (y and pp(t)) or ((not y) and nn(t))])
    old = lambda t: not fd(t)
    print(lab, 'all %.4f' % a, '| old-only %.4f' % sub(old, old), 'finds-only %.4f' % sub(fd, fd),
          '| oldpos-vs-findneg %.4f' % sub(old, fd), 'findpos-vs-oldneg %.4f' % sub(fd, old))
    npos = sum(1 for _, y, _ in pairs if y); nf = sum(1 for _, y, t in pairs if fd(t))
    print('   n', len(pairs), 'pos', npos, 'finds share %.3f' % (nf / len(pairs)), 'find pos', sum(1 for _, y, t in pairs if y and fd(t)), 'find neg', sum(1 for _, y, t in pairs if not y and fd(t)), 'pos rate %.3f' % (npos/len(pairs)), 'find pos rate %.3f' % (sum(1 for _, y, t in pairs if y and fd(t))/nf))
    if lab.startswith('B'):
        g2 = set(G['G2_new_neg']); sc = {t['id']: s for s, y, t in pairs}
        P = [s for s, y, t in pairs if y]; N0 = [s for s, y, t in pairs if not y and t['id'] not in g2]; N2 = [sc[i] for i in g2]
        print('   median score pos %.3f  old-neg %.3f  agedin-neg %.3f' % (st.median(P), st.median(N0), st.median(N2)))
        print('   AUC pos vs old-neg %.4f   pos vs agedin-neg %.4f' % (auc([(s,1) for s in P]+[(s,0) for s in N0]), auc([(s,1) for s in P]+[(s,0) for s in N2])))
        # features of aged-in negatives vs old negatives (train profile = full pop for description)
        p = profile(pop, D)
        byid = {t['id']: t for t in pop}
        for nm, ids in [('agedin-neg', g2), ('old-neg', {t['id'] for s, y, t in pairs if not y and t['id'] not in g2}), ('pos', {t['id'] for s, y, t in pairs if y})]:
            fs = [score_parts(byid[i], p) for i in ids]
            print('   %-10s' % nm, ' '.join('%s=%.3f' % (k, st.mean(f[k] for f in fs)) for k in ['album', 'artist', 'plays', 'intensity', 'recency']),
                  'albums-with-a-star %.2f' % st.mean(1 if any(is_star(x) for x in []) else 0 for _ in [0]))
        # album-mate stat
        alb = collections.defaultdict(list)
        for t in pop: alb[k_album(t)].append(t)
        for nm, ids in [('agedin-neg', g2), ('old-neg', {t['id'] for s, y, t in pairs if not y and t['id'] not in g2})]:
            share = st.mean(1 if any(is_star(x) for x in alb[k_album(byid[i])]) else 0 for i in ids)
            print('   %-10s share whose album has a starred track: %.3f' % (nm, share))
