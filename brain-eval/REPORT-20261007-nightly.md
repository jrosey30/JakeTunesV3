# Nightly brain exercise — 2026-10-07 (homemini)

**Outcome: (b) — nothing beat baseline, nothing applied, brain untouched.**
embeddings.bin sha1 `d35caad43302a0758fee594b43b3c502c8895e8e` (68,789,984 B,
mtime 02:00), mood-index.bin `f31759f2ccdcfa9ff9cc38d3cfabf17a4eb6fa27`
(67,843,192 B, mtime 02:00) — ×3-sha-verified before measurement, re-verified
byte-identical after. All measurement ran on the frozen snapshot
`/tmp/brain-snap-20261007` (copies sha-matched the NAS originals).

## Pipeline state

- Trainer: clean launchd run 06:00:07–06:00:26Z, +2 enriched →
  **11,035/11,035, backlog 0**; embeddings 11,189 vectors, mood 11,035.
  Second consecutive clean night since the `ecba7d1` mount-wait fix.
- Import day (+2 tracks, library 11,033→11,035) → clobber pre-check ran
  (guards `5baa13e`/`309b375` still under proof): **mood orphans 0 / dups 0,
  zero in-library tracks missing a mood vector** — the `34ba4de` trainer
  prune + replay guards held through import-day churn. Guard-proof night 2.
- embeddings.bin orphans 154 (unpruned index; measured-0.000 effect, benign).

## Measurements (1-token probes 200 on both keys first)

- Baseline: **retrieval 0.734 / grounding 1.000 / overall 0.867** — identical
  headline to 10-06, band floor wobble (shas changed → content churn per the
  09-25 A/A rule). Traps 4/4. Wrong-index artifacts unchanged
  (ret-011 0.44, ret-012 0.35, ret-014 0.13, ret-015 0.43).
- Router-truth: **rt 0.835 flat at the healthy ceiling.**
  **TWENTY-FIRST orphan point: +0.000 — S0==S1==S2==0.835**, un-enriched
  +0.000, zero residual, worst per-probe delta +0.00, orphan/un-enriched slot
  occupancy 0 across all six mood probes. Second consecutive 0.000 since the
  prune shipped. **Per the 10-06 standing rule, ONE more 0.000 night retires
  the decomp from the standard nightly.**

## KEY RESULT — 10-06 freeze flag RESOLVED (hypothesis refuted, grounded)

mobile-listening-log.jsonl **unfroze 10-06 12:50–16:50 ET** (+18 events, 16
organic skips) — the same day the NAS mount returned, zero client change, no
backfill. Per-day census: zero events exactly spanning the 09-27..10-05
NAS-dark window. Grounded in `backend/src/routes/listen.ts:27,55`:
`/api/listen` bare-`appendFile`s to the NAS state dir with **no local
fallback, queue, or retry** — unmounted path → 500 → event dropped forever.
Plays/stars advanced through the outage because their paths are local-first;
the listen log is the only per-event stream appended directly to the NAS.
**The "iOS stopped POSTing" hypothesis is refuted; the nine days of listen
events are unrecoverable.** Both proposals updated:
PROPOSAL-mobile-failure-skip-cascade (new ask: local-first append /
queue-and-replay, supersedes the iOS-side check) and
PROPOSAL-nas-mount-resilience (third cost class: permanent signal loss).

## Standing items

- Skip gate (forensics standard): organic 682 mobile + 610 desktop =
  **1,292/3,000 CLOSED** (+16 since 10-06). **No new mechanical bursts**
  (still 14 sessions / 2,237) — cascade quiet since 09-26.
- Taste-W guard **PASS ×3** (V3 src:89 / Mobile backend/src:87 / dist:63 —
  v4 W line byte-identical; refresh-v4 proposal premise intact).
- Taste-drift monthly due ~10-13 (v4 script; re-diff deployed W first).
- Snap hygiene: kept /tmp/brain-snap-20261006 + 20261007.
- TOP asks unchanged: PROPOSAL-taste-weights-refresh-v4 (Jake-gated);
  clobber guards need a few more import waves before archiving the proposal;
  keeper-osascript half of mount-resilience still open.

## Why nothing was applied

No candidate existed tonight: baseline in-band, rt at ceiling, orphan tax
0.000 (the last lever resolved by shipped code), skip gate closed at
1,292/3,000, and the night's key finding was diagnostic (a refuted
hypothesis + two proposal updates), not a brain change. Per policy, outcome
(b) with proposals updated.
