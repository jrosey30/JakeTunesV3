# Nightly brain exercise — 2026-11-11 (homemini)

## Outcome
**IDLE (26th) — baselines only. Nothing applied; brain untouched** (NAS emb sha256
`dfe455ad6eba` / mood `5effe3596e90` verified identical before measurement and at
end of run). `pick_experiment.py pick` → IDLE: E1 bare backlog = 0; E2 genre-tag
churn 24/11,549 = 0.21% (< 1% gate). Queue remains fully drained both lanes.

## Pre-flight
- brain-trainer finished clean 02:17 EST (160 enriched; brain 13,638/13,638;
  embeddings.bin 13,851 vectors). Mtimes stable ≥45 min before snapshot; nothing
  after the 02:30 watch line.
- 00:00 mood prune ledgered (1 vector, id 14862, 13,479→13,478). Mood fully
  accounted: 13,478 + 160 trainer adds = 13,638. No unlogged writer events.
- Redescribe job ended early at 02:05 (swap 12.8 GB > 12 GB limit, exit 143) —
  writes only brain-descriptors.next.json, not a brain writer. Backlog remains
  100% staged; the gemma4 promotion pricing item is STILL NOT QUEUED (Jake ask #2).
- Snapshot /tmp/brain-snap-20261111 sha-verified against NAS before + after copy.
- Worktree /tmp/wt-20261111 fresh from origin/brain-eval (8deaca0d).

## Baselines (brain_id 524eb741c44d, 13,851 vec; library e2897373638f)
- **v1: retrieval 0.804 / grounding 0.900 / overall 0.852** (run B1-20261111)
  - retrieval 0.804 = **6th consecutive night** (11-06..11: 0.808/0.808/0.804/0.804/0.804/0.804).
    Four straight identical readings below the old 0.810–0.816 band — this looks
    settled, not transient. **Recommend re-centering the v1 retrieval normal to 0.804**
    (Jake's call; rt<0.80 = NEW still stands as the alarm line).
  - grounding 0.900: **grd-005 unparseable (reply was not JSON) — FIRST v1 grounding
    flake in the series.** Same transport/formatting class as the v3 flakes; v1
    fabrication record stays clean. Overall 0.852 is depressed by the flake only.
- **v3: headline 0.780 / grounding 0.850** (run B3-20261111; primary source bridge;
  routes 29 main / 94 mood / 1 mood+lexicon / 30 main+decade — identical to 11-10,
  so bridge = production holds across the main-src move cc9fc7e2 → a45b40529a5b)
  - groups: artist 0.963 / umbrella 0.909 / leaf 0.829 / family_decade 0.876 /
    tempo_family 0.450 / vibe 0.651. Headline in the add-churn zone
    (11-06..11: 0.789/0.778/0.785/0.782/0.781/0.780) — 6th night below the
    0.794–0.803 band; watching for re-entry vs re-center continues.
  - grounding 0.850 = grd-15 trap (deterministic APPLY-BLOCKER, unchanged) **plus
    grd-05 AND grd-11 unparseable — two NEW flake IDs**; grd-16 and grd-19 both
    recovered. Flake tally now **13/26** (grd-16 ×5 / grd-14 ×3 / grd-12 ×1 /
    grd-19 ×2 / grd-05 ×1 / grd-11 ×1 — plus v1 grd-005 tonight). **Three
    unparseable-JSON events in one night across both rulers = the strongest night
    yet for PROPOSAL-grd16-fenced-json-parse.md** (transport/formatting, not
    fabrication). That proposal should rise toward the top of Jake's list.

## Movers (v3, vs B3-20261110): 9/174 — very quiet
- 4 are grounding flakes swapping (grd-16/19 up, grd-05/11 down).
- 5 retrieval movers, all ±0.04 one-slot shuffles from the 160-vector wave:
  leaf-12 0.56→0.52, tempo-09 0.88→0.84 (exp 1799→1811), tempo-12 0.08→0.04,
  vibe-prod-006 0.72→0.68, tempo-07 0.60→0.64.
- **Watch items all HELD exactly**: leaf-33 Melodic Rap 0.64 (2nd night — settled
  at the lower level, same shape as leaf-41's dip; no further decay), leaf-41
  Singer-Songwriter 0.68, leaf-29 0.48.

## Applied / rejected
Nothing applied, nothing rejected — no experiment ran (IDLE). Auto-apply
remains impossible until the grd-15 trap is reworded (grounding ceiling 0.950
< required 1.000).

## Standing Jake asks (unchanged order, #3 strengthened tonight)
1. grd-15 trap reword (PROPOSAL-grd15-trap-staleness-colloquial-dance.md) — apply-blocker.
2. Queue the gemma4 promotion pricing item (brain-descriptors.next.json 100% staged).
3. grd flaky-parse proposal (PROPOSAL-grd16-fenced-json-parse.md) — now 3 events
   in one night, first-ever v1 hit.
4. tempo_family 0.450 — needs a new Jake-approved hypothesis.
5. grd-12 legacy-tag proposal; Plunderphonics vocab re-export (stale 0.21%, well under gates).
