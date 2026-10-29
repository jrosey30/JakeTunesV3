# Nightly brain-eval — 2026-10-29

**Outcome: IDLE (12th consecutive idle night) — baselines only, nothing applied, brain untouched.**

## Pre-flight

- brain-trainer finished 02:03 EDT (log dated today): **+96 tracks enriched**
  — a new biggest add night (library 12,062 → 12,158; embeddings.bin
  → 12,345 vectors, mood-index.bin → 12,158), plus a lyrics-meaning
  catch-up of **9** re-embeds (10-27: 124 → 10-28: 6 → tonight: 9 — the
  drain stays effectively done; single-digit nightly counts now track new
  adds that arrive with lyrics, not backlog). The trainer also ran a new
  **nightly purity gate** and passed it cleanly (neighbour purity 0.9079
  vs 0.9079, regression 0.0000 ≤ 0.02) — that gate shipped with PR #285.
- Files stable ~62 min before snapshot. Snapshot `/tmp/brain-snap-20261029`
  sha-verified against the NAS before and after copy:
  - embeddings.bin `79f21c96b661…` (12,345 vec)
  - mood-index.bin `3b9bb0276379…` (12,158 vec)
  - carried library.json, metadata-overrides.json, artist-members.json,
    lyrics.json, brain-descriptors.json.
- Both shas changed vs 10-28 (prior emb `097a9dbc5355…`, mood
  `2f41a8ee06d6…`) — fully accounted for by tonight's trainer run (+96
  adds + 9 meaning re-embeds). No unlogged writer event.
- Fresh worktree at brain-eval tip `0e53f54` (matched origin). Audio fusion
  OFF as always on homemini (mood-only routing both rulers).

## NEW concurrent job on this box (not a live-brain writer — verified)

`com.jaketunes.brain-redescribe` (PR #285, plist installed 10-28) ran its
first window tonight, 02:30–07:00, alongside this job: a staged gemma4:12b
re-describe of the whole library (blind A/B scored gemma4:12b 77% accurate
descriptors vs live gemma3:4b's 55%). **Verified in
`scripts/brain-redescribe.mjs`: it writes ONLY
`brain-descriptors.next.json`** — never embeddings.bin, mood-index.bin, or
the live brain-descriptors.json. Promotion is a separate explicit
`--promote-next` step, and the script ships a `--mood-candidate <file>`
mode built for this harness to score staged-vs-live before any promotion.
Tonight it reached ~450/12,134 tracks (~4.9 s/track, ~15.8 h of model time
left → roughly two weeks of nightly windows). It hammers Ollama during my
window but did not affect tonight's runs (grounding is OpenAI; retrieval is
local numpy + the node bridge).

## Bridge main-src advance

origin/main advanced `667ac01` → `628ed75` (PRs #284–#291: orphan-check
mirror fix, the staged-redescribe trainer work, On Repeat playlist,
concerts date ordering, and the genre-filer overhaul #288–#291).
Retrieval-neutral by inspection — **zero diff under `src/main/ai/`**, no
change to `genre-vocab.ts` / `genre-iceberg.ts` (vocab snapshot still
fresh: `3c6d2e22e73f`), the rest is writer scripts + renderer/UI — and by
routes: v1 unchanged (8 mood / 7 main), v3 mix identical
(29 main / 94 mood / 1 mood+lexicon / 30 main+decade).

## Pick

`pick_experiment.py pick` → **IDLE**. E1 bare backlog = 0 (all 96 new adds
enriched same-night — same-night enrichment's biggest test yet, passed);
E2 genre-tag churn 21/11,550 (0.18%, needs >1% — note the genre-filer
changes in #288–#291 could push churn over the gate on a future night;
that is exactly what E2 is queued for). Auto lane and Jake lane both empty.

## Baselines (the night's only measurement)

| ruler | headline | detail |
|---|---|---|
| v1 | **0.908** | retrieval 0.816 / grounding 1.000 — a hair above the ×14 band (0.810–0.813 / 0.905–0.906); the entire move is ONE mood-routed row, ret-007 0.84 → 0.88 (+1 slot). Band extends to 0.810–0.816 / 0.905–0.908, ×15 nights 10-15..29 |
| v3 | **0.797** | artist 0.963 / umbrella_family 0.913 / leaf 0.836 / family_decade 0.869 / tempo_family 0.497 / vibe 0.703; grounding **1.000 (20/20)**; primary source bridge; ruler fresh (eval_set `c2d5e57c9f53`, vocab `3c6d2e22e73f`), qvec 348 cached / 0 fresh |

E3 win still holding: v3 0.797–0.803 ×15 nights across add-churn.
Grounding flake did NOT fire — class tally stays 5 of 15 nights
(grd-16 ×3, grd-14 ×2).

## Drift vs 10-28 (4 of 174 rows moved)

- v3-tempo-07 0.84 → 0.76, v3-tempo-02 0.88 → 0.84, v3-tempo-14
  0.12 → 0.08, v3-vibe-prod-002 0.92 → 0.88. All four are small
  single-to-double-slot drops; three of four sit in tempo_family — the +96
  add-churn landing on the group that has no bpm-aware retrieval term
  (the standing gap). Group means: tempo_family 0.507 → 0.497, vibe
  0.707 → 0.703; headline 0.799 → 0.797, inside the holding band. The
  all-downward direction on n=4 is noted but is one night of churn on the
  two weakest groups, not a watch; if tempo_family drops again on the next
  add night, say so explicitly in that report.
- Sentinels: **vibe-prod-006 HELD 0.64 a 6th straight night**;
  **leaf-20 held 0.92**.

## Applied

Nothing. IDLE night — no candidate was built, no gate was run, the NAS
brain was never written. Backups unchanged (E3 undo still
`mood-index.bin.pre-E3-20261014`, sha `028b02ea0e93…`).

## Standing items for Jake

1. `PROPOSAL-grd16-fenced-json-parse.md` — tolerant parse in scorecard.py
   (option a). Still the main apply-risk on future non-idle nights.
2. tempo_family 0.497 (main-idx diag 0.107) — standing gap, no queued
   remedy; needs a new Jake-approved hypothesis (tempo in mood text, or a
   bpm-aware rerank term). Tonight's drift landed mostly here.
3. **NEW — gemma4:12b promotion will need a queue item.** When the staged
   re-describe finishes (~two weeks of windows), the right path is already
   built: `brain-redescribe.mjs --mood-candidate <file>` produces a
   candidate mood index from the staged descriptors for this harness to
   score against baseline, and `--promote-next` applies only after the
   eval passes. Per the one-item-per-night rule I am not queueing it —
   Jake should add the auto-lane item (eligibility: staged count =
   candidate-needed count, i.e. staging complete) so the dual-run gate
   prices the upgrade the night it's ready.

## Next nights

Queue fully drained — IDLE until >1% main-tag churn (watch the genre-filer
PRs), a bare backlog, or Jake queues work (the gemma4 promotion item
above). Mood-sha changes should keep tracking adds (+ single-digit
meaning re-embeds); an unexplained mood sha change remains a strong
unlogged-writer signal. The redescribe job will keep running 02:30–07:00
concurrently — it is verified staged-only, but if a future night's
pre-flight ever sees mood/emb mtimes move after 02:30, suspect promotion
ran early and stop.
