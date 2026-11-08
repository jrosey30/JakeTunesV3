# Nightly brain-eval — 2026-11-08 (homemini, ~03:05 EST)

**Outcome: IDLE (22nd consecutive) — baselines only, nothing built, nothing applied, brain untouched.**

## Pre-flight
- brain-trainer completed 02:00–02:14 EST (log dated 2026-11-08T07:00–07:14Z): +211 enriched,
  13,235/13,235, embeddings.bin 13,433 vectors, mood-index 13,235 vectors, purity gate ok
  (0.8645 vs 0.8645, Δ 0.0000).
- 00:00 EST: LEDGERED 2-vector mood prune (ids 8714, 13732; `brain-prune-ledger.jsonl`
  2026-11-08T05:00:08Z, undo at `mood-index.bin.prune.bak`) — normal per the writer rule.
- Redescribe-all **FINISHED tonight: 362/362 staged with gemma4:12b, 0 fails** (01:10 EST),
  all in `brain-descriptors.next.json` (staged-only; live brain untouched). The trainer log
  itself now says "Next: --mood-candidate, score it, then --promote-next" — see Jake asks.
- NAS mtimes stable 02:14 → 03:05 (≥2 min, before the 02:30 promotion-watch cutoff).
- Snapshot `/tmp/brain-snap-20261108`, sha-verified before + after copy (NAS stable during copy).
  Carried: embeddings.bin, mood-index.bin, brain-descriptors.json, library.json,
  artist-members.json, metadata-overrides.json, lyrics.json.

## Brain identity (NEW tonight — +211 adds, full LLM runs on both rulers)
- embeddings.bin sha256 `f03490bf213e` (13,433 vec) — was 1a638d5a8550 (13,222)
- mood-index.bin sha256 `f8b241d3516b` (13,235 vec) — was e3ce707798c3 (13,026)
- harness ids: brain_id `371d5e08eccb` / mood_id `a2e179eb0438` / library `8fb5fcf52ce5`
- mood fully accounted: 13,026 − 2 ledgered prune + 211 adds = 13,235 ✓

## Scores
**v1** (B1-20261108): retrieval **0.804** / grounding **1.000** / overall **0.902**
— third night a hair under the 0.810–0.816 band (0.808/0.808/0.804), consistent with
sustained add-churn. Routes 8 mood / 7 main (identical).

**v3** (B3-20261108): headline **0.785** — recovering from 11-07's 0.778 toward the
0.794–0.803 band. Groups: artist 0.963 / umbrella 0.904 / leaf 0.845 / family_decade 0.875 /
tempo_family 0.465 / vibe 0.659. Grounding **0.900** (grd-15 deterministic trap + a grd-16
unparseable flake — see below). Primary source **bridge**, bridge_error null,
routes {main 29, mood 94, mood+lexicon 1, main+decade 30} = identical to every prior night.
Diagnostics: main-idx 0.575 / mood-idx 0.542.

Main src moved again c959335d → **0e012acd** (weekend merges #363/#367); routes identical on
both rulers → bridge = production still holds.

## Movers (12/174 vs 11-07, up-skewed 7↑/5↓ excluding grd-16)
The 11-07 WATCH item resolved the right way — all three droppers partially recovered as the
new adds got descriptors + tempo lines:
- v3-tempo-07 0.44 → 0.60 (was 0.76 on 11-06)
- v3-vibe-prod-002 0.60 → 0.76 (was 0.84)
- v3-vibe-ret-013 0.73 → 0.87 (was 0.93)
Plus leaf-03 +0.20, leaf-29 +0.16, leaf-36 +0.12, tempo-16 +0.04; down: leaf-41 −0.08,
leaf-09/tempo-04/fdec-04 −0.04. **This supports plain add-churn, not the structural
tempo_family hypothesis** — expect further recovery toward the bands as churn settles.
tempo_family 0.455 → 0.465 remains the top open quality item regardless.

## Grounding detail
- v3-grd-15 trap failed again exactly as diagnosed (cited the deterministic Johnny B. Goode
  colloquial-dance track) → grounding pinned at 0.950 ceiling → **APPLY-BLOCKER STANDS**
  (PROPOSAL-grd15-trap-staleness-colloquial-dance.md, Jake ask #1).
- v3-grd-16 flaked tonight: "unparseable (reply was not JSON)" — the PR #194-diagnosed
  fenced-JSON transport failure, NOT fabrication. Flake tally now **8/23: grd-16 ×4 /
  grd-14 ×3 / grd-12 ×1** (PROPOSAL-grd16-fenced-json-parse.md).
- v1 grounding 1.000, all 4 traps correct.

## Queue
PICK = **IDLE**: E1 bare mood vectors = 0; E2 genre-tag churn 24/11,549 = 0.21% (needs >1%);
Jake lane empty. Ledger 'picked' event committed. Vocab stale guard 33/13,235 = **0.249%**
pass (threshold 0.5%).

## Applied
**Nothing.** No candidate was built (IDLE); the grd-15 apply-blocker would bar any apply
regardless. End-of-run verify: NAS embeddings.bin f03490bf213e / mood-index.bin f8b241d3516b,
mtimes + sizes unchanged since measurement.

## Open Jake asks (unchanged priority)
1. grd-15 trap reword ("1950s electronic dance music") — unblocks the apply gate.
2. **gemma4 promotion queue item — now URGENT-adjacent: the redescribe backlog is 100% staged
   (362/362 tonight, 0 fails) and the trainer is explicitly pointing at --promote-next.**
   Queue the dual-run pricing item BEFORE any promotion.
3. grd-16/grd-14 tolerant-parse ruler fix (pairs with #1 in one ruler PR).
4. tempo_family gap (0.465) — needs a new approved hypothesis (tempo in mood text, or
   bpm-aware rerank).
5. grd-12 legacy-tag re-tag via LAPTOP overrides; Plunderphonics vocab re-export.
