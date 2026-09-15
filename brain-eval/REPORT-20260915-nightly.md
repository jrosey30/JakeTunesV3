# Nightly brain exercise — 2026-09-15 (homemini)

**Outcome: (b) nothing beat baseline / brain untouched + (c) new Jake-gated
proposal.** Headline: the skip-experiment gate counter was being poisoned by
mechanical failure-skip bursts — caught tonight BEFORE it could produce a
false taste-model proposal.

## Pipeline state

- brain-trainer clean (launchd 06:00:04–06:01:54Z): +50 enriched, brain
  10,579/10,877, embeddings.bin 10,946 vectors; both brain mtimes == trainer
  finish (no post-trainer replay). Files stable >1h before measurement.
- Library 10,877 (+0 imports — 11th consecutive no-clobber day; clobber 15/25).
- Snapshot /tmp/brain-snap-20260915, shas stable ×3:
  embeddings `9842b18534566a587609169932e23046546c02fc`,
  mood `98adb846c46d2f5fefe7320c9e9018e2e6e50452` — re-verified UNCHANGED at
  end of session; **no brain file written tonight.**

## Standard nightly readings

- Pre-check fingerprint (precheck_20260915.py): **18 orphans / 5 dup groups**,
  byte-identical benign id list (09-08 signature). No clobber.
- Baseline (frozen snapshot, 1-token Anthropic probe 200 first):
  **retrieval 0.746 / grounding 1.000 / overall 0.873** — in the v2 band.
- Router-truth (exp_20260915_sag_decomp.py): **0.813** flat on the plateau
  (0.819→0.819→0.816→0.816→0.813→0.813). **SEVENTH orphan point +0.011**
  (series 0.013/0.013/0.011×5 — seven-point-proven floor tax, worst per-probe
  delta +0.00 again). Un-enriched component +0.007. **Stale-215 mood cohort
  frozen a 6TH night** (queue-locked). S2 ceiling 0.830.
- Enrichment backlog **348→298** (fifth drain night, −50 on +0 imports;
  ~6 quiet nights to clear). Embeddings orphans steady 152.
- Watchlist 33/34 (11467–11499+454) still te=False after an 11th
  500-re-encode night; queue pos ~3,988 ≈ **7 nights** (11th data point for
  PROPOSAL-tempo-catchup-queue-order).
- Taste-W premise guard: V3 src == Mobile src == Mobile dist == the committed
  08-23 v4 line (ae147e0 / 7d8c29f). **PASS — no silent W move;
  PROPOSAL-taste-weights-refresh-v4 premise intact.** For future guards, the
  deployed v4 line is:
  `{ bias: -6.529, album: 12.625, artist: 1.892, genre: -0.068, decade: 0.285, plays: -0.824, recency: -0.191, intensity: 4.65 }`
  (tonight's initial alarm was only because no prior report spelled these out).

## Tonight's experiment: skip-log contamination forensics

Trigger: the mobile skip counter read **2,703** (was 1,049 on 09-08) → raw
merged 3,313 ≥ the ~3k v4 re-run gate. Before running anything, verified the
accrual — and it is not listening:

- `skip_log_forensics_20260915.py` (pre-registered rule: sessionize at
  gap>600s; mechanical iff n≥30 AND median intra-gap <5s): **12 mechanical
  bursts since 08-09 = 2,129 of 2,703 mobile skips (79%)**. The 09-12/13 jump
  is three bursts (877 + 681 + 60) at median gap **0.85s**, 88% `pct:0`, 1,487
  distinct tracks, 18 play events across both days — a playback-failure
  auto-advance cascade, not taste.
- **Corrected gate: merged ORGANIC = 574 mobile + 610 desktop = 1,184 / 3,000
  → CLOSED** (1,816 to go). The raw counter is retired;
  `stage_skipclean_20260915.py` builds the organic staging dir for all future
  v4 re-runs (pre-registered tonight, ahead of any gate-open run).
- Diagnostic dual run of taste-experiments-v4.py VERBATIM (read-only, local):
  - RAW corpus (3,313): four arms **falsely graduate** the pre-registered bar
    (B +0.0096 t+25.7, C +0.0085, D +0.0102 t+24.5, E +0.0098, G +0.0103 —
    50/50 folds each). Had the gate been trusted raw, tonight would have
    produced a wire-in proposal built on failure-cascade noise.
  - CLEAN corpus (1,184): **all arms refuted** (best D +0.0039 ± 0.0020,
    t +13.8 — real but under the +0.005 bar; F artist-rate −0.0000, stays
    permanently closed). Consistent with the organic trend (09-07: +0.0027).
  - Read: mechanical bursts fabricate ~2/3 of the apparent per-track skip
    signal (they mark swept-queue tracks that correlate with the unstarred
    pool). The 09-07 result itself ran ~29% contaminated (469/1,617) — its
    "+0.0027, signal accruing" stands only as the organic-trend direction, not
    magnitude.
- Live-surface audit: mixes UNAFFECTED (`engagement.ts` reads the desktop log
  only); tasteScore UNAFFECTED (skips never wired); **aiReport distorted**
  (268 burst skips in mobile-play-log.json's window). No brain surface.
- → **PROPOSAL-mobile-failure-skip-cascade.md** (Jake-gated): client
  circuit-breaker on consecutive instant advances, error-advances logged as
  non-skips, report-side burst filter; historical log NOT rewritten
  (read-time exclusion only).

## Ledger

- Applied to the brain: **nothing.** No candidate beat baseline; no repair
  needed; shas verified unchanged before+after.
- score_log.jsonl: +1 baseline row (appended by run_eval).
- Next: taste-drift monthly ~10-13 (v4 script, re-diff deployed W first —
  constants recorded above); v4 skip re-run gate now ORGANIC-only 1,184/3,000
  (~months at organic rates unless skips accelerate); watchlist te-encoding
  ~7 nights; backlog ~6 quiet nights; clobber fixes 4/5 + trainer-side orphan
  prune (+0.011, seven-point) remain the TOP asks.
