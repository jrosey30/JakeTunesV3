# Nightly brain exercise — 2026-09-12 (homemini, ~03:05)

**Outcome: (b) nothing beat baseline under the bars — brain untouched.**
One read-only experiment ran (fourth sag decomposition, second drain night);
its numbers were appended to three standing proposals. Nothing applied.

## Coordination

- brain-trainer clean via launchd 06:00:02–06:01:55Z (+50 enriched; embeddings
  10,796 vectors == log; library 10,876 both in the trainer log and the
  03:07 snapshot — small night, +13 imports).
- NAS reads sha-stable ×3 (20s apart) before snapshot: embeddings
  `bf6255dd8363`, mood `bbcb53a42a67`. Snapshot `/tmp/brain-snap-20260912`
  byte-identical.
- Brain untouched: same shas + mtimes re-verified at session end.

## Pre-check (clobber fingerprint — precheck_20260912.py)

18 orphans / 5 dup groups — **same benign orphan id list** as
09-08 through 09-11 (9796/9820/9863/10642/10923/10924 + the 11338–11349
block). NOT the replay signature. **8th consecutive no-clobber import day**
(still luck, not fix — the replay writer is unfixed). Embeddings orphans
steady at 152.

## Baseline (frozen snapshot, 1-token key probe 200 first)

retrieval **0.747** / grounding **1.000** (traps 4/4) / overall **0.874** —
in-band (series 0.744–0.757). score_log row appended (brain_id
`bf6255dd8363`, vectors 10796). Known artifacts unchanged: ret-014
identity-side 0.20 (wrong-index ruler, P3 — mood-side 0.30, router sends it
to mood, router-truth unaffected), ret-012 0.35, ret-011 0.40.

## Router-truth (rt_20260912.py)

**0.816** — a one-slot dip from the recovery plateau (series 0.818 → 0.816 →
0.811 → 0.808 → 0.805 → 0.819 → 0.819 → **0.816**). mood-routed mean
0.803/9 — identical to 09-10/09-11, so the dip is main-routed: ret-006
(decade probe) 0.72, one k=25 slot below its recent 0.76. Noise-order.
Known artifacts unchanged: ret-002 0.70 (P2), ret-012 0.35 (P3 decade-guard
miss), ret-014 0.30 (wrong-index ruler).

## Experiment: sag decomposition, fourth point (exp_20260912_sag_decomp.py, READ-ONLY)

Question: does the orphan floor tax stay constant on a second consecutive
drain night, and is the remaining wave component still healing?

| scenario | rt 09-09 | rt 09-10 | rt 09-11 | rt 09-12 |
|---|---|---|---|---|
| S0 current | 0.805 | 0.819 | 0.819 | 0.816 |
| S1 minus 18 orphans | +0.013 | +0.013 | +0.011 | **0.827 (+0.011)** |
| S2 minus orphans + un-enriched | 0.840 | 0.843 | 0.839 | **0.836** |

- **Orphan component +0.011** — fourth measurement, constant to the third
  decimal across sag / recovery / drain / drain. Worst per-probe delta
  +0.00 a fourth night (the prune never hurts anything). Slot occupancy
  unchanged (ret-007 4/25, ret-012 4/20, ret-008 1/25). Appended to
  PROPOSAL-mood-import-clobber fix 2 — the case is four-point-proven.
- **Un-enriched component +0.009** (series +0.022 → +0.011 → +0.009 →
  +0.009) — the self-heal curve has FLATTENED, and the reason is measured:
  the mood-index un-enriched-in-lib cohort is exactly **215 for a THIRD
  night** while the backlog fell 485→447. The stale cohort sits at earlier
  library-order queue positions; nightly enrichment of newer positions never
  touches it. Three-point-proven; appended to
  PROPOSAL-enrichment-backlog-drain and cross-linked to
  PROPOSAL-tempo-catchup-queue-order (same queue-order defect).
- **S2 = 0.836** — inside the healthy 0.833–0.844 band; nothing hidden.

**NOT applied** — same three reasons as 09-09/09-10/09-11: a mood-only prune
cannot move run_eval retrieval/overall (guardrail fails strictly); a NAS-only
prune is resurrected by the next replay event; the durable fix is
trainer-side, which the harness must not touch (THE ONE RULE). Four
independent measurements now sit in the proposal; the decision is Jake's.

## Watches / bookkeeping

- Enrichment backlog **485→447** (−38: +50 enriched vs +13 imports) — second
  consecutive real drain night; ~9 quiet nights to clear.
- Watchlist 11467–11499+454: **33/34 still te=False** after an 8th "500 on an
  older encoding" night; queue pos ~5,488 ≈ **10 nights out** (8th data point
  for PROPOSAL-tempo-catchup-queue-order).
- Taste-drift re-run due ~09-16 (four nights out). Skip v4 re-run gate
  ~3k merged skips (~mid-Oct) — not due, not touched.
- Expectation refined: rt stays ~0.816–0.819 with ±0.003 slot noise until
  either (a) the queue reaches the 215-track stale cohort (+~0.009) or
  (b) a trainer-side orphan prune lands (+~0.011). The two fixes are
  independent and additive: together they put rt at the ~0.836 S2 ceiling.
