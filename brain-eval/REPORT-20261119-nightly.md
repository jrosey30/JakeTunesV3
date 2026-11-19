# Nightly brain exercise — 2026-11-19 (homemini)

**Outcome: IDLE (34th) — baselines only, nothing applied, brain untouched.**
`pick_experiment.py pick` → IDLE: E1 ineligible (bare mood backlog = 0), E2 ineligible
(genre-tag churn 24/11,547 = 0.21%, needs >1%), Jake lane empty. No candidate was built,
no gate was run, nothing was applied.

## Brain state measured
- Snapshot `/tmp/brain-snap-20261119`, sha-verified against the NAS before and after the
  copy, and re-verified byte-identical at end of run (**BRAIN UNTOUCHED**).
- embeddings.bin sha256 `f51371333256…` (14,522 vectors) · mood-index.bin `464cfe9ef4b9…`
  (14,306 vectors) · library 14,306 tracks (`2e5d9b437a85`).
- Harness ids: brain_id `4d43f9b050b1` / mood_id `1ec5a546752e`.
- Trainer ran 23:40–23:49 EST: +146 enriched (the biggest add wave in weeks), purity
  regression 0.0000, mood fully accounted (14,162 − 2 pruned + 146 = 14,306).
- Mood prune of 2 vectors (ids 10426, 12455) IS logged in brain-prune-ledger.jsonl — a
  logged ~23:40 prune is normal per the writer rule; no unlogged writer events.

## Scores
| ruler | headline | grounding | notes |
|---|---|---|---|
| v1 | retrieval **0.811** / overall **0.906** | **1.000** | numerically identical 5th straight night; zero movers; all traps clean; routes 8 mood / 7 main |
| v3 | **0.780** | **0.950** | 16th night settled ~0.78; grounding miss = grd-15 trap ONLY (deterministic colloquial-dance, cited 3); **zero parser flakes** → flake tally 16/34 |

v3 groups: artist 0.963 / umbrella_family 0.907 / leaf 0.838 / family_decade 0.880 /
tempo_family 0.440 / vibe 0.655. Primary source **bridge**; routes identical to prior
nights (29 main / 94 mood / 1 mood+lexicon / 30 main+decade).

**main-src moved cf87f18dce90 → 6d5e8ce8a6a9** (origin/main advanced — genres-sort +
sidebar-order merges). Routes identical on both rulers, v1 numerically identical → the
code motion is retrieval-inert. New stability baseline is 6d5e8ce8.

## Movers 12/174 (6 up, 6 down, net ≈ −0.001) — the +146 add wave reshuffle
- **v3-tempo-10 0.48 → 0.24 (−0.24) — NEW WATCH.** "slow, mellow country and folk songs"
  (family + bpm≤85, route mood, k=25). Expected set grew 42 → 46: the add wave included
  country/folk tracks that reshuffled the mood-index top-25; hits fell 12 → 6. Read-only
  diagnosis, no action; one more night decides churn vs real regression.
- v3-fdec-02 0.80 → 1.00 (+0.20) — expected 191 → 216, the same add wave landing well.
- v3-fdec-03 0.64 → 0.52 (−0.12); v3-tempo-01 0.64 → 0.76 (+0.12); eight more at ±0.04.
- **All 8 standing watch items HELD exactly**: leaf-33 0.64 / leaf-41 0.72 / leaf-29 0.48 /
  tempo-12 0.04 / vibe-prod-006 0.68 / leaf-12 0.52 / leaf-38 0.72 / fdec-18 0.36; prior
  movers tempo-16 0.20 / leaf-03 0.52 also held.

## Watch item RESOLVED: the "early trainer" was a deliberate reschedule
The 11-18 watch (trainer fired 23:40 EST, 02:00 slot silent) is closed: the launchd plist
`com.jaketunes.brain-trainer.plist` was edited **2026-11-17 17:22:42** changing
StartCalendarInterval from 02:00 → **23:40**, with a backup kept at
`/tmp/brain-trainer.plist.bak-202611171722`. Both "early" fires were the new schedule
working as configured. Note the new ordering: trainer (23:40) → redescribe (00:00) →
this job (03:05) — the trainer now finishes ~3h before measurement, which is MORE margin,
not less. Pre-flight mtime watch updated accordingly (tonight 23:49, clean).

## Ops notes
- Redescribe pass restarted with denominator 4,093 (remaining-at-restart, as resolved
  11-18); 1,050/4,093 by 02:59 EST, 0 fails, ~10.2 s/track, yielding politely to the BPM
  worker. Writes only `.next*.json` — no brain race.
- vocab stale guard 24/11,549 = 0.21% pass. E2 churn 0.21%.
- Foreground rule held (35th night). Worktree `jt-braineval-20261119` from
  origin/brain-eval, removed clean after push. Snapshot kept.

## Open Jake asks (unchanged, in priority order)
1. **grd-15 trap reword** (PROPOSAL-grd15-trap-staleness-colloquial-dance.md) — the
   deterministic trap failure caps v3 grounding at 0.950 and blocks every apply.
2. **gemma4 promotion pricing queue item** — still NOT queued; needed before any
   `--promote-next`.
3. grd-16/14/19 fenced-json parser proposal (no new evidence tonight — zero flakes).
4. tempo_family 0.440 gap — needs a new Jake-approved hypothesis.
5. grd-12 legacy-tag re-tag (laptop overrides) · Plunderphonics vocab re-export.
