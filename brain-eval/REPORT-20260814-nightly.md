# Nightly brain exercise — 2026-08-14 (homemini)

**Outcome: brain untouched. P3 (decade token in moodText + relaxed decade guard)
measured offline for the first time: router-truth +0.075 (0.831 → 0.906), but it
trips the pre-registered no-regression bar on exactly one probe (ret-014 −0.10).
Not applied; the gated proposal is now quantified both ways for Jake.**

## Preconditions
- brain-trainer finished cleanly 02:01 EDT (+50 enriched, brain 9,157/9,430,
  embeddings.bin 9,466 vectors). embeddings.bin mtime stable >1h before measuring.
- Measured a frozen snapshot (/tmp copy of the NAS state dir);
  NAS shas verified identical before AND after the session:
  embeddings.bin `a4402796d59d…`, mood-index.bin `3cfdd531fc10…` (both 58,196,980 B, mtime 02:01).

## Baseline (canonical NAS brain, frozen)
retrieval **0.756** / grounding **1.000** / overall **0.878** — exactly the
encoding-v2 normal (08-09/08-10: 0.762, 08-11: 0.756). ret-011 0.40, ret-012 0.35,
ret-014 0.20, ret-015 0.50 = the documented identity-index/ruler wobble band.
Row appended to score_log.jsonl.

## Experiment: P3 counterfactual (pre-registered, read-only)
The 08-11 diagnosis left P3 as a *future* experiment: add a decade token to
`moodText()` + rebuild mood-index + relax the router's decade guard (ret-012
"new wave 80s" scores 1.00 on mood but the guard forces it to main = 0.35).
The 07-03 era NO-GO was identity-index-only — mood text has no year, so this
was genuinely untested. Tonight ran the required fidelity-gated counterfactual:

1. **Reconstruction** — `mood_texts_reconstruct.mjs` extracts `tempoEnergy()` +
   `moodText()` from the trainer source itself (no hand-port → no twin drift) and
   emits base + decade-variant texts (`era: 1970s` line from the grounded library
   year; 9,430/9,430 tracks have a year).
2. **Fidelity gate** — 59/60 sampled reconstructions cosine ≥0.999 vs the live
   mood-index vectors (median 1.0000; one 0.834 outlier = post-embed metadata
   drift). PASSED. All comparisons are recon-vs-recon so residual noise cancels.
3. **Full spaces** — embedded 9,430 recon-base + 9,430 recon-decade mood vectors
   (text-embedding-3-small; .npy caches in the worktree, not committed).
4. **Scoring** — all 15 ret probes on identity / frozen-mood / recon-base /
   recon-decade, router emulated with current + relaxed decade guard
   (`cf_decade_mood.py`).

### Results (router-truth mean over 15 probes)
| config | mean |
|---|---|
| A′ current guard + recon-base (status quo) | 0.831 |
| B  current guard + decade token (token only) | 0.841 |
| C  relaxed guard, no token (guard only) | 0.866 |
| D  relaxed guard + decade token (full P3) | **0.906** |

Per-probe movers under D vs A′:
- **ret-006 "classic rock from the 1970s": 0.64 → 0.96** — the decade token makes
  the mood index decade-competent (mood 0.52→0.96), so relaxing the guard is safe
  for the probe that previously justified it.
- **ret-012 "new wave 80s": 0.35 → 1.00** (the original P3 motivation).
- ret-011 "funk and soul": 0.84 → 0.92; ret-008 0.96 → 1.00; ret-015 0.73 → 0.77;
  ret-004 mood-side 0.50 → 0.75 (routes main either way).
- **ret-014 "slow mellow late night": 0.33 → 0.23** — a real paired 3-rank
  dilution at k=30: the era line on every track crowds borderline slow tracks out
  of a pure-mood top-30. This is the single-vector tradeoff again, now inside the
  mood space.

### Verdict (pre-registered rule)
D beats A′ by +0.075, but ret-014 regresses >0.05 → **NOT auto-appliable**, and
correctly so: P3 is code (trainer `moodText()` twin + `src/main/ai/mood-index.ts
buildMoodText` twin + router guard + mood rebuild + desktop rebuild), never a
brain-data-only apply. No wording variants were tried — that would re-open the
refuted vocabulary-fishing lever (08-07).

**For Jake — P3 is now a quantified tradeoff, not a hunch:** +0.075 mean
router-truth (two probes jump +0.32 and +0.65) at the cost of −0.10 on one
mood probe whose production score is already depressed. If the tradeoff is
acceptable, P3 ships as designed; if not, the fallback is C (relax guard only:
+0.035, ret-006 dips 0.64→0.52, ret-012 +0.65) or status quo. Note ret-002
"Beatles tracks" routing to mood (0.80 vs identity 1.00) again confirms P2
(leading-"the" artist variants) as the cheapest real router win.

## Housekeeping
- 329 stale NAS *.tmp files: unchanged, still awaiting daytime cleanup; no new
  litter tonight (trainer wrote clean).
- Artifacts committed: this report, cf_decade_mood.py, mood_texts_reconstruct.mjs,
  score_log row. Not committed: mood-texts.jsonl + the two 58 MB .npy caches
  (deterministically reconstructable).
