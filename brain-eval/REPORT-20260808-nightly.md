# Nightly brain exercise — 2026-08-08 (homemini, 3:05 AM launchd)

**Outcome: skip-signal re-test REFUTED (again, decisively) → NOTHING APPLIED.**
`embeddings.bin` on the NAS was never written: sha `657b106b517c` / mtime
02:04:58 / 53,124,880 bytes identical before and after the run. All
measurements ran on a frozen snapshot in `/tmp/jt-state-frozen` (brain +
library + listener-profile + listening-log copied once, sha-verified).

## Preconditions
- brain-trainer finished 06:05Z (02:05 EDT): +50 enriched, 8,924/9,137
  tracks, "embeddings.bin 8641 vectors". Log dated today, complete.
- embeddings.bin stable for a full hour before measurement (mtime 02:04:58,
  measured 03:05+). No writer racing.
- Library is mid-large-import: 9,137 tracks (was 9,078 last night, 8,875
  two nights ago).

## Baseline (brain 657b106b517c, frozen library 9,137 tracks)
retrieval **0.791** · grounding **1.000** · overall **0.896**

Recovered vs last night's 0.762/0.881 — composition churn plus tonight's
+50 enrichment, not a harness change:
- ret-013 (fast workout): 0.87 → 0.77
- ret-014 (slow mellow late-night): 0.23 → **0.33** (partial recovery)
- ret-015 (aggressive): 0.47 → **0.70–0.73** (recovered; wobbles between
  identical same-brain runs, the documented composition-churn behavior)

Baseline judged trustworthy: self-test passed, per-prompt scores plausible,
no unexplained collapse.

## The one experiment: skip signal re-test at 493 events
Yesterday's correction flagged this as the queued candidate: production
`tasteScore.ts` records "skips don't help", but that refutation was
measured at ~141 skip events. The log now holds **493** (2,097 plays +
493 skips; 406 skipped-not-starred tracks).

Method: `scripts/taste-experiments-v2.py` (read-only, repeated 5×5 CV)
against the frozen snapshot, plus a paired per-fold extension (10 repeats,
50 folds, identical splits) for a proper significance read.

| model | AUC |
|---|---|
| identity (locked baseline) | 0.785 ± 0.021 |
| identity + skip-rate | 0.792 ± 0.021 |
| identity + behavior (plays, recency) — production formulation | 0.801 ± 0.020 |
| identity + behavior + skip-rate | 0.802 ± 0.019 |
| hard-negatives arms (skipped as negatives) | 0.757–0.767 (different task, lower) |

Paired per-fold, production formulation vs +skip-rate:
**Δ = +0.0004 ± 0.0009, t = 3.11, 37/50 folds improved.**

Verdict: with 3.5× the data the effect is now *statistically detectable*
and *practically zero* — four ten-thousandths of AUC. Per-artist skip-rate
is almost entirely redundant with play behavior (you don't keep playing
artists you skip). The "skips don't help" header in `tasteScore.ts` stands;
this question is now closed with a tight error bar, not an underpowered
refutation. No production change proposed. A future *differently-shaped*
skip feature (e.g. per-track skip recency, or skip-after-30s vs
skip-immediately) would be a new experiment, not a re-run of this one.

## Observations flagged for Jake (no action taken, none urgent)
1. **588 newest tracks have no vector** (all ids 9330–10010, dateAdded
   2026-07/08). Overnight the recent-import block was re-keyed: last night
   the brain had 9,081 vectors / 3 orphans on 9,078 tracks; tonight the
   trainer pruned ~440 now-orphaned vectors (old ids) and the re-keyed
   tracks re-entered the enrichment queue. Benign mechanism, but at
   batch=50/night the newest music is vibe-search-blind for ~12 nights.
   If that matters, a one-night batch bump or an id-remap pass in the
   trainer would close it — trainer changes are out of this harness's
   write scope (THE ONE RULE), so this is a proposal only.
2. **Orphaned `embeddings.bin.*.tmp` litter on the NAS state dir** (~15
   files, several from tonight 00:36–01:30 EDT) — failed atomic renames
   over SMB. Also a `library.json.partial.json` (01:11) in local
   Application Support. Consistent with the known torn-SMB-write pattern;
   the final files themselves verify clean. Worth a cleanup pass + a look
   at which writer retries-and-litters, some daytime.
3. Brain id churn is normal-high right now (import in progress); expect
   retrieval wobble ±0.03 night-to-night until enrichment catches up.

## Score log
Two rows appended this run (both brain 657b106b517c, frozen snapshot):
no-llm retrieval 0.7936, full run 0.791/1.000/0.896. Taste-experiment
numbers live in this report (the AUC harness has no score_log of its own).
