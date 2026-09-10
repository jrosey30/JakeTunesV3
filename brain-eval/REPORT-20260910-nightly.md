# Nightly brain exercise — 2026-09-10 (homemini, ~03:05)

**Outcome: (b) nothing beat baseline under the bars — brain untouched.**
One read-only experiment ran: a repeat of the sag decomposition on a recovery
night. Its numbers were appended to the standing proposals; nothing was applied.

## Coordination

- brain-trainer clean via launchd 06:00:01–06:01:57Z (+50 enriched; embeddings
  10,696 vectors == log; library 10,861, **+49 imports** — biggest wave day yet).
- NAS reads sha-stable ×3 (20s apart) before snapshot: embeddings
  `c89f84fd4845`, mood `37c1c978dffe`. Snapshot `/tmp/brain-snap-20260910`
  byte-identical.
- Brain untouched: same shas re-verified at session end.

## Pre-check (clobber fingerprint)

18 orphans / 5 dup groups — **same benign orphan id list as 09-08/09-09**
(9796/9820/9863/10642/10923/10924 + the 11338–11349 block). NOT the ~125/60
replay signature. **6th consecutive no-clobber import day** (still luck, not
fix — the replay writer is unfixed). Embeddings orphans steady at 152.

## Baseline (frozen snapshot, 1-token key probe 200 first)

retrieval **0.752** / grounding **1.000** (traps 4/4) / overall **0.876** —
in-band, up from 09-09's bottom-edge 0.744. score_log row appended
(brain_id c89f84fd4845, vectors 10696).

## Router-truth (rt_20260910.py)

**0.819** — the wave-sag has TURNED: 0.818 → 0.816 → 0.811 → 0.808 → 0.805 →
**0.819** (+0.014, right on 09-09's "expect ~+0.02 over the next week").
mood-routed mean 0.803/9 (was 0.784). Known artifacts unchanged: ret-002 0.70
(P2), ret-012 0.35 (P3 decade-guard miss), ret-014 0.30 (wrong-index ruler).

## Experiment: sag decomposition repeat (exp_20260910_sag_decomp.py, READ-ONLY)

Question: does the orphan component persist through the recovery, as 09-09
predicted?

| scenario | rt 09-09 | rt 09-10 | delta tonight |
|---|---|---|---|
| S0 current | 0.805 | 0.819 | — |
| S1 minus 18 orphans | 0.818 | 0.832 | **+0.013** (same as 09-09) |
| S2 minus orphans + un-enriched (215) | 0.840 | 0.843 | +0.011 over S1 |

- **Orphan component: +0.013 on BOTH nights** — constant while everything else
  healed. It is a floor tax, not part of the wave. Slot occupancy unchanged
  (ret-007 4/25, ret-012 4/20, ret-008 1/25). Second measurement appended to
  PROPOSAL-mood-import-clobber fix 2 (trainer-side prune).
- **Un-enriched component +0.022 → +0.011** — self-heal confirmed in the
  recovering direction.
- **S2 = 0.843** — inside the healthy 0.833–0.844 band; still nothing hidden.

**NOT applied**, although S1 = 0.832 crosses the ≥0.83 line for the first
time: (1) a mood-only prune cannot move run_eval retrieval/overall, so the
"improves retrieval AND overall" guardrail fails strictly; (2) a NAS-only
prune is resurrected by the next replay event — the durable fix is
trainer-side, which the harness must not touch (THE ONE RULE); (3) four
consecutive sessions' precedent declining these same orphans. The proposal now
carries two identical independent measurements; the decision is Jake's.

## Watches / bookkeeping

- Watchlist 11467–11499+454: **33/34 still te=False** after a 6th
  "500 on an older encoding" night; queue pos ~6,488 ≈ **12 nights out**
  (6th data point for PROPOSAL-tempo-catchup-queue-order).
- Enrichment backlog **532** (533→532: +50 enriched vs +49 imports — batch=50
  treads water on a ~50-import day; appended to
  PROPOSAL-enrichment-backlog-drain).
- Taste-drift re-run due ~09-16. Skip v4 re-run gate ~3k merged (~mid-Oct).
- Expect rt to keep climbing toward ~0.830 (S1-equivalent) as the wave
  enriches; the ~0.013 orphan gap persists until a trainer-side prune lands.
