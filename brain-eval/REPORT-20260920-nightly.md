# Nightly brain exercise — 2026-09-20 (homemini)

**Outcome: (b) — nothing beat baseline, nothing applied; brain untouched.**
The night's one bounded exercise was drain-check night 4 on the stale mood
cohort: cohort 104 → 90, **14 drained, 0 joined** — and the night's
**36 fresh imports (ids 12008–12043) + 14 cohort head = 50 exactly**, zero
residual for a FOURTH consecutive night. Hypothesis A (pure queue tail)
needs no further defense. The import wave stretches cohort-empty past the
old ~09-21 estimate (~2 more quiet nights; each import day defers it).

## Integrity

- embeddings.bin sha1 `22795dd0de5f` (68,064,520 B, mtime 02:01) —
  identical before measurement and after the run; snapshot shas match the
  live NAS files byte-for-byte. mood-index.bin `4eb3f025a87a`
  (67,240,688 B, 02:01). All measurement on frozen
  `/tmp/brain-snap-20260920`.
- Trainer clean, launchd 06:00–06:01Z: +50 enriched (10,829/10,919),
  embeddings.bin 11,071 vectors, mood-index 10,937.
- **16th consecutive no-clobber day — on a +36-import day** (library
  10,883 → 10,919), the biggest import day since the clobber era: same
  benign 18-orphan id list, dup groups 4 (dup_tracks 21) unchanged,
  emb orphans 152 steady. Strongest single-day evidence yet that whatever
  stopped the clobber (last event 09-04) is durable under import load —
  though fixes 4/5 remain the root-cause ask.
- API keys probed before spend: OpenAI 200, Anthropic 200 (1-token).

## Baseline (identity eval, frozen snapshot)

retrieval **0.740** / grounding **1.000** / overall **0.870** — a hair
below the 0.744 band floor, same shape as 09-18's 0.738 which decomposed
as ruler noise; tonight likewise: rt flat and the decomp closes with zero
residual, so the dip is identity-ruler slot wobble, not production. All
four wrong-index artifacts in usual ranges (ret-011 0.40 / ret-012 0.30 /
ret-014 0.17 / ret-015 0.50); grounding 10/10 incl. traps.

## KEY RESULT — drain night 4 (exp_20260920_stale_drain_check.py)

Id-level set-diff across frozen snapshots 09-19 vs 09-20:
old cohort 104 → survivors 90, drained 14, joined 0. New library ids
12008–12043 (36 imports) took 36 of the 50 batch slots from the head of
the recent-first queue — 36 + 14 = 50, the drain arithmetic closes exactly
as on nights 1–3. Backlog census agrees: 104 → 90 (+50 enriched, +36
imports). Mechanism fully understood; no intervention by design.

## Router-truth + sag decomposition (exp_20260920_sag_decomp.py)

rt **0.802 flat** (series 0.813×4 → 0.806 → 0.802 → 0.802), fully
decomposed, zero residual (0.802 + 0.016 + 0.010 = S2 0.828 exact):

- **Orphan component +0.016 — TWELFTH point** (0.013/0.013/0.011×6/
  0.013/0.016×3), third consecutive night at the elevated level: the same
  18 bare-genre orphans hold their climbed ranks (ret-007 top-25 holds 4
  orphan slots, ret-012 4, ret-008 1). Worst per-probe S1 delta +0.00 —
  the prune remains strictly non-harmful. Trainer-side orphan prune is now
  a twelve-point-proven +0.011–0.016 ask (Jake-gated,
  PROPOSAL-mood-import-clobber fix 2).
- **Un-enriched component +0.011** — steady at the rank-wobble level
  (ret-007 holds 5 un-enriched slots). Id-proven draining; goes to zero
  with the cohort.
- S2 ceiling **0.828** (0.826–0.843 healthy band). ret-011 mood-side 0.88,
  ret-015 0.80 — both healthy.

## Guards & counters

- Taste-W premise guard **PASS**: v4 W line byte-identical in V3
  `src/renderer/utils/tasteScore.ts:89`, Mobile
  `backend/src/util/tasteScore.ts:87`, Mobile
  `backend/dist/util/tasteScore.js:63`.
- Watchlist 33/34 still te≠3; queue pos ~1,488 ≈ **3 nights** at 500/night
  (16th queue-order point) — but tonight's 36-import wave may push it back.
- Skip gate not re-counted (09-16: organic 1,186/3,000, CLOSED; count only
  via skip_log_forensics, never the raw counter).
- Taste-drift monthly due ~10-13 (v4 script; re-diff deployed W first).

## Why nothing was applied

Same three standing reasons: rt below the 0.83 apply band with the
shortfall fully decomposed into two known, converging components; a
mood-only prune cannot move run_eval retrieval/overall (the pre-registered
keep bar); and a NAS-only prune gets resurrected by the next desktop
replay — the durable fix is trainer-side (Jake-gated). The drain needs no
intervention by design.

Snapshot kept at /tmp/brain-snap-20260920 (tomorrow's set-diff needs it +
20260919). Top asks unchanged: clobber fixes 4/5 + trainer-side orphan
prune (now twelve-point).
