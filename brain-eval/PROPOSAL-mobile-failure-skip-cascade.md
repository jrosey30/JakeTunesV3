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

**2026-10-06 — NEW: mobile-listening-log.jsonl FROZEN since
2026-09-26T03:20:06Z, and the freeze boundary IS the last burst's boundary.**
Ten days, zero events — while mobile-plays.json / mobile-stars.json /
mobile-playlists.json all advance (phone in active use, backend writing the
same state dir fine). Backend route + sidecar fence unchanged since 09-13;
backend logs don't record per-request lines (and the 09-27 reboot wiped
/tmp). Most likely the iOS client stopped firing /api/listen when the 09-26
cascade session ended. Consequences while frozen: the skip gate
(1,276/3,000) cannot advance, phone KPI parity silently degrades, and this
proposal's evidence stream is dark. Ask: an iOS-side check that the app still
POSTs /api/listen (or one authorized, clearly-marked probe event). Diagnosis
details in REPORT-20261006-nightly.md.

**2026-10-07 — 10-06 FREEZE FLAG RESOLVED: not the iOS client — the backend
DROPS listen events whenever the NAS is unmounted.** The log unfroze 10-06
12:50–16:50 ET (+18 events, 16 organic skips), the SAME DAY the NAS mount
returned, with zero client-side change and NO backfill. Per-day census: zero
events exactly spanning 09-27..10-05 = the NAS-dark window (09-26/27 quiet is
normal — many zero-event days exist). Grounded mechanism
(`backend/src/routes/listen.ts:27,55`): `/api/listen` does a bare
`appendFile` to `config.stateDir/mobile-listening-log.jsonl` — the NAS path —
with NO local fallback, queue, or retry; an unmounted path → 500 → the event
is gone forever. mobile-plays/stars survived the outage because their write
paths are local-first; the listen log is the ONLY per-event stream appended
directly to the NAS. The 10-06 "iOS stopped POSTing" hypothesis is REFUTED;
no iOS-side check needed. NEW ASK (supersedes the 10-06 ask, cross-filed to
PROPOSAL-nas-mount-resilience): give /api/listen the same local-first
treatment (append locally, mirror to NAS) OR at minimum queue-and-replay on
append failure — otherwise every future NAS outage permanently loses the
exact signal the skip gate is waiting on. Forensics recount tonight: organic
682 mobile + 610 desktop = 1,292/3,000 CLOSED; no new mechanical bursts
(still 14 sessions / 2,237) — the cascade has been quiet since 09-26, but
the breaker asks above stand.
