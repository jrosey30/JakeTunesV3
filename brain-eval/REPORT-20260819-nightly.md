# Nightly brain exercise — 2026-08-19 (homemini)

**Outcome: (b) nothing beat baseline, nothing changed — and the 08-18 repair
PROVED DURABLE.** Watch item cleared: no clobber recurrence. Brain untouched.

## Pipeline pre-flight
- brain-trainer finished cleanly 02:01 EDT (+50 enriched → 9,407/9,590;
  embeddings.bin 9,663 vectors, sha `f2ace36ddf24`; mood-index 9,590 vectors,
  sha `7bbf831e2e20`). Files stable ≥64 min before measurement.
- mood-index total 9,662 → 9,590 across the trainer's own write tonight =
  exactly the 72 pruned orphans staying gone. The repair survives the
  trainer's read-modify-write cycle (first hard proof of that).
- library.json untouched since 08-18 00:02 — zero daytime imports/churn
  yesterday, so the clobber writer (import-time embed + day sync) never fired.
- All measurement on a frozen /tmp snapshot of all four state files.

## Baseline (run_eval, identity path)
**retrieval 0.766 / grounding 1.000 / overall 0.883** — normal v2 band,
slightly above 08-18 (0.763). Self-test fired. Harness trusted.

## WATCH ITEM (from 08-18): genre-probe mood scores — CLEARED
| probe | query | post-repair | tonight |
|---|---|---|---|
| ret-007 | punk rock | 1.00 | **1.00** |
| ret-008 | hip-hop and rap | ≥0.84 | **0.96** |
| ret-011 | funk and soul | 0.84 | **0.88** |
| ret-012 | new wave 80s | 1.00 | **1.00** |

**router-truth 0.837** (vs 0.836 live-verified post-apply on 08-18, 0.762
corrupted). Series: 0.821 ×3, 0.818, [0.762→0.836 repair], **0.837**. The
repaired level is now a stable point ~0.016 ABOVE the old 0.821 band — the
orphan poison removal + fresher re-embeds were a real net gain, not just a
restore. 6th router-truth point; identity-vs-router gap (0.766 vs 0.837)
remains the standing P1 exhibit.

## Integrity sweep (read-only, beyond the probes)
- Byte-identical duplicate scan on mood-index: **2 groups, 4 tracks** (vs 39
  groups / 228 tracks at the corruption peak). Both are same-artist pairs of
  recent un-enriched imports (Noelle & The Deserters 9827/9830, Lindstrøm
  9960/9961) whose interim mood texts coincide — the nightly-50 will enrich
  them; expected to self-resolve. NOT the clobber signature (no bare-genre
  fingerprint groups, no cross-artist collapse).
- **Orphans in mood-index: 0.** Clean.

## Tried / applied / rejected
- Tried: baseline eval + router-truth + per-probe watch + duplicate/orphan
  integrity scan. All measurement, all read-only.
- Applied: **nothing** — no candidate beat baseline; no corruption to repair;
  every actionable lever is either gated on Jake (P1 router-aware eval, P2 S2
  stripped-artist guard, P3 decade-token, taste-weights refresh,
  mood-import-clobber root-cause fix) or closed by prior measurement (skip
  signal until ~1k, orphan prune = 0.000).
- Rejected: nothing new to reject.

## Standing items
- Skips **538**/1000 — stays closed (was 529).
- Taste-drift re-run due ~09-16.
- If dup-pair count GROWS across nights without library churn, that's a new
  writer pattern — investigate before it reaches probe-visible scale.
- 329 stale NAS tmps + 73 identity-index orphans: daytime hygiene, benign.
- Gated proposals unchanged, awaiting Jake: PROPOSAL-mood-import-clobber.md
  (root cause — the ONLY thing that prevents a repeat; tonight was quiet only
  because there were no imports), PROPOSAL-p2-stripped-artist-guard.md,
  PROPOSAL-taste-weights-refresh.md, PROPOSAL-ret015-aggression-enrichment.md.

## Files
- score_log.jsonl: +1 row (brain `f2ace36ddf24`, 0.766/1.000/0.883).
- No brain files written. No backups needed. Snapshot + venv + worktree
  cleaned after commit.
