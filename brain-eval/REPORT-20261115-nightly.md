# Nightly brain-eval — 2026-11-15 (homemini, ~03:05 EST)

**Outcome: IDLE (30th consecutive) — baselines only, nothing applied, brain untouched.**

## Pre-flight
- brain-trainer finished 02:17 EST (+138 enriched, brain 14,041/14,041 tracks, embeddings.bin 14,255 vectors; purity gate ok 0.8959, regression 0.0000). Mood-index nightly +138 → 14,041 accounted; NO prune (brain-prune-ledger.jsonl last line stays 11-12).
- NAS mtimes 02:16–02:19, stable ≥45 min at measure time; nothing after 02:30 (promotion watch clean).
- Snapshot `/tmp/brain-snap-20261115` sha256-verified against NAS before and after copy (emb `9e1e05bf2c30…`, mood `239a313973…`, lib `acc110f031…`). Carries artist-members / metadata-overrides / lyrics aux.
- Worktree `wt-20261115` fresh from origin/brain-eval (754d1d17); .env copied; removed clean after the run.
- origin/main moved again b38e9a7a → **3478d3ba** — new main-src hash, routes IDENTICAL on both rulers, scores flat ⇒ benign, expect 3478d3ba as baseline next night.

## Scores
- **v1 (B1-20261115): retrieval 0.811 / grounding 1.000 / overall 0.906.** One mover: ret-015 0.83 → **0.90** (mood-routed *enrich; the add wave grew into the aggressive predicate, |expected|=2,708). All traps clean, grd-005 stayed recovered. Routes 8 mood / 7 main (unchanged).
- **v3 (B3-20261115): headline 0.7788 — numerically IDENTICAL to 11-14.** 10th night settled ~0.78. Groups: artist 0.963 / umbrella 0.907 / leaf 0.834 / family_decade 0.876 / tempo_family 0.443 / vibe 0.651 — all six unchanged at 3 decimals. Primary source **bridge**; routes 29 main / 94 mood / 1 mood+lexicon / 30 main+decade (identical). Diagnostics: main-idx 0.571 / mood-idx 0.534.
- **v3 grounding 0.850**: grd-15 standing trap (deterministic, cited 2 — APPLY-BLOCKER stands until Jake rewords the ruler) **plus grd-16 AND grd-20 both "unparseable (reply was not JSON)"** = the documented fenced-JSON parser signature, not a new failure mode. Tally: grd-16 ×6, grd-20 ×2; flake-nights 15/30. The parser proposal (PROPOSAL-grd16-fenced-json-parse.md) just claimed two more points tonight — it remains Jake ask #3 and tonight is more evidence for it.

## Movers (v3): 4/174 — quietest-possible substantive night
- grd-16 1→0, grd-20 1→0 (parser flakes, above)
- vibe-prod-001 0.24→0.28, vibe-prod-003 0.04→0.00 (one slot each — net zero churn)
- The +138 add wave moved essentially nothing, again: second consecutive night the brain is near-static under add-churn at 14k scale.
- Watch items ALL HELD exactly: leaf-33 0.64 / leaf-41 0.68 / leaf-29 0.48 / tempo-12 0.04 / vibe-prod-006 0.68 / leaf-12 0.52 / leaf-38 0.68 / fdec-18 0.36.

## Queue
`pick_experiment.py pick` → **IDLE**. E1 bare backlog = 0; E2 genre-tag churn 24/11,549 = 0.21% (need >1%; vocab-stale guard also passes, threshold 0.5%). Jake lane empty. Ledger 'picked' event appended + committed.

## Identity (end of run)
- NAS brain re-verified byte-identical after all measurement: emb sha256 `9e1e05bf2c30…` (14,255 vec) / mood `239a313973…` (14,041 vec) — **nothing written**.
- Harness ids: brain_id `fb27decb36ef` / mood_id `8848c826274f` / library `ebc126790e54` (14,041 tracks) / main-src `3478d3ba`.

## Open Jake asks (unchanged order)
1. grd-15 trap reword (PROPOSAL-grd15-trap-staleness-colloquial-dance.md) — blocks every v3 gate.
2. gemma4 promotion PRICING queue item (still not queued; redescribe-all pass was ~700/8,928 as of 11-14 — check its log before promoting anything).
3. Fenced-JSON parser fix (PROPOSAL-grd16-fenced-json-parse.md) — +2 flake points tonight.
4. tempo_family 0.443 — needs a new approved hypothesis.
5. grd-12 legacy-tag re-tag (laptop overrides) · Plunderphonics vocab re-export.
6. Re-center advisories: v1 ~0.804–0.811 band, v3 ~0.78.
