import json, sys
sys.path.insert(0, '.')
from be import *
from homemini_emul import *
T = json.load(open('library.json'))['tracks']
A_D, B_D = edt(2026,8,28), edt(2026,10,9)
Alib = {t['id']: t for t in emulate(as_of(T, A_D), A_D, use_mstars=False)}
Apop = population(list(Alib.values()), A_D)
for drop in [(), ('intensity',), ('recency',), ('intensity', 'recency')]:
    print('clock-only effect with drop=%-25s %+.4f' % (drop, cv(Apop, B_D, drop=drop) - cv(Apop, A_D, drop=drop)))
# intensity of young vs old tracks at A vs B clock
import statistics as st
p = profile(Apop, A_D); q = dict(p); q['now'] = B_D
fd = lambda t: t.get('source') in FINDS
for nm, sel in [('finds', fd), ('old', lambda t: not fd(t))]:
    xs = [t for t in Apop if sel(t) and (t.get('playCount') or 0) > 0]
    print('  played %s n=%d mean intensity A-clock %.3f B-clock %.3f' % (nm, len(xs), st.mean(score_parts(t, p)['intensity'] for t in xs), st.mean(score_parts(t, q)['intensity'] for t in xs)))
# projection: current library, no new stars/plays, clock forward
cur = emulate(T, edt(2026,10,12,19), use_mstars=False)
for lab, D in [('10/12', edt(2026,10,12,19)), ('11/13', edt(2026,11,13)), ('12/11', edt(2026,12,11)), ('1/8', edt(2027,1,8))]:
    pop = population(cur, D); n = sum(map(is_star, pop)); print('projection %s pop %d pos %d neg %d AUC %.4f' % (lab, len(pop), n, len(pop)-n, cv(pop, D)))
