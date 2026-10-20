# Nightly brain eval — 2026-10-20 (03:05, homemini)

**Outcome: IDLE — queue still fully drained (3rd consecutive idle night); baselines only, NOTHING applied, brain untouched.**

## Pipeline coordination
- brain-trainer finished 02:00:56 EDT: +16 enriched (library 11,676 → 11,692),
  embeddings.bin → 11,865 vectors, mood-index 16 vectors updated (11,692
  total). All changes accounted in its log — no stray writer.
- NAS files stable ≥65 min before snapshot. Snapshot `/tmp/brain-snap-20261020`
  sha-verified against the NAS before and after copy; NAS re-verified
  UNCHANGED end-to-end before commit:
  - embeddings.bin `50e1bf60b599…` (changed from 10-19's `cc32b2575cc8…` —
    fully explained by tonight's logged trainer run)
  - mood-index.bin `ebcd3e3dc829…` (same: 16 nightly updates, no prune)
  - harness ids: brain_id `0aba1dc73aa8`, mood_id `c4c1d5da9699`
- Worktree advanced to **306aa39** (PR #194, merged by Jake 10-19 evening):
  closes E7 + E10 in the ledger, marks PROPOSAL-taste-weights-refresh-v4
  superseded (taste v5 shipped), and adds grd-16 raw-reply capture to
  run_eval.py (unparseable grounding replies now store a 400-char
  `raw_excerpt` so a dropped call is distinguishable from a prose answer).

## Pick
`pick_experiment.py pick` → **IDLE** (ledger event logged 03:08:05). Auto lane
empty, 3rd night: E1 bare-mood backlog = 0, E2 genre-tag churn 0.00%
(0/11,562). Jake lane has no unpriced items (E7/E10/v4 all closed by PR #194).
Per protocol: baselines + report, no candidate, no apply.
- Note: tonight's trainer log shows taxonomy merged-subgenre coverage jumped
  10,480 → 11,691 tracks (a laptop overrides wave). That wave did NOT move
  E2's gate — E2 watches the single main-index genre tag per track
  (`experiments/state/main-index-tags.json`), and 0 of those changed. No
  migration-matrix concern: only 2/154 v3 probes moved, both small (below).

## Baselines (worktree @ 306aa39, bridge primary, routes main 29 / mood 94 / mood+lexicon 1 / main+decade 30)
- **v1 (B1-20261020): retrieval 0.813 / grounding 1.000 / overall 0.906** —
  identical to 10-19, a hair above the 0.810/1.000/0.905 normals.
- **v3 (B3-20261020): headline 0.799, grounding 20/20 = 1.000.** Groups:
  artist 0.963 / umbrella_family 0.913 / leaf 0.841 / family_decade 0.871 /
  tempo_family 0.507 / vibe 0.696. Per-probe diff vs 10-19: only 2 of 154
  moved — v3-leaf-20 0.960 → 0.920 and v3-vibe-prod-006 0.720 → 0.680
  (−0.040 each, candidate-pool churn from 16 new tracks; shas changed so
  movement is legitimate). The 10-19 vibe watch (0.719 → 0.700 → 0.696) is
  now fully attributable to single-probe pool churn, not a trend across the
  group; still worth one recheck on the next sha-stable night.
- Ruler freshness: **1/11,692 unresolved (0.009%)** — the tag is
  `Rock, Alternatif et Indé, Pop`, a French-locale genre string on one track
  (presumably among tonight's adds). Far below the 0.5% stale bar; the
  laptop's Cynthia/overrides pass should normalize it. Watch only — if it
  multiplies, that's a store-locale import pattern.

## Grounding — clean night
All 20 v3 grounding questions clean (6/6 traps), v1 grounding 10/10.
v3-grd-16 scored 1 for the 2nd consecutive night; flake rate stays 2 of the
last 7 LLM nights. The new raw_excerpt capture (PR #194) is now live for any
recurrence; the retry-on-unparseable idea remains Jake-gated.

## Applied
Nothing. No brain file written; NAS shas re-verified unchanged end-to-end
before commit. No backups needed.

## Queue state after tonight
- Auto lane: EMPTY (E1 0 backlog, E2 0.00% churn, E3/E5 spent, E8 measured).
  E2 re-arms when >1% of main-index genre tags change.
- Jake lane: EMPTY — E7 closed (rejected, keep RERANK_GENRE_W=0.08), E10
  closed (rejected), taste-weights-v4 closed (superseded by v5). Open for
  Jake: only the grd-16 retry idea (no proposal file; raw-excerpt capture
  may settle it).
- tempo_family 0.507 (main-idx diag 0.107) remains the standing gap with NO
  queued remedy; any fix needs a new Jake-approved hypothesis (tempo in mood
  text, or a bpm-aware rerank term).

## Standing-rule compliance
- Foreground rule held (6th night): every run to completion in-session.
- Determinism: brain shas CHANGED tonight (trainer-logged, +16), so full LLM
  runs were required and run — not a sha-identical `--no-llm` night.
- No side experiments, no new watch series, no queue additions.
