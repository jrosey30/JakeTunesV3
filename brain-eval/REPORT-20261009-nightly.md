# Nightly brain exercise — 2026-10-09 (homemini)

**Outcome: (b) — nothing beat baseline, nothing changed. Brain untouched
(emb sha `c4a9e9250410`, mood sha `cb42137577c9`; NAS mtime/size/sha256 verified
identical before measurement and after the full session).**

**Headline: the orphan-tax decomposition series is RETIRED tonight** — the
pre-registered retiring third 0.000 landed on a genuine content-change night.

## Pipeline coordination

- Trainer: clean launchd run 06:00:05–06:01:49Z (4th consecutive post-`ecba7d1`
  mount-wait). **IMPORT NIGHT: library 11,035 → 11,203 (+168)** — the biggest
  wave since the dark nights. Mood prune removed 1 orphan (11,035 → 11,034),
  nightly enriched +50 → mood 11,084 vectors / emb 11,239 vectors.
  **Backlog 119** (first multi-night backlog since the 09-19 wave; drains at
  ~50/night ⇒ clear by ~10-12 morning).
- embeddings.bin mtime stable ≥63 min before snapshot; snapshot
  `/tmp/brain-snap-20261009` sha256-verified byte-identical to the NAS.
- Post-measurement re-check: mtime 1791525696 / 69,097,384 bytes / sha256
  `e8b6113ff66d…` — unchanged through the session. Nothing applied anyway.

## Import-day clobber pre-check (the +168 stress test) — guard-proof night 3

- mood-index: **orphans=0, dup_groups=0, dup_tracks=0** on a fresh prune +
  import night. The `5baa13e`/`309b375` replay-writer guards and the `34ba4de`
  prune held through the biggest import wave they've faced.
- in-library tracks without a mood vector: **119 = exactly tonight's backlog**
  (prune ate no live tracks). embeddings orphans 155 (~expected steady-state;
  unpruned identity index, measured-0.000 effect, benign).
- te census 3:11057 / 2:27 / True:22 / False:49; enrichment 11,084/11,203
  matches the trainer log exactly.
- **library.json freeze-watch RESOLVED benign**: library.json advanced tonight
  (00:30 ET) on the real import day — exactly the condition that would have
  flagged it, and it moved. Watch closed.

## Baseline (full run — content changed, cheap-night rule does not apply)

- retrieval **0.736** / grounding **1.000** / overall **0.868**
  (brain `c4a9e9250410`, 11,239 vectors; score_log row appended 03:0x ET).
- Dead-center of the 0.733–0.736 band despite 119 vectorless new tracks
  swelling the expected sets — the wave shape barely dented the ruler.
- All 10 grounding probes clean (5 normal cite-real, 4 traps cite-nothing,
  1 normal).

## Decomposition — TWENTY-SECOND point, series RETIRED

Pre-registered criterion (10-07/10-08): one more +0.000 on a CONTENT-CHANGE
night retires the series. Tonight is that night (+168 tracks, +50 vectors,
fresh prune event, new shas):

- **rt 0.837** — up from 0.835, inside the healthy 0.833–0.844 band and above
  the former S2 ceiling.
- **S0 == S1 == S2 == 0.837**; orphan component **+0.000**, un-enriched
  component +0.000; slot occupancy 0 orphans / 0 unenriched on all six watched
  probes; worst per-probe delta +0.00.
- Third consecutive 0.000 (10-06 content-change, 10-07 content-change, tonight
  content-change; 10-08 skipped as forced). `34ba4de` is proven: the trainer-side
  prune permanently closed the orphan tax. **No nightly decomp from tomorrow
  on.** Standing rule stays: **rt < 0.80 = something NEW** (no orphan excuse
  exists anymore). PROPOSAL-mood-import-clobber can be archived per the 10-08
  plan once Jake signs off (import-day pre-check stays a few more waves —
  tonight was wave 1 post-plan, held).

## Standard guards

- **Taste-W guard PASS ×3**: V3 `src/renderer/utils/tasteScore.ts:89`, Mobile
  `backend/src/util/tasteScore.ts:87`, Mobile `backend/dist/util/tasteScore.js:63`
  — byte-identical v4 W line. Taste-drift monthly due ~10-13; prerequisite
  re-diff fresh as of tonight.
- **Skip gate recount** (forensics, never the raw counter): mobile total 2,963;
  organic 726 + 610 desktop = **1,336/3,000 CLOSED** (+29 organic since 10-08
  — log alive and advancing). **No new mechanical bursts** — still 14/2,237,
  quiet since 09-26.

## Experiment slate check (why outcome (b))

Tonight's pre-registered experiment WAS the decomp retirement — it ran and
concluded the series. Beyond it, every lever is closed or Jake-gated (skip
features gated at 3,000 organic, now 1,336; taste-weights-v4, queue-order,
keeper-osascript, listen-log local-first append all awaiting Jake). The
enrichment backlog self-heals at ~50/night; a forced drain is the Jake-gated
PROPOSAL-enrichment-backlog-drain, not an auto-apply. Correct move = measure,
retire the series, change nothing.

Snapshots kept: /tmp/brain-snap-20261008 + 20261009 (20261007 removed).
Watch for tomorrow: backlog 119 → expect ~69 after 10-10's run; rt may wobble
within band while the wave enriches — no alarm unless rt < 0.80.
