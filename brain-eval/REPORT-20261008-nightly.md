# Nightly brain exercise — 2026-10-08 (homemini)

**Outcome: (b) — nothing beat baseline, nothing changed. Brain untouched
(emb sha `d35caad43302`, mood sha `f31759f2ccdc`, ×3-verified before + re-verified after;
BYTE-IDENTICAL to the 10-07 measurement — second unchanged-brain night ever, first since 09-25).**

## Pipeline coordination

- Trainer: clean launchd run 06:00:07–06:00:12Z — "library fully enriched — nothing to do
  tonight" (11,035/11,035, backlog 0; 3rd consecutive clean night post-`ecba7d1` mount-wait).
  Zero imports (+0, library 11,035). Zero brain writes: embeddings.bin/mood-index.bin
  mtimes still Oct 7 02:00, stable ≥25h — no mid-write risk.
- Post-measurement re-check: embeddings.bin 68,789,984 bytes / mtime Oct 7 02:00:22 —
  unchanged through the session. Nothing applied anyway.

## A/A on unchanged bytes (the 09-25 standing rule, now a 48-hour point)

Both brain shas match the 10-07 score_log row exactly, so the standing rule binds:
any eval delta tonight = broken harness, not a brain change. Verification run
(`run_eval.py --no-llm`, JT_STATE_DIR = frozen sha-verified /tmp/brain-snap-20261008):

- retrieval **0.734**, brain d35caad43302, 11,189 vectors — headline identical.
- **Per-probe: 15/15 identical to the 10-07 row** (compared id-by-id from score_log).
  Extends the 09-25 same-day A/A result across a 24h gap with fresh query embeds:
  OpenAI query-embed nondeterminism stays below tie-break threshold across days,
  and the harness + environment are healthy.
- Grounding/persona NOT re-run — on byte-identical inputs with a proven-deterministic
  harness, re-measuring grounding (1.000 on these exact bytes last night) buys zero
  information for real Anthropic spend. Grounding 1.000 / overall 0.867 carry by the
  A/A rule. (OpenAI key probed 200 before the one paid embed call; Anthropic key not
  exercised tonight.)

## Decomp retirement — DEFERRED, deliberately

10-07 said "one more 0.000 night retires the decomp." Tonight CANNOT be that night:
on byte-identical indexes the decomp result is mathematically forced to reproduce
(+0.000), so running it adds no evidence and skipping it loses none. It was not run.
**The retiring third 0.000 point must come from the next content-change night.**
Same logic: the import-day orphan/dup pre-check carries by sha identity
(0 orphans / 0 dups, guard-proof state unchanged); not an import day anyway.

## Standard guards

- **Taste-W guard PASS ×3**: V3 `src/renderer/utils/tasteScore.ts:89`, Mobile
  `backend/src/util/tasteScore.ts:87`, Mobile `backend/dist/util/tasteScore.js:63` —
  all byte-identical v4 W line. PROPOSAL-taste-weights-refresh-v4 premise intact.
- **Skip gate recount** (forensics standard, never the raw counter): mobile total 2,934;
  organic 697 + 610 desktop = **1,307/3,000 CLOSED** (+15 organic since 10-07).
  **No new mechanical bursts** — still 14 sessions / 2,237, quiet since 09-26.
  The mobile listening log is alive and advancing (last event Oct 7 18:19 ET),
  consistent with the 10-07 NAS-outage root-cause finding.

## Watch items (no action)

- **library.json quiet since Oct 6 15:56 (~36h)** while mobile-* files advance.
  Consistent with zero desktop imports + the `5baa13e` behind-never-pushes guard;
  becomes interesting only if it stays frozen across a day Jake actually imports.
- emb orphans unchanged (unpruned identity index, measured-0.000 effect, benign).
- Taste-drift monthly due **~10-13** (v4 script; re-diff deployed W first — done
  tonight, PASS).

## Experiment slate check (why outcome (b))

Every lever is correctly closed or gated: skip features refuted at 3 volumes (gate
needs 3,000 organic, at 1,307); vocabulary/era/prune levers refuted or resolved;
orphan tax resolved by shipped `34ba4de` (+0.000 ×2); all remaining asks are
Jake-gated code proposals (taste-weights-v4, queue-order, keeper-osascript half of
nas-mount-resilience, listen-log local-first append, skip-cascade client fixes).
On a byte-identical-brain night there is no measurable brain-side experiment whose
result isn't already known. Correct move = verify, log, change nothing.

Snapshots kept: /tmp/brain-snap-20261007 + 20261008 (20261006 removed).
