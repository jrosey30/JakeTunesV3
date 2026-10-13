import json, sys, itertools, math, collections
sys.path.insert(0, '.')
from be import *
from homemini_emul import *
T = json.load(open('library.json'))['tracks']
A_D, B_D = edt(2026,8,28), edt(2026,10,9)
Alib = {t['id']: t for t in emulate(as_of(T, A_D), A_D, use_mstars=False)}
Blib = {t['id']: t for t in emulate(as_of(T, B_D), B_D, use_mstars=False)}
G = {k: v for k, v in json.load(open('groups.json')).items()}
F = ['F1_agedin_neg', 'F2_new_pos', 'F3_flips', 'F4_time_feats']
def build(on):
    ids = G['G0_same'] + G['G1_flip_to_pos'] + (G['G2_new_neg'] if 'F1_agedin_neg' in on else []) + (G['G3_new_pos'] if 'F2_new_pos' in on else [])
    flips = set(G['G1_flip_to_pos'])
    pop = []
    for i in ids:
        src = Blib[i] if ('F4_time_feats' in on or i not in Alib) else Alib[i]
        u = dict(src)
        if i in flips: u['rating'] = 5 if 'F3_flips' in on else 0
        else: u['rating'] = Blib[i]['rating']
        pop.append(u)
    return pop, (B_D if 'F4_time_feats' in on else A_D)
val = {}
for r in range(5):
    for S in itertools.combinations(F, r):
        pop, now = build(set(S)); val[frozenset(S)] = cv(pop, now)
print('none (A-like) %.4f   all (B) %.4f' % (val[frozenset()], val[frozenset(F)]))
for f in F:
    phi = 0
    others = [g for g in F if g != f]
    for r in range(4):
        for S in itertools.combinations(others, r):
            w = math.factorial(r) * math.factorial(3 - r) / math.factorial(4)
            phi += w * (val[frozenset(S) | {f}] - val[frozenset(S)])
    print('%-16s shapley %+.4f   alone %+.4f' % (f, phi, val[frozenset([f])] - val[frozenset()]))
