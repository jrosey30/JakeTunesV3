#!/usr/bin/env python3
"""
pick_experiment.py — the nightly brain job's experiment queue.

Files (brain-eval/experiments/):
  queue.json    the seeded items (E1…): what to try, how, and the bar to beat
  ledger.jsonl  append-only history: every pick, every result, every requeue
  state/        small facts the preconditions compare against (e.g. the genre
                tags the main index was last embedded with)

RULES (enforced here, restated in nightly-prompt-v3.md):
  * ONE item per night. pick = the highest-priority QUEUED `auto` item whose
    machine-checkable preconditions all pass.
  * If no auto item qualifies, MEASURE the top queued `jake` item whose
    preconditions pass, to price its proposal. Pricing never applies anything.
  * Watch series are capped at 3 nights (max_nights <= 3 for series items);
    the picker never creates items, so it can never open a new series.
  * Every result goes to the ledger (`record`).
  * A rejected item can only be re-queued with a NEW hypothesis (`requeue`),
    one that differs from every hypothesis it was already tried under.

    python3 pick_experiment.py check                         # validate queue.json
    python3 pick_experiment.py status
    python3 pick_experiment.py pick --state-dir /tmp/brain-snap-YYYYMMDD [--dry-run] [--json]
    python3 pick_experiment.py record --id E1 --outcome rejected --summary "..." [--metrics '{...}'] [--gate gate.json]
    python3 pick_experiment.py requeue --id E1 --hypothesis '{"metric": ..., "to_beat": ...}' --why "..."
    python3 pick_experiment.py record-tags --library /tmp/brain-snap-YYYYMMDD/library.json

Reads the brain (preconditions) read-only; writes only queue.json, ledger.jsonl
and experiments/state/.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import scorecard as S  # noqa: E402

EXP_DIR = os.path.join(HERE, "experiments")
QUEUE_PATH = os.path.join(EXP_DIR, "queue.json")
LEDGER_PATH = os.path.join(EXP_DIR, "ledger.jsonl")
TAGS_PATH = os.path.join(EXP_DIR, "state", "main-index-tags.json")

LANES = ("auto", "jake")
STATUSES = ("queued", "applied", "rejected", "measured", "priced", "expired", "done", "blocked")
OUTCOMES = {  # outcome -> new status
    "applied": "applied",        # passed the dual-run gate, applied with backup + undo
    "rejected": "rejected",      # measured, failed its bar
    "measured": "measured",      # auto measure-only item finished
    "priced": "priced",          # jake item measured for its proposal
    "no-change": None,           # ran clean, nothing to decide (status unchanged unless out of nights)
    "blocked": None,             # couldn't run (pipeline/mount/etc.) — status unchanged
    "aborted": None,
}
REQUIRED = ("id", "title", "status", "priority", "lane", "hypothesis", "method", "touches",
            "preconditions", "acceptance", "rollback", "grounding_source", "budget", "max_nights", "result")
SERIES_MAX_NIGHTS = 3


# ------------------------------------------------------------------ io
def load_queue(path=QUEUE_PATH):
    return json.load(open(path, encoding="utf-8"))


def save_queue(q, path=QUEUE_PATH):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(q, f, indent=1, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, path)


def read_ledger(path=LEDGER_PATH):
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        return [json.loads(l) for l in f if l.strip()]


def append_ledger(row, path=LEDGER_PATH):
    row = {"at": time.strftime("%Y-%m-%dT%H:%M:%S"), **row}
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")
    return row


# ------------------------------------------------------------------ validation
def validate(q):
    errs, seen = [], set()
    for it in q.get("items", []):
        iid = it.get("id", "?")
        for k in REQUIRED:
            if k not in it:
                errs.append(f"{iid}: missing field {k!r}")
        if iid in seen:
            errs.append(f"{iid}: duplicate id")
        seen.add(iid)
        if it.get("lane") not in LANES:
            errs.append(f"{iid}: lane must be one of {LANES}")
        if it.get("status") not in STATUSES:
            errs.append(f"{iid}: status {it.get('status')!r} not in {STATUSES}")
        if not isinstance(it.get("priority"), int):
            errs.append(f"{iid}: priority must be an int")
        h = it.get("hypothesis")
        if not isinstance(h, dict) or "metric" not in h or "to_beat" not in h:
            errs.append(f"{iid}: hypothesis must be a number to beat: {{metric, to_beat, ...}}")
        if not isinstance(it.get("max_nights"), int) or it.get("max_nights", 0) < 1:
            errs.append(f"{iid}: max_nights must be an int >= 1")
        if it.get("series") and it.get("max_nights", 99) > SERIES_MAX_NIGHTS:
            errs.append(f"{iid}: watch series are capped at {SERIES_MAX_NIGHTS} nights")
        if not isinstance(it.get("preconditions"), list):
            errs.append(f"{iid}: preconditions must be a list")
        for pc in it.get("preconditions") or []:
            if pc.get("kind") not in PRECONDITIONS:
                errs.append(f"{iid}: unknown precondition kind {pc.get('kind')!r}")
        if it.get("lane") == "auto" and not it.get("touches") and not it.get("measure_only"):
            errs.append(f"{iid}: an auto item that applies must say what it touches")
    return errs


# ------------------------------------------------------------------ preconditions
def _expand(p, ctx):
    p = p.replace("$STATE_DIR", ctx.get("state_dir") or "$STATE_DIR")
    p = p.replace("$BRAIN_EVAL", HERE)
    return os.path.expanduser(p)


def pc_file_exists(pc, ctx):
    p = _expand(pc["path"], ctx)
    return os.path.exists(p), f"{p} {'exists' if os.path.exists(p) else 'MISSING'}"


def pc_source_grep(pc, ctx):
    if "ref" in pc:
        r = subprocess.run(["git", "-C", S.REPO, "show", f"{pc['ref']}:{pc['path']}"], capture_output=True)
        if r.returncode != 0:
            return False, f"{pc['ref']}:{pc['path']} unreadable"
        text, where = r.stdout.decode("utf-8", "replace"), f"{pc['ref']}:{pc['path']}"
    else:
        where = _expand(pc["file"], ctx)
        if not os.path.exists(where):
            return False, f"{where} MISSING"
        text = open(where, encoding="utf-8", errors="replace").read()
    found = re.search(pc["pattern"], text) is not None
    want = pc.get("expect", "present") == "present"
    return found == want, f"/{pc['pattern'][:50]}/ {'found' if found else 'absent'} in {where} (want {pc.get('expect', 'present')})"


def _need_state(ctx):
    if not ctx.get("state_dir"):
        raise ValueError("needs --state-dir (a snapshot of the brain)")
    return ctx["state_dir"]


def pc_bare_backlog(pc, ctx):
    n = len(ctx.setdefault("_bare", S.bare_mood_ids(_need_state(ctx))))
    ok = (n >= pc.get("min", 0)) and (n <= pc.get("max", 10 ** 9))
    rng = f"[{pc.get('min', 0)}, {pc.get('max', '∞')}]"
    return ok, f"bare mood vectors (in-library, no descriptor) = {n}, need {rng}"


def pc_genre_tag_churn(pc, ctx):
    snap = _expand(pc.get("snapshot", TAGS_PATH), ctx)
    if not os.path.exists(snap):
        return False, f"no tag snapshot at {snap} — record one (record-tags) after the next main-index refresh"
    old = json.load(open(snap, encoding="utf-8"))["tags"]
    tracks = S.load_tracks(os.path.join(_need_state(ctx), "library.json"))
    common = [t for t in tracks if str(t["id"]) in old]
    changed = sum(1 for t in common if str(t.get("genre") or "").strip() != old[str(t["id"])])
    frac = changed / max(1, len(common))
    return frac > pc["min_frac"], f"{changed}/{len(common)} genre tags changed since the snapshot ({frac:.2%}; need > {pc['min_frac']:.0%})"


def pc_meaning_count(pc, ctx):
    sd = _need_state(ctx)
    lib = {int(t["id"]) for t in S.load_tracks(os.path.join(sd, "library.json"))}
    desc = S.load_descriptors(sd)
    mood = set(S.embd_ids(os.path.join(sd, "mood-index.bin")))
    n = sum(1 for k, v in desc.items() if k.isdigit() and int(k) in lib and int(k) in mood
            and str(v.get("d") or "").strip() and str(v.get("m") or "").strip())
    return n >= pc["min"], f"described tracks with a lyrics meaning + mood vector = {n} (need ≥ {pc['min']})"


def pc_item_status(pc, ctx):
    st = {it["id"]: it["status"] for it in ctx["queue"]["items"]}.get(pc["id"])
    return st in pc["in"], f"{pc['id']} status {st} (need one of {pc['in']})"


PRECONDITIONS = {
    "file_exists": pc_file_exists, "source_grep": pc_source_grep, "bare_backlog": pc_bare_backlog,
    "genre_tag_churn": pc_genre_tag_churn, "meaning_count": pc_meaning_count, "item_status": pc_item_status,
}


def check_preconditions(item, ctx):
    out = []
    for pc in item.get("preconditions") or []:
        try:
            ok, detail = PRECONDITIONS[pc["kind"]](pc, ctx)
        except Exception as e:  # noqa: BLE001 — an uncheckable precondition is a failed one
            ok, detail = False, f"could not check: {e}"
        out.append({"kind": pc["kind"], "pass": bool(ok), "detail": detail, "why": pc.get("why", "")})
    return all(x["pass"] for x in out), out


# ------------------------------------------------------------------ picking
def nights_run(item_id, ledger):
    return len({r["at"][:10] for r in ledger if r.get("id") == item_id and r.get("event") == "result"})


def pick(queue, ledger, ctx):
    """-> {"mode": "run"|"price"|"idle", "item": id|None, "checked": [...]}"""
    ctx = dict(ctx, queue=queue)
    checked = []
    queued = [it for it in queue["items"] if it["status"] == "queued"]
    order = lambda it: (-it["priority"], it["id"])  # noqa: E731
    for lane, mode in (("auto", "run"), ("jake", "price")):
        for it in sorted((i for i in queued if i["lane"] == lane), key=order):
            used = nights_run(it["id"], ledger)
            if used >= it["max_nights"]:
                checked.append({"id": it["id"], "lane": lane, "eligible": False,
                                "why": f"out of nights ({used}/{it['max_nights']}) — mark expired"})
                continue
            ok, pcs = check_preconditions(it, ctx)
            checked.append({"id": it["id"], "lane": lane, "eligible": ok, "preconditions": pcs})
            if ok:
                return {"mode": mode, "item": it["id"], "title": it["title"],
                        "night": used + 1, "max_nights": it["max_nights"], "checked": checked}
    return {"mode": "idle", "item": None, "checked": checked}


def record(queue, item_id, outcome, summary, metrics=None, gate=None, ledger=None):
    if outcome not in OUTCOMES:
        raise ValueError(f"outcome must be one of {sorted(OUTCOMES)}")
    item = next((it for it in queue["items"] if it["id"] == item_id), None)
    if item is None:
        raise ValueError(f"no item {item_id}")
    if outcome == "applied" and item["lane"] != "auto":
        raise ValueError(f"{item_id} is a jake-lane item — it is never applied by the nightly (record 'priced')")
    if outcome == "applied" and item.get("measure_only"):
        raise ValueError(f"{item_id} is measure-only — record 'measured'")
    if outcome == "priced" and item["lane"] != "jake":
        raise ValueError("'priced' is for jake-lane items")
    if outcome == "applied" and not (gate and gate.get("apply")):
        raise ValueError("'applied' needs a gate.py decision with apply=true (pass --gate)")
    row = {"event": "result", "id": item_id, "outcome": outcome, "summary": summary,
           "hypothesis": item["hypothesis"], **({"metrics": metrics} if metrics else {}),
           **({"gate": gate} if gate else {})}
    if ledger is not None:
        row = append_ledger(row, ledger)
    new = OUTCOMES[outcome]
    if new:
        item["status"] = new
    item["result"] = {"at": row.get("at", time.strftime("%Y-%m-%dT%H:%M:%S")), "outcome": outcome,
                      "summary": summary, **({"metrics": metrics} if metrics else {})}
    if item["status"] == "queued" and ledger is not None and nights_run(item_id, read_ledger(ledger)) >= item["max_nights"]:
        item["status"] = "expired"
    return row


def _norm_h(h):
    return json.dumps(h, sort_keys=True, separators=(",", ":")).lower()


def requeue(queue, item_id, hypothesis, why, ledger_rows):
    item = next((it for it in queue["items"] if it["id"] == item_id), None)
    if item is None:
        raise ValueError(f"no item {item_id}")
    if item["status"] not in ("rejected", "expired", "priced"):
        raise ValueError(f"{item_id} is {item['status']} — only rejected/expired/priced items can be re-queued")
    if not isinstance(hypothesis, dict) or "metric" not in hypothesis or "to_beat" not in hypothesis:
        raise ValueError("a re-queue needs a NEW hypothesis: {metric, to_beat, ...}")
    tried = {_norm_h(item["hypothesis"])} | {_norm_h(r["hypothesis"]) for r in ledger_rows
                                             if r.get("id") == item_id and r.get("hypothesis")}
    if _norm_h(hypothesis) in tried:
        raise ValueError(f"{item_id}: that hypothesis was already tried — a re-queue needs a NEW one")
    old = item["hypothesis"]
    item["hypothesis"], item["status"], item["result"] = hypothesis, "queued", None
    return {"event": "requeued", "id": item_id, "old_hypothesis": old, "hypothesis": hypothesis, "why": why}


# ------------------------------------------------------------------ cli
def main(argv=None):
    ap = argparse.ArgumentParser(description="the nightly experiment queue")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("check")
    sub.add_parser("status")
    p = sub.add_parser("pick")
    p.add_argument("--state-dir", default=os.environ.get("JT_STATE_DIR"))
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--json", action="store_true")
    r = sub.add_parser("record")
    r.add_argument("--id", required=True)
    r.add_argument("--outcome", required=True, choices=sorted(OUTCOMES))
    r.add_argument("--summary", required=True)
    r.add_argument("--metrics", default=None, help="JSON object")
    r.add_argument("--gate", default=None, help="path to `gate.py --json` output")
    rq = sub.add_parser("requeue")
    rq.add_argument("--id", required=True)
    rq.add_argument("--hypothesis", required=True, help="JSON object {metric, to_beat, ...}")
    rq.add_argument("--why", required=True)
    rt = sub.add_parser("record-tags")
    rt.add_argument("--library", required=True)
    for sp in (p, r, rq, rt):
        sp.add_argument("--queue", default=QUEUE_PATH)
        sp.add_argument("--ledger", default=LEDGER_PATH)
    a = ap.parse_args(argv)
    qpath = getattr(a, "queue", QUEUE_PATH)
    lpath = getattr(a, "ledger", LEDGER_PATH)
    q = load_queue(qpath)
    errs = validate(q)
    if errs:
        print("queue.json INVALID:\n  " + "\n  ".join(errs), file=sys.stderr)
        return 2
    if a.cmd == "check":
        print(f"queue.json OK — {len(q['items'])} items")
        return 0
    if a.cmd == "status":
        led = read_ledger(lpath)
        for it in sorted(q["items"], key=lambda i: (-i["priority"], i["id"])):
            print(f"{it['id']:<4} {it['lane']:<5} p{it['priority']:<3} {it['status']:<9} "
                  f"nights {nights_run(it['id'], led)}/{it['max_nights']}  {it['title']}")
        return 0
    if a.cmd == "pick":
        res = pick(q, read_ledger(lpath), {"state_dir": a.state_dir})
        if not a.dry_run:
            append_ledger({"event": "picked", "id": res["item"], "mode": res["mode"],
                           "checked": [{"id": c["id"], "eligible": c["eligible"]} for c in res["checked"]]}, lpath)
        if a.json:
            print(json.dumps(res, indent=1, ensure_ascii=False))
        else:
            for c in res["checked"]:
                print(f"  {c['id']:<4} {c['lane']:<5} {'ELIGIBLE' if c['eligible'] else 'skip':<9}"
                      + (f" {c.get('why', '')}" if "why" in c else ""))
                for pc in c.get("preconditions", []):
                    print(f"        [{'ok' if pc['pass'] else 'NO'}] {pc['kind']}: {pc['detail']}")
            verb = {"run": "RUN (auto lane — may apply only through the dual-run gate)",
                    "price": "MEASURE to price the proposal (jake lane — never applies)",
                    "idle": "IDLE — nothing eligible; measure the baseline only"}[res["mode"]]
            print(f"PICK: {res['item'] or '-'} — {verb}")
        return 0
    if a.cmd == "record":
        gate = json.load(open(a.gate, encoding="utf-8")) if a.gate else None
        row = record(q, a.id, a.outcome, a.summary, json.loads(a.metrics) if a.metrics else None, gate, lpath)
        save_queue(q, qpath)
        print(f"recorded {a.id} {a.outcome} -> status {next(i for i in q['items'] if i['id'] == a.id)['status']} ({row['at']})")
        return 0
    if a.cmd == "requeue":
        row = requeue(q, a.id, json.loads(a.hypothesis), a.why, read_ledger(lpath))
        append_ledger(row, lpath)
        save_queue(q, qpath)
        print(f"re-queued {a.id} under a new hypothesis")
        return 0
    if a.cmd == "record-tags":
        tracks = S.load_tracks(a.library)
        os.makedirs(os.path.dirname(TAGS_PATH), exist_ok=True)
        with open(TAGS_PATH, "w", encoding="utf-8") as f:
            json.dump({"_meta": {"recorded_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                                 "library_sha": S.file_sha(a.library), "tracks": len(tracks),
                                 "what": "genre tag per track the MAIN index text was last embedded with (E2's churn baseline)"},
                       "tags": {str(t["id"]): str(t.get("genre") or "").strip() for t in tracks}}, f)
        append_ledger({"event": "tags-recorded", "id": "E2", "library_sha": S.file_sha(a.library)}, lpath)
        print(f"recorded {len(tracks)} genre tags -> {os.path.relpath(TAGS_PATH)}")
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
