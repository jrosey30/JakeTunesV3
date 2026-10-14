#!/usr/bin/env bash
# status.sh — Brief 183: one glance at every JakeTunes job's last-known
# state, read from each job's own status file (never from launchd's
# memory of exit codes). Also reachable as install-launchagents.sh --status.
#
# Overrides: JT_STATE_DIR (state dir; default the app's), LAUNCHAGENTS_DIR.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="${JT_STATE_DIR:-$HOME/Library/Application Support/JakeTunes}"
LA_DIR="${LAUNCHAGENTS_DIR:-$HOME/Library/LaunchAgents}"
export JT_MANIFEST="$HERE/jobs.json" JT_STATE_DIR_RESOLVED="$STATE_DIR" JT_LA_DIR="$LA_DIR"

python3 - <<'PY'
import json, os, time

manifest = json.load(open(os.environ["JT_MANIFEST"]))
state = os.environ["JT_STATE_DIR_RESOLVED"]
la = os.environ["JT_LA_DIR"]

def brain_status():
    p = os.path.join(state, "brain-status.json")
    try:
        d = json.load(open(p))
        at = d.get("at", "?")
        age = ""
        try:
            t = time.mktime(time.strptime(at[:19], "%Y-%m-%dT%H:%M:%S"))
            age = f" ({(time.time() - t) / 3600:.1f}h ago)"
        except Exception:
            pass
        return f"ok={d.get('ok')} at {at}{age}" + (f" error={d.get('error')}" if d.get("error") else "")
    except FileNotFoundError:
        return "NO brain-status.json — the trainer has never written one here (watchdog would alert)"
    except Exception as e:
        return f"brain-status.json UNPARSEABLE ({e}) — watchdog would alert"

def deferred():
    p = os.path.join(state, "taxonomy-deferred.json")
    try:
        d = json.load(open(p))
        return f"DEFERRED at {d.get('at')}: {d.get('pendingCount')} subgenre write(s) owed (app was running)"
    except FileNotFoundError:
        return "no deferral marker — last taxonomy write landed (or none attempted)"
    except Exception as e:
        return f"taxonomy-deferred.json unparseable ({e})"

def history():
    p = os.path.join(state, "taste-eval-history.jsonl")
    try:
        lines = [l for l in open(p).read().splitlines() if l.strip()]
        return f"last of {len(lines)} run(s): {lines[-1][:160]}"
    except FileNotFoundError:
        return "no taste-eval-history.jsonl yet"
    except Exception as e:
        return f"history unreadable ({e})"

def enrichment():
    p = os.path.join(state, "enrichment-status.json")
    try:
        d = json.load(open(p))
        return f"at {d.get('at')}: phases={json.dumps(d.get('phases', {}))[:140]} capSource={str(d.get('capSource'))[:60]}"
    except FileNotFoundError:
        return "no enrichment-status.json — catch-up has not run here yet"
    except Exception as e:
        return f"enrichment-status.json unparseable ({e})"

READERS = {
    "brain-status.json": brain_status,
    "taxonomy-deferred.json": deferred,
    "taste-eval-history.jsonl": history,
    "enrichment-status.json": enrichment,
}

print(f"JakeTunes job status — state dir: {state}")
print()
for j in manifest["jobs"]:
    label, kind = j["label"], j["kind"]
    if kind == "managed":
        installed = "installed" if os.path.exists(os.path.join(la, label + ".plist")) else "NOT installed"
        line = f"[{label}] ({kind}, {j['schedule']}{', proposed' if j.get('proposed') else ''}) — {installed}"
    elif kind == "existing-plist":
        line = f"[{label}] (existing plist in repo: {j.get('repoPlist')}, {j['schedule']})"
    else:
        line = f"[{label}] (external, {j['schedule']})"
    print(line)
    sf = j.get("statusFile")
    if sf and sf in READERS:
        print(f"    status: {READERS[sf]()}")
    if kind != "managed":
        print(f"    note: {j['notes'][:150]}")
print()
print("Legend: brain-status drives the watchdog (stale >26h alerts); a taxonomy")
print("deferral marker means classification results are cached and owed a write.")
PY
