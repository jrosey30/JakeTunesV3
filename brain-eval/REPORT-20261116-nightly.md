# Nightly brain exercise — 2026-11-16 (homemini)

## Outcome
**IDLE — 31st consecutive idle night. Baselines only. Nothing applied; brain untouched** (NAS
`embeddings.bin` + `mood-index.bin` sha256 verified identical before measurement and at end of run).

## Pre-flight
- brain-trainer finished 02:10 EST (+45 enriched; brain 14,086/14,086 tracks, embeddings.bin
  14,300 vectors, mood-index 14,086 vectors; purity gate ok −0.0010). NAS mtimes 02:09, stable
  ≥2 min before snapshot — clean, before the 02:30 promotion watch line.
- Mood prune ledger: last line still 2026-11-12 (id 15018) — mood fully accounted by the trainer
  (14,041 + 45 = 14,086), no unlogged writer event.
- Snapshot `/tmp/brain-snap-20261116` (7 files incl. aux), sha-verified against NAS before and
  after the copy; NAS stable across copy.
- Harness ids: brain_id `5e03435968da` / mood_id `a05a546c6bba` / library `54332f249dc4`
  (14,086 tracks). NAS sha256: emb `42023418d0ab…`, mood `7683bc4201…`.
- ⚠️ origin/main moved again `3478d3ba → cf87f18dce90`. Routes IDENTICAL on both rulers
  (v1 8 mood / 7 main; v3 29/94/1/30), scores flat ⇒ benign; `cf87f18dce90` is the new
  expected main-src hash.
- One transient network blip: the first v3 run died mid-grounding with `[Errno 65] No route to
  host` reaching api.anthropic.com. No partial rows written; network recovered within a minute;
  the retry completed normally. Not counted as a failure (flaky external system).

## Baselines
- **v1 (B1-20261116): retrieval 0.811 / grounding 1.000 / overall 0.906** — numerically identical
  to 11-15. ret-015 held at 0.90. All traps clean.
- **v3 (B3-20261116): headline 0.7799** (12th night settled ~0.78; 11-06..16:
  0.789/0.778/0.785/0.782/0.781/0.780/0.779/0.779/0.779/0.779/0.780 — re-center still the lean).
  Groups: artist 0.963 / umbrella 0.907 / leaf 0.835 / family_decade 0.876 / tempo_family 0.448
  / vibe 0.651 — leaf +0.001, tempo_family +0.005, rest unchanged.
- **v3 grounding 0.900** = grd-15 trap (deterministic colloquial-dance, cited 2 — the standing
  APPLY-BLOCKER until Jake rewords the ruler) + **grd-20 "unparseable (reply was not JSON)"**
  (the documented fenced-JSON parser signature, 2nd consecutive night for grd-20 → its tally
  is now ×3; flake-night tally **16/31**). grd-16 recovered (1-night flake, as usual).
- Primary source: **bridge** (production path) on both runs. Vocab stale guard: 24/11,549 =
  0.21% — passes (threshold 0.5%).

## Movers (v3, 11-15 → 11-16): 5/174 — another near-record-quiet night
- v3-grd-16 0→1 (parser flake recovered) · v3-leaf-38 0.68→0.72 · v3-leaf-41 0.68→0.72 ·
  v3-tempo-04 0.84→0.88 · v3-tempo-13 0.16→0.20 — four one-slot gains, zero drops. The +45 add
  wave was mildly positive; 3rd consecutive near-static night under add-churn at 14k scale.
- Watch items ALL HELD or improved: leaf-33 0.64 / leaf-41 0.68→**0.72** / leaf-29 0.48 /
  tempo-12 0.04 / vibe-prod-006 0.68 / leaf-12 0.52 / leaf-38 0.68→**0.72** / fdec-18 0.36.

## Queue
`pick_experiment.py pick` → **IDLE**: E1 bare backlog = 0; E2 genre-tag churn 24/11,549 = 0.21%
(needs >1%); Jake lane empty. Ledger 'picked' (mode idle) event committed with the night's logs.

## Open Jake asks (unchanged order)
1. **grd-15 trap reword** (PROPOSAL-grd15-trap-staleness-colloquial-dance.md) — blocks every
   apply until resolved.
2. **gemma4 promotion pricing queue item** — still not queued; redescribe-all pass is grinding
   toward a full gemma4 mood index, price it with the dual-run gate BEFORE any --promote-next.
3. **Fenced-JSON parser proposal** (PROPOSAL-grd16-fenced-json-parse.md) — +1 evidence point
   tonight (grd-20 again).
4. tempo_family 0.448 — top open quality item; needs a new Jake-approved hypothesis.
5. grd-12 legacy-tag proposal; Plunderphonics vocab re-export.

## Numbers
| ruler | run | headline | grounding | notes |
|---|---|---|---|---|
| v1 | B1-20261116 | 0.811 ret / 0.906 overall | 1.000 | identical to 11-15 |
| v3 | B3-20261116 | 0.7799 | 0.900 | grd-15 trap + grd-20 parser flake |
