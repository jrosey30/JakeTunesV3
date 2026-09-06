# Master plan checkpoint — 2026-09-06

Supersedes [2026-09-05](master-plan-checkpoint-2026-09-05.md) for current status.

## Done since the last checkpoint

- **Record Shop live wiring — shipped.** Desktop commits f316b4e (live session,
  ownership resolve IPC, live command bus, fixtures behind `#shopFixtures`),
  1ac198f (a record jot is its own identity), 8178a28 (finished Downloads jobs
  stay inspectable), c1770a8 (docs). Live-tested on the installed build; results
  in [record-shop-model-verification.md](record-shop-model-verification.md).
- **Recommendation identity twin — deployed.** Mobile db11ee1 on homemini via
  auto-deploy; the `identity:artist:talkingheads` tombstone created by the
  test cleanup was removed from both hub copies (backups kept). Two records by
  one artist survive desktop → hub → desktop; an exact repeat dedupes.
- **Brief 144 (Mobile) — COMPLETE.** Device acceptance by Jake on the iPhone Air
  (offline Crawlspace playback, scrubbers, wheel). Commits 05dd741, c3a546a,
  00bb64b, 3afe508, 934d43f, 337bcb3; homemini auto-deployed **337bcb3**
  (12:10, dist rebuilt, live "Chill" = 25 tracks / 21 artists); the laptop dev
  backend restarted from the committed tree. Evidence and report:
  `~/Downloads/jaketunes mobile issues 9.6.26/proof/`. Accepted layout rule:
  the Now Playing cover is never resized or moved; the queue counter lives on
  the scrubber's time row.

## Recorded follow-ups (visible, not started)

1. Tracklist auto-expansion on prefill when the plain edition takes the hero slot.
2. Listen List cache freshness (the regular shop's hook does not subscribe to
   `recommendations-updated`; the Counter's reader always re-reads on mount).
3. Friend import credit matching should use the recording matchers.
4. "Not found" rows still offer Retry (Downloads bar + regular list); the
   Counter says Details / Choose version.
5. Enrichment must not imply another edition: the regular list shows iTunes
   enrichment names for record jots; the Counter shows them as written.
6. Canceled jobs are invisible in the Downloads bar.
7. Mobile small-phone Now Playing fit (cover stack taller than a 17e screen) —
   observed in the simulator only; not Jake's device.
8. Mobile download identity parity with the album contract.

## Current next work

Record Shop implementation order, step 5, remaining small changes in order:
**literal labels** (For You / Listen List with count, per the terminology map
in [record-shop-structure-and-domain.md](record-shop-structure-and-domain.md)),
then Music Sources placement, the Downloads panel, and the Browse migration —
each a separate reviewable slice, legacy routes retained until verified.
After the Record Shop: the Desktop placement audit and the Activity Sync front
end per [jaketunes-6-plan.md](jaketunes-6-plan.md).

## In progress — step 5, slice 1: literal labels (uncommitted)

- Record Shop tabs: "For You" (subtitle "The Racks") and "Listen List" with the
  saved-item count (the Counter's lean list reader, no suggestion fetch).
- The list's own title reads "Listen List"; album-detail back labels read
  "← Listen List" and "← Record Shop". Routes, tab ids and the Step Inside
  room ("At the Counter" = acquisition activity) unchanged. Artwork untouched.
- The window title / breadcrumb for the route reads "Record Shop" (was
  "Discovery"); the sidebar entry already did.
- Gate: 1,138 tests; renderer built. Verified on the dev instance:
  `diagnostics/step-inside-review/labels-1-for-you.png`, `labels-2-listen-list.png`,
  `labels-3-title.png`. Count pill verified with a temporary in-memory list
  fixture (three entries served through the read IPC on the dev instance,
  no real jots added or removed): pill "3" = three visible Listen List
  entries ("3 to decide"); mounting For You triggered no suggestion fetch
  (the only request logged was one made explicitly to prove the instrument).
  Captures `labels-4-count-pill-for-you.png`, `labels-5-count-pill-listen-list.png`.
  Labels approved by Jake; committed. Not installed yet.
