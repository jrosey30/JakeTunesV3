"""skip_log_forensics_20260915 — READ-ONLY. Organic-vs-mechanical skip census.

WHY. 2026-09-12/13 the phone logged 1,646 skip events in three machine-speed
bursts (median inter-skip gap 0.85s, 88% pct=0, 1,487 distinct tracks, only 18
play events across both days) — a playback-failure auto-advance cascade, not
taste. The taste-experiments-v4 re-run gate (~3,000 MERGED skips) must count
ORGANIC skips only, or the re-test runs on poisoned data.

PRE-REGISTERED MECHANICAL RULE (fixed here, before any future re-test):
  - sessionize skip events per source log: boundary = gap > 600s
  - a session is MECHANICAL iff n >= 30 AND median intra-session gap < 5s
  - merged organic = organic mobile skips + 610 static desktop-log skips
The rule is deliberately coarse: a human cannot sustain 30+ skips at <5s
median (that is < the app's own transition time), and no organic session in
the log to date comes near both thresholds at once.

Output: organic/mechanical counts, burst windows (for the exclusion sidecar),
and the v4 gate status. Writes NOTHING.
"""
import json, datetime, statistics

LOG = "/Volumes/JakeShared/JakeTunesState/mobile-listening-log.jsonl"
DESKTOP_STATIC = 610          # desktop listening-log skips, static since 2026-05-25
GATE = 3000                   # merged-organic gate for the verbatim v4 re-run

def parse_ts(t):
    return datetime.datetime.fromisoformat(str(t).replace("Z", "+00:00"))

skips = []
with open(LOG) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            e = json.loads(line)
        except Exception:
            continue
        if e.get("t") != "s" or not e.get("ts"):
            continue
        skips.append(e)

skips.sort(key=lambda e: e["ts"])
sessions, cur = [], []
for e in skips:
    if cur and (parse_ts(e["ts"]) - parse_ts(cur[-1]["ts"])).total_seconds() > 600:
        sessions.append(cur)
        cur = []
    cur.append(e)
if cur:
    sessions.append(cur)

organic, mechanical, bursts = 0, 0, []
for s in sessions:
    if len(s) >= 30:
        gaps = [(parse_ts(b["ts"]) - parse_ts(a["ts"])).total_seconds()
                for a, b in zip(s, s[1:])]
        if statistics.median(gaps) < 5:
            mechanical += len(s)
            bursts.append((s[0]["ts"], s[-1]["ts"], len(s)))
            continue
    organic += len(s)

merged = organic + DESKTOP_STATIC
print(f"mobile skip events total     = {len(skips)}")
print(f"  organic                    = {organic}")
print(f"  mechanical (burst)         = {mechanical} in {len(bursts)} session(s)")
for a, b, n in bursts:
    print(f"    burst {a} -> {b}  ({n} skips)")
print(f"merged organic (+{DESKTOP_STATIC} desktop) = {merged}")
print(f"v4 re-run gate ({GATE}): {'OPEN' if merged >= GATE else f'CLOSED ({GATE - merged} to go)'}")
