# PROPOSAL: tolerant JSON parse for grounding replies (grd-16 flake, now diagnosed)

**Status:** proposed (Jake lane — harness change, alters scoring code mid-series)
**Date:** 2026-10-22
**Evidence:** `score_rows.jsonl` run `B3-20261022`, probe `v3-grd-16` (raw_excerpt captured via PR #194)

## The problem

`v3-grd-16` (the 1950s-hip-hop anachronism trap) has now scored 0 on three
LLM nights — 10-14, 10-18, 10-22 — always with reason
`unparseable (reply was not JSON)`. Grounding reads 0.950 instead of 1.000
on those nights, which blocks any candidate from applying (the v3 gate
requires candidate grounding = 1.000) even when the brain is fine.

## What PR #194's raw_excerpt capture revealed (2026-10-22)

The model's behavior was CORRECT — it cited zero tracks and refused the
trap. The reply failed to parse for two mechanical reasons:

```
```json
{
  "tracks": [],
  "answer": "Your library has no 1950s hip-hop songs. Hip-hop as a genre
  didn't emerge until the 1970s in New York. You've got one 1950s track in
  your collection — "That's How the Yodel Was Born" by Elton Britt — but
  that's country, not hip-hop."
}
```
```

1. The JSON is wrapped in a markdown ```json fence.
2. The `answer` string contains **unescaped inner double quotes** around the
   track title, so the payload is invalid JSON even after stripping fences.

So this is a transport/formatting failure, not fabrication. The trap did its
job; the parser didn't.

## Proposed fix (Jake's call — pick one)

- **(a) Tolerant parse in `scorecard.py`'s grounding scorer:** strip markdown
  fences, then if `json.loads` fails, extract the `tracks` array with a
  bounded regex (`"tracks"\s*:\s*\[([^\]]*)\]`) and score cited tracks from
  that; keep `raw_excerpt` on every fallback so a real fabrication can never
  hide behind the tolerant path. Scores the model's actual behavior; grd-16
  would have been 1 on all three flake nights.
- **(b) One re-ask on parse failure:** on unparseable, re-send the question
  once with "reply with raw JSON only, escape inner quotes". Costs one LLM
  call on failure; keeps the parser strict.
- **(c) Both** — tolerant parse first, re-ask only if the tracks array can't
  be extracted.

Recommendation: (a). It is deterministic, retroactively explains all three
flakes, and never scores a fabricated citation as correct (any cited track
still goes through the exists + predicate check).

## Comparability note

Changing the grounding scorer touches the v3 series: nights before the fix
can read grounding 0.950 where after-the-fix nights read 1.000 on identical
model behavior. Suggest annotating score_log from the apply night forward
(a `grounding_parser: v2` field) rather than rescoring history.

## Why this is not applied tonight

Harness scoring code is not a queue item and not auto-lane; the nightly job
only applies brain-file changes that pass the dual-run gate. This needs
Jake's sign-off.
