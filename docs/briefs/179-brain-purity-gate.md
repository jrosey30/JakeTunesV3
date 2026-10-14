# Brief 179 — A quality gate on nightly brain writes

**Stacked on Brief 176** (`fix/brief-176-trainer-failures-loud`): this PR's
base is that branch; the trainer changes here build on its status module +
failure channel. Merge 176 first.

## Source / evidence
- Proposed briefs 160+, Brief 179 (desktop audit Lens 3, finding F3).
- Verified against JakeTunesV3 main `12bb43b24d49a146bc73489d945f34092878f707`:
  every nightly publish verified integrity only (dim, count, round-trip,
  `.bak` restore) — nothing scored the candidate index's quality.
- **Experiment-recovery finding:** the 2026-10-10 neighbour-purity
  experiment's code does **not** survive in the repo. `search_code` for
  "purity" returns only an artist name in `scripts/taxonomy.json`;
  `brain-eval/` (run_eval.py) measures recall@k of natural-language queries
  against objective metadata predicates (artist/genre/era/BPM) — a
  different instrument, with no neighbour-purity computation and no
  recorded threshold. The metric below is therefore the brief's specified
  shape (same-artist/same-genre neighbour share on a fixed sample), built
  on the same library.json metadata brain-eval resolves, with the
  threshold a clearly-marked conservative default rather than a recovered
  experiment value.

## What changes
- **NEW `scripts/brain-purity.mjs`** — pure, dependency-free:
  - `neighbourPurity(index, meta, ids, k)`: for each sampled track, the
    share of its k nearest cosine neighbours (same index) that share its
    artist OR genre, averaged over the sample.
  - `pickSample(...)`: ids present in BOTH indexes + metadata, chosen by a
    seeded PRNG (mulberry32) — candidate and previous are always scored on
    the identical fixed sample.
  - `comparePurity(...)` → regression = previous − candidate.
  - `gateDecision(...)`: blocks only on a measured regression beyond
    `PURITY_MAX_REGRESSION` (**0.02**, exported constant, overridable per
    run via `BRAIN_PURITY_MAX_REGRESSION`). An unscorable comparison
    abstains (never blocks) and says so.
  - `readEmbFile(...)`: EMBD reader with the trainer's truncation
    discipline (throws on bad magic / short reads).
- **`scripts/brain-trainer.mjs`** — a `purityGate()` helper runs at BOTH
  publish sites, after the candidate map is folded and **before**
  `writeEmb`:
  - the nightly enrich publish, and
  - `--reembed-all` (which the taxonomy job triggers at night).
  On a block: the previous index is kept (nothing is written), a failure
  status is written through Brief 176's status module
  (`{ ok:false, gateBlocked:true, candidatePurity, previousPurity, error }`),
  the alert is pushed via 176's `notifyFailure` (osascript + ntfy), and the
  run throws → 176's top-level handler exits non-zero. Progress
  (brain-descriptors.json) is not persisted on a blocked nightly publish,
  so the same tracks are retried tomorrow.
- **NEW `scripts/__tests__/brain-purity.test.mjs`** — synthetic-fixture
  suite (clustered vs vector-shuffled indexes).

## What does NOT change
- The gate only ever blocks; it never writes, repairs, or promotes an index.
- No change to what gets embedded, batching, descriptors, or the mood
  index. The mood index is not gated (it carries no canonical-brain risk
  and its writer already restores on verify failure).
- Tempo/meaning catch-up writes inside a run are not separately gated;
  the gate judges the run's final candidate against the index published
  at gate time.
- No threshold was recovered from the experiment (none exists in the
  repo); 0.02 is a starting default, named as such in the module header.
- No version bump.

## Done looks like
- A degraded candidate index (scrambled/shuffled vectors, bad model swap)
  never reaches `embeddings.bin`: the publish aborts, the previous index
  stays live, the status file records the block with both purity numbers,
  and Jake gets the alert the same night.

## Tests (run in the agent environment, Node v24.20.0)
- `node --check scripts/brain-purity.mjs` + edited trainer — clean.
- `node --test scripts/__tests__/brain-purity.test.mjs` — **5/5 pass**:
  clean clustered index purity > 0.9; vector-shuffled candidate collapses
  (< 0.45) and the gate blocks with a "regressed" reason; identical
  candidate regression = 0, no block; unscorable comparison abstains;
  sample is deterministic across runs.
- Trainer regression fixture (176 + 179 edits together): fully-enriched
  2-track fixture state dir → run exits 0 and writes `ok:true` status —
  the gated code paths load and the normal no-op night is unchanged.
  (The gate's block path itself is exercised at module level above; a
  live publish fixture would need Gemma + OpenAI, which are not reachable
  from the agent environment.)

## Manual steps (verbatim)
1. None required for activation — the gate is live in the trainer as soon
   as this merges (stacked on 176).
2. Optional tuning: set `BRAIN_PURITY_MAX_REGRESSION` in the trainer's
   launchd environment on homemini to adjust the 0.02 default once a few
   nights of `purity gate:` log lines show the healthy night-to-night
   variance.
