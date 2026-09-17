# Nightly brain exercise — 2026-09-17 (homemini)

**Outcome: (b) — nothing beat baseline, nothing applied; brain untouched.**
The night's one bounded exercise was the PRE-REGISTERED falsifiable test from
09-16: does the frozen stale-215 mood cohort drain on tonight's trainer run
(215 → ~198), proving the queue-tail hypothesis? **It did. Confirmed at
id-level; no reopen.**

## Integrity

- embeddings.bin sha1 `a6c5b56ec51e` (67,818,600 B, mtime 02:01) — identical
  before measurement and after the run. mood-index.bin `e8ac697667ac`
  (66,994,768 B). All measurement on frozen `/tmp/brain-snap-20260917`.
- Trainer clean, launchd 06:00–06:01Z: +50 enriched (10,679/10,879),
  embeddings.bin 11,031 vectors, mood-index 10,897.
- **13th consecutive no-clobber day** (clobber 15/26) on a +2-import day —
  fingerprint the same benign 18 orphans / 5 dup groups (identical id list).
  Emb orphans 152 steady.
- API keys probed before spend: Anthropic 200 (1-token), OpenAI 200.

## Baseline (identity eval, frozen snapshot)

retrieval **0.744** / grounding **1.000** / overall **0.872** — encoding-v2
band, per-probe wobble all documented (ret-011 0.40 / ret-012 0.30 /
ret-014 0.17 / ret-015 0.40 = the known wrong-index ruler artifacts).

## Router-truth + sag decomposition (exp_20260917_sag_decomp.py)

- rt **0.813** (series 0.805→0.819→0.819→0.816→0.816→0.813→0.813→0.813→0.813).
- **NINTH orphan point: +0.013** (series 0.013/0.013/0.011×6/0.013) —
  nine-point-proven floor tax; worst per-probe delta vs S0 = +0.00 again.
  Trainer-side prune remains the Jake-gated fix.
- **Un-enriched component fell +0.007 → +0.004** — the drain is now visible
  in the decomposition itself (ret-013 unenriched slots recovering), even
  though headline rt hasn't moved yet. S2 ceiling 0.830 unchanged.

## KEY RESULT — stale-215 drain night 1 (exp_20260917_stale_drain_check.py)

Id-level set diff of the cohort across the 09-16/09-17 frozen snapshots:

- old cohort 215 → survivors **200**; **15 drained, 0 joined**.
- Predicted 17; the −2 gap is exactly the night's +2 fresh imports
  (ids 12002/12003) queue-jumping the recent-first head — both received full
  Gemma descriptors tonight (occupying 2 of the 50 batch slots) and both are
  in the mood-index. Direction, magnitude, and mechanism all match
  hypothesis A (pure queue tail). **No trainer bug; no reopen.**
- Revised drain schedule: 200 cohort ÷ ~50/night ≈ 4 more nights →
  un-enriched component gone ~09-21, rt walks 0.813 → ~0.830 (S2 ceiling).
  Remaining gap after that = orphan +0.013 (trainer-side prune, Jake-gated).

## Other standard checks

- Backlog 248 → **200** (7th drain night, −48 net on +2 imports; ~4 nights).
- Watchlist 33/34 un-encoded, queue pos ~2,988 ≈ 5–6 nights at 500/night
  (13th queue-order point for PROPOSAL-tempo-catchup-queue-order).
- **Taste-W premise guard PASS**: deployed v4 `W` byte-identical in all three
  places (V3 src/renderer/utils/tasteScore.ts, Mobile backend/src/util/
  tasteScore.ts, Mobile compiled dist) to the line PROPOSAL-taste-weights-
  refresh-v4 targets.
- Skip gate: not re-counted tonight (09-16: organic 1,186/3,000, CLOSED).
- Snapshots: /tmp/brain-snap-20260916 retained for the diff; tonight's left
  at /tmp/brain-snap-20260917 (tomorrow's drain check diffs against it).

## Applied / rejected

- Applied: **nothing** (no candidate outperformed baseline; the night's
  exercise was a pre-registered measurement, which passed).
- Open Jake-gated items unchanged: trainer-side orphan prune (+0.013,
  nine-point) + mood-import-clobber fixes 4/5 = TOP asks;
  taste-weights-refresh-v4; P1/P2/P3; tempo-catchup-queue-order;
  mobile-failure-skip-cascade. Taste-drift monthly due ~10-13 (v4 script;
  re-diff deployed W first).
