# Nightly brain eval — 2026-10-21 (03:05, homemini)

**Outcome: IDLE — queue still fully drained (4th consecutive idle night); baselines only, NOTHING applied, brain untouched.**

## Pipeline coordination
- brain-trainer finished 02:08:20 EDT: +34 enriched (library 11,692 → 11,726),
  embeddings.bin → 11,899 vectors, mood-index 34 vectors updated (11,726
  total). PLUS a **meaning catch-up** pass: 150 already-enriched tracks had
  lyrics but no derived meaning (a lyrics wave landed 10-20 17:33 —
  lyrics.json updated), so the trainer derived meaning and re-embedded those
  150 mood vectors. That code is OLD (commit e364d7e, 2026-07-13:
  `gemmaMeaning + enrichedText + --meaning-catchup`), not a new writer — it
  simply had fresh lyrics to chew on tonight. All changes accounted in its
  log — no stray writer event.
- Note for Jake (observation only, nothing to act on tonight): E8 (10-15)
  measured that ADDING a lyrics-meaning line to either index text didn't pay
  on the v3 ruler; the trainer's July meaning-in-enrichedText path is a
  different, pre-existing text shape and tonight's 150 re-embeds moved the
  needle slightly UP (vibe 0.696 → 0.699, headline 0.7986 → 0.7994), so
  there is no measured conflict — just worth knowing the two are different
  mechanisms.
- NAS files stable ~57 min before snapshot. Snapshot `/tmp/brain-snap-20261021`
  sha-verified against the NAS before and after copy; NAS re-verified
  UNCHANGED end-to-end before commit:
  - embeddings.bin `05418bb640b6…` (changed from 10-20's `50e1bf60b599…` —
    fully explained by tonight's logged trainer run: +34 adds)
  - mood-index.bin `1c9ac86b9c12…` (same: 34 nightly updates + 150
    meaning-catch-up re-embeds, no prune)
  - harness ids: brain_id `00c96ec8a2d0`, mood_id `ca6f81a3a1bc`
- Worktree at **242acad** (origin/brain-eval tip, last night's report).

## Pick
`pick_experiment.py pick` → **IDLE** (ledger event logged 03:07:52). Auto lane
empty, 4th night: E1 bare-mood backlog = 0, E2 genre-tag churn 0.00%
(0/11,562). Jake lane has no unpriced items. Per protocol: baselines +
report, no candidate, no apply.

## Baselines (worktree @ 242acad, bridge primary, routes main 29 / mood 94 / mood+lexicon 1 / main+decade 30)
- **v1 (B1-20261021): retrieval 0.813 / grounding 1.000 / overall 0.906** —
  identical to 10-19 and 10-20, a hair above the 0.810/1.000/0.905 normals
  (7th consecutive night at normals).
- **v3 (B3-20261021): headline 0.7994, grounding 20/20 = 1.000.** Groups:
  artist 0.963 / umbrella_family 0.913 / leaf 0.840 / family_decade 0.871 /
  tempo_family 0.510 / vibe 0.699. Per-probe diff vs 10-20: only **3 of 154**
  moved, net positive — v3-leaf-24 0.960 → 0.920 (−0.040), v3-vibe-ret-013
  0.900 → 0.933 (+0.033), v3-tempo-11 0.120 → 0.160 (+0.040); all mood-routed,
  all consistent with candidate-pool churn from +34 adds + 150 meaning
  re-embeds (shas changed, so movement is legitimate).
- **Vibe-slide watch largely settled:** the two probes behind the 10-19→10-20
  slide (v3-leaf-20 and v3-vibe-prod-006) held EXACTLY steady tonight (0.920
  and 0.680) while the group recovered 0.696 → 0.699 on a different probe.
  Three nights of evidence now all point to single-probe pool churn, not a
  group trend. The formal recheck on a sha-stable night remains nominally
  open but is low-value now.
- Ruler freshness: **0/11,726 unresolved (0.000%)** — fully fresh. The
  French-locale tag from 10-20 (`Rock, Alternatif et Indé, Pop`) has been
  normalized (laptop overrides pass did its job). Locale-import watch can
  stand down unless it recurs.

## Grounding — clean night
All 20 v3 grounding questions clean (6/6 traps), v1 grounding 10/10.
v3-grd-16 scored 1 for the 3rd consecutive night; flake rate stays 2 of the
last 8 LLM nights. raw_excerpt capture (PR #194) remains armed for any
recurrence; the retry-on-unparseable idea remains Jake-gated.

## Applied
Nothing. No brain file written; NAS shas re-verified unchanged end-to-end
before commit. No backups needed.

## Queue state after tonight
- Auto lane: EMPTY (E1 0 backlog, E2 0.00% churn, E3/E5 spent, E8 measured).
  E2 re-arms when >1% of main-index genre tags change.
- Jake lane: EMPTY. Open for Jake: only the grd-16 retry idea (raw-excerpt
  capture may settle it).
- tempo_family 0.510 (main-idx diag 0.107) remains the standing gap with NO
  queued remedy; any fix needs a new Jake-approved hypothesis (tempo in mood
  text, or a bpm-aware rerank term).

## Standing-rule compliance
- Foreground rule held (7th night): every run to completion in-session.
- Determinism: brain shas CHANGED tonight (trainer-logged, +34 and the 150
  meaning catch-up), so full LLM runs were required and run — not a
  sha-identical `--no-llm` night.
- No side experiments, no new watch series, no queue additions.
