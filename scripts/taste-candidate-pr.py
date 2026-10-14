#!/usr/bin/env python3
"""
taste-candidate-pr.py — Brief 194: the twin-PR generator for a taste
candidate (scripts/taste-candidate.py). The candidate job proposes;
this tool disposes — on Jake's Mac, by hand, never on a schedule.

Modes:
  --dry-run (DEFAULT): read the candidate, print the EXACT unified diffs
    it would apply to both repos' tasteScore W blocks, and verify the
    two W blocks are identical before AND after the would-be edit.
    Writes nothing, anywhere.
  --apply: perform the edits in two local clones and open twin PRs
    (one per repo) with git + gh. This is the only mode that changes
    anything, and it still only opens PRs — merging is Jake's call, and
    the nightly W guard remains as a backstop (Brief 159: no auto-refit;
    nothing here deploys or merges).

Hard gates (both modes):
  * The two existing W blocks must be BYTE-IDENTICAL before editing.
    If the twins have drifted, abort — fix the drift first; a candidate
    must never paper over it.
  * After editing (or simulating), the two new W blocks must again be
    byte-identical, or abort (in --apply, before any push).
  * --apply refuses a candidate whose beatsBaseline is false unless
    --allow-non-beating is passed explicitly. A losing candidate is
    reported by the candidate job, never hidden — and never promoted
    by accident.

Usage:
  python3 scripts/taste-candidate-pr.py [--candidate FILE]
      [--v3 PATH] [--mobile PATH] [--dry-run]
  python3 scripts/taste-candidate-pr.py --apply
      [--v3-repo DIR] [--mobile-repo DIR] [--allow-non-beating]

Defaults: candidate = $JT_STATE_DIR/taste-candidate.json (or the app
state dir); --v3/--mobile point at the tasteScore files inside the
clones given by --v3-repo/--mobile-repo (defaults: ~/JakeTunesV3 and
~/JakeTunesMobile).
"""
import argparse
import datetime
import difflib
import json
import os
import re
import subprocess
import sys

W_RE = re.compile(r"^const W = \{[^}]*\}$", re.MULTILINE)
KEY_ORDER = ["bias", "album", "artist", "genre", "decade", "plays", "recency", "intensity"]
V3_REL = os.path.join("src", "renderer", "utils", "tasteScore.ts")
MOBILE_REL = os.path.join("backend", "src", "util", "tasteScore.ts")


def fail(msg):
    print(f"taste-candidate-pr: ABORT — {msg}", file=sys.stderr)
    sys.exit(1)


def extract_w(path):
    text = open(path).read()
    m = W_RE.search(text)
    if not m:
        fail(f"no 'const W = {{...}}' line found in {path}")
    return text, m.group(0)


def format_w(W):
    missing = [k for k in KEY_ORDER if k not in W]
    if missing:
        fail(f"candidate W is missing keys: {missing}")
    inner = ", ".join(f"{k}: {float(W[k]):.3f}" for k in KEY_ORDER)
    return f"const W = {{ {inner} }}"


def apply_w(text, old_line, new_line):
    return text.replace(old_line, new_line, 1)


