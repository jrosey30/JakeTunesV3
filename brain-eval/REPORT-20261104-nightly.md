# Nightly brain exercise — 2026-11-04 (homemini)

**Outcome (b): IDLE night 18 — baselines only, nothing applied, brain untouched end-to-end.**

## Pre-flight
- brain-trainer completed 02:04:43 EST (log dated today): +76 enriched (library 12,518 → 12,591,
  ALL adds enriched same-night); meaning catch-up 26; purity gate passed (0.8580 vs 0.8580,
  regression 0.0000 — level moved 0.9260 → 0.8580 between nights, within the gate's own tolerance
  regime; the gate compares against its own previous reading and passed).
- Logged 00:00 EST mood prune: 12,518 → 12,515 (−3, ids 13845/13846/13849, ledgered,
  undo `mood-index.bin.prune.bak`). 12,515 + 76 = 12,591 — **all sha changes fully accounted**
  (trainer + logged prune only; no rogue writer).
- Redescribe campaign (staged-only, window 00:00–08:15): 950/3,108 by 02:58 EST, 0 fails,
  ~11.3 s/track, ~6.8 h left ⇒ roughly 1–2 nights to drain. Yielded correctly around the 02:00
  trainer. Writes brain-descriptors.next.json only — verified not a live-brain writer tonight.
- NAS files mtime 02:04, stable >1 h before snapshot.
- Snapshot `/tmp/brain-snap-20261104` (7 files incl. artist-members / metadata-overrides / lyrics),
  sha-verified NAS-stable during copy + copy-matches-NAS.
  - embeddings.bin sha256 `8d404ca9d9aa…` (12,785 vectors)
  - mood-index.bin sha256 `854bcfdeabbf…` (12,591 vectors)

## Baselines (shas changed vs 11-03 → full LLM runs, both rulers)
- **v1 (B1-20261104): retrieval 0.813 / grounding 1.000 / overall 0.906** — 21st consecutive
  night in the normal band (0.810–0.816 / 1.000 / 0.905–0.908). Routes 8 mood / 7 main.
- **v3 (B3-20261104): headline 0.794, grounding 1.000 (20/20 — no flake; tally stays 7/21)**.
  Primary source: bridge (main src 46384434). Routes 29 main / 94 mood / 1 mood+lexicon /
  30 main+decade — identical.
  - Groups: artist 0.963 / umbrella_family 0.911 / leaf 0.835 / family_decade 0.875 /
    tempo_family 0.485 / vibe 0.695.

## Movers vs B3-20261103: 10/174, balanced add-churn
5 down / 5 up, all ±0.04 except fam-09 +0.08 (reversing its 11-03 −0.08). tempo_family
0.487 → 0.485 is MIXED (tempo-04/10 −0.04, tempo-13 +0.04) — the directional slide-watch stays
paused; tempo_family remains the top open quality item (no queued remedy; needs a Jake-approved
hypothesis). Sentinels: vibe-prod-006 **0.76 held** (at its new high), leaf-20 **0.88 held**,
tempo-13 **0.28 → 0.32** (recovering).

## Production bridge / main-src
origin/main advanced d9f95acd → 46384434 (PRs ~#318–#337: concerts, artist-photo picks,
Year-in-Review, home rows, downloads). Only ai/bridge-adjacent file touched is
`src/main/index.ts`: artist-photo-picks wiring, Blink FaceDetector flag, phone-star merge,
mbThrottle plumbing — **zero diff to the retrieval router / RAG paths** (verified by reading the
hunks); routes identical on both rulers confirms it empirically. vocab_snapshot staleness
unchanged (Plunderphonics + 2 legacy tags; in-run guard ~0.27% < 0.5% threshold, passed;
re-export remains Jake's call).

## Pick
`pick_experiment.py pick` → **IDLE** (E1 bare mood backlog = 0; E2 genre-tag churn 22/11,550 =
0.19%, needs >1%; Jake lane empty). Ledger 'picked' event appended + committed. Nothing built,
nothing gated, nothing applied. NAS shas re-verified unchanged at close.

## Open Jake items (unchanged)
grd-16/grd-14 fenced-JSON tolerant-parse proposal · grd-12 legacy-tag re-tag (laptop overrides) ·
tempo_family 0.485 gap (needs new hypothesis) · gemma4 mood-index promotion queue item (staging
~1–2 nights from done — queue it so the dual-run gate prices it) · Plunderphonics vocab re-export.
