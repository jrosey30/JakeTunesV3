# Nightly brain eval — 2026-10-19 (03:05, homemini)

**Outcome: IDLE — queue still fully drained (2nd consecutive idle night); baselines only, NOTHING applied, brain untouched.**

## Pipeline coordination
- brain-trainer finished 02:01:42 EDT: +55 enriched (library 11,622 → 11,676),
  embeddings.bin → 11,849 vectors, mood-index 55 vectors updated + 1 pruned
  (11,676 total). All changes accounted in its log — no stray writer.
- NAS files stable ≥60 min before snapshot. Snapshot `/tmp/brain-snap-20261019`
  sha-verified against the NAS before and after copy:
  - embeddings.bin `cc32b2575cc8…` (changed from 10-18's `e68c5c92635e…` —
    fully explained by tonight's logged trainer run)
  - mood-index.bin `72b9f6b49a9a…` (same: 55 nightly updates + 1 prune,
    undo copy at mood-index.bin.prune.bak)
  - harness ids: brain_id `4c4dc2dbb6eb`, mood_id `4274b37da5ca`

## Pick
`pick_experiment.py pick` → **IDLE** (ledger event logged 03:06:15). Auto lane
empty, 2nd night: E1 bare-mood backlog = 0, E2 genre-tag churn 0.00%
(0/11,562). Jake lane has no unpriced items. Per protocol: baselines + report,
no candidate, no apply.

## Baselines (worktree @ 592e58a, bridge primary, routes main 29 / mood 94 / mood+lexicon 1 / main+decade 30)
- **v1 (B1-20261019): retrieval 0.813 / grounding 1.000 / overall 0.906** —
  a hair above the 0.810/1.000/0.905 normals (retrieval +0.003 on the
  +55-track brain; within add-churn).
- **v3 (B3-20261019): headline 0.799, grounding 20/20 = 1.000.** Groups:
  artist 0.963 / umbrella_family 0.913 / leaf 0.842 / family_decade 0.871 /
  tempo_family 0.507 / vibe 0.700. E3-era profile holding on the +55-track
  brain. Drift vs 10-18 (0.803): vibe 0.719 → 0.700 and tempo 0.510 → 0.507;
  per-probe diff shows small two-sided movement (8 probes moved, largest
  v3-vibe-prod-004 −0.160, with leaf-09/leaf-16/vibe-prod-007 gaining) —
  normal candidate-pool churn from 55 new tracks, not a harness anomaly
  (shas changed, so per-probe movement is legitimate and expected).
- Ruler freshness: **0/11,676 unresolved (0.000%)** — the single `Dance` tag
  flagged 10-18 has resolved (tonight's overrides pass applied 11,673).
  Freshness watch clean; nothing to trend.

## Grounding — clean night, flake did NOT recur
v3-grd-16 (trap) scored 1 tonight — the `unparseable/no-LLM` transport flake
did not recur after two occurrences (10-14, 10-18). All 20 v3 grounding
questions clean (6/6 traps), v1 grounding 10/10. Flake rate now 2 of the last
6 LLM nights; the open retry-on-unparseable proposal remains with Jake.

## Applied
Nothing. No brain file written; NAS shas re-verified unchanged end-to-end
before commit. No backups needed.

## Queue state after tonight
- Auto lane: EMPTY (E1 0 backlog, E2 0.00% churn, E3/E5 spent, E8 measured,
  E10 priced/refuted). E2's churn tracker will re-arm the lane when the
  laptop's taxonomy work moves >1% of genre tags.
- Jake lane: EMPTY — all proposals priced. Open for Jake's decision:
  PROPOSAL-E7-rerank-genre-weight.md (recommend CLOSE, keep 0.08),
  E10 close, PROPOSAL-taste-weights-refresh-v4, and the grd-16 retry idea.
- tempo_family 0.507 (main-idx diag 0.107) remains the standing gap with NO
  queued remedy; any fix needs a new Jake-approved hypothesis (tempo in mood
  text, or a bpm-aware rerank term).

## Standing-rule compliance
- Foreground rule held (5th night): every run to completion in-session.
- Determinism: brain shas CHANGED tonight (trainer-logged, +55/−1), so full
  LLM runs were required and run — not a sha-identical `--no-llm` night.
- No side experiments, no new watch series, no queue additions.
