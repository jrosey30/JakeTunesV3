# Nightly brain exercise — 2026-09-23 (homemini)

**Outcome: (b) — nothing beat baseline, nothing changed. Brain untouched**
(embeddings sha1 `3413a18c8730…`, mood sha1 `05583c85e02f…`, verified ×3
before and re-verified after; no writes to any NAS state file).

Tonight was the double pre-registered close-out night set on 09-22.

## Pre-flight
- Trainer clean, launchd 06:00–06:01Z: +10 enriched → **10,939/10,939 = 100%**,
  tempo catch-up 500 (50 newly analysed + 450 v2 re-encodes), embeddings
  11,091 vectors / mood 10,957. Brain mtimes = trainer write times (02:00/02:01),
  stable 60+ min before measurement; library.json untouched since 09-21 12:50
  → **zero-import night**.
- Snapshot /tmp/brain-snap-20260923, all four files sha-verified ×3 (no torn
  reads), copies byte-identical.
- Fingerprint precheck: mood 18 orphans / 1 dup group (n=4) — the same benign
  id list as 09-08→09-22; embeddings orphans 152 steady. **19th consecutive
  no-clobber day** (clobber 15/30 import days; replay writer still unfixed).

## Close-out #1 — un-enriched cohort → EMPTY: **PASSED exactly**
exp_20260923_stale_drain_check.py (id-level set-diff vs /tmp/brain-snap-20260922):
cohort 10 → **0**, 10 drained, 0 joined, on a zero-import night. Drain series
215→200→150→104→90→40→10→0 over 7 trainer runs, every night id-accounted with
zero residual. The wave-sag un-enriched story is fully closed: decomp
un-enriched component +0.000 a second consecutive night, `unenriched_in_lib=0`.

## Close-out #2 — watchlist te→3: **ETA missed by one night; mechanism CONFIRMED by id**
wl_closeout_20260923.py: drained tonight = **exactly ids 11467–11479** (old queue
positions 488–500); survivors = **exactly 11480–11499** (old positions 501–520);
0 joined. The block spanned 488–520 (the "488–492" was a 5-id sample), and
tonight's 50 newly-analysed tracks queue-jumped the recent-first head, leaving
~450 slots — the cutoff landed at old-pos ~500. Perfect queue-order split, zero
exceptions = 18th data point for PROPOSAL-tempo-catchup-queue-order (appended).
Survivors now at queue positions 1–20 → drain on the 09-24 run; id 454 (White
Stripes Black Math) already te-encoded. Per pre-registration the strict ETA
FAILED, so the watch stays open exactly one more night: **19th and final
checkpoint 09-24 — survivors must go te=3 or genuinely reopen.**
te census: 10,784 v3 / 31 v2 / 22 True / 158 False (was 10,274/481/22/208).

## Altimeter
- 1-token Anthropic probe 200 first; run_eval on the frozen snapshot:
  retrieval **0.740** / grounding **1.000** (traps 4/4) / overall **0.870** —
  the 09-18/20/21/22 ruler-wobble band (0.736–0.740), same shape as before:
  identity-side one-slot spread, rt decomp zero-residual.
- Router-truth **0.811** (series 0.813×4→0.806→0.802→0.802→0.804→0.815→0.811;
  −0.004 = slot arithmetic). exp_20260923_sag_decomp: **FIFTEENTH orphan point
  +0.016** (S0 0.811 → S1 0.826, worst per-probe delta +0.00; ret-007 4 +
  ret-012 4 + ret-008 1 orphan slots), un-enriched +0.000, **S1 == S2 = 0.826**.
  0.811 + 0.016 ≈ 0.826: zero residual. The remaining gap to the healthy
  0.833–0.844 band is pure orphan tax + probe wobble — nothing hidden.

## Experiments/changes applied
None. No candidate built: cohort empty + orphan-prune is the documented
Jake-gated lever (NAS-only prunes get resurrected by the replay writer;
mood-only changes can't move run_eval; 5-session precedent). Default-to-do-
nothing honored.

## Guards
- Taste-W guard PASS: v4 W line byte-identical in V3 src:89, Mobile
  backend/src:87, Mobile dist:63 — PROPOSAL-taste-weights-refresh-v4 premise
  intact.
- Skip gate not re-counted (09-16: organic 1,186/3,000, CLOSED).

## Standing asks (unchanged)
1. PROPOSAL-mood-import-clobber fixes 4/5 + **trainer-side orphan prune**
   (+0.013–0.016 rt, now FIFTEEN-point-proven — the only lever left).
2. PROPOSAL-tempo-catchup-queue-order (18 data points; tonight's id-level
   close-out is the cleanest yet).
3. Taste-drift monthly re-run due ~10-13 (v4 script; re-diff deployed W first).

## Watch for 09-24
1. Watchlist survivors 11480–11499 (queue pos 1–20) MUST be te=3 — final
   falsifiable checkpoint; if any survive a >480-slot jump night, reopen.
2. Standard clobber pre-check (import days can still replay).
3. With the cohort empty, rt should sit ~0.815–0.826 minus wobble; a drop
   below ~0.80 without orphan-slot growth = something NEW, investigate.

Snapshots kept: /tmp/brain-snap-20260922 + /tmp/brain-snap-20260923 (the 09-24
final checkpoint needs tonight's for its set-diff).
