"""stage_skipclean_20260915 — build the ORGANIC-ONLY staging state dir for
taste-experiments-v4.py re-runs.

Pre-registered 2026-09-15, BEFORE any gate-open decisive run: the v4 re-run
corpus = desktop listening-log.jsonl + mobile-listening-log.jsonl with
mechanical burst sessions removed by the rule fixed in
skip_log_forensics_20260915.py (session gap>600s; mechanical iff n>=30 AND
median intra-gap <5s). Rationale: REPORT-20260915-nightly.md — on the raw
corpus 4 arms falsely graduate the bar (D +0.0102 t=+24.5); organic-only all
arms refuted (D +0.0039). Mechanical failure-cascade events (2,129 of 2,703
mobile skips as of tonight) are not taste.

Usage:
  python stage_skipclean_20260915.py /tmp/skipexp-clean-YYYYMMDD \
      [snapshot_dir_with_library.json]
  JT_STATE_DIR=/tmp/skipexp-clean-YYYYMMDD python taste-experiments-v4.py
Writes ONLY into the target scratch dir.
"""
import json, datetime, statistics, sys, os, shutil

NAS = "/Volumes/JakeShared/JakeTunesState"
DESKTOP_LOG = os.path.expanduser("~/Library/Application Support/JakeTunes/listening-log.jsonl")

def parse_ts(t): return datetime.datetime.fromisoformat(str(t).replace("Z", "+00:00"))

def filter_mobile(src, dst):
    lines = open(src).read().splitlines()
    parsed = []
    for i, line in enumerate(lines):
        l = line.strip()
        if not l: continue
        try: e = json.loads(l)
        except Exception: e = None
        parsed.append((i, e))
    skip_rows = sorted(((i, e) for i, e in parsed if e and e.get("t") == "s" and e.get("ts")),
                       key=lambda r: r[1]["ts"])
    sessions, cur = [], []
    for r in skip_rows:
        if cur and (parse_ts(r[1]["ts"]) - parse_ts(cur[-1][1]["ts"])).total_seconds() > 600:
            sessions.append(cur); cur = []
        cur.append(r)
    if cur: sessions.append(cur)
    drop = set()
    for s in sessions:
        if len(s) >= 30:
            gaps = [(parse_ts(b[1]["ts"]) - parse_ts(a[1]["ts"])).total_seconds()
                    for a, b in zip(s, s[1:])]
            if statistics.median(gaps) < 5:
                drop.update(i for i, _ in s)
    kept = [lines[i] for i, e in parsed if i not in drop]
    with open(dst, "w") as f:
        f.write("\n".join(kept) + "\n")
    ks = sum(1 for i, e in parsed if e and e.get("t") == "s" and i not in drop)
    print(f"mobile log: kept {ks} organic skips, dropped {len(drop)} mechanical")

if __name__ == "__main__":
    target = sys.argv[1]
    snap = sys.argv[2] if len(sys.argv) > 2 else NAS
    os.makedirs(target, exist_ok=True)
    shutil.copy(os.path.join(snap, "library.json"), target)
    shutil.copy(DESKTOP_LOG, os.path.join(target, "listening-log.jsonl"))
    filter_mobile(os.path.join(NAS, "mobile-listening-log.jsonl"),
                  os.path.join(target, "mobile-listening-log.jsonl"))
