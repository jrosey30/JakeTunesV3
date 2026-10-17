# Nightly brain eval — 2026-10-17 (03:05, homemini)

**Outcome: E7 (jake lane) PRICED & REFUTED — RERANK_GENRE_W 0.08 confirmed optimal; NOTHING applied, brain untouched.**

## Pipeline coordination
- brain-trainer finished 02:00:50 EDT: +15 enriched, embeddings.bin → 11,772
  vectors, plus a LOGGED mood prune of 15 de-libraried vectors (11600→11585,
  undo `mood-index.bin.prune.bak`) then 15 re-added — all accounted in its log.
- NAS files stable ≥65 min before snapshot. Snapshot `/tmp/brain-snap-20261017`
  sha-verified against the NAS before and after copy:
  - embeddings.bin `d35e36dbc943…` (changed from 10-16's `17cd46e53641…` — fully
    explained by tonight's logged trainer run; not a stray writer)
  - mood-index.bin `69a90dfae41c…` (same: logged prune + nightly update)

## Baselines (worktree @ 3f3db50, bridge primary, routes main 29 / mood 94 / mood+lexicon 1 / main+decade 30)
- **v1 (B1-20261017): retrieval 0.810 / grounding 1.000 / overall 0.905** — exactly the confirmed normals.
- **v3 (B3-20261017): headline 0.803, grounding 20/20 = 1.000** (traps all clean —
  second consecutive clean night after the 10-14 v3-grd-16 transport flake).
  Groups: artist 0.963 / umbrella_family 0.913 / leaf 0.843 / family_decade 0.871 /
  tempo_family 0.510 / vibe 0.719. Matches the E3-era profile on the +15-track brain.

## Pick
`pick_experiment.py pick` → **E7** (jake lane, MEASURE/price only). Auto lane
empty as expected: E1 bare-mood backlog = 0, E2 genre-tag churn 0.00%.

## E7 — sweep RERANK_GENRE_W 0.04 / 0.12 vs 0.08 (bridge env override, v3 --no-llm, gate --v3-only)
| arm | mean Δ | CI90 | up/down/same | worst group |
|---|---|---|---|---|
| W=0.04 (E7-w0.04-20261017) | −0.0015 | [−0.0049, +0.0024] | 3/13/138 | vibe −0.0113 |
| W=0.12 (E7-w0.12-20261017) | 0.0000 | [0, 0] | 0/0/154 | none (bit-identical) |

Both gates exit 1 (`/tmp/gate-E7-w0.04-20261017.json`, `…w0.12…`). Reading:
0.04 loses close reranks (vibe −0.011); 0.12 changes literally nothing — the
bonus saturates above 0.08. The 0.04 arm moving proves the `JT_RERANK_GENRE_W`
override is live through the bridge, so the 0.12 zero is a real plateau.
**The 09-01 choice of 0.08 is confirmed by the v3 ruler. Recommend CLOSE, keep
0.08 in both twins** — see `PROPOSAL-E7-rerank-genre-weight.md`. Recorded
`priced` in `experiments/ledger.jsonl`.

## Applied
Nothing. No brain file written; NAS shas unchanged end-to-end (re-verified
before commit). No backups needed.

## Queue state after tonight
- Auto lane: EMPTY (E1 0 backlog, E2 0.00% churn, E3/E5 spent, E8 measured,
  E10 priced/refuted).
- Jake lane: **E7 now priced/refuted** — the queue has no remaining eligible
  items. Next nights are IDLE (baselines + report) until Jake acts on open
  proposals (E7 close, E10 close, taste-weights-refresh-v4) or queues new work.
- tempo_family 0.510 (main-idx diag 0.110) remains the biggest known gap, now
  with no queued remedy: E7 (rerank weight) and E10 (routing) are both refuted.
  Any fix needs a new, Jake-approved hypothesis — likely tempo signal in the
  mood text or a bpm-aware rerank term, both app-code (jake lane) ideas.
