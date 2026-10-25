# Nightly brain-eval — 2026-10-25

**Outcome: IDLE (8th consecutive idle night) — baselines only, nothing applied, brain untouched.**

## Pre-flight

- brain-trainer finished 02:06 EDT (log dated today): **+1 track enriched**
  (library 11,965 → 11,966; embeddings.bin → 12,153 vectors, mood-index.bin
  → 11,966), plus another 150-track lyrics-meaning catch-up re-embed —
  **5th consecutive night of exactly 150** (same logged writer, benign; see
  Observations).
- Files stable ~59 min before snapshot. Snapshot `/tmp/brain-snap-20261025`
  sha-verified against the NAS before and after copy:
  - embeddings.bin `fd9c814bd489…`
  - mood-index.bin `d592cabaa4d9…`
  - carried library.json, metadata-overrides.json, artist-members.json,
    lyrics.json, brain-descriptors.json.
- Both shas changed vs 10-24 (prior emb `c52de8fe3f56…`, mood `4aa016238b80…`)
  — fully accounted for by tonight's trainer run (+1 add + 150 meaning
  re-embeds). No unlogged writer event.
- Worktree fresh at brain-eval tip `2f0daf8` (matched origin). Audio fusion
  OFF as always on homemini (mood-only routing both rulers).
- Bridge main-src advanced to origin/main `6897b507` (PR #262
  top1000-finish-line merged since last night) — production code moved;
  v1 routes and all v3 retrieval scores unchanged on it (see below), so the
  merge is retrieval-neutral on both rulers.

## Pick

`pick_experiment.py pick` → **IDLE**. E1 bare backlog = 0 (the 1 new add was
enriched same-night); E2 genre-tag churn 21/11,550 (0.18%, needs >1%).
Auto lane and Jake lane both empty.

## Baselines

**v1 (B1-20261025):** retrieval 0.813 / grounding 1.000 / overall 0.906 —
11th consecutive night at 0.810–0.813 / 1.000 / 0.905–0.906. Routes: 8 mood /
7 main (unchanged under the new main sha).

**v3 (B3-20261025, primary source bridge):** headline **0.798** (Δ 0.000 vs
10-24). Groups: artist 0.963 · umbrella_family 0.909 · leaf 0.834 ·
family_decade 0.869 · tempo_family 0.507 · vibe 0.707 — all identical to
last night. **Grounding 20/20 (1.000)** — the fenced-JSON flake did NOT fire;
both prior flakers (grd-14, grd-16) parsed clean tonight. Flake tally stays
4 of the last 11 nights, class-wide. Routes: main 29 / mood 94 /
mood+lexicon 1 / main+decade 30 (the standing pattern).

## Per-probe drift vs 10-24

**Zero movement on all 154 retrieval probes** — the only row that changed is
grd-14 (0 → 1, flake recovery). Plausible for a near-still brain: +1 add, and
the 150 meaning re-embeds add one meaning line to each track's mood text — a
small vector nudge on tracks that evidently sit nowhere near a probe's top-k
boundary tonight. Not a harness-frozen artifact: shas differ night-over-night
and the grounding row did move.

- **Sentinel vibe-prod-006 HELD 0.64 a second straight night** — the re-watch
  armed on 10-23 ("watch for a second slide on a low-churn night") is
  **resolved: no slide**. The 10-23 move was pool churn.
- leaf-20 held 0.92; umb-04 held 0.76.

## Observations (no action taken)

1. **Meaning catch-up measured — it is a healthy capped drain, not a loop.**
   5th consecutive night of exactly 150 raised the question of whether the
   derived meaning persists. Counted in tonight's snapshot: 8,268 descriptors
   carry a meaning (`m`) field; **3,199 enriched tracks still have lyrics but
   no meaning**. That is consistent with a large backlog draining at a
   150/night cap (≈750 drained over the 5 nights) — persistence confirmed,
   ETA ~21 more nights of catch-ups. No action needed; expect the 150-track
   line (and nightly mood-sha churn) through roughly mid-November.
2. tempo_family 0.507 remains the standing gap with no queued remedy.
3. Open Jake items unchanged: PROPOSAL-grd16-fenced-json-parse.md (tonight
   adds a clean night to the tally — flake remains intermittent, 4/11) and
   the tempo_family gap.

## Ledger / hygiene

- Idle pick entry written to `experiments/ledger.jsonl` (03:06:27).
- score_log.jsonl +2 rows (B1/B3), score_rows.jsonl +199 rows.
- No candidate built, no gate run, no brain file written. NAS brain
  untouched by this job.
