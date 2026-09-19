# Nightly brain exercise — 2026-09-19 (homemini)

**Outcome: (b) — nothing beat baseline, nothing applied; brain untouched.**
The night's one bounded exercise was drain-check night 3 on the stale mood
cohort (pre-registered 09-16, confirmed 09-17/18): cohort 150 → 104,
**46 drained, 0 joined** — the −4 vs the nominal 50 is exactly the night's
4 fresh imports (ids 12004–12007) queue-jumping the recent-first head, the
same mechanism as night 1's −2. Hypothesis A (pure queue tail) holds with
zero residual for a third consecutive night. ~2 nights to empty (~09-21).

## Integrity

- embeddings.bin sha1 `384900455915` (67,843,192 B, mtime 02:01) —
  identical before measurement and after the run. mood-index.bin
  `dc0fc9dde647` (67,019,360 B, 02:01). All measurement on the frozen,
  md5-verified `/tmp/brain-snap-20260919`.
- Trainer clean, launchd 06:00–06:01Z: +50 enriched (10,779/10,883),
  embeddings.bin 11,035 vectors, mood-index 10,901.
- **15th consecutive no-clobber day** (clobber 15/28) on a +4-import day
  (library 10,879 → 10,883) — fingerprint the same benign 18 orphans
  (identical id list). Dup groups **5 → 4** (dup_tracks 21): one prior
  benign group resolved as its members got distinct enriched vectors —
  the opposite direction of a clobber (whose signature is ~96 orphans /
  ~46 dup groups). Emb orphans 152 steady.
- API keys probed before spend: OpenAI 200, Anthropic 200 (1-token).

## Baseline (identity eval, frozen snapshot)

retrieval **0.745** / grounding **1.000** / overall **0.872** — back in the
v2 band after 09-18's 0.738 one-slot wobble, confirming that reading was
ruler noise. All four wrong-index ruler artifacts in their usual range
(ret-011 0.40 / ret-012 0.30 / ret-014 0.17 / ret-015 0.50); grounding
10/10 incl. traps.

## KEY RESULT — drain night 3 (exp_20260919_stale_drain_check.py)

Id-level set-diff across frozen snapshots 09-18 vs 09-19:
old cohort 150 → survivors 104, drained 46, joined 0. New library ids
12004–12007 (4 imports) took 4 of the 50 batch slots from the head of the
recent-first queue — accounting for the drain shortfall exactly, as on
night 1. Backlog census agrees: 150 → 104 (+50 enriched, +4 imports).
Cohort empty in ~2 more nights; then rt should walk toward the S2 ceiling
and the residual gap is pure orphan tax.

## Router-truth + sag decomposition (exp_20260919_sag_decomp.py)

rt **0.802** (series 0.813×4 → 0.806 → 0.802), fully decomposed, zero
residual (0.802 + 0.016 + 0.011 ≈ S2 0.828 exact):

- **Orphan component +0.016 — ELEVENTH point** (0.013/0.013/0.011×6/
  0.013/0.016/0.016), second consecutive night at the elevated level:
  the same 18 bare-genre orphans hold their climbed ranks after the
  nightly 500-vector re-encodes (ret-007 top-25 holds 4 orphan slots,
  ret-012 4, ret-008 1). Worst per-probe S1 delta +0.00 — the prune
  remains strictly non-harmful. Trainer-side orphan prune is now an
  eleven-point-proven +0.011–0.016 ask (Jake-gated,
  PROPOSAL-mood-import-clobber fix 2).
- **Un-enriched component +0.011** — REBOUND from 09-18's +0.004. Not a
  drain reversal: membership is id-proven draining (46 out, 0 in). This
  component is rank-dependent — the surviving 104 bare-genre vectors
  climbed into top-k neighborhoods reshaped by tonight's 500 re-encodes
  (ret-007 holds 5 un-enriched slots, ret-014 2). It goes to zero with
  the cohort regardless of nightly rank wobble.
- S2 ceiling **0.828** (0.826–0.843 healthy band). ret-011 mood-side 0.88,
  ret-015 0.80 — both healthy.

## Guards & counters

- Taste-W premise guard **PASS**: v4 W byte-identical in V3
  `src/renderer/utils/tasteScore.ts`, Mobile `backend/src/util/tasteScore.ts`,
  Mobile `backend/dist/util/tasteScore.js`.
- Watchlist 33/34 still te≠3; queue pos ~1,988 ≈ **4 nights** at 500/night
  (15th queue-order point).
- Skip gate not re-counted (09-16: organic 1,186/3,000, CLOSED; count only
  via skip_log_forensics, never the raw counter).
- Taste-drift monthly due ~10-13 (v4 script; re-diff deployed W first).

## Why nothing was applied

Same three standing reasons: rt below the 0.83 apply band with the shortfall
fully decomposed into two known, converging components; a mood-only prune
cannot move run_eval retrieval/overall (the pre-registered keep bar); and a
NAS-only prune gets resurrected by the next desktop replay — the durable fix
is trainer-side (Jake-gated). The drain needs no intervention by design.

Snapshot kept at /tmp/brain-snap-20260919 (tomorrow's set-diff needs it +
20260918). Top asks unchanged: clobber fixes 4/5 + trainer-side orphan prune.
