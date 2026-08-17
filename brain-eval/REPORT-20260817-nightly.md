# Nightly brain exercise — 2026-08-17 (homemini)

**Brain untouched.** All measurement on a frozen /tmp snapshot; embeddings.bin
sha `6bd4aa12e23b` (9,593 vectors), mood-index sha `d8fe19e64392`. NAS
mtime/size verified stable ≥60 min before measuring and unchanged after
(re-checked at close). brain-trainer ran clean at 02:01 (+50 enriched →
9,307/9,583; one tempo-catchup re-embed; backlog ~276, draining at 50/night).

## Baseline (run_eval, frozen snapshot)

**retrieval 0.752 / grounding 1.000 / overall 0.876** — encoding-v2 normal
band. Per-probe identical to 08-15/16 except ret-006 0.60 (documented wobble
edge, was 0.60–0.64 all week) and ret-013 0.83. ret-014 0.20 / ret-015 0.50
unchanged.

## Router-truth: FOURTH point

diag_ret011_012 (unchanged legacy emulation, same ruler as 08-11/15/16):
**router-truth 0.818** vs identity-only 0.752. Series: 0.821, 0.821, 0.821,
0.818 — the −0.003 is entirely the ret-006 wobble both rulers share.
Production's ~+0.07 edge over the identity-only eval holds; P1 evidence now
four points. (Tonight's app-faithful re-port — 24-word guard + albumArtist,
vs the diag's stale 8-word artist-only set — routes every eval probe
identically: 0.818 both ways.)

## Tonight's experiment: P2 quantification + collision audit → naive P2 VETOED, S2 recommended

P2 (08-11, "add 'the'-stripped artist variants to the router set") had no
numbers and no risk analysis. Two read-only scripts fixed that:

**Benefit is real and large.** 142 valid stripped variants; 140/142 bare-name
queries ("clash songs") flip mood→identity; scored sample mean **+0.75
recall@20** (identity vs mood; "clash songs" 1.00 vs 0.00, "postal service
songs" 1.00 vs 0.00). Eval router-truth 0.818 → **0.838 (+0.020)**, only the
intended ret-002 flip, no regression on any probe.

**But the naive one-liner is unsafe — vetoed by its own audit.** 57/142
variants are ordinary English words incl. plurals (`beat, band, sleeping,
cure, cars, doors, animals, zombies…`); naive substring matching hijacks
**10/12 realistic vibe queries** to the identity index ("music for sleeping"
→ artist:sleeping, "big band music" → artist:band), where vibe retrieval is
measurably worse. A singular-only dictionary check misses the plural trap
(cars/doors/zombies) — worth remembering.

**S2 keeps the whole benefit at zero measured risk:** dictionary-word
variants match only on artist-intent templates (`<x> songs`, `play <x>`, …).
0/12 hijacks, 142/142 coverage, all flagship bands ("cure/doors/smiths/
killers songs") still route to identity. S1 (drop dictionary-word variants)
would forfeit exactly the most bare-queried bands — rejected.

→ **PROPOSAL-p2-stripped-artist-guard.md** (supersedes the 08-11 P2 text):
quantified benefit, hijack evidence, S2 spec + implementation sketch, undo.
Still an app code change (desktop rebuild), so gated for Jake — nothing
applied.

## Applied tonight

**Nothing.** No brain-data change was on the table; brain sha verified
unchanged after measurement.

## Standing items

- **P1** (router-aware eval): now 4 identical-conclusion points, awaiting Jake.
- **P2**: upgraded from sketch → decision-ready proposal (S2). Awaiting Jake.
- **P3** (decade token), **taste-weights refresh**: unchanged, awaiting Jake.
- Skips still ~520/1000 — stays closed.
- 329 stale NAS tmps unchanged; daytime cleanup still pending.

## Files

`p2_stripped_artist_audit.py`, `p2_safe_variant_check.py`,
`PROPOSAL-p2-stripped-artist-guard.md`, this report, +1 score_log row.
Worktree + throwaway venv + /tmp snapshot removed after commit.
