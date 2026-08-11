#!/usr/bin/env python3
"""
brain-eval/stage_dataset.py — GATHERS real Music Man usage into a versioned,
append-only pile for a FUTURE, deliberate, human-gated fine-tune. It does NOT
train anything and does NOT touch the app, the brain-trainer, or embeddings.bin.

THE ONE RULE applies: read the interaction log, write only staged_dataset.jsonl.

SOURCE REALITY (verified): the only usage log is
  ~/Library/Application Support/JakeTunes/musicman-interactions.jsonl
Its rows look like:
  {"at":<ms>,"mode":"mic|dj|chat","persona":"mm|stephen","track":{title,artist,...},"response":"..."}
=> It captures (track context -> Music Man response). It does NOT capture the
   user's actual prompt, nor any correction / confirm / reject signal. So every
   staged example is marked vetted:false and prompt is RECONSTRUCTED from the
   track context. A real prompt+correction log is a PREREQUISITE for high-quality
   training data and is its own future brief. We flag that rather than fake it.

USAGE:
  python stage_dataset.py --dry-run     # report what would be added; write nothing
  python stage_dataset.py               # append new (deduped) examples, vetted:false
"""
import argparse, hashlib, json, os, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
STATE_DIR = os.path.expanduser("~/Library/Application Support/JakeTunes")
SRC = os.path.join(STATE_DIR, "musicman-interactions.jsonl")
OUT = os.path.join(HERE, "staged_dataset.jsonl")

def sig(row):
    return hashlib.sha1(f"{row.get('at','')}|{(row.get('response') or '')[:120]}".encode()).hexdigest()[:16]

def reconstruct_prompt(row):
    t = row.get("track") or {}
    who = f"\"{t.get('title','?')}\" by {t.get('artist','?')}"
    mode = row.get("mode", "")
    if mode == "dj":
        return f"DJ intro for the track now playing: {who}."
    if mode == "chat":
        return f"(chat) Talk about {who}."
    return f"React to {who} playing."

def load_existing_sigs():
    sigs = set()
    if os.path.exists(OUT):
        for line in open(OUT, encoding="utf-8"):
            line = line.strip()
            if not line:
                continue
            try:
                sigs.add(json.loads(line).get("sig"))
            except Exception:
                pass
    return sigs

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="report only; write nothing")
    args = ap.parse_args()

    if not os.path.exists(SRC):
        print(f"[note] no interaction log at {SRC}. Nothing to stage. "
              "(A usage log is a prerequisite — its own future brief.)")
        # still leave a correct, empty pipeline
        return

    existing = load_existing_sigs()
    rows, skipped_dupe, skipped_bad = [], 0, 0
    for line in open(SRC, encoding="utf-8"):
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except Exception:
            skipped_bad += 1
            continue
        resp = (row.get("response") or "").strip()
        if not resp:
            skipped_bad += 1
            continue
        s = sig(row)
        if s in existing:
            skipped_dupe += 1
            continue
        existing.add(s)
        rows.append({
            "sig": s,
            "prompt": reconstruct_prompt(row),
            "prompt_is_reconstructed": True,
            "response": resp,
            "persona": row.get("persona", "mm"),
            "mode": row.get("mode", ""),
            "track": row.get("track"),
            "source": "musicman-interactions.jsonl",
            "source_at": row.get("at"),
            "staged_at": int(time.time() * 1000),
            "vetted": False,
        })

    print(f"source rows scanned, {len(rows)} NEW stageable, "
          f"{skipped_dupe} already-staged, {skipped_bad} skipped(empty/bad).")
    if rows:
        print("  sample:", json.dumps({"prompt": rows[0]["prompt"],
              "response": rows[0]["response"][:80] + "…", "vetted": False}))

    if args.dry_run:
        print("[dry-run] wrote nothing. Re-run without --dry-run to append.")
        return
    if not rows:
        print("nothing new to append.")
        return
    with open(OUT, "a", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"appended {len(rows)} examples (vetted:false) to {os.path.relpath(OUT, os.path.dirname(HERE))}")
    print("NOTE: review + flip vetted:true by hand before this ever feeds a fine-tune. "
          "This brief only builds the pile; wiring it into training is a separate human-gated brief.")

if __name__ == "__main__":
    main()
