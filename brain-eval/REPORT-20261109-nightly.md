# Nightly brain-eval — 2026-11-09 (homemini)

**Outcome: IDLE (23rd consecutive) — baselines only, nothing applied, brain untouched.**

## Pre-flight
- brain-trainer finished clean 02:08 EST (+75 enriched; emb 13,508 vec / mood 13,296 vec; library 13,296 tracks). Purity gate ok (0.9135, Δ0.0000).
- 00:00 mood prune LEDGERED: −14 vec (ids 14510, 14566–14578), 13,235 → 13,221; +75 trainer adds = 13,296. Fully accounted.
- No early promotion (emb/mood mtimes 02:08, before the 02:30 watch cutoff). Redescribe job idling, yielding to the BPM/key worker — writes only brain-descriptors.next.json, not a brain writer.
- Snapshot `/tmp/brain-snap-20261109` sha-verified = NAS before and after copy; NAS re-verified UNCHANGED end-of-run.
  - embeddings.bin sha256 `d3bd998519…` (83,047,196 B) · mood-index.bin `0fa3076d5c…` (81,743,820 B) · library `7267081ab5…` · harness brain_id `f6d9c7152fd0`.
- origin/main moved 0e012acd → **3f67cb74** (weekend work); bridge archived it, primary source **bridge**, routes IDENTICAL both rulers (v1 8 mood / 7 main; v3 29 main / 94 mood / 1 mood+lexicon / 30 main+decade) → bridge = production holds on the new src.
- Vocab stale guard passed (E2 shows 24/11,549 = 0.21% tag churn).

## Baselines (run ids B1-20261109 / B3-20261109)
- **v1: retrieval 0.804 / grounding 1.000 / overall 0.902** — identical to 11-08; 4th night just under the 0.810–0.816 band (0.808/0.808/0.804/0.804). Sustained add-churn drift; keep watching for re-center.
- **v3 headline 0.782** (11-06/07/08: 0.789 / 0.778 / 0.785) — still below the 0.794–0.803 band, bouncing in the add-churn recovery zone.
  - Groups: artist 0.963 / umbrella_family 0.904 / **leaf 0.830 (−0.015)** / family_decade 0.875 / tempo_family 0.463 / vibe 0.659.
  - **v3 grounding 0.900**: grd-15 trap (the standing deterministic APPLY-BLOCKER) + **grd-19 unparseable-JSON flake — a NEW flake id** (reply not JSON; transport/formatting, same class as PROPOSAL-grd16-fenced-json-parse). Flake tally now **9/24** (grd-16 ×4 / grd-14 ×3 / grd-12 ×1 / grd-19 ×1). grd-16 itself recovered to 1 tonight. v1 grounding 1.000.

## Movers (|Δ| ≥ 0.04 vs B3-20261108): 9 total, 1↑ / 8↓ — concentrated in leaf
- v3-leaf-29 "Instrumental Hip-Hop" 0.64→0.48: expected set SHRANK 54→41 — tonight's metadata-overrides wave (13,260 applied vs 13,202) re-tagged 13 tracks off the leaf; mood vectors still carry the old genre text until re-embed → known tag-vs-vector lag, self-corrects as the trainer re-embeds. Churn 0.21% ≪ the 1% E2 gate.
- v3-leaf-41 "Singer-Songwriter" 0.92→0.68 (expected 42 unchanged), leaf-37/38/02/43 −0.04..−0.12, tempo-16 −0.04: rank shuffles from the 75 updated + 14 pruned mood vectors; expected sets ~unchanged. Add-churn, watch only.
- No migration-matrix run needed: churn 0.21% is far below a re-tag wave.

## Pick
`pick_experiment.py pick` → **IDLE** (E1 bare backlog = 0; E2 genre-tag churn 0.21%, needs >1%). Both lanes remain EMPTY. Ledger 'picked' event committed.

## Applied
Nothing. No candidate was built; no gate was run (nothing to gate).

## Open Jake asks (unchanged, in priority order)
1. **grd-15 reword** (PROPOSAL-grd15-trap-staleness-colloquial-dance.md) — v3 grounding is ceilinged at 0.950, so the v3 gate fails every night until reworded. THE apply-blocker.
2. **Queue the gemma4 promotion PRICING item** — redescribe backlog is 100% staged (362/362, brain-descriptors.next.json complete); the trainer's own log says `--mood-candidate` → `--promote-next` is next. Price it through the dual-run gate BEFORE any promotion.
3. grd-16/grd-14/grd-19 fenced/unparseable-JSON parser fix (PROPOSAL-grd16-fenced-json-parse.md) — tally 9/24.
4. tempo_family 0.463 — needs a new approved hypothesis (tempo in mood text, or bpm-aware rerank).
5. grd-12 legacy-tag proposal (laptop overrides) · Plunderphonics vocab re-export.
