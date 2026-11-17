# Nightly brain exercise — 2026-11-17 (homemini)

## Outcome
**IDLE — 32nd consecutive idle night. Baselines only. Nothing applied; brain untouched** (NAS
`embeddings.bin` + `mood-index.bin` sha256 verified identical before measurement and at end of run).

## Pre-flight
- brain-trainer finished 02:07 EST (+13 enriched; brain 14,099/14,099 tracks, embeddings.bin
  14,313 vectors, mood-index 14,099 vectors; purity gate ok, regression 0.0000). NAS mtimes
  02:07, stable ~58 min before snapshot — clean, before the 02:30 promotion watch line.
- Mood prune ledger: last line still 2026-11-12 (id 15018) — mood fully accounted by the trainer
  (14,086 + 13 = 14,099), no unlogged writer event.
- Snapshot `/tmp/brain-snap-20261117` (7 files incl. aux), sha-verified against NAS before and
  after the copy; NAS stable across copy.
- Harness ids: brain_id `7c2b332129d6` / mood_id `4f67e8c324cd` / library `27f55d5939fd`
  (14,099 tracks). NAS sha256: emb `c5a238c52cc5…`, mood `41642debdfa8…`.
- main-src **stable** at `cf87f18dce90` (first night since 11-14 with no origin/main movement).
  Routes identical on both rulers (v1 8 mood / 7 main; v3 29/94/1/30).
- No network blips; both rulers completed first try.

## Baselines
- **v1 (B1-20261117): retrieval 0.811 / grounding 1.000 / overall 0.906** — numerically identical
  to 11-15 and 11-16; ZERO v1 probe movers. ret-015 held 0.90. All traps clean.
- **v3 (B3-20261117): headline 0.7805** (13th night settled ~0.78; 11-06..17:
  0.789/0.778/0.785/0.782/0.781/0.780/0.779/0.779/0.779/0.779/0.780/0.7805 — re-center at ~0.78
  remains the lean). Groups: artist 0.963 / umbrella 0.909 / leaf 0.837 / family_decade 0.876 /
  tempo_family 0.448 / vibe 0.651 — umbrella +0.002, leaf +0.002, rest unchanged.
- **v3 grounding 0.950** = grd-15 trap only (deterministic colloquial-dance, cited 2 — the
  standing APPLY-BLOCKER until Jake rewords the ruler). **grd-20 recovered** → its 11-15/11-16
  "unparseable" run was a two-night flake, tally stays ×3. No new flake tonight: flake-night
  tally stays **16/32**.
- Primary source: **bridge** (production path) on both runs. Vocab stale guard: 24/11,549 =
  0.21% — passes (threshold 0.5%).

## Movers (v3, 11-16 → 11-17): 4/174 — all gains, zero drops
- v3-grd-20 0→1 (parser flake recovered) · v3-umb-04 0.96→1.00 · v3-leaf-34 0.36→0.40 ·
  v3-leaf-30 0.32→0.36. The +13 add wave was neutral-to-mildly-positive; 4th consecutive
  near-static night under add-churn at 14k scale.
- Watch items ALL HELD: leaf-33 0.64 / leaf-41 0.72 / leaf-29 0.48 / tempo-12 0.04 /
  vibe-prod-006 0.68 / leaf-12 0.52 / leaf-38 0.72 / fdec-18 0.36.

## Queue
`pick_experiment.py pick` → **IDLE**: E1 bare backlog = 0; E2 genre-tag churn 24/11,549 = 0.21%
(needs >1%); Jake lane empty. Ledger 'picked' (mode idle) event committed with the night's logs.

## Redescribe (observation only — not a brain writer)
Tonight it actually worked (unlike 11-14/11-16's zero-work nights): 01:29–01:58 EST it ground
550→**750/6,944** (0 fails, ~9.5 s/track, ~16.3 h left), yielded to the trainer 02:00–02:04,
then the swap guard ended it (12,239 MB > 12,000, exit 143 — same signature as before, but this
time AFTER real progress). Note the pass denominator changed 8,928 (11-14) → 6,944 — looks like
the pass restarted/recounted; worth an eye next night, not a failure. Writes only `.next.json`.
The gemma4 promotion PRICING queue item (Jake ask #2) is still not queued.

## Open Jake asks (unchanged order)
1. **grd-15 trap reword** (PROPOSAL-grd15-trap-staleness-colloquial-dance.md) — blocks every
   apply until resolved.
2. **gemma4 promotion pricing queue item** — redescribe is now making real progress toward a
   full gemma4 mood index; price it with the dual-run gate BEFORE any --promote-next.
3. **Fenced-JSON parser proposal** (PROPOSAL-grd16-fenced-json-parse.md) — no new evidence
   tonight (grd-20 recovered), tally unchanged.
4. tempo_family 0.448 — top open quality item; needs a new Jake-approved hypothesis.
5. grd-12 legacy-tag proposal; Plunderphonics vocab re-export.

## Numbers
| ruler | run | headline | grounding | notes |
|---|---|---|---|---|
| v1 | B1-20261117 | 0.811 ret / 0.906 overall | 1.000 | identical to 11-15/11-16, zero movers |
| v3 | B3-20261117 | 0.7805 | 0.950 | grd-15 trap only; grd-20 recovered |
