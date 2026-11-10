# Nightly brain exercise — 2026-11-10 (homemini)

## Verdict
**IDLE (24th consecutive) — baselines only, nothing applied, brain untouched.**
`pick_experiment.py pick` → IDLE: E1 bare backlog = 0; E2 genre-tag churn 24/11,549 = 0.21% (needs >1%). Jake lane empty. No candidate was built, no gate was run, no write to any brain file.

## Pre-flight
- brain-trainer finished 02:17 EST, exit clean: +183 enriched (every new add), brain now **13,479/13,479** tracks; embeddings.bin **13,691 vectors**, mood-index **13,479 vectors**; purity gate ok (0.8759 vs 0.8739, regression −0.0020 ≤ 0.02).
- Mood accounting exact: 13,296 (11-09) + 183 trainer adds, **no prune tonight** (last brain-prune-ledger line is 11-09) = 13,479. No unlogged writer.
- Mtimes 02:17 (< the 02:30 promotion watch), stable 48 min before snapshot. Redescribe job only yielded to streaming all night (writes .next.json only — not a brain writer).
- Snapshot /tmp/brain-snap-20261110 (7 files incl. artist-members/metadata-overrides/lyrics), sha-verified against NAS before + after copy. Worktree /tmp/wt-20261110 fresh from origin/brain-eval @ 6bcbe1d8.

## Baselines (snapshot, harness brain_id 6c9afa599449, library 8e3a8e3e3457)
- **v1 (B1-20261110): retrieval 0.804 / grounding 1.000 / overall 0.902** — 5th straight night at retrieval 0.804 vs the old 0.810–0.816 band (11-06..10: 0.808/0.808/0.804/0.804/0.804). Sustained add-churn drift; looks like it may be settling at 0.804 — one more night or two decides band re-center. Routes 8 mood / 7 main, unchanged. rt ≥ 0.80 so the "rt<0.80 = NEW" tripwire did not fire.
- **v3 (B3-20261110): headline 0.781**, primary source **bridge** (production path), routes identical: 29 main / 94 mood / 1 mood+lexicon / 30 main+decade. Main src moved 3f67cb74 → cc9fc7e29e59 (weekend merges on main); routes identical on both rulers so bridge = production holds.
- Groups: artist 0.963 / umbrella 0.909 / leaf 0.830 / family_decade 0.876 / tempo_family 0.453 / vibe 0.655. tempo_family (0.453, −0.010) remains the top open quality item — still needs a Jake-approved hypothesis.
- **v3 grounding 0.850**: grd-15 trap failed again (the deterministic Johnny B. Goode colloquial-dance citation — APPLY-BLOCKER until Jake rewords the ruler, PROPOSAL-grd15-trap-staleness-colloquial-dance.md), **plus grd-16 AND grd-19 both unparseable-JSON tonight** (known flake ids; transport/formatting, not fabrication — PROPOSAL-grd16-fenced-json-parse.md). Flake tally now **11/25** (grd-16 ×5 / grd-14 ×3 / grd-12 ×1 / grd-19 ×2). First night with two flakes at once.

## Movers (v3, vs B3-20261109): 18/174, 7↑ / 11↓
Consistent with the 183-vector wave (1.4% of mood index — ~2× a normal night). Mostly ±0.04 one-slot shuffles; expected sets grew broadly (adds + overrides re-tags).
- **leaf-33 "Melodic Rap songs" 0.84 → 0.64 (−0.20), expected set UNCHANGED (190)** — pure rank shuffle, the night's one real dip. WATCH (same shape as leaf-41's 11-09 dip).
- leaf-31 "Jazz Fusion" 0.68 → 0.88 (+0.20), expected 46→54 (re-tag wave onto the leaf).
- leaf-41 "Singer-Songwriter" held at 0.68 — did not recover, did not worsen.
- leaf-29 (11-09's re-tag mover) stable tonight.
No migration-matrix needed: tag churn 0.21% ≪ 1%, and the big dip's expected set didn't move.

## Integrity
End-of-run NAS shas identical to snapshot: embeddings.bin d2caf52433…, mood-index.bin 7f287adcbb…. Brain untouched. All commands foreground; session completed in one pass.

## Open Jake asks (unchanged order)
1. **grd-15 ruler reword** (clears the nightly apply-blocker).
2. **Queue the gemma4 promotion pricing item** before any `--promote-next` (redescribe backlog is 100% staged).
3. grd-16/14/19 fenced-JSON parser proposal — tonight strengthens it: 2 flakes in one night, tally 11/25.
4. tempo_family 0.453 hypothesis; grd-12 legacy-tag re-tag; Plunderphonics vocab re-export.
