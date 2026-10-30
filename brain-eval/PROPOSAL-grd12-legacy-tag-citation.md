# PROPOSAL — grd-12 flake: a cited track with a legacy comma genre tag can never score (Jake lane)

**Opened:** 2026-10-30 (first occurrence of this flake)
**Status:** open — needs Jake's pick
**Lane:** Jake (touches either laptop-authored metadata or scorecard.py — neither is auto-lane)

## What happened

v3 grounding scored 0.950 tonight (19/20). `v3-grd-12` ("Name three 1970s
r&b and soul songs from my collection", predicate `genre_family = "R&B,
Soul & Funk"` AND `year 1970–1979`) was marked OFF-PREDICATE for citing:

> Let No Man Put Asunder — First Choice, *Delusions* (1977), genre tag `R&B, Soul, Funk`

The answer is factually right — a real 1977 soul track in the library. But
its genre tag is the literal legacy string **`R&B, Soul, Funk`** (an old
comma-style tag), which is not a vocab leaf, so the predicate resolver
cannot place it in any family and the citation counts as off-predicate.

This is the same *class* as the grd-16 fenced-JSON flake
(`PROPOSAL-grd16-fenced-json-parse.md`): the Music Man answers correctly,
the harness can't credit it. Different root cause: data, not transport.

## Scope — measured on tonight's snapshot (12,212 tracks)

Unresolved genre tags: **33 total (0.27%, under the 0.5% stale threshold)**
- 31 × `Plunderphonics` — resolves itself when the vocab snapshot is
  re-exported (the leaf was added to main 10/29, commit 8489a90)
- 1 × `R&B, Soul, Funk` — First Choice, "Let No Man Put Asunder" (*Delusions*, 1977)
- 1 × `World` — one track, same legacy-tag class

So exactly **two tracks** carry dead legacy tags. The flake fires only when
the Music Man happens to cite one of them — rare, but any flake night
blocks a candidate apply (candidate grounding must be 1.000), so each
scoring-artifact flake is real apply-risk.

## Options

**(a) Fix the data (recommended).** Re-tag the two tracks on the laptop
via the normal Cynthia / metadata-overrides flow (`R&B, Soul, Funk` →
the right vocab leaf, e.g. `Classic Soul` or `Disco` — Jake's call by
listening; `World` likewise). Two override entries, zero harness changes,
and the library is cleaner for every consumer, not just the eval.
This box must NOT write metadata-overrides.json (laptop-authored), so this
is a Jake/laptop action.

**(b) Tolerant predicate resolution in scorecard.py.** Split unresolvable
comma tags and try each part against the vocab (`R&B, Soul, Funk` →
`R&B` resolves → family `R&B, Soul & Funk`). One function, harness-only.
Con: it papers over bad data, adds a resolution rule the production app
doesn't have (the eval would diverge from what the router actually sees),
and `World` still wouldn't resolve.

**Recommendation:** (a). It's two tags, the fix is upstream where the
problem is, and the ruler stays an honest mirror of production. Pair it
with the already-queued vocab re-export decision (Plunderphonics) and all
33 unresolved tags go to zero in one pass.

## Numbers to beat / verify

After the re-tag syncs: unresolved tags 33 → ≤31 (or 0 after re-export),
and grd-12 can no longer flake on this track. No gate run needed — this is
data hygiene, not a brain change.
