# Nightly brain exercise — 2026-09-22 (homemini)

**Outcome: (b) — nothing beat baseline, nothing applied; brain untouched.**
The night's one bounded exercise was drain-check night 6 — the
pre-registered empty-cohort verification. Cohort 40 → 10: **30 drained,
0 joined**, and the night's 20 fresh imports (12044–12063) queue-jumped
the recent-first head — 20 + 30 = 50 EXACT, zero residual a SIXTH
consecutive night. More important: **the un-enriched sag component
measured exactly +0.000 for the first time** — the wave-sag
decomposition closes with the entire remaining gap being pure orphan
floor tax. The sag story that began 09-08 is finished; what remains is
Jake-gated.

## Integrity

- embeddings.bin sha1 `79c3bc965b91` (68,187,480 B, mtime 02:01:45) —
  identical before measurement and after the run; snapshot
  `/tmp/brain-snap-20260922` byte-matches the live NAS files (all four,
  shasum-verified at copy time and re-verified post-run). mood-index.bin
  `1f27c81d4dcc` (67,363,648 B, 02:01:50). All measurement on the frozen
  snapshot.
- Trainer clean, launchd 06:00–06:01Z: +50 enriched (10,929/10,939),
  embeddings.bin 11,091 vectors, mood-index 10,957.
- **18th consecutive no-clobber day**: same benign 18-orphan id list
  (9796/9820/9863/10642/10923/10924/11338–11349), emb orphans 152
  steady. Dup groups **2 → 1** (dup_tracks 9 → 4) — the n=5 group
  (11257–11261) dissolved; only the 11338–11341 orphan group remains.
  Enrichment individualizing, the healthy direction.
- API keys probed before spend: OpenAI 200, Anthropic 200 (1-token).

## Baseline (identity eval, frozen snapshot)

retrieval **0.736** / grounding **1.000** / overall **0.868** — a hair
below the 09-18/20/21 ruler-wobble readings (0.738/0.740/0.738), same
shape: rt is UP tonight and the decomp closes zero-residual, so the
identity-ruler dip is slot wobble, not production. Wrong-index artifacts
in usual ranges (ret-011 0.44 / ret-012 0.30 / ret-014 0.17 / ret-015
0.43); grounding 10/10 incl. all 4 traps.

## KEY RESULT 1 — drain night 6 (exp_20260922_stale_drain_check.py)

Id-level set-diff across frozen snapshots 09-21 vs 09-22: old cohort 40
→ survivors 10, drained 30, joined 0, new library ids = the 20 imports
12044–12063 (all fully enriched tonight = 20 of the 50 slots).
Arithmetic exact a sixth night. Backlog census agrees: 40 → 10.
Empty-cohort: **tomorrow night (09-23)** barring imports — 10 < 50
even alongside the watchlist block.

## KEY RESULT 2 — sag decomposition converged (exp_20260922_sag_decomp.py)

rt **0.815** — the predicted drain payoff
(series 0.813×4 → 0.806 → 0.802 → 0.802 → 0.804 → **0.815**), fully
decomposed, zero residual (0.815 + 0.013 + 0.000 = S2 0.828 exact):

- **Un-enriched component +0.000 — CONVERGED TO ZERO** (series 0.022 →
  0.011 → 0.009 → 0.007×2 → 0.004 → 0.011 → 0.011 → 0.008 → 0.000).
  The 10 survivors hold only 1 top-k slot anywhere (ret-007); S1 == S2
  == 0.828. The 09-16 hypothesis-A prediction ("un-enriched recovers by
  ~09-21 with NO intervention") is confirmed to the decimal, one day
  late for exactly the import-wave reason the model allows.
- **Orphan component +0.013 — FOURTEENTH point**
  (0.013/0.013/0.011×6/0.013/0.016×4/0.013): the same 18 bare-genre
  orphans (ret-007 holds 4 slots, ret-012 4, ret-008 1). S1 worst
  per-probe delta +0.00 again — prune strictly non-harmful, fourteen
  nights running. This is now the ONLY sag component left; the trainer-
  side orphan prune (PROPOSAL-mood-import-clobber fix 2, Jake-gated) is
  worth +0.013–0.016 rt on its own.
- S2 ceiling **0.828** (healthy 0.826–0.843 band). ret-011 mood-side
  0.88, ret-015 0.80, ret-013 0.90 — all healthy.

## Guards & counters

- Taste-W premise guard **PASS**: v4 W line byte-identical in V3
  `src/renderer/utils/tasteScore.ts:89`, Mobile
  `backend/src/util/tasteScore.ts:87`, Mobile
  `backend/dist/util/tasteScore.js:63`.
- **Watchlist about to clear**: 33/34 still te≠3, but queue positions
  488–492 (< 500) — they drain on the 09-23 tempo catch-up. 18th and
  likely FINAL queue-order data point; tomorrow's check is the
  falsifiable close-out for PROPOSAL-tempo-catchup-queue-order (if they
  DON'T clear, the proposal gains a new failure mode; if they do, the
  proposal's fix remains valid for future import waves but the standing
  33-track exhibit resolves).
- te census: 10,274 v3 / 481 v2 / 22 True / 208 False.
- Skip gate not re-counted (09-16: organic 1,186/3,000, CLOSED; count
  only via skip_log_forensics, never the raw counter).
- Taste-drift monthly due ~10-13 (v4 script; re-diff deployed W first).

## Why nothing was applied

The sag is now a single Jake-gated component: a mood-only NAS-side
orphan prune (a) cannot move run_eval retrieval/overall (the
pre-registered keep bar), (b) sits below the 0.83 apply band (S1
0.828), and (c) gets resurrected by the next desktop replay — the
durable fix is trainer-side. The drain finished by design; nothing to
intervene on. Outcome (b).

Snapshot kept at /tmp/brain-snap-20260922 (tomorrow's set-diff needs it
+ 20260921 — tomorrow verifies BOTH the empty cohort AND the watchlist
clearing). Top asks unchanged: clobber fixes 4/5 + trainer-side orphan
prune (fourteen-point, +0.013–0.016).
