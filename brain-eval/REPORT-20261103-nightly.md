# Nightly brain exercise — 2026-11-03 (IDLE, 17th consecutive)

## Verdict
**IDLE — baselines only, nothing applied.** `pick_experiment.py pick` found nothing
eligible: auto lane empty (E1 bare backlog = 0 — all 154 of tonight's adds enriched
same-night; E2 genre-tag churn 22/11,550 = 0.19%, gate needs >1%), jake lane empty.

## Pre-flight
- brain-trainer finished 02:06 EST (07:06:18Z): **+154 enriched** (largest recent add
  night; library 12,364 → 12,518), meaning catch-up 13, purity gate passed —
  neighbour purity **0.9260** (prev 0.9260, regression 0.0000; level rose from
  11-02's 0.9077 during the daytime interval).
- NAS files stable ≥1h before snapshot; sha-verified copy to `/tmp/brain-snap-20261103`
  (3/3 match, NAS unchanged before/after copy AND re-verified unchanged after both
  eval runs). Snapshot carried artist-members / metadata-overrides / lyrics aux.
- **No 00:00 mood prune tonight** — no new `brain-prune-ledger.jsonl` entry (last:
  11-02 id 13612), and none needed: mood 12,364 + 154 trainer = 12,518 exactly.
  All sha movement accounted: emb + mood = trainer only. Mtimes 02:06 < 02:30
  promotion watch — clean.
- Worktree `/tmp/brain-eval-wt-20261103` from origin/brain-eval 79cd5d9f; wt-20261102
  removed clean.

## Scores (snapshot = live brain: emb sha 929d54e0920a, 12,709 vec; mood 412d79698e4d, 12,518 vec)
- **v1 (B1-20261103): retrieval 0.813 / grounding 1.000 / overall 0.906** — inside
  normals (0.810–0.816 / 1.000 / 0.905–0.908). Routes 8 mood / 7 main, unchanged.
- **v3 (B3-20261103): headline 0.794**, grounding **1.000** — primary source bridge,
  routes identical (main 29 / mood 94 / mood+lexicon 1 / main+decade 30), qvec all
  cached (348/0).
- Groups: artist 0.963 / umbrella_family 0.909 / leaf 0.835 / family_decade 0.872 /
  **tempo_family 0.487** / vibe 0.699.
- **Grounding clean on BOTH rulers** — no grd-14/grd-16 flake tonight; **grd-14
  recovered 0→1**, consistent with the fenced-JSON transport diagnosis (not
  fabrication). Flake tally now 7/20 nights.

## Movers vs 11-02 (B3 rows, n=174)
16 scored movers of 154 (12 down, 4 up, all ±0.04–0.08) + grd-14's +1 — classic
add-churn scaled to the +154-track night; headline 0.796 → 0.794 (−0.002), zero
route changes. Largest: fam-09 0.92→0.84, leaf-24 0.96→0.88 (reverses 11-02's +0.04),
vibe-prod-006 0.68→**0.76**.
- **Sentinels HELD or improved:** vibe-prod-006 0.68→0.76 (new high for this
  sentinel), leaf-20 0.88 flat, tempo-13 0.28 flat, tempo-15 0.20→0.24.
- **tempo_family 0.490→0.487** is mixed churn (tempo-01/08/09 −0.04 each;
  tempo-15/16 +0.04 each), NOT a resumption of the directional slide — the
  slide-watch stays paused. Still the top open quality item; still needs a
  Jake-approved hypothesis (tempo line in mood text, or bpm-aware rerank).

## Bridge / ruler health
- main-src at run time: a86a8ff3 (same as 11-02). Post-run fetch shows origin/main
  advanced to **d9f95acd** (PRs #315 default playlist covers, #316 Top 1000 playlist,
  #317 splash intro evolution) — diff a86a8ff3..d9f95acd touches **zero**
  `src/main/ai` / `bridge/` code (only `src/main/__tests__/splash-eras.test.ts`),
  so tonight's bridge IS production behavior; tomorrow's run will vendor d9f95acd.
- eval_set c2d5e57c9f53 / vocab 3c6d2e22e73f unchanged — series comparable since
  10-12. Vocab staleness unchanged (Plunderphonics + 2 legacy, in-run guard passes
  ~0.27% < 0.5%); re-export remains Jake's call.

## Redescribe campaign (observational)
Full speed with early-evening streaming yields: counter restates pool at
**4,712 remaining**, 800 done by 03:03 EST (0 fails, ~13.7s/track, ~14.9h left
⇒ ~2–3 nights). Staged-only confirmed (live emb/mood untouched by it tonight).
Note: PR #295 (merged to main) extends the redescribe window to **08:15** (was
07:00→then 06:00 per earlier note) — extra drain headroom; window-state note
updated.

## Applied
Nothing. No candidate was built; no gate run (IDLE). Live brain untouched —
verified NAS emb/mood shas identical before snapshot and after all measurement.

## Open items for Jake (unchanged)
1. PROPOSAL-grd16-fenced-json-parse (tolerant parse in scorecard.py) — grd-14's
   0→1 recovery tonight is further confirmation it's transport, not grounding.
2. tempo_family 0.487 gap — needs a new hypothesis before any queue item.
3. grd-12 legacy-tag re-tag (laptop overrides lane).
4. gemma4 promotion queue item once the redescribe campaign drains (~2–3 nights).
5. Plunderphonics vocab re-export.
