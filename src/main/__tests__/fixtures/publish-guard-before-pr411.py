# The library publish guard as it ran until PR 411: the Python inside publish_backend_library in
# Dr. Claude/scripts/jaketunes-homemini-sync.sh at b38e9a7a, byte for byte below this header.
# Frozen. sync-script-publish-deletions.test.ts runs it beside the guard of today to prove the
# new one never publishes what this one refused. Never edit it.
import json, os, time
from datetime import datetime
def tracks(p):
    try:
        d = json.load(open(p))
    except Exception:
        return None
    return d if isinstance(d, list) else d.get("tracks", [])
def ts(t):
    try: return datetime.fromisoformat(str(t.get("dateAdded","")).replace("Z","+00:00")).timestamp()
    except Exception: return None
new = tracks(".library.json.incoming")
if new is None or len(new) == 0:
    print("refused-corrupt"); raise SystemExit(0)
cur = tracks("library.json") or []
ids = set(str(t.get("id")) for t in new)
newest = max([x for x in (ts(t) for t in new) if x is not None] or [float("-inf")])
ahead = [t for t in cur if str(t.get("id")) not in ids and (ts(t) or float("-inf")) > newest]
if ahead:
    print("refused-stale %d" % len(ahead)); raise SystemExit(0)
# Brief 197 — twin of the recent-id rule in stale-push.ts: a song the
# incoming copy lacks that was added in the last 30 days refuses too,
# even when it is OLDER than the newest in the incoming copy (the same-day
# phone download erased by a cross-lineage publish, 2026-10-14). Named,
# so the refusal is loud, never silent.
cutoff = time.time() - 30 * 24 * 3600
recent = [t for t in cur if str(t.get("id")) not in ids and (ts(t) or 0) > cutoff]
if recent:
    names = "; ".join(str(t.get("title") or t.get("id")) for t in recent[:10])
    print("refused-recent %d %s" % (len(recent), names)); raise SystemExit(0)
os.replace(".library.json.incoming", "library.json")
print("published %d" % len(new))
