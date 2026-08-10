# Nightly brain exercise — 2026-08-10 (homemini, 3:05 AM launchd)

**Outcome: orphan-vector prune measured as EXACTLY zero on the eval → NOTHING
APPLIED (proposed as optional hygiene only).** `embeddings.bin` on the NAS was
never written: sha `9fb4a3f33948` / 57,471,516 bytes / mtime 02:01:39 identical
before and after the run.

## Preconditions
- brain-trainer finished 06:01:45Z (02:01 EDT): +50 enriched, 9,007/9,324
  tracks, embeddings.bin 9,348 vectors, clean write with matching `.bak`.
- embeddings.bin stable ~63 minutes before measurement.
- **The 08-09 tmp-litter storm has STOPPED**: newest orphaned
  `embeddings.bin.*.tmp` is Aug 9 14:57 — no failing remote writer observed
  tonight. The litter itself remains: **329 stale `*.tmp` files** in the state
  dir (embeddings/mood-index ~56MB each, plus library.json/mixtapes litter —
  several GB). Cleanup is still flagged daytime work; not touched by this run
  (write-scope rule).

## Baseline (brain 9fb4a3f33948, library 9,324 tracks)
retrieval **0.762** · grounding **1.000** · overall **0.881**

Exactly the encoding-v2 normal (2026-08-07 rebaseline). Per-probe identical to
last night on all 15 retrieval probes; metadata controls ≥0.95; known-bad
self-test passed. Baseline judged trustworthy. Notable: **the vector backlog is
CLOSED** — every one of the 9,324 library tracks has a vector (was 192
vector-less on 08-09); the remaining 317-track backlog is Gemma-descriptor
enrichment only.

## The one experiment: prune orphan vectors (deleted tracks still in the index)
Grounded observation: embeddings.bin holds 9,348 vectors but the library holds
9,324 tracks — **24 orphan vectors** whose ids are not in `library.json`
(identity gate: id ∉ parsed library; zero duplicate ids; grounded to real
deletions — the removed Allison Rhodes album ids 7782–7789/8381–8384, deleted
dupes/remixes 437, 491, 5522, 5540, 7673, 9596, and six descriptor-less
short-lived imports 9791, 9857, 9999, 10068, 10258, 10272). Orphans occupy
retrieval slots in any consumer that doesn't post-filter by library membership
(the harness's `retrieve_topk` does not). Hypothesis: pruning them frees top-k
slots and can only help (removing never-expected items from a ranked corpus is
monotonically non-harmful to recall).

Method: sha-verified frozen snapshot in `/tmp/jt-state-frozen-20260810`;
candidate bin rebuilt with the 24 records dropped (header count 9,348→9,324,
record order otherwise preserved; round-trip verified: magic/ver/dim intact,
all ids ∈ library, no dupes). `run_eval.py --no-llm` on frozen vs candidate.

| | vectors | sha | retrieval |
|---|---|---|---|
| frozen baseline | 9,348 | 9fb4a3f33948 | 0.762 |
| pruned candidate | 9,324 | 3debf2f779cc | 0.762 |

Per-probe: identical on all 15. Exact-membership check (query vectors reused,
full ranking inspected): orphans appear in **0 of 15** top-k lists; the best
rank any orphan achieves on any probe is **#28** (ret-008, k=25). The eval
delta is exactly 0.000 — not small, zero.

Verdict: **not a provable win → not applied** (apply policy: measurable
improvement required; a guaranteed-non-negative no-op does not qualify).

### Proposal for Jake (optional hygiene, not urgency)
The prune is still correct hygiene: 24 deleted tracks can surface in any
production retrieval path lacking a library filter, and the vector count stays
honest. It is trivially reproducible (drop records whose id ∉ library.json,
temp+rename, verify count 9,324) and self-healing in reverse — if a pruned
track ever re-enters the library, brain-trainer re-embeds
tracks-without-vectors on its next pass. Apply any daytime you like, or fold it
into brain-trainer as a startup step. Same litter exists in `mood-index.bin`
(untested tonight — out of the one-experiment scope).

## Not retried (closed lines)
Skip signal (closed both directions 08-08/08-09; wait for ~1,000 skips),
ret-014 vocab counterfactuals (refuted 08-07; mood-index serves that query),
ret-015 aggression enrichment (standing proposal, awaiting Jake).

## Future candidate (diagnosis first, no change proposed)
ret-011 "funk and soul" (0.44) and ret-012 "new wave 80s" (0.35) are the two
stable weak NON-enrichment probes — both genre-predicate queries. Given the
ret-014 lesson (the identity index title-matches mood/genre vocabulary), the
next honest step is a diagnosis night: are the misses a genre-tag coverage gap
in `library.json` (fixable via grounded metadata, laptop-side Cynthia
territory) or an index-routing question (mood-index may already serve these
better, as it did ret-014)? Measure which index wins these probes before
proposing any brain change.

## Score log
Three rows appended this run: full canonical baseline
(0.762/1.000/0.881, brain 9fb4a3f33948) and the frozen/candidate `--no-llm`
pair (0.762 vs 0.762, brains 9fb4a3f33948 / 3debf2f779cc).
