# Nightly brain-eval — 2026-11-27 (homemini)

**Outcome: IDLE (42nd consecutive) — baselines only, nothing applied, brain untouched.
v3 headline 0.791 = new high for the comparable series (since 10-12), driven by the
trainer's tempo/key-encoding-v3 catch-up, not by this job.**

## Pre-flight
- brain-trainer finished 23:46 EST (log dated 2026-11-27T04:46Z): big night — tempo
  catch-up re-embedded **500 tracks with tempo/key encoding v3** (500 newly analysed),
  +79 enriched, library 14,789 → **14,866**; brain now 14,866/14,866
  (embeddings.bin 15,089 vectors); purity gate 0.8729 vs 0.8709 (regression −0.0020 ≤ 0.02);
  mood-index 500 + 79 vectors updated (14,866 total after +79).
- Mood prune: 2 vectors (ids 6797, 7566), **ledger-logged** in brain-prune-ledger.jsonl
  at 04:40:13Z with undo copy `mood-index.bin.prune.bak` — normal trainer-time prune,
  writer rule satisfied.
- embeddings.bin/mood-index.bin mtimes 23:46 EST — well before the 02:30 early-promotion
  cutoff; stable >3 h before measurement.
- Snapshot `/tmp/brain-snap-20261127` (7 files incl. artist-members / metadata-overrides /
  lyrics), sha-verified against NAS before AND after copy:
  - embeddings.bin `597a4ac59f77` (15,089 vectors)
  - mood-index.bin `3ed9b0804f63` (14,866 vectors)
  - library.json `f75ff16dcf87` (14,866 tracks)
- Worktree `/tmp/jt-braineval-20261127` from origin/brain-eval (4610e8d1), .env copied.

## Pick
`pick_experiment.py pick` → **IDLE** — E1 bare mood vectors = 0; E2 genre-tag churn
24/11,545 = 0.21% (need >1%). Queue remains fully drained both lanes. Ledger 'picked'
event committed.

## v1 (B1-20261127)
**retrieval 0.812 / grounding 1.000 / overall 0.906** — a hair above the 0.808 normals.
- Sole mover vs 11-26: **ret-012 0.80→0.85** (single slot, brain genuinely changed
  tonight — 500 tempo re-embeds). Zero grounding flakes; flake tally stays
  7 nights / 4 probes / both rulers, zero fabrication.
- ret-011 held 0.48, ret-015 held 0.90, traps clean. Routes 8/7 identical.

## v3 (B3-20261127)
**headline 0.791** — up from 0.779, best comparable reading to date; **grounding 0.950 =
grd-15 trap only** (the known apply-blocker, Jake ask #2); zero v3 parser flakes.
Primary source **bridge**; routes identical 29/94/1/30. Ruler fresh: 34/14,866 = 0.23%
unresolved (< 0.5% stale bar).
- Groups: artist 0.963 / umbrella 0.916 / leaf 0.843 / family_decade 0.877 /
  **tempo_family 0.440** (was 0.427) / **vibe 0.704** (was 0.658).
- Movers vs 11-26: **31/174, net +0.90 probe-points** — the loudest night in weeks,
  exactly where a 500-track tempo re-embed should land: tempo and vibe skewed positive
  (vibe-prod-004/006 +0.16 each, vibe-ret-015 0.93→1.00, tempo-01 0.84→0.92,
  tempo-03/12/15 +0.04 each), broad +0.04 leaf drift.
- tempo-13 0.08→**0.12** (watch stays CLOSED; re-open bar is <0.08).

## leaf-38 forensic (the one real drop: 0.72→0.44, −0.28 after 11 flat nights)
Read-only forensic, fully explained, no mystery:
- "play some Psychedelic Rock" (mood route, k=25, expected 186 unchanged). Reproduced
  0.44 exactly on the snapshot.
- **All 10 Zinc Vacuum tracks** (one album, added 10-13, tagged Psychedelic Rock, every
  one a HIT) had bpm land from the analyzer and were in tonight's 500-track tempo-v3
  catch-up. Their mood vectors moved: cosine to the query dropped ~0.56–0.59 → ~0.48–0.52,
  pushing them from the top-25 to ranks 36–173.
- Every entrant's vector is UNCHANGED since last night — pure displacement. Entrants are
  Doors / Jefferson Airplane / Tame Impala / Guiding Light (HITs) plus Grateful Dead,
  Beatles psych-era, Ween (semantically psychedelic, tagged Classic Rock/Rock = ruler
  misses — same honest-underestimate class as ret-015/grd-12).
- Verdict: the 0.72 was propped up by a single-album 10-track cluster; the tempo line
  diluted its genre affinity (the documented single-vector tradeoff) and the slots went
  to a more diverse, semantically-correct but tag-uncredited set. **Known-benign churn
  with identified root cause — WATCH opened: expect a new band; escalate only if it
  falls below 0.40 or drags the leaf group mean >0.01.** Nothing to fix in the brain;
  if Jake wants the slots credited, the fix is tag-side (re-tag Dead/Beatles psych-era
  via LAPTOP overrides — same family as PROPOSAL-grd12).

## main-src benign-check
origin/main advanced **46aaf42e → 596b3b50** (PR #514, flaky-test fixes — touches test
files only, zero rag/bridge/router code). Benign: routes identical on both rulers
(8/7 and 29/94/1/30). **596b3b50 = new stability baseline.**

## Applied / rejected
Nothing applied, nothing rejected — IDLE night, no candidate built, NAS brain bytes
untouched (embeddings.bin `597a4ac59f77` / mood-index.bin `3ed9b0804f63` re-verified
unchanged at end of run).

## Standing Jake asks (unchanged order)
1. **gemma4 promotion pricing item — STILL NOT QUEUED (top ask).**
2. grd-15 trap reword (apply-blocker for v3 grounding 1.000).
3. Fenced-json parser fix (PROPOSAL-grd16; root cause proven 11-25).
4. tempo_family gap (0.440 tonight — moving the right way on its own via tempo-v3).
5. grd-12 legacy-tag proposal + Plunderphonics vocab re-export.
