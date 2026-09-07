# Nightly brain exercise — 2026-09-07 (homemini)

**Outcome: (b) nothing beat baseline, nothing changed.** Brain untouched
(embeddings sha `1777d076a505` / mood sha `60869921fadf`, verified identical
before + after the session). The pre-registered 1,000-skip re-test ran and
every arm fell below the bar.

## Pipeline state

- brain-trainer clean via launchd, 06:00–06:04Z: +50 enriched, library
  10,727 (import day, +134), embeddings.bin 10,546 vectors, mood-index
  10,412. Both brain mtimes == trainer-done (02:04 ET); no post-trainer
  replay.
- **No clobber — 3rd consecutive import day** (luck, not fix: the
  autoBackupStateToNas replay writer is still unfixed). Pre-check
  fingerprint 12 orphans / 5 dup groups = the benign 09-05/09-06 signature
  byte-for-byte (orphans are exactly the deleted 11338–11349 block).
  Clobber count stays 15/18 import days. PROPOSAL-mood-import-clobber
  (fixes 4/5) remains the TOP ask.
- Anthropic key probed with 1 token (200) before grounding spend.

## Baseline (frozen snapshot /tmp/brain-snap-20260907, triple-sha verified)

retrieval **0.751** / grounding **1.000** (traps 4/4) / overall **0.875** —
inside the v2-encoding band (0.748–0.762). ret-011 0.40 / ret-012 0.35 /
ret-014 0.17 = the documented wrong-index ruler artifacts; router-truth not
re-measured tonight (no repair to prove).

## Experiment: the 1,000-skip re-test (pre-registered, gate opened tonight)

The mobile skip counter crossed 1,000 (1,007; was 990 on 09-06). Merged
corpus = 610 desktop-era skips (static log, disjoint time range) + 1,007
mobile = **1,617 skip events**, 514/2,916 task rows carrying ≥1 skip (was
155/2,762 at the 08-09 refutation).

`taste-experiments-v4.py` — same paired 50-fold design as v2/v3, bar
declared in-file BEFORE running: graduate only if Δ ≥ +0.005 AND t ≥ 3.

| arm | Δ AUC vs production (0.8095) | t | folds improved | verdict |
|---|---|---|---|---|
| B + track_skips | +0.0019 | +7.4 | 42/50 | refuted |
| C + skip_recency | +0.0013 | +5.7 | 39/50 | refuted |
| D + early/late split | +0.0027 | +8.9 | 48/50 | refuted |
| E + all track shapes | +0.0027 | +9.2 | 47/50 | refuted |
| F + artist_skip_rate (v2 form) | −0.0009 | −2.9 | 20/50 | refuted |
| G + everything | +0.0014 | +3.4 | 35/50 | refuted |

**Read of the result:** the per-track skip shape has FLIPPED SIGN — it was
−0.0003..−0.0005 at ~643 skips (08-09), it is now +0.0027 with 48/50 folds
improving. That is a real, consistent signal emerging as data accrues; it
is simply still half the practical bar. Artist skip-rate is dead in both
directions across 493 → 1,617 events — **permanently closed** (redundant
with play behavior, as v2 concluded).

**Next gate (pre-registered now):** re-run v4 verbatim at **~3,000 merged
skips** (linear extrapolation of the trend crosses +0.005 around there; at
the recent ~+40 skips/day accrual that is roughly 5–6 weeks, ~mid-October).
No wiring, no formulation changes, no smoothing tweaks before then — a
differently-shaped feature hunt now would be the multiple-comparisons trap
the bar exists to prevent. If D/E cross the bar at 3k, the deliverable is a
PROPOSAL (tasteScore twins are app code → Jake-gated), not an auto-apply.

## Watch items

- **09-06 watchlist CONFIRMED stuck again:** 33/34 aged suspect ids
  (11467–11499 + 454) still `te=False` after tonight's catch-up ran another
  "500 on an older encoding, 0 newly analysed" — 3rd night; queue-order
  starvation exactly as computed. PROPOSAL-tempo-catchup-queue-order
  gains its third confirming data point.
- 146 standing embeddings-index orphans: not recounted tonight (watch only).
- Tmp litter not recounted (was 10, benign accrual).
- Taste-drift monthly re-run due ~09-16.

## For 09-08

1. Standard pre-check — clobber can return any import day.
2. Skip counter: next action gate is ~3,000 merged (~1,007+610 now).
3. If brain mtimes > trainer-done: post-trainer replay — run BOTH repairs
   (09-04 pattern; verify .bak count == trainer log first).
