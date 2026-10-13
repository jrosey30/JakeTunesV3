"""H1 validation: both sides aged >=90 days (a track enters the eval only once
owned 90 days, starred or not) vs today's rule (stars enter at once). Weekly
series 8/28 -> 10/9 rebuilt as-of each date, plus a forward projection on
today's library with no new stars. Finds = store-sourced tracks."""
import json, sys
sys.path.insert(0, '.')
from be import *
from homemini_emul import emulate
T = json.load(open('library.json'))['tracks']
FOUND = {'streamrip', 'bandcamp', 'squid'}

def pop_both(tracks, now, days=90):
    cut = now - days * DAY
    return [t for t in tracks if (ms(t.get('dateAdded')) or 0) <= cut]

dates = [edt(2026, 8, 28), edt(2026, 9, 4), edt(2026, 9, 11), edt(2026, 9, 18), edt(2026, 9, 25), edt(2026, 10, 2), edt(2026, 10, 9)]
print('date    old-rule  new-rule  (pos/neg)   finds-AUC (pos/neg)')
for D in dates:
    lib = emulate(as_of(T, D), D)
    old = cv(population(lib, D), D)
    pn = pop_both(lib, D); new = cv(pn, D)
    fp = [t for t in pn if t.get('source') in FOUND]
    fa = cv(fp, D) if sum(map(is_star, fp)) >= 50 and len(fp) - sum(map(is_star, fp)) >= 50 else None
    print(datetime.datetime.fromtimestamp(D / 1000).strftime('%m/%d'), ' %.4f    %.4f   (%d/%d)   %s' % (old, new, sum(map(is_star, pn)), len(pn) - sum(map(is_star, pn)), ('%.4f (%d/%d)' % (fa, sum(map(is_star, fp)), len(fp) - sum(map(is_star, fp)))) if fa else f'n/a ({sum(map(is_star, fp))} starred finds)'))
print('-- projection, today\'s library, no new stars --')
now_lib = emulate(T, edt(2026, 10, 12, 19))
for D in [edt(2026, 10, 16), edt(2026, 11, 13), edt(2026, 12, 11)]:
    print(datetime.datetime.fromtimestamp(D / 1000).strftime('%m/%d'), ' old %.4f   new %.4f' % (cv(population(now_lib, D), D), cv(pop_both(now_lib, D), D)))
