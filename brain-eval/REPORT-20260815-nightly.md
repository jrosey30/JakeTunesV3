# Nightly brain exercise — 2026-08-15 (homemini)

**Outcome: (b) nothing beat baseline, nothing changed.** Brain untouched
(embeddings sha `b7c392511963`, mood sha `8d923e9559cf`, verified identical
before and after; all measurement ran on a frozen /tmp snapshot).

## Pipeline pre-flight
- brain-trainer finished cleanly 02:01 EDT: +50 enriched (9207/9469),
  embeddings.bin 9,505 vectors, mood-index updated. Files stable ≥1 h
  before measurement.
- Frozen snapshot `/tmp/brain-frozen-20260815` sha-matched the NAS
  byte-for-byte for both indexes.

## Baseline (frozen snapshot, full eval with grounding)
- **retrieval 0.754 / grounding 1.000 / overall 0.877** — exactly the
  encoding-v2 normal (0.756 ± wobble). Weak probes are all the documented,
  already-diagnosed set: ret-006 0.64 (decade guard), ret-011 0.40 /
  ret-012 0.35 (wrong-index ruler artifacts), ret-014 0.20 / ret-015 0.50
  (documented wobble band). No unexplained movement; harness trusted.

## Exercise: router-truth trend point (read-only, diag_ret011_012.py)
- **Router-truth 0.821 — identical to 08-11's 0.821**, while the
  identity-only eval number wobbled 0.756→0.791→0.754 across the same
  window. Production retrieval is *stable*; the eval's wobble is a
  property of scoring the wrong index on vibe probes, not of the brain.
  This is the strongest evidence yet for P1 (router-aware eval).
- ret-002 "Beatles tracks" → mood (0.70 vs identity 1.00) reconfirms
  **P2 (leading-"the"-stripped artist variants in ragLibraryArtistSet)**
  as the cheapest real win. Still a desktop code change → gated on Jake.

## Levers checked and correctly NOT pulled
- **Skips: 520 events** (plays 2,194) — below the ~1,000 pre-registered
  re-test threshold. Both prior formulations refuted (08-08, 08-09).
  Stays closed.
- Orphan-vector prune: provably 0.000 on this ruler (08-10) — not re-run.
- Era/vocabulary token edits: refuted (07-03 identity, 08-07, 08-14 P3
  ret-014 regression). Not re-tried.
- P1/P2/P3 all await Jake's call (all code changes, outside the nightly
  auto-apply lane, quantified 08-11/08-14).

## Salvage + hygiene
- The 08-13 nightly's worktree (`/tmp/be-20260813`) held an UNCOMMITTED
  baseline score row (brain `4fe6182b8394`, retrieval 0.7564 — normal)
  — recovered into score_log.jsonl tonight. Its `exp_mood_decade.py`
  (first-cut hand-port, superseded by 08-14's fidelity-gated
  `cf_decade_mood.py`) archived as `attic/exp_mood_decade-20260813.py`.
  Both stale worktrees removed after this commit landed.
- NAS tmp-litter unchanged (~329 stale `*.tmp`), no new litter tonight —
  still awaiting the daytime cleanup pass.

## For Jake (unchanged asks, now with a trend line)
1. **P2** — one-line router artist-guard fix; reconfirmed 3 nights running.
2. **P1** — router-aware eval: production has now measured 0.821 twice,
   4 days apart, while the eval printed 0.756/0.754. The ruler
   understates and wobbles; production doesn't.
3. **P3** — decade token: +0.075 router-truth but ret-014 −0.10; your
   tradeoff call (numbers in REPORT-20260814).
