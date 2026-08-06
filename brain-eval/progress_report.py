#!/usr/bin/env python3
"""
Print the brain-eval drift table from score_log.jsonl.

Read-only. Never touches embeddings.bin, the trainer, or the app.
  python progress_report.py
  python progress_report.py --self-check
"""
from __future__ import annotations

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
LOG = os.path.join(HERE, "score_log.jsonl")
EVAL = os.path.join(HERE, "eval_set.json")
RUN = os.path.join(HERE, "run_eval.py")


def load_rows():
    if not os.path.exists(LOG):
        return []
    rows = []
    with open(LOG, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rows.append(json.loads(line))
    return rows


def fmt(x):
    if x is None:
        return "—"
    return f"{x:.4f}" if isinstance(x, float) else str(x)


def print_table(rows):
    if not rows:
        print("No score_log.jsonl rows yet. Run: python run_eval.py")
        return 1

    print("JakeTunes brain altimeter — score_log.jsonl")
    print("=" * 88)
    hdr = f"{'when':<20} {'brain_id':<14} {'vec':>5} {'ret':>8} {'grd':>8} {'overall':>8}"
    print(hdr)
    print("-" * 88)
    for j in rows:
        print(
            f"{j.get('iso','?'):<20} "
            f"{j.get('brain_id','?'):<14} "
            f"{j.get('vectors',0):>5} "
            f"{fmt(j.get('retrieval')):>8} "
            f"{fmt(j.get('grounding')):>8} "
            f"{fmt(j.get('overall')):>8}"
        )
    print("-" * 88)

    first, last = rows[0], rows[-1]
    d_ret = (last.get("retrieval") or 0) - (first.get("retrieval") or 0)
    d_ov = (last.get("overall") or 0) - (first.get("overall") or 0)
    d_vec = (last.get("vectors") or 0) - (first.get("vectors") or 0)
    print(
        f"Δ first→last:  retrieval {d_ret:+.4f}  overall {d_ov:+.4f}  "
        f"vectors {d_vec:+d}  (n={len(rows)} runs)"
    )

    # Working proof: grounding must stay perfect; overall must not collapse.
    grounds = [r.get("grounding") for r in rows if r.get("grounding") is not None]
    if grounds and min(grounds) < 1.0:
        print("WARN: grounding dipped below 1.0 — investigate Music Man hallucinations.")
        return 2
    if last.get("overall") is not None and last["overall"] < 0.7:
        print("WARN: overall < 0.70 — brain may have regressed.")
        return 2

    print("OK: grounding held at 1.0 across logged runs; overall above floor.")
    return 0


def self_check():
    """Harness integrity without network or live brain files."""
    errs = []
    for path, label in ((LOG, "score_log.jsonl"), (EVAL, "eval_set.json"), (RUN, "run_eval.py")):
        if not os.path.exists(path):
            errs.append(f"missing {label}")

    rows = load_rows()
    if len(rows) < 1:
        errs.append("score_log.jsonl is empty")

    try:
        ev = json.load(open(EVAL, encoding="utf-8"))
        prompts = ev.get("prompts") or []
        buckets = {}
        for p in prompts:
            buckets[p.get("bucket")] = buckets.get(p.get("bucket"), 0) + 1
        if buckets.get("retrieval", 0) < 10:
            errs.append(f"eval_set retrieval prompts too few: {buckets.get('retrieval')}")
        if buckets.get("grounding", 0) < 5:
            errs.append(f"eval_set grounding prompts too few: {buckets.get('grounding')}")
        # ret-015 must include metal after the 2026-07-12 recalibration
        ret015 = next((p for p in prompts if p.get("id") == "ret-015"), None)
        if not ret015:
            errs.append("ret-015 missing from eval_set")
        else:
            genres = (ret015.get("expected") or {}).get("genre_any") or []
            if "metal" not in [g.lower() for g in genres]:
                errs.append("ret-015 missing 'metal' after recalibration")
    except Exception as e:
        errs.append(f"eval_set.json unreadable: {e}")

    # One Rule: run_eval must not write embeddings.bin
    try:
        src = open(RUN, encoding="utf-8").read()
        if "open(EMB_PATH" in src and ("'wb'" in src or '"wb"' in src):
            errs.append("run_eval.py appears to write embeddings.bin — One Rule violated")
        if "THE ONE RULE" not in src:
            errs.append("run_eval.py missing One Rule banner")
    except Exception as e:
        errs.append(f"run_eval.py unreadable: {e}")

    if errs:
        print("SELF-CHECK FAILED:")
        for e in errs:
            print("  -", e)
        return 2

    print("SELF-CHECK OK")
    print(f"  score_log rows: {len(rows)}")
    print(f"  eval_set buckets: {buckets}")
    print(f"  latest overall: {fmt(rows[-1].get('overall'))}  "
          f"brain={rows[-1].get('brain_id')}  vec={rows[-1].get('vectors')}")
    print("  One Rule: run_eval does not write embeddings.bin")
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--self-check", action="store_true",
                    help="Validate harness files without live brain / network")
    args = ap.parse_args()
    if args.self_check:
        return self_check()
    return print_table(load_rows())


if __name__ == "__main__":
    sys.exit(main())
