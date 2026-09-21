# Nightly brain exercise — 2026-09-21 (homemini)

**Outcome: (b) — nothing beat baseline, nothing applied; brain untouched.**
The night's one bounded exercise was drain-check night 5 on the stale mood
cohort: cohort 90 → 40, **50 drained, 0 joined, ZERO imports** — the full
50-slot batch went to the cohort head, zero residual a FIFTH consecutive
night. At 40 survivors (< the 50/night batch), the cohort should EMPTY on
tomorrow's trainer run barring a new import wave. Hypothesis A needs no
further defense; the drain finishes by design, not intervention.

## Integrity

- embeddings.bin sha1 `010f1bbf7028` (68,064,520 B, mtime 02:01) —
  identical before measurement and after the run; snapshot shas match the
  live NAS files byte-for-byte. mood-index.bin `b54f1ad153fc`
  (67,240,688 B, 02:01). All measurement on frozen
  `/tmp/brain-snap-20260921`.
- Trainer clean, launchd 06:00–06:01Z: +50 enriched (10,879/10,919),
  embeddings.bin 11,071 vectors, mood-index 10,937.
- **17th consecutive no-clobber day**: same benign 18-orphan id list, emb
  orphans 152 steady. Dup groups **4 → 2 (dup_tracks 21 → 9)** — the
  n=5 (11257–11261) and n=4 (11338–11341, also orphans) groups remain;
  the two that dissolved are enrichment individualizing former bare-genre
  duplicates — the healthy direction, not a clobber signal.
- API keys probed before spend: OpenAI 200, Anthropic 200 (1-token).

## Baseline (identity eval, frozen snapshot)

retrieval **0.738** / grounding **1.000** / overall **0.869** — same
ruler-wobble band as 09-18 (0.738) and 09-20 (0.740); rt UP tonight and
the decomp closes zero-residual, so the identity-ruler dip is slot wobble,
not production. Wrong-index artifacts in usual ranges (ret-011 0.44 /
ret-012 0.30 / ret-014 0.17 / ret-015 0.43); grounding 10/10 incl. traps.

## KEY RESULT — drain night 5 (exp_20260921_stale_drain_check.py)

Id-level set-diff across frozen snapshots 09-20 vs 09-21:
old cohort 90 → survivors 40, drained 50, joined 0, new library ids NONE.
First quiet night since the import wave: all 50 batch slots went to the
cohort head — arithmetic closes exactly a fifth night. Backlog census
agrees: 90 → 40. Empty-cohort prediction: **tomorrow night** (09-22) if
no imports; each import day defers by its size.

## Router-truth + sag decomposition (exp_20260921_sag_decomp.py)

rt **0.804 — first uptick since the sag began**
(series 0.813×4 → 0.806 → 0.802 → 0.802 → 0.804), fully decomposed,
zero residual (0.804 + 0.016 + 0.008 = S2 0.828 exact):

- **Orphan component +0.016 — THIRTEENTH point** (0.013/0.013/0.011×6/
  0.013/0.016×4), fourth consecutive night elevated: the same 18
  bare-genre orphans hold their ranks (ret-007 top-25 holds 4 orphan
  slots, ret-012 4, ret-008 1). S1 worst per-probe delta +0.00 — the
  prune remains strictly non-harmful. Trainer-side orphan prune is now a
  thirteen-point-proven +0.011–0.016 ask (Jake-gated,
  PROPOSAL-mood-import-clobber fix 2).
- **Un-enriched component +0.008** — shrinking with the cohort
  (0.011 → 0.008; ret-007 down to 5 un-enriched slots). Goes to zero
  when the cohort empties (~tomorrow).
- S2 ceiling **0.828** (0.826–0.843 healthy band). ret-011 mood-side
  0.88, ret-015 0.80 — both healthy.

## Guards & counters

- Taste-W premise guard **PASS**: v4 W line identical in V3
  `src/renderer/utils/tasteScore.ts:89`, Mobile
  `backend/src/util/tasteScore.ts:87`, Mobile
  `backend/dist/util/tasteScore.js:63`.
- Watchlist 33/34 still te≠3; queue pos ~988 ≈ **2 nights** at 500/night
  (17th queue-order point).
- Skip gate not re-counted (09-16: organic 1,186/3,000, CLOSED; count
  only via skip_log_forensics, never the raw counter).
- Taste-drift monthly due ~10-13 (v4 script; re-diff deployed W first).

## Why nothing was applied

Same three standing reasons: rt below the 0.83 apply band with the
shortfall fully decomposed into two known components (one converging to
zero ~tomorrow, one awaiting the Jake-gated trainer-side prune); a
mood-only prune cannot move run_eval retrieval/overall (the
pre-registered keep bar); and a NAS-only prune gets resurrected by the
next desktop replay — the durable fix is trainer-side (Jake-gated). The
drain needs no intervention by design.

Snapshot kept at /tmp/brain-snap-20260921 (tomorrow's set-diff needs it +
20260920 — tomorrow is the empty-cohort verification night). Top asks
unchanged: clobber fixes 4/5 + trainer-side orphan prune (now
thirteen-point).
