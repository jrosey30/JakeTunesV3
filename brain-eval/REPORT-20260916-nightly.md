# Nightly brain exercise — 2026-09-16 (homemini)

**Outcome: (b) nothing beat baseline / brain untouched.** Headline: the
stale-215 freeze is SOLVED — no trainer bug, pure queue position. All 215
have playCount 0 and sat behind every played track in the most-played-first
enrichment queue; they begin draining on the NEXT trainer run (17 tomorrow
night, then 50/night, gone in 5 nights). The un-enriched +0.007 component
now has a night-by-night recovery schedule instead of an open question.

## Pipeline state

- brain-trainer clean (launchd 06:00:05–06:01:52Z): +50 enriched, brain
  10,629/10,877, embeddings.bin 10,996 vectors; both brain mtimes == trainer
  finish 02:01 local (no post-trainer replay). Files stable >1h before
  measurement.
- Library 10,877 (+0 imports — 12th consecutive no-clobber day).
- Snapshot /tmp/brain-snap-20260916, shas stable across re-reads:
  embeddings `9439e880f123823eb4746a678507ea0285bf3b23`,
  mood `d15871a835d203824538ee27e4db6991ff705cab` — re-verified UNCHANGED at
  end of session; **no brain file written tonight.**

## Standard nightly readings

- Pre-check fingerprint (precheck_20260916.py): **18 orphans / 5 dup
  groups**, same benign id list (09-08 signature). No clobber.
- Baseline (frozen snapshot, 1-token Anthropic probe 200 first):
  **retrieval 0.744 / grounding 1.000 / overall 0.872** — in the v2 band.
- Router-truth (exp_20260916_sag_decomp.py): **0.813** flat
  (0.819→0.816→0.816→0.813→0.813→0.813). **EIGHTH orphan point +0.011**
  (worst per-probe delta +0.00 again — eight-point-proven floor tax).
  Un-enriched component +0.007. S2 ceiling 0.830.
- Enrichment backlog **298→248** (sixth drain night, −50 on +0 imports;
  ~5 nights to clear). Embeddings orphans steady 152.
- Watchlist 33/34 (11467–11499+454) still te=False after a 12th 500-re-encode
  night; queue pos ~3,488 ≈ **6 nights** (12th data point for
  PROPOSAL-tempo-catchup-queue-order).
- Taste-W premise guard: V3 src (`src/renderer/utils/tasteScore.ts:89`) ==
  Mobile src (`backend/src/util/tasteScore.ts:87`) == Mobile dist
  (`backend/dist/util/tasteScore.js:63`) — all byte-identical to the recorded
  v4 line. **PASS.** (Note for future guards: Mobile code lives under
  `backend/src`, not `src` — a bare `~/JakeTunesMobile/src` grep finds
  nothing and is NOT an alarm.)
- Skip gate (skip_log_forensics_20260915.py): mobile 2,705 total = 576
  organic + 2,129 mechanical in the SAME 12 bursts (none new since 09-13).
  **Merged organic 1,186 / 3,000 → CLOSED** (+2 organic since 09-15).

## Tonight's experiment: stale-215 drain ETA (exp_20260916_stale215_eta.py)

Question no prior night answered: does the frozen stale-215 mood cohort
drain automatically when the backlog clears, or is it stuck forever?
Two pre-registered hypotheses:

- **(B) trainer bug — REFUTED.** `brain-trainer.mjs:456` builds
  `done = Set(Object.keys(desc))`, so a descriptor ENTRY with an empty `d`
  would be skipped forever. Census: **0** of the 215 (and 0 of the whole
  248 backlog) have entry-without-d. The `done`-vs-`d` asymmetry is
  currently harmless — worth remembering, not worth a proposal.
- **(A) queue tail — CONFIRMED.** Reconstructed the trainer's exact queue
  (recent-adds-first, then most-played-first, `brain-trainer.mjs:753-761`;
  reconstruction length 248 == trainer's own backlog count). The cohort:
  **playCount 0 for all 215/215**, queue positions min 33 / median 140 /
  max 247. Every played track ahead of them has now drained — that is the
  whole "frozen 7 nights" story.
- **Drain schedule at 50/night** (night 1 = the 2026-09-17 run):
  17 → 50 → 50 → 50 → 48. Cohort fully enriched in **5 nights**; the
  un-enriched +0.007 recovers on the same schedule, and rt should walk
  from 0.813 toward the 0.830 S2 ceiling by ~09-21 with NO intervention.
  Remaining gap after that is the orphan +0.011 (trainer-side prune —
  Jake-gated, eight-point-proven).
- Falsifiable prediction for tomorrow night: stale cohort 215 → ~198
  (−17). If it does NOT move, hypothesis A is wrong and this analysis
  must be re-opened.

## Ledger

- Applied to the brain: **nothing.** All work read-only against the frozen
  snapshot; shas verified unchanged before+after. No repair needed.
- score_log.jsonl: +1 baseline row (appended by run_eval).
- Next: watch the drain prediction (215→~198 tomorrow); backlog ~5 nights;
  watchlist te-encoding ~6 nights; taste-drift monthly ~10-13 (re-diff
  deployed W first — recorded in REPORT-20260915); v4 skip re-run gate
  ORGANIC-only 1,186/3,000; clobber fixes 4/5 + trainer-side orphan prune
  (+0.011) remain the TOP asks.
