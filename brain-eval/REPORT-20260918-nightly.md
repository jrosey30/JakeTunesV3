# Nightly brain exercise — 2026-09-18 (homemini)

**Outcome: (b) — nothing beat baseline, nothing applied; brain untouched.**
The night's one bounded exercise was drain-check night 2 on the stale mood
cohort (pre-registered from 09-16/17): on a zero-import night the trainer's
full 50-slot batch should drain the cohort 200 → 150. **It did — exactly.**

## Integrity

- embeddings.bin sha1 `da6013ee2dac` (67,818,600 B, mtime 02:01:49) —
  identical before measurement and after the run. mood-index.bin
  `6a3c5d8e39cc` (66,994,768 B, 02:01:54). All measurement on the frozen,
  triple-sha-verified `/tmp/brain-snap-20260918`.
- Trainer clean, launchd 06:00–06:01Z: +50 enriched (10,729/10,879),
  embeddings.bin 11,031 vectors, mood-index 10,897.
- **14th consecutive no-clobber day** (clobber 15/27) on a **zero-import**
  day (library flat 10,879) — fingerprint the same benign 18 orphans /
  5 dup groups (identical id list). Emb orphans 152 steady.
- API keys probed before spend: OpenAI 200, Anthropic 200 (1-token).

## Baseline (identity eval, frozen snapshot)

retrieval **0.738** / grounding **1.000** / overall **0.869** — 0.006 below
the v2 band floor (0.744), i.e. ~one k-slot of wobble spread across the mid
probes. All four wrong-index ruler artifacts unchanged vs 09-17 (ret-011
0.40 / ret-012 0.30 / ret-014 0.17 / ret-015 0.40); grounding 10/10 incl.
traps. Router-truth (below) confirms this is ruler wobble, not production
movement beyond the decomposed components — P1's standing pattern.

## KEY RESULT — stale-cohort drain night 2 (exp_20260918_stale_drain_check.py)

Id-level set diff across the 09-17/09-18 frozen snapshots:

- cohort **200 → 150 survivors; 50 drained, 0 joined; 0 new library ids.**
- Zero imports → no queue-jumping → the full 50-slot batch went to the
  cohort head, matching hypothesis A (pure queue tail) with **zero residual**
  this time (night 1's −2 gap was exactly its 2 imports; night 2 is exact).
- Schedule intact: ~3 more nights → cohort empty **~09-21**, un-enriched
  component → 0, rt walks toward the S2 ceiling.

## Router-truth + sag decomposition (exp_20260918_sag_decomp.py)

- rt **0.806** (series 0.805→0.819→0.819→0.816→0.816→0.813×4→**0.806**).
- **TENTH orphan point: +0.016** (series 0.013/0.013/0.011×6/0.013/**0.016**)
  — the floor tax's largest reading yet; same 18 orphans, but the nightly
  500-vector tempo re-encodes shifted neighborhoods and the bare-genre
  orphans climbed (ret-007 top-25 now holds 4 orphan + 5 un-enriched slots;
  ret-012 4 orphan slots). Worst per-probe delta S1 vs S0 = +0.00 again.
- Un-enriched component **+0.004** (series …0.009/0.007/0.004/0.004 —
  drain visible and on schedule).
- S2 ceiling 0.826 (was 0.830) — the ret-013/007 slot arithmetic that
  wobbles with re-encodes; the healthy band remains 0.833–0.844 once the
  orphan prune lands.
- The rt dip 0.813→0.806 is **fully decomposed** into the two known
  components (0.806 + 0.016 + 0.004 = 0.826 = S2); no new failure class;
  ret-012 0.30 in all scenarios = the documented decade-guard router miss
  (P3), routed to main by design.

## Why nothing was applied

Same three standing reasons, all still true tonight: (1) a mood-only orphan
prune cannot move run_eval retrieval/overall (wrong ruler) and sits below
the ≥0.83 rt band mid-drain; (2) a NAS-only prune gets resurrected by the
next autoBackupStateToNas replay — the durable fix is the Jake-gated
trainer-side prune (PROPOSAL-mood-import-clobber fix 2, now **ten-point-
proven at +0.011–0.016**); (3) the un-enriched component self-heals by
~09-21 with no intervention (don't pre-empt the trainer mid-drain).

## Other standard checks

- Backlog 200 → **150** (8th drain night, −50 on +0 imports; ~3 nights).
- Watchlist 33/34 still un-encoded (te=False), queue pos ~2,488 ≈ 5 nights
  at 500/night (**14th queue-order data point** for
  PROPOSAL-tempo-catchup-queue-order).
- **Taste-W premise guard PASS**: deployed v4 `W` byte-identical in all
  three places (V3 src/renderer/utils/tasteScore.ts, Mobile
  backend/src/util/tasteScore.ts, Mobile compiled dist).
- Skip gate: not re-counted tonight (09-16: organic 1,186/3,000, CLOSED).
- Snapshots: /tmp/brain-snap-20260917 retained for the diff; tonight's at
  /tmp/brain-snap-20260918 (tomorrow's drain check diffs against it).
- score_log: 2 rows appended tonight (full run + a --no-llm per-probe
  capture used to localize the identity wobble).

## Applied / rejected

- Applied: **nothing** (the night's exercise was a pre-registered
  measurement, which passed exactly; no candidate could beat baseline under
  the bars).
- Open Jake-gated items unchanged: trainer-side orphan prune (+0.011–0.016,
  ten-point) + mood-import-clobber fixes 4/5 = TOP asks;
  taste-weights-refresh-v4; P1/P2/P3; tempo-catchup-queue-order;
  mobile-failure-skip-cascade; enrichment-backlog-drain (moot in ~3 nights).
  Taste-drift monthly due ~10-13 (v4 script; re-diff deployed W first).
