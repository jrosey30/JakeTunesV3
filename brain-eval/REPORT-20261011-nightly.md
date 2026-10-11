# Nightly brain exercise — 2026-10-11 (homemini)

**Outcome: (b) — nothing applied, brain untouched. REBASELINE NIGHT: first
nightly on the PLAIN main brain (PR #66). New normals recorded below.**

Brain measured from /tmp/brain-snap-20261011, snapshotted after ×3-sha256
stability verification (embeddings.bin sha256 9ebfe6778c5b… 71,107,780 bytes,
mood-index.bin f1ef959a7a96… 70,148,692 bytes; NAS mtimes 02:01 = trainer-done,
library.json last pushed 10-10 20:07 — no post-trainer replay). score_log
brain_id tonight: **c7ad5286e59e**, 11,566 vectors.

## The big event (daytime 10-10, Jake's shipped change — not ours)

PR #66 `caa5bf0` "the main brain goes plain" (artist — title, album (year),
genre tag; descriptors/meaning/tempo stay in mood-index only) re-embedded the
whole main index during the day. Id-level diff vs /tmp/brain-snap-20261010
(precheck_20261011.py):

- embeddings.bin: **11,133 of 11,289 existing vectors changed bytes** (the
  plain re-embed), +277 added (ALL in-library — the enrichment backlog, which
  plain text can embed without a descriptor), 0 removed, 0 orphan adds.
- mood-index.bin: +277 added (same block), 6,194 existing changed, 0 removed.
- Only 9 tracks (12511–12519, post-rewrite imports) lack vectors in either
  index — the trainer picks them up on coming nights.

Import-day clobber pre-check through the biggest brain rewrite since the
clobber era: mood orphans **0** / dup groups 8 (30 tracks, all the benign
un-enriched same-import class) / emb orphans 156 steady = **guard-proof
night 5** — the one-way adoption (309b375) carried a legitimately newer brain
while nothing stale replayed.

## New baselines (the 0.733–0.757 band is OBSOLETE)

| metric | old normal | tonight | read |
|---|---|---|---|
| run_eval retrieval | 0.734–0.757 | **0.781** | plain-brain-era normal; matches PR #66's own 0.736→0.788 |
| grounding | 1.000 | **1.000** | 10/10 incl. all 4 traps |
| overall | ~0.867 | **0.891** | new normal |
| router-truth | 0.833–0.844 | **0.849** | ALL-TIME HIGH |
| mood-routed mean | ~0.846 | **0.780** | depressed by bare-vector dilution (below), recovers with enrichment |

Per-probe expectations for future nights (per docs/brain-improvement-2026h2.md):
- ret-013/014/015 on the MAIN index now read 0.20/0.07/0.53 — **EXPECTED, by
  design** (main carries no sound words). Production routes them to mood
  (0.90/0.33/0.77 tonight). Do not chase; judge vibe on mood routes only.
- Genre/era main probes JUMPED: ret-006 0.92, ret-007 0.88, ret-008 0.88,
  ret-011 0.60, ret-012 **0.80** (was 0.35). Artist probes all 1.00.
- Standing rule unchanged: **rt < 0.80 = something NEW.**

## Proposal dispositions moved by the plain brain

- **P3 (mood decade-token) largely OBSOLETE**: its headline wins were
  ret-006 0.64→0.96 and ret-012 0.35→1.00 via mood; the plain MAIN index now
  scores 0.92/0.80 on those decade-routed probes natively. Numbers recorded
  here; closing is Jake's call.
- **PROPOSAL-enrichment-backlog-drain ESCALATED (status change)**: the
  re-embed-all gave the 236-track backlog *bare* mood vectors — previously
  ABSENT (couldn't pollute), now PRESENT and diluting mood routes. Quantified:
  ret-007 mood 1.00→0.44 with 14/25 top slots bare (diag_ret007_20261011.py);
  mood-routed mean −0.066. Self-heals ~50/night but the wave is outrunning the
  batch a third night (226→236). NOT auto-applied — trainer code + supervised
  Gemma load, Jake-gated as filed.

## Guards

- Taste-W guard PASS ×3 (V3 src:89 / Mobile backend/src:87 / Mobile dist:63 —
  v4 line byte-identical). Taste-drift monthly due ~10-13, not run early.
- Skip gate: organic 740 mobile + 610 desktop = **1,350/3,000 CLOSED** (+14).
  **NEW mechanical burst** 10-11T00:34–00:46Z, 105 skips (15th; first since
  09-26) — appended to PROPOSAL-mobile-failure-skip-cascade. Listen log alive
  (resolves 10-10's quiet-phone watch benignly).
- 1-token probes 200 on both keys before any paid call.

## Watch 10-12

1. Backlog 236→~186 if imports pause; **ret-007 bare-in-top25 must FALL**
   (14 → ~9-11) as enrichment individualizes the bare cohort. Growth on a
   no-import night = something new.
2. Standard import-day pre-check (guards proven 5 nights; a few more waves,
   then archive PROPOSAL-mood-import-clobber — Jake sign-off).
3. Taste-drift monthly due ~10-13 (v4 script; W pre-diff already PASS tonight).
4. ret-013/014/015 low on main is EXPECTED — do not re-diagnose.

## Why nothing was applied

The plain brain is Jake's shipped, measured change (it IS the improvement
tonight's numbers record). The bare mood vectors are intended state for
un-enriched tracks — the trainer would write the same bytes today; nothing to
repair, and the fix (drain) is a Jake-gated trainer change. No candidate beat
the production baseline on any in-lane, reversible axis. Brain untouched;
snapshot verified unchanged at session end.
