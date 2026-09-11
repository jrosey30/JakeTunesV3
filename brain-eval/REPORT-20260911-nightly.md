# Nightly brain exercise — 2026-09-11 (homemini, ~03:05)

**Outcome: (b) nothing beat baseline under the bars — brain untouched.**
One read-only experiment ran (third sag decomposition, this time on a drain
night); its numbers were appended to the two standing proposals. Nothing
applied.

## Coordination

- brain-trainer clean via launchd 06:00:01–06:01:49Z (+50 enriched; embeddings
  10,746 vectors == log; library 10,863 in the trainer log, 10,864 in the
  03:07 library.json snapshot — one import landed between 02:00 and 03:07,
  benign, brain files untouched by it).
- NAS reads sha-stable ×3 (20s apart) before snapshot: embeddings
  `9d8cf6d5fdce`, mood `e9d626663ea0`. Snapshot `/tmp/brain-snap-20260911`
  byte-identical.
- Brain untouched: same shas + mtimes re-verified at session end.

## Pre-check (clobber fingerprint — precheck_20260911.py)

18 orphans / 5 dup groups — **same benign orphan id list** as
09-08/09-09/09-10 (9796/9820/9863/10642/10923/10924 + the 11338–11349 block).
NOT the replay signature. **7th consecutive no-clobber import day** (still
luck, not fix — the replay writer is unfixed). Embeddings orphans steady
at 152.

## Baseline (frozen snapshot, 1-token key probe 200 first)

retrieval **0.750** / grounding **1.000** (traps 4/4) / overall **0.875** —
in-band (series 0.744–0.757). score_log row appended (brain_id
`9d8cf6d5fdce`, vectors 10746). One wobble: ret-014 identity-side 0.30→0.20
(known wrong-index ruler, P3 — its mood-side score is unchanged at 0.30, and
the router sends it to mood, so router-truth is unaffected).

## Router-truth (rt_20260911.py)

**0.819** — flat at the recovery level (series 0.818 → 0.816 → 0.811 → 0.808
→ 0.805 → 0.819 → **0.819**). mood-routed mean 0.803/9, identical to 09-10.
Known artifacts unchanged: ret-002 0.70 (P2), ret-012 0.35 (P3 decade-guard
miss), ret-014 0.30 (wrong-index ruler).

## Experiment: sag decomposition, third point (exp_20260911_sag_decomp.py, READ-ONLY)

Question: does the orphan floor tax persist on a *drain* night (backlog
falling, rt flat), and how much of the remaining gap to the healthy band is
still wave?

| scenario | rt 09-09 | rt 09-10 | rt 09-11 |
|---|---|---|---|
| S0 current | 0.805 | 0.819 | 0.819 |
| S1 minus 18 orphans | 0.818 (+0.013) | 0.832 (+0.013) | **0.830 (+0.011)** |
| S2 minus orphans + un-enriched (215) | 0.840 | 0.843 | **0.839** |

- **Orphan component +0.011** — third measurement, constant-order across a
  sagging, a recovering, and a drain night. The dip from +0.013 is slot
  arithmetic (ret-013), not healing. Slot occupancy unchanged a third night
  (ret-007 4/25, ret-012 4/20, ret-008 1/25). Appended to
  PROPOSAL-mood-import-clobber fix 2.
- **Un-enriched component +0.009** (series +0.022 → +0.011 → +0.009) —
  self-heal on schedule.
- **S2 = 0.839** — inside the healthy 0.833–0.844 band; nothing hidden.
- Curiosity: the mood-index un-enriched-in-lib cohort is exactly **215 for a
  second night** despite the backlog falling 47 — tonight's newly-enriched 50
  entered the mood index *at* enrichment, so the stale bare-genre cohort only
  drains when the queue reaches those import-day tracks (noted in
  PROPOSAL-enrichment-backlog-drain).

**NOT applied** — same three reasons as 09-09/09-10: a mood-only prune cannot
move run_eval retrieval/overall (guardrail fails strictly); a NAS-only prune
is resurrected by the next replay event; the durable fix is trainer-side,
which the harness must not touch (THE ONE RULE). The proposal now carries
three independent measurements; the decision is Jake's.

## Watches / bookkeeping

- Enrichment backlog **532→485** (−47: +50 enriched vs +2 imports) — **first
  real drain night**; batch=50 wins exactly when imports pause, as the
  proposal predicted. ~10 quiet nights to clear.
- Watchlist 11467–11499+454: **33/34 still te=False** after a 7th "500 on an
  older encoding" night; queue pos ~5,988 ≈ **11 nights out** (7th data point
  for PROPOSAL-tempo-catchup-queue-order).
- Taste-drift re-run due ~09-16. Skip v4 re-run gate ~3k merged (~mid-Oct).
- Expect rt to climb toward ~0.830 (S1-equivalent) as the 215 stale mood
  vectors get re-enriched; the ~0.011–0.013 orphan gap persists until a
  trainer-side prune lands.
