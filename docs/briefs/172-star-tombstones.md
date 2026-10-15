# Brief 172 — Star merge learns to subtract: tombstones

> ⚠️ **FORMAT CHANGE — read the rollout order in the PR body before
> merging anything.** `mobile-stars.json` changes shape. Every reader
> in this PR and the companion JakeTunesMobile PR reads BOTH the old
> and new shapes; writers must not ship until both reader sets have.

## Source / evidence

- Proposed briefs 160+, Brief 172: the phone↔desktop star merge is
  union-only with no tombstones; an un-starred track resurrects on the
  next sync round-trip, permanently.
- `src/main/mobile-stars-merge.ts` (main @ 12bb43b): header documented
  the additive behaviour as accepted (sync B-pass 2026-06-07) —
  `mergeStarIds` was a pure union.
- `src/main/ipc/mobile-reads-ipc.ts:68-75` (desktop un-star deleted
  from the sidecar via the cache), `:84-108` (incoming merge was the
  union).
- Sync script (`Dr. Claude/scripts/jaketunes-homemini-sync.sh`, star
  section): pulled homemini's set to staging, then pushed the local
  file back with `rsync --update` — a blunt copy that could erase
  phone-side state written since the pull.
- JakeTunesMobile `backend/src/util/mobileStars.ts`: the backend owns
  the homemini sidecar; its persist wrote the in-memory set whole-file
  (union semantics via pending deltas).

## The format

```
v1:  ["5","12"]                      (bare array, historical)
v1:  { "trackIds": ["5","12"] }
v2:  { "v": 2,
       "trackIds": ["5","12"],           // resolved star set
       "removed":  { "37": 1757000000000 },  // tombstones: id → un-star epoch ms
       "added":    { "5": 1756900000000 } }   // id → latest star epoch ms
```

Resolution, per id, last-writer-wins: an id is starred iff it is
asserted present (listed in `trackIds` or present in `added`) AND its
add time (0 when unknown — every legacy/v1 star) is >= its tombstone
time. A tombstone therefore beats a legacy star of unknown age, a
newer explicit re-star beats an older tombstone, and a newer
tombstone beats an older explicit star.

**Why `added` exists (minimal completion of the brief's rule).** The
brief's literal shape ({trackIds, removed}) cannot resolve
"un-starred on the phone at t2, re-starred on the desktop at t3":
with no add timestamp there is nothing to compare the tombstone
against, so either every re-star loses forever or every tombstone
loses to a stale listing. `added` is optional for readers (unknown
fields are ignored by every reader in both repos), writers in this
change set maintain it, and the resolution rule degrades exactly to
the brief's shape when it is absent.

## What changes

- `src/main/mobile-stars-merge.ts` — rewritten: `normalizeStarSidecar`
  (any historical shape → resolved v2 state, never throws),
  `mergeStarStates` (per-id max of both timestamp maps, then resolve),
  `applyStarChange`, `starSidecarForWrite`. `mergeStarIds` kept as the
  v1-shaped wrapper (existing tests/call shape unchanged). Twin
  comment names both other implementations.
- `src/main/ipc/mobile-reads-ipc.ts` — the stars cache now carries the
  whole sidecar (`StarSidecarData`; v1 files satisfy the shape).
  Desktop star/un-star goes through `applyStarChange` (an un-star
  writes a tombstone); the incoming merge parses v1 or v2 staging
  files and merges states instead of unioning id lists.
- `src/main/__tests__/mobile-stars-merge.test.ts` — the four original
  union cases kept verbatim; eight Brief 172 cases added (v1
  normalization, v1+v2 tombstone, v2+v2 removal, removal-then-readd,
  desktop un-star round-trip non-resurrection, commutativity).
- Sync script star push — the local file uploads to
  `.mobile-stars.json.incoming` on homemini and a remote Python pass
  merges it into homemini's copy under the same rule, then
  `os.replace`. The pull leg (homemini → local staging) is unchanged.
  The Python is the third implementation of the rule (twin-commented).

Companion PR (JakeTunesMobile): `backend/src/util/starSidecar.ts`
(new pure twin module + tests) and `mobileStars.ts` rewired onto it —
mtime-aware reload and pending-delta composition preserved, deltas
now merge tombstone-aware; first persist upgrades the file to v2.

## What does NOT change

- The library.json rating overlay on the backend (`track.rating =
  max(library rating, sidecar star)`) — a track rated in library.json
  itself still cannot be unstarred from the phone. Tombstones govern
  the sidecar set, which is what sync merges.
- The pull direction, the staging-file contract, and the app's
  sole-writer rule for the local sidecar.
- No version bump. No `src/main/index.ts` edits (the cache host
  interface widens with optional fields only).

## Migration

Every reader normalizes v1 → v2 in memory with `removed = {}`
(removals the old format never recorded stay unknown — there is
nothing to recover them from). The first write on each side
(desktop cache update, backend persist, sync-script merge) persists
v2. No offline conversion step exists or is needed.

## Tests

- `node --test --experimental-strip-types
  src/main/__tests__/mobile-stars-merge.test.ts` — 12/12 pass
  (4 legacy + 8 new), run in the agent environment.
- Existing harness `sync-script-replica-push.test.ts` against the
  edited script — 8/8 pass (hub + replica behaviour unchanged,
  openrsync escaping intact).
- The remote Python merge extracted from the script and run against
  fixtures: v1 incoming + v2 current with tombstone → tombstone
  survives; v2 un-star incoming + v1 current → un-star lands; re-add
  (added 900 > removed 500) → star survives; corrupt incoming →
  `refused-corrupt`, current untouched.
- Script-level integration tests for the new push shapes
  (`sync-script-verified-push.test.ts`) land with Brief 174, which is
  stacked on this branch and touches the same script.
- NOT run here: `npm run check` (needs the Mac checkout) — the merge
  module and the edited IPC file were typechecked standalone with
  `tsc --strict` against the real module; full gate is a manual step.

## Manual steps

1. Merge + ship BOTH reader sets first (this PR and the
   JakeTunesMobile companion), per the rollout order in the PR body.
2. Reinstall the sync script to `~/bin/` on the Mac
   (`Dr. Claude/scripts/jaketunes-homemini-sync.sh` is the source;
   the app runs the copy) — only after both apps' readers are live.
3. On the Mac: `npm run check` in V3; backend `npm run typecheck &&
   npm test` in JakeTunesMobile; restart the homemini backend after
   its deploy.
4. Sanity: star a track on the phone, un-star it on the desktop, run
   two sync cycles — it must stay un-starred on both.
