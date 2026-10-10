# Nightly brain exercise — 2026-10-10 (homemini)

**Outcome: (b) — nothing beat baseline, nothing changed. Brain untouched
(emb sha `59db258d327c`, mood sha `acec8e2ca1cd`; NAS size/mtime/sha256
verified identical before measurement and after the full session:
emb 69,404,784 B @ 02:01:29, mood 68,445,696 B @ 02:01:35, sha256
`2542134ef3cfdb7c…` / `ec075e2af3fdbccb…` ×3 at start, re-verified at end).**

First post-retirement night: per the 10-09 close-out, NO decomposition ran —
the standard nightly is now precheck → baseline → rt → guards.

## Pipeline coordination

- Trainer: clean launchd run 06:00:05–06:01:35Z (5th consecutive
  post-`ecba7d1`). **IMPORT NIGHT, wave 2: library 11,203 → 11,359 (+156)**
  (library.json written 00:48 ET, before the trainer). Mood prune removed 1
  orphan (11,084 → 11,083), nightly enriched +50 → mood 11,133 vectors / emb
  11,289 vectors. **Backlog 119 → 226** — the wave outran batch=50 a second
  night (10-09 predicted ~69; instead +156 more imports landed).
- embeddings.bin mtime stable 64 min before snapshot; snapshot
  `/tmp/brain-snap-20261010` sha256-verified byte-identical to the NAS.
- Post-measurement re-check: both files unchanged. Nothing applied anyway.

## Import-day clobber pre-check — guard-proof night 4

- mood-index: **orphans=0, dup_groups=0, dup_tracks=0** through a second
  consecutive import wave. `5baa13e`/`309b375` replay guards + `34ba4de`
  prune held again.
- in-library tracks without a mood vector: **226 = exactly tonight's backlog**
  (prune ate no live tracks). embeddings orphans 156 (155 → 156, steady-state
  drift of the unpruned identity index; measured-0.000 effect, benign).
- te census 3:11107 / 2:27 / True:22 / False:49; enrichment 11,133/11,359
  matches the trainer log exactly.

## Baseline (full run — content changed; both keys 1-token-probed 200 first)

- retrieval **0.734** / grounding **1.000** / overall **0.867**
  (brain `59db258d327c`, 11,289 vectors; score_log row appended).
- In-band (0.733–0.757), same floor-region reading as 10-06/10-07, despite
  226 vectorless tracks swelling expected sets. All 10 grounding probes clean
  (traps 4/4 named nothing).

## Router-truth (rt_20261010.py)

- **rt 0.837 — byte-for-byte the 10-09 value** (series 0.835 → 0.835 → 0.837
  → 0.837; healthy band 0.833–0.844). Mood-routed mean 0.846/9.
- Per-probe identical to 10-09 at every watched probe; the 226-track backlog
  costs production nothing because absent vectors can't pollute top-k.

## Standard guards

- **Taste-W guard PASS ×3** (V3 src:89 / Mobile backend/src:87 / dist:63 —
  v4 line byte-identical). Taste-drift monthly due ~10-13: W pre-diff is
  fresh as of tonight.
- **Skip gate recount** (forensics): mobile total 2,963, organic 726 + 610
  desktop = **1,336/3,000 CLOSED** (+0 — no new mobile events at all), no new
  mechanical bursts (14/2,237, quiet since 09-26).
- **Watch (benign): zero mobile listening since 10-08 23:35Z** — but this is
  the quiet-phone shape, NOT the NAS-drop signature: mobile-play-log stopped
  at the same minute (19:35/19:38 ET) and mobile-stars advanced with the
  00:42 import, so the backend is writing fine; Jake just didn't listen on
  mobile yesterday. Only interesting if it persists ~a week.

## Experiment slate check (why outcome (b))

Decomp retired 10-09 (22 points, `34ba4de` proven). Skip features gated at
3,000 organic (1,336, +0 tonight). Taste-drift due 10-13 — three days early
is a protocol violation, not an experiment; its prerequisite (W guard) ran.
Era/vocabulary/P3 levers all closed by prior refutations. Remaining levers
are all Jake-gated proposals (taste-weights-v4, queue-order, backlog-drain —
which gained an October-wave data point tonight: first multi-day compounding
backlog since filing — keeper-osascript, listen-log local-first, skip-cascade
client fixes). Correct move = measure, verify guards on wave 2, change nothing.

Snapshots kept: /tmp/brain-snap-20261009 + 20261010 (20261008 removed).
Watch for 10-11: backlog 226 → ~176 if imports pause (another wave keeps
compounding — the backlog-drain proposal's exact scenario); import-day
pre-check again if library.json advances; rt < 0.80 = something NEW.
