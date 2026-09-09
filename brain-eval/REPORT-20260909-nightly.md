# Nightly brain exercise — 2026-09-09 (homemini, ~03:05)

**Outcome: (b) nothing beat baseline under the bars — brain untouched.**
One read-only experiment ran: the wave-sag decomposition. Its numbers were
appended to two standing proposals; nothing was applied.

## Coordination

- brain-trainer clean via launchd 06:00:03–06:01:51Z (+50 enriched; embeddings
  10,646 vectors == log; library 10,812, +19 imports).
- NAS reads sha-stable ×3 before snapshot: embeddings `1845234a20af`, mood
  `1adf339e9aa8`. Snapshot `/tmp/brain-snap-20260909` byte-identical.
- Brain untouched: same shas re-verified at session end.

## Pre-check (clobber fingerprint)

18 orphans / 5 dup groups — **byte-for-byte the 09-08 benign signature** (same
ids: 9796/9820/9863/10642/10923/10924 + the 11338–11349 block; dups = the
benign un-enriched same-artist class). NOT the ~125/60 replay signature.
**5th consecutive no-clobber import day** (clobber 15/20 import days; luck not
fix — replay writer still unfixed). Embeddings orphans steady at 152.

## Baseline (frozen snapshot, 1-token key probe 200 first)

retrieval **0.744** / grounding **1.000** (traps 4/4) / overall **0.872** —
bottom edge of the v2 band (matches 08-24/08-26). score_log row appended
(brain_id 1845234a20af, vectors 10646).

## Router-truth (rt_20260909.py)

**0.805** — wave-sag series 0.818 → 0.816 → 0.811 → 0.808 → **0.805**.
mood-routed mean 0.784/9. Known artifacts unchanged: ret-002 0.70 (P2),
ret-012 0.35 (P3 decade-guard miss), ret-014 0.30 (wrong-index ruler).

## Experiment: wave-sag decomposition (exp_20260909_sag_decomp.py, READ-ONLY)

Question: how much of the sag never self-heals?

| scenario | rt | delta |
|---|---|---|
| S0 current | 0.805 | — |
| S1 minus 18 orphans | 0.818 | +0.013, worst per-probe +0.00 |
| S2 minus orphans + 215 un-enriched | **0.840** | +0.022 over S1 |

- **Orphan component +0.013 NEVER self-heals** (deleted tracks — no enrichment
  coming; trainer never prunes mood orphans). Slot occupancy: ret-007 4/25,
  ret-012 4/20, ret-008 1/25 top-k slots are orphan bare-genre embeds.
- **Un-enriched component +0.022 self-heals** (~50/night; backlog 564→533,
  first shrink night of the wave).
- **S2 = 0.840 = the healthy 0.833–0.844 band** → the sag is fully accounted
  for by the two known classes; nothing hidden is broken. Keep waiting.

**NOT applied** (S1 would have been the candidate): rt 0.818 < the ≥0.83
apply band; run_eval retrieval/overall cannot move from a mood-only change
(guardrail "improves retrieval AND overall" fails); 09-05/06/08 precedent
declined sub-bar candidates including these same orphans; and a NAS-only
prune is resurrected by the next replay event anyway. Quantification appended
to PROPOSAL-mood-import-clobber (fix 2 = trainer-side prune, now worth a
measured permanent ~+0.013) and PROPOSAL-enrichment-backlog-drain.

## Watches / bookkeeping

- Watchlist 11467–11499+454: **33/34 still te=False** after a 5th
  "500 on an older encoding" night; queue position ~6,988 ≈ **13 nights out**
  (5th data point for PROPOSAL-tempo-catchup-queue-order).
- Enrichment backlog 533 (first shrink; series 315→458→542→564→533).
- Tmp litter steady (benign). Taste-drift re-run due ~09-16. Skip v4 re-run
  gate ~3k merged (~mid-Oct).
- Expect rt to climb ~+0.02 over the next week as the wave enriches; the
  remaining ~0.013 gap persists until a trainer-side orphan prune lands.
