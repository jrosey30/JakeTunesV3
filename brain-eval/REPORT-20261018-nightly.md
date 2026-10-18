# Nightly brain eval — 2026-10-18 (03:05, homemini)

**Outcome: IDLE — queue fully drained (first idle night); baselines only, NOTHING applied, brain untouched.**

## Pipeline coordination
- brain-trainer finished 02:00:59 EDT: +22 enriched (library 11,600 → 11,622),
  embeddings.bin → 11,794 vectors, mood-index 22 vectors updated (11,622 total).
  No prune tonight. All changes accounted in its log — no stray writer.
- NAS files stable ≥65 min before snapshot. Snapshot `/tmp/brain-snap-20261018`
  sha-verified against the NAS before and after copy:
  - embeddings.bin `e68c5c92635e…` (changed from 10-17's `d35e36dbcf…` — fully
    explained by tonight's logged trainer run)
  - mood-index.bin `67bb79614ca4…` (same: 22 nightly vector updates)
  - harness ids: brain_id `16834f4c4623`, mood_id `b5af1938b851`

## Pick
`pick_experiment.py pick` → **IDLE** (ledger event logged 03:06:28). Auto lane
empty exactly as forecast on 10-17: E1 bare-mood backlog = 0, E2 genre-tag
churn 0.00% (0/11,562). Jake lane has no unpriced items (E7 and E10 both
priced/refuted). Per protocol: baselines + report, no candidate, no apply.

## Baselines (worktree @ f2ff6a1, bridge primary, routes main 29 / mood 94 / mood+lexicon 1 / main+decade 30)
- **v1 (B1-20261018): retrieval 0.810 / grounding 1.000 / overall 0.905** —
  exactly the confirmed normals, 6th consecutive confirmation.
- **v3 (B3-20261018): headline 0.803, grounding 19/20 = 0.950.** Groups:
  artist 0.963 / umbrella_family 0.913 / leaf 0.842 / family_decade 0.871 /
  tempo_family 0.510 / vibe 0.719 — the E3-era profile holding steady on the
  +22-track brain (leaf 0.843 → 0.842 is the only visible drift, within the
  churn a 22-track add produces).
- Ruler freshness: 1/11,623 tags unresolved (0.009%, limit 0.5%) — the tag is
  `Dance` on one of tonight's 22 adds. Nowhere near stale; noting for trend.

## Grounding flake — v3-grd-16 again (2nd occurrence)
v3-grd-16 (trap) scored 0 with `unparseable/no-LLM` — the identical transport
symptom as 10-14, the only prior occurrence. The other 19 grounding questions
(incl. all 5 other traps) were clean, and v1's 10 grounding probes were 10/10.
This is the LLM transport flake already flagged to Jake, not fabrication, and
tonight nothing applies so no gate binds on it. It is now 2 nights out of the
last 5 LLM runs — the open retry-on-unparseable proposal (one bounded retry,
scored normally on the retry's answer) is worth a decision; see the 10-14
report where it was first flagged.

## Applied
Nothing. No brain file written; NAS shas re-verified unchanged end-to-end
before commit. No backups needed.

## Queue state after tonight
- Auto lane: EMPTY (E1 0 backlog, E2 0.00% churn, E3/E5 spent, E8 measured,
  E10 priced/refuted). E2's churn tracker is live and will re-arm the lane
  when the laptop's taxonomy work moves >1% of genre tags.
- Jake lane: EMPTY — all proposals priced. Open for Jake's decision:
  PROPOSAL-E7-rerank-genre-weight.md (recommend CLOSE, keep 0.08),
  E10 close, PROPOSAL-taste-weights-refresh-v4, and the grd-16 retry idea.
- tempo_family 0.510 (main-idx diag 0.110) remains the standing gap with NO
  queued remedy; any fix needs a new Jake-approved hypothesis (tempo in mood
  text, or a bpm-aware rerank term).

## Standing-rule compliance
- Foreground rule held (4th night): every run to completion in-session.
- Determinism: brain shas CHANGED tonight (trainer-logged), so full LLM runs
  were required and run — not a sha-identical `--no-llm` night.
- No side experiments, no new watch series, no queue additions.
