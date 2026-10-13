import json, sys, collections
sys.path.insert(0, '.')
from be import *
MP = json.load(open('mobile-plays.json'))
LOG = json.load(open('mobile-play-log.json'))
MS = set(json.load(open('mobile-stars.json'))['trackIds'])

def emulate(tracks, D, use_mplays=True, use_mstars=True, use_log=True):
    """Apply homemini getLibrary + brainEval inputs as of D."""
    after = collections.Counter()
    plays_after = collections.Counter()
    lastp = {}
    for e in LOG:
        m = ms(e['at'])
        if m is None: continue
        if m > D:
            if e.get('t') != 's': plays_after[e['id']] += 1
            continue
        if m > lastp.get(e['id'], 0): lastp[e['id']] = m
    out = []
    for t in tracks:
        u = dict(t)
        sid = str(t['id'])
        if use_mplays:
            extra = MP.get(sid, 0) - plays_after.get(sid, 0)
            if extra > 0: u['playCount'] = (u.get('playCount') or 0) + extra
        if use_mstars and sid in MS and (u.get('rating') or 0) < 1:
            u['rating'] = 1
        if use_log and sid in lastp: u['lastPlayedAt'] = lastp[sid]
        out.append(u)
    return out