def main():
    ap = argparse.ArgumentParser(description="Twin-PR generator for a taste candidate (Brief 194).")
    ap.add_argument("--candidate", default=None)
    ap.add_argument("--v3", default=None, help="path to V3 tasteScore.ts")
    ap.add_argument("--mobile", default=None, help="path to mobile backend tasteScore.ts")
    ap.add_argument("--v3-repo", default=os.path.expanduser("~/JakeTunesV3"))
    ap.add_argument("--mobile-repo", default=os.path.expanduser("~/JakeTunesMobile"))
    ap.add_argument("--apply", action="store_true", help="edit both clones and open twin PRs (default is --dry-run)")
    ap.add_argument("--allow-non-beating", action="store_true", help="permit --apply for a candidate that does not beat the baseline")
    args = ap.parse_args()

    state_dir = os.environ.get("JT_STATE_DIR", os.path.expanduser("~/Library/Application Support/JakeTunes"))
    cand_path = args.candidate or os.path.join(state_dir, "taste-candidate.json")
    if not os.path.exists(cand_path):
        fail(f"no candidate file at {cand_path} — run scripts/taste-candidate.py first")
    cand = json.load(open(cand_path))
    if "W" not in cand:
        fail(f"{cand_path} has no W block")

    v3_path = args.v3 or os.path.join(args.v3_repo, V3_REL)
    mobile_path = args.mobile or os.path.join(args.mobile_repo, MOBILE_REL)
    for p in (v3_path, mobile_path):
        if not os.path.exists(p):
            fail(f"tasteScore file not found: {p}")

    v3_text, v3_w = extract_w(v3_path)
    mob_text, mob_w = extract_w(mobile_path)

    print(f"candidate: {cand_path}")
    print(f"  generatedAt={cand.get('generatedAt')} candidateCvAuc={cand.get('candidateCvAuc')} "
          f"baselineCvAuc={cand.get('baselineCvAuc')} beatsBaseline={cand.get('beatsBaseline')}")
    print(f"BEFORE: V3 W     {v3_w}")
    print(f"BEFORE: mobile W {mob_w}")
    if v3_w != mob_w:
        fail("the two W blocks are NOT identical before editing — the twins have drifted. "
             "Fix the drift first; refusing to paper over it.")
    print("BEFORE check: W blocks identical ✓")

    new_w = format_w(cand["W"])
    print(f"AFTER:  new W    {new_w}")
    new_v3 = apply_w(v3_text, v3_w, new_w)
    new_mob = apply_w(mob_text, mob_w, new_w)
    _, chk_v3 = (new_v3, W_RE.search(new_v3).group(0))
    _, chk_mob = (new_mob, W_RE.search(new_mob).group(0))
    if chk_v3 != chk_mob or chk_v3 != new_w:
        fail("post-edit verification failed: the two W blocks would NOT be identical after editing.")
    print("AFTER check: W blocks identical ✓")

    for label, path, old_text, new_text in (("JakeTunesV3", v3_path, v3_text, new_v3),
                                            ("JakeTunesMobile", mobile_path, mob_text, new_mob)):
        diff = difflib.unified_diff(old_text.splitlines(keepends=True), new_text.splitlines(keepends=True),
                                    fromfile=f"a/{label}:{os.path.basename(path)}",
                                    tofile=f"b/{label}:{os.path.basename(path)}")
        print(f"\n--- diff for {label} ({path}) ---")
        sys.stdout.writelines(diff)

    if not args.apply:
        print("\nDRY-RUN: nothing written. Re-run with --apply on the Mac (local clones + gh) to edit both files and open twin PRs.")
        return 0

    if not cand.get("beatsBaseline") and not args.allow_non_beating:
        fail("candidate does not beat the baseline (beatsBaseline is false). "
             "Refusing to promote it. Pass --allow-non-beating to override deliberately.")

    stamp = datetime.date.today().isoformat()
    branch = f"feat/taste-candidate-{stamp}"
    body = (f"Taste-model candidate W from scripts/taste-candidate.py (Brief 194).\n\n"
            f"candidateCvAuc {cand.get('candidateCvAuc')} vs baseline {cand.get('baselineCvAuc')} "
            f"(taste-eval history). Twin PR in the other repo carries the identical W block — "
            f"the two tasteScore copies must stay byte-identical (nightly W guard).\n\n"
            f"Nothing auto-deploys: review + merge is Jake's call (Brief 159).")
    for label, repo, path, new_text in (("JakeTunesV3", args.v3_repo, v3_path, new_v3),
                                        ("JakeTunesMobile", args.mobile_repo, mobile_path, new_mob)):
        def run(*cmd):
            r = subprocess.run(cmd, cwd=repo, capture_output=True, text=True)
            if r.returncode != 0:
                fail(f"{label}: {' '.join(cmd)} failed: {r.stderr.strip()[:300]}")
            return r.stdout.strip()
        run("git", "checkout", "-b", branch)
        open(path, "w").write(new_text)
        # verify on disk before committing
        _, on_disk = extract_w(path)
        if on_disk != new_w:
            fail(f"{label}: on-disk W after write is not the candidate W — aborting before commit")
        run("git", "add", path)
        run("git", "commit", "-m", f"Brief 194: taste candidate W (candidateCvAuc {cand.get('candidateCvAuc')} vs baseline {cand.get('baselineCvAuc')})")
        run("git", "push", "-u", "origin", branch)
        url = run("gh", "pr", "create", "--title", f"Brief 194: taste candidate W ({stamp})",
                  "--body", body, "--head", branch)
        print(f"{label}: PR opened — {url}")
    print("twin PRs opened. Merging is Jake's call; the nightly W guard remains the backstop.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
