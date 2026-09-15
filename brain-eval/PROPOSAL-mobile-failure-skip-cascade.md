# PROPOSAL: stop the mobile failure-skip cascade (client + log hygiene)

**Status: OPEN — Jake-gated (JakeTunesMobile app + backend code, not brain data).**
Filed 2026-09-15 by the nightly brain exercise.

## What happened

The iOS app has repeatedly auto-advanced through the queue at machine speed and
logged every advance as a taste skip (`t:"s"`) in `mobile-listening-log.jsonl`.
As of tonight: **12 mechanical burst sessions since 2026-08-09, totaling 2,129
of the log's 2,703 skip events (79%)**. The two biggest, 09-12/09-13:

- 2026-09-12 21:05–21:24Z — 877 skips in 19.5 min (~0.75/s)
- 2026-09-13 04:02–04:35Z — 681 skips in 33 min
- 2026-09-13 03:50–03:51Z — 60 skips in 2 min

Signature: median inter-skip gap **0.85s**, 88% at `pct: 0`, 1,487 distinct
tracks across 692 artists (a queue sweep, near-zero repeats), and only **18
play events** across both days. No human skips 30+ tracks at sub-second cadence
for half an hour. This is a playback-failure auto-advance loop: track fails to
start → player advances → next fails → cascade. (Client-side; the backend log
carries no per-request timestamps, so the exact failure — offline downloads
missing, stream endpoint unreachable, audio session dead — needs a look at the
app. The 09-12 21:05Z burst = 5:05 PM ET; homemini was up.)

Census + pre-registered detection rule: `skip_log_forensics_20260915.py`
(session gap>600s; mechanical iff n≥30 AND median intra-session gap <5s).

## Why it matters (quantified 2026-09-15)

1. **It nearly caused a false taste-model change.** The taste-experiments-v4
   re-run gate was "~3,000 merged skips"; the RAW counter hit 3,313 tonight.
   Run verbatim on the raw corpus, **four arms falsely graduate the
   pre-registered bar** (early/late split Δ +0.0102, t +24.5, 50/50 folds).
   On the organic-only corpus (1,184 merged) **all arms are refuted** (best
   +0.0039 < +0.005 bar). The mechanical events fabricate ~2/3 of the apparent
   skip signal. Gate math is corrected in REPORT-20260915-nightly.md; the
   organic corpus is now the standing definition (`stage_skipclean_20260915.py`).
2. **The mobile AI report is distorted.** `routes/aiReport.ts` computes
   aiSkipRate/manualSkipRate from `mobile-play-log.json`, which carried 268
   burst skips in-window tonight — skip rates read near-total until the window
   ages out.
3. **Not affected:** mixes (`engagement.ts` reads the desktop log only),
   tasteScore (skips were never wired), the brain indexes (no skip surface).

## Proposed fixes (in order of value)

1. **Client circuit-breaker:** stop auto-advance after N consecutive advances
   that begin without ≥2s of actual playback (or after N consecutive playback
   errors); surface an error state instead of silently eating the queue.
2. **Log truthfully:** an auto-advance caused by a playback *error* is not a
   user skip — log it as a distinct event type (e.g. `t:"e"` or
   `src:"autofail"`), or don't log it at all. `routes/listen.ts` accepts
   whatever the client sends; the fix belongs client-side, with the backend
   type widened to match.
3. **Report hygiene:** aiReport (and any future skip consumer) should exclude
   mechanical bursts via the same rule as the forensics script.
4. **Historical log:** do NOT rewrite `mobile-listening-log.jsonl` (append-only
   user data). Exclusion happens at read time via the committed rule.

## Undo / risk

Pure additive client+report logic; no data migration. Reverting = removing the
circuit-breaker and event-type change. Risk: a too-aggressive breaker could
halt legitimate rapid skipping — Jake's real rapid skips (organic sessions) top
out well under 30 consecutive sub-5s skips, so N=10–15 instant-failure
advances is a safe threshold.
