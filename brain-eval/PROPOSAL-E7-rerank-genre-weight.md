# PROPOSAL — E7: reranker genre bonus (RERANK_GENRE_W) sweep — RECOMMEND CLOSE, KEEP 0.08

**Status: CLOSED 2026-10-19 (taste-engine program) — keep 0.08, no code change.** Priced 2026-10-17; recommendation below stood on the numbers alone.

## What was asked

`RERANK_GENRE_W = 0.08` (the reranker's genre-match bonus in
`src/main/ai/rag-rerank.ts`, twin `JakeTunesMobile backend/src/util/ragRerank.ts`)
was chosen on 2026-09-01 by sweeping the old 16-prompt v2 bucket. E7 asked
whether the 154-probe v3 ruler prefers a different weight — 0.04 or 0.12 —
priced through the production bridge via the `JT_RERANK_GENRE_W` lab override,
no code change.

## What was measured (night of 2026-10-17, snapshot /tmp/brain-snap-20261017, baseline B3-20261017 headline 0.803)

| arm | mean per-probe Δ | 90% CI | probes up/down/same | group damage |
|---|---|---|---|---|
| W=0.04 | **−0.0015** | [−0.0049, +0.0024] | 3 / 13 / 138 | vibe −0.0113, leaf −0.0024 |
| W=0.12 | **0.0000** | [0, 0] | 0 / 0 / **154** | none — bit-identical retrieval |

Gate files: `/tmp/gate-E7-w0.04-20261017.json`, `/tmp/gate-E7-w0.12-20261017.json`
(both exit 1; full numbers also in `experiments/ledger.jsonl`).

## Reading

- **Halving the bonus hurts.** At 0.04 the genre signal stops winning some
  close reranks: 13 probes drop vs 3 up, and the vibe group alone loses 0.011
  (it would fail even the group-drop rule on its own).
- **Raising it is a no-op.** At 0.12 every one of the 154 probes retrieves
  identically — above 0.08 the bonus already dominates every ordering decision
  it can influence on this ruler. This is a real plateau, not a dead knob: the
  0.04 arm moving proves the env override reaches the bridge's reranker.
- So 0.08 sits exactly at the plateau's edge: big enough to win everything the
  bonus can win, small enough that nothing else was sacrificed to get there.
  The 09-01 choice is confirmed by the stronger ruler.

## Recommendation

Close E7 with no code change. `RERANK_GENRE_W` stays 0.08 in both twins.
If it ever comes back, it needs a NEW hypothesis — e.g. a ruler whose probes
exercise cross-genre rerank collisions directly — not a re-run of this sweep.
