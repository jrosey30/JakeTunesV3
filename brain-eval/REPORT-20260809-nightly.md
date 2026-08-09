# Nightly brain exercise — 2026-08-09 (homemini, 3:05 AM launchd)

**Outcome: per-track skip-shape features REFUTED (all four arms) → NOTHING APPLIED.**
`embeddings.bin` on the NAS was never written: sha `4b44337c8123` / mtime
02:01:42 / 56,383,320 bytes identical before, during, and after the run. All
measurements ran on a sha-verified frozen snapshot in
`/tmp/jt-state-frozen-20260809` (brain + library + listener-profile +
listening-log, each copy sha1-matched against its source).

## Preconditions
- brain-trainer finished 06:01:46Z (02:01 EDT): +50 enriched, 8,959/9,151
  tracks, embeddings.bin 9,171 vectors. Log dated today, run complete.
- embeddings.bin stable 64 minutes before snapshot (mtime 02:01:42).
- ⚠️ An ACTIVE REMOTE WRITER was observed all night (see observation 1).
  The canonical file never changed, but tonight was not a safe night to
  auto-apply anything to the brain even if an experiment had won.

## Baseline (brain 4b44337c8123, frozen library 9,151 tracks)
retrieval **0.762** · grounding **1.000** · overall **0.881**

0.762 is exactly the documented encoding-v2 normal (2026-08-07 rebaseline).
Down from last night's 0.791 purely on the enrichment-sensitive wobble:
ret-014 0.33→0.23, ret-015 0.70→0.47 — both inside the documented
composition-churn band while the import backlog re-enriches (192 tracks
still vector-less, down from 588 two nights ago; the trainer is closing the
gap faster than batch=50/night predicted). Metadata-control prompts steady
(ret-001..005 ≥ 0.95). Known-bad self-test passed. Baseline judged
trustworthy.

## The one experiment: per-track skip SHAPE (the queued follow-up)
2026-08-08 closed per-ARTIST skip-rate (+0.0004 AUC, "practically zero") and
queued "a differently-shaped skip feature (per-track skip recency, or
skip-immediately vs skip-after-30s)" as the valid next test. The log now
holds 497 skips; 295 (since 2026-07-01) carry `pct` — percent-through-track
at skip time. Ground fact from the log: Jake skips immediately — 253/295
(86%) of pct-bearing skips are at pct ≤ 5; only 42 are listened-then-skipped.

Method: `taste-experiments-v3.py` (in this folder, READ-ONLY, frozen
snapshot). Production formulation (identity + plays + recency, the
tasteScore.ts shape) vs four per-track arms, all scored on the SAME 50
folds (10×5 repeated stratified CV), paired per-fold deltas — the same
method that closed the skip-rate question.

| arm | AUC | Δ vs production (paired) | t | folds improved |
|---|---|---|---|---|
| A production: identity+plays+rec | 0.8023 ± 0.0172 | — | — | — |
| B + track_skips (log1p count) | 0.8020 | −0.0003 ± 0.0006 | −3.15 | 14/50 |
| C + skip_recency (days since last skip) | 0.8020 | −0.0003 ± 0.0006 | −3.00 | 20/50 |
| D + early/late split (pct ≤ 5 vs > 5) | 0.8019 | −0.0004 ± 0.0009 | −3.14 | 20/50 |
| E + all skip-shape | 0.8018 | −0.0005 ± 0.0011 | −3.44 | 17/50 |

Verdict: every shape is a statistically significant, practically tiny
**negative**. Only 155 of 2,762 task rows have any skip at all — the
signal is sparse, and what it says is already said louder by play
behavior. The skip question is now closed from BOTH directions:
per-artist rate (08-08, +0.0004) and per-track shape (tonight, −0.0003
to −0.0005). No production change proposed. Do not re-run skip
experiments until the log roughly doubles again (~1,000 skips) or a new
signal type appears (e.g. a real correction/thumbs-down control) —
re-testing the same well with more shapes is now negative expected value.

## Observations flagged for Jake (no action taken)
1. **The desktop→NAS brain sync is failing its atomic rename, all night,
   every ~2 minutes.** A remote process (PIDs 22582/32736/85374… — none on
   homemini, so the laptop) keeps writing a NEWER brain (56,395,616 bytes
   vs canonical 56,383,320) as `embeddings.bin.<pid>.<ts>.tmp` and never
   completing the rename: 41 orphaned tmp files as of 03:11, growing
   ~2/hour, latest at 03:09 — still active during this run. Consequences:
   (a) the phone/backend serves the 02:01 brain while a richer one exists
   on the laptop, (b) the litter grows unboundedly (~56MB each — several
   GB on the share already). Yesterday's report saw ~15 of these; it has
   *tripled* in a day. The failing writer is desktop-side sync code — out
   of this harness's write scope (THE ONE RULE), so this is a flag, not a
   fix. Litter cleanup + a look at the sync's rename-over-SMB retry logic
   is real daytime work now. (`library.json.*.tmp` litter shows the same
   pattern, ~180 files.)
2. Enrichment backlog is closing fast: 192 vector-less tracks tonight vs
   588 two nights ago. No batch-bump proposal needed; the trainer is
   handling it.
3. Score-log wobble on ret-014/015 continues as documented; no harness
   change made, comparability preserved.

## Score log
Two rows appended this run (both brain 4b44337c8123, frozen snapshot):
no-llm retrieval 0.762, full run 0.762/1.000/0.881.
