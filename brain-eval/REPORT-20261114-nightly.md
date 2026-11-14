# Nightly brain-eval — 2026-11-14 (homemini, launchd 03:05)

## Verdict
**IDLE (29th consecutive) — baselines only, nothing applied, brain untouched.**
`pick_experiment.py pick` → IDLE: E1 bare backlog = 0; E2 genre-tag churn 24/11,549 = 0.21% (gate 1%). Queue remains empty in both lanes.

## Pre-flight
- brain-trainer completed 02:17 EST (log: +152 enriched this run — the biggest add wave in weeks; brain now 13,903/13,903 tracks, embeddings.bin 14,117 vectors; purity gate ok 0.8709 vs 0.8689). NAS brain mtimes 02:16, stable ≥2 min before snapshot.
- No mood prune tonight — brain-prune-ledger last line stays 2026-11-12 (id 15018). Mood accounting clean: 13,751 + 152 trainer adds = 13,903 ✓ (matches run row `mood_vectors`).
- Redescribe job: now in a full **redescribe-all pass (700/8,928 done, ~10.2s/track, ~23h of work left, 0 fails)** — a scale change from the previously-reported 362-track staged backlog. It yielded to the trainer at 07:00Z then ended on its swap guard (12,617 MB > 12,000, exit 143). Benign — writes only `brain-descriptors.next.json`, not a brain writer.
- Snapshot `/tmp/brain-snap-20261114` (7 files incl. artist-members / metadata-overrides / lyrics), sha-verified against NAS before + after copy: NAS stable, all copies match. emb sha256 a7a63c05b3eb / mood 90474053be1f / library b3783554ecc6.

## Scores
| ruler | result | prior (11-13) |
|---|---|---|
| v1 (B1-20261114) | retrieval **0.807** / grounding **1.000** / overall **0.903** | 0.807 / 1.000 / 0.903 (identical) |
| v3 (B3-20261114) | headline **0.779** (0.7788) / grounding **0.950** | 0.779 / 0.900 |

- harness brain_id 0d24fe05e753 / mood_id 0dfe9f717dfc; library 13,903 tracks.
- v1: grd-005 stayed recovered (2nd clean night); all traps clean; ret-015 held 0.83; routes 8 mood / 7 main (unchanged).
- v3 groups: artist 0.963 / umbrella 0.907 / leaf 0.834 / family_decade 0.876 / tempo_family 0.443 / vibe 0.651 — all within one slot of 11-13. 9th night settled ~0.78 (11-06..14: 0.789/0.778/0.785/0.782/0.781/0.780/0.779/0.779/0.779) — re-center recommendation strengthens.
- v3 grounding 0.950 = **grd-15 trap ONLY** (cited 2, the known deterministic colloquial-dance failure). **grd-20 recovered 0→1** — last night's unparseable was a one-night flake, not a repeat. No new flake IDs tonight; tally stays 14/29 nights with a flake somewhere (tonight flake-free apart from the standing trap).
- **Movers 3/174 — ties 11-13's "quietest" low once grd-20's recovery is set aside (2 substantive):** grd-20 0→1 (recovery), leaf-20 0.76→0.80 (+1 slot), tempo-13 0.20→0.16 (−1 slot). The 152-vector add wave moved essentially nothing — the brain is remarkably stable under add-churn at this size.
- Watch items ALL HELD exactly: leaf-33 0.64 / leaf-41 0.68 / leaf-29 0.48 / tempo-12 0.04 / vibe-prod-006 0.68 / leaf-12 0.52 / leaf-38 0.68. fdec-18 held 0.36.
- **Main-src changed: fe8fed66715a → b38e9a7a9861** (origin/main moved since 11-13). Primary source still `bridge`; routes IDENTICAL on both rulers (v3: 29 main / 94 mood / 1 mood+lexicon / 30 main+decade); scores flat → the main change did not alter retrieval-path behavior. Not a bridge failure.
- Vocab stale guard passed (24/11,549 = 0.21%, threshold 0.5%).

## Applied
Nothing. IDLE night; the standing APPLY-BLOCKER (grd-15 trap → v3 gate cannot pass) is unchanged anyway — PROPOSAL-grd15-trap-staleness-colloquial-dance.md remains Jake ask #1.

## Open Jake asks (unchanged order)
1. grd-15 trap reword (apply-blocker).
2. Queue the gemma4 promotion PRICING item — more urgent now that redescribe has moved to a full 8,928-track redescribe-all pass (~23h of Gemma work left); pricing must happen BEFORE any `--promote-next`.
3. grd-16/14/19 fenced-json parser proposal (grd-20's one-night flake-and-recover is consistent with it).
4. tempo_family 0.443 — needs a new approved hypothesis.
5. grd-12 legacy-tag proposal; Plunderphonics vocab re-export.

## End-of-run integrity
NAS brain re-verified after all runs: embeddings.bin a7a63c05b3eb (14,117 vec) / mood-index.bin 90474053be1f (13,903 vec) — unchanged from snapshot. Brain untouched.
