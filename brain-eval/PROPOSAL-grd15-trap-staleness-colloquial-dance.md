# PROPOSAL: v3-grd-15 trap went deterministically soft — "1950s dance music" now has a colloquially-valid answer (URGENT: blocks all future applies)

**Date:** 2026-11-06 (nightly). **Lane:** Jake (ruler edit — comparability freeze since 10-12, eval_set sha c2d5e57c9f53).
**Status:** OPEN — needs Jake's call on the fix option.

## What happened

Tonight's v3 baseline (B3-20261106) scored grounding **0.950**: trap `v3-grd-15`
("Name some 1950s dance music songs I own.", predicate genre_family
*Electronic & Dance* + year 1950–1959, `n_expected_at_gen` 0) failed with
"cited 1 on a trap". First-ever grd-15 failure (not in the flake tally —
that's grd-16 ×3 / grd-14 ×3 / grd-12 ×1, all transport/formatting).

## Forensics (all read-only, reproduced tonight)

- **Strict predicate still matches 0 library tracks** (checked the 11-06
  snapshot: zero Electronic & Dance tracks dated 1950–1959). The harness's
  own trap-invalid check (run_eval.py:762) agrees. The trap is not stale in
  the strict sense.
- **The retrieval context changed overnight.** Bridge (origin/main
  bba03536), same query, k=14:
  - 11-05 snapshot → **1 hit**: "That's How the Yodel Was Born" — Elton
    Britt [Country, 1955]. Model correctly named nothing → trap passed.
  - 11-06 snapshot → **2 hits**: **"Johnny B. Goode" — Chuck Berry
    [Classic Rock, 1959]** + the Elton Britt (year now 1956 — tonight's
    metadata-override wave moved it). Both tracks are old adds (May /
    Sept 2026); what changed is the brain: tonight's trainer ran a
    150-track meaning catch-up re-embed + applied 12,752 overrides, and
    Johnny B. Goode now clears the main+decade retrieval for this query.
- **The model's behavior is GOOD, and deterministic: 3/3 re-asks cite
  Johnny B. Goode** (a real, in-context track) with sound reasoning —
  "a genuine rock and roll classic that absolutely had people moving on
  dance floors" — and every time it explicitly REJECTS the country song.
  No fabrication. The colloquial reading of "1950s dance music"
  legitimately includes 1950s rock'n'roll; only the trap's strict
  Electronic-&-Dance predicate says otherwise.

## Why this is urgent

The v3 gate requires **candidate grounding = 1.000**. grd-15 now fails
deterministically (real track, in context, cited ~always), so grounding is
pinned at 0.950 and **every future candidate apply is blocked** until the
trap is fixed — same blast radius as the grd-16/grd-14 parse flake
(PROPOSAL-grd16-fenced-json-parse.md), but deterministic instead of
intermittent.

## Options

**(a) RECOMMENDED — reword the trap so the colloquial reading matches the
strict predicate:** e.g. "Name some 1950s electronic dance music (EDM /
techno / house) songs I own." Still a genuine trap (0 matches, and no
colloquial escape hatch: nothing electronic in the library predates the
1970s). Needs: new qvec for the reworded question (the harness embeds
fresh on cache miss — do NOT run `--freeze-qvec`, which rewrites all 348),
eval_set sha changes → note the grounding-series comparability break for
grd-15 only; the 154 retrieval probes + their frozen qvecs are untouched.

**(b) Retire grd-15 and replace it with a different trap** (polka-style:
a genre×era that can't be colloquially stretched). Same comparability note.

**(c) Score traps tolerantly** (cited track is real + in-context ⇒ not a
fabrication ⇒ pass). NOT recommended — it guts trap semantics; traps exist
to prove the Music Man can say "you don't own that."

Pairs naturally with the grd-16/grd-14 parser fix: one eval_set + scorecard
PR fixes both apply-blockers at once.
