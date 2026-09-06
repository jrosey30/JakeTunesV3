# Shared Record Shop model — first implementation slice

2026-09-05 · built on `f11314a` · not installed or committed.

The shared model and pure adapters are ready for queue integration. Fixture
tests exercise feed → explicit catalogue selection → saved entry → job draft
and retry, preserving edition evidence and recommendation attribution.
These are model-level handoffs; the running Listen List and Downloads queues
have not yet been rewired and live recommendation persistence is unchanged.

## Changes

- `src/common/acquisition-identity.ts`: the existing requested-recording,
  requested-album, provider, alternative and outcome DTOs moved into common.
  Main modules import/re-export those same types; builders and matchers are
  unchanged. No new identity algorithm or Mobile twin behavior.
- `src/common/record-shop.ts`: item kinds, selections, provenance, saved
  entries, ownership, jobs, results and shelves. Saved/job snapshots clone
  and freeze nested evidence. A draft job requires an explicit selection;
  artist/note/concert items remain browse-only. Retry preserves selection.
- `src/common/record-shop-adapters.ts`: feed, legacy recommendation, explicit
  selection and download-result adapters. Legacy UUIDs, notes, source hints,
  resolution metadata and fulfillment hints survive. Legacy `owned` does not
  become verified edition ownership; catalogue URLs are browse links.
- `src/main/record-shop-adapters.ts`: ownership projection calls the existing
  album ownership matcher and attaches the selection/library revisions and
  per-position library ids. Missing tracklists/ids yield unknown ownership.
- `src/main/__tests__/record-shop-domain.test.ts`: 11 regression tests.

The two existing dirty audit/checkpoint docs were preserved. The audit received
an implementation-status note. No protected playback/library files were edited.

## Verification

- Baseline: `npm run check`, 1,091 tests and both typechecks passed.
- Final: `npm run check`, 1,102 tests and both typechecks passed.
- `npm run build` passed, with the existing bundler warnings.
- `git diff --check` passed.
- Tests prove that a saved Deluxe selection rejects a standard candidate via
  the existing matcher; mutable view/cache enrichment cannot rewrite saved
  evidence; provider ids/runtime/explicitness survive; loose XTC jots stay
  unresolved; multiple sources remain distinct; album hook previews retain
  their song identity; retries retain the original selection; missing tracks
  and already-owned counts are retained; ownership uses the existing contract.

No install or live download was needed for this data-only slice. UI interaction
and live queue acceptance remain required after integration. This is not a
claim that cross-view runtime handoffs or restart recovery are already wired.

## Next slice

Unify the Listen List queue through the existing Downloads scheduler, projecting
statuses by recommendation id. Carry the selected identity end to end; loose
album recommendations must reach catalogue selection before acquisition. Keep
cancel, retry, fulfillment sync, friend attribution and result details intact.
Then build Step Inside with the same fixtures and command interfaces.

## Queue unification slice — 2026-09-05

The Listen List no longer owns a queue. `listen-to-the-list/ltlDownload.ts`
is now an adapter over `views/DownloadStore/downloadQueue.ts`, the one
scheduler:

- **Identity.** A song recommendation becomes the same job a Download-view
  Get would (`trackQueryId`, shared with `songQ`/`albumQ`), carrying artist,
  title and the album as the album-door hint. Main's download-by-query and
  its identity/ownership contracts are unchanged; no new matcher.
- **Provenance.** Jobs carry `origin` — recommendation ids, the entry id and
  the human source ("from Alex" stays a person; the catalogue provider never
  becomes the source). Two recommenders of one recording share one job and
  both ids are adopted onto it.
- **Loose albums reach selection first.** An album recommendation has no
  chosen edition, so `queueRecoDownload` answers `select-edition` and the
  view opens the Download tracklist with the origin attached; the Get made
  from that tracklist carries the recommendation id back, so the list sees
  the edition job land. Artist-only jots and concerts are `browse-only`.
- **Projection.** Status by recommendation id (queued → downloading → done /
  error; canceled reads as idle), with the structured verdict (`primary`,
  `detail`, `outcome`), `matchDesc`, the album completion line and the
  already-owned count. The done/fulfillment rule is unchanged: imported or
  already owned is done; nothing imported is an error.
- **Cancel / retry** act on the owning job by key; retry is a new attempt
  of the same identity.

Tests: `src/main/__tests__/listen-list-queue.test.ts` drives the real
scheduler with a stubbed main (6 cases: identity + provenance, selection
routing, projection lifecycle, verdict mapping, shared job / view-started
job / prefilled album job, cancel + retry). Not yet exercised live: the
Listen List rows and the Download view's prefilled Get in the running app.
No install, commit or push.

### Live acceptance — 2026-09-05 (builds 16:13 → 16:22 → 17:16, all uncommitted)

- **A. One job across surfaces.** A song jot (XTC, "Earn Enough for Us",
  from Alex) was fetched from the Listen List; searching the same song in
  Download showed the *same* job in flight (hero row "0:06 · Cancel", no Get
  button), then "In your library · 1" and "1 in your library" on the queue bar
  — one job, one import. The list row fulfilled and left the list.
- **Cancel / retry.** "Grass" fetched from the list showed "Getting…";
  cancelled from the Download queue bar the row returned to Get; Get again
  re-armed the same identity and imported once.
- **Already owned.** "Senses Working Overtime" (owned) answered as done
  without an import; the row left the list.
- **Two recommenders.** The hub dedupes a second jot of the same song on
  add; the second sender is kept in the attribution ledger, not as a second
  list row. Queue-level adoption of a second origin is unit-tested.
- **B. Album jot → edition selection → back to the entry.** An album-kind
  jot (Little Creatures, from Sam) → Tracks → Download prefilled with the
  album search → Get all → "12 tracks · 0 imported, 12 already in your
  library; nothing downloaded" → the list entry fulfilled and removed.

Fixes made along the way (all in this working tree):
- The prefill event fired before the Download view mounted and was lost; it
  is now captured at module scope and applied on mount.
- Ownership called two owned tracks missing because iTunes labels the early
  takes "(Early Version)" and Qobuz tags the same files "(Demo)"; two
  duplicates were imported and then removed (local, Trash, and the pushed
  copies). The contract now treats the alternate-take label family
  (demo/early/alternate/rough/outtake…) as one recording when both sides
  carry one and runtimes agree; a label on one side only stays a different
  recording. Regression test added.

Known, not fixed here: the album tracklist does not auto-expand on a
prefill (the card must be clicked); the Browse results derived from a song
search listed only the Deluxe edition for Little Creatures; hub-side jots
reach the desktop list on the 5-minute cache, not on arrival; friend import
credits key on exact normalised titles ("The Mayor of Simpleton" vs Qobuz's
"Mayor Of Simpleton" earned no credit).

### Follow-ups recorded (not in this slice)
1. **Tracklist auto-expansion on prefill** — the Download view runs the
   prefilled search but the album card does not open by itself (fails on the
   mounted path too, so pre-existing). One click on the card opens it.
2. **List cache freshness** — jots added on the hub reach the desktop list
   only when the 5-minute renderer cache expires or a UI mutation invalidates
   it; the hook does not subscribe to `recommendations-updated`.
3. **Friend import credit matching** — credits key on the exact normalised
   library title; "The Mayor of Simpleton" (jot) vs "Mayor Of Simpleton"
   (Qobuz tag) earned no credit. Needs the recording matchers, not a new one.

### Close-out checks — 2026-09-05 evening (build 21:57, uncommitted)

**Take-label exception, audited.** Equivalence across differently-worded
take labels now needs: a take label on both sides, an offending marker
that is itself a take word, no differing take numbers, and both runtimes
known and within 5 s. Nine negative cases lock it: a missing runtime, 13 s
or 63 s apart, "Demo 1" vs "Demo 2", "Take 3" vs "Alternate Take 1",
"(Rough Mix)", "(Acoustic Demo)", "(Demo) [Live]", studio vs take in
either direction. Status: unit-tested; targeted live check below.

**Album intent, desktop → hub → desktop.** The desktop add now infers
`kind` (an album with no song is an album), sends it to the hub, and keeps
the jot's own artist/album through iTunes enrichment (`reco-kind-core.ts`).
Live, through the normal UI with no direct POST and no renderer reload:
"+ List" on the feed's *Piano — Joy Again* card → hub record
`kind: album, artist: Joy Again, album: Piano, song: none` → desktop mirror
the same → Listen List row with **Tracks** (after the list's 5-minute cache
expired) → Download prefilled "Joy Again Piano" → the 7-track 2019 edition
offered as Top Match → Get → "7 tracks · 7 imported" → the list entry
fulfilled and removed, and the hub entry deleted with it.

Found on the way and fixed: the prefilled search used the enrichment's
decorated name ("Sting & Bedouin … [feat. Cheb Mami]") and found nothing;
it now searches with the jot as written, brackets and feature credits
dropped. The tracklist expander used to fall back to the first card
(Sting's *Brand New Day* for a Bedouin record); it now opens only the
album that was asked for, or nothing.

Still open (recorded as follow-ups): tracklist auto-expansion when the
edition is the Top Match hero; list cache freshness; friend-credit title
matching; a tossed jot whose remote delete has not landed comes back on
the next converge carrying its old local enrichment.

### Deluxe tracklist failure, root cause and fix — 2026-09-05 late (build 23:25)

Why the app could not load *Little Creatures (Deluxe Version)*'s tracklist
while the shell lookup succeeded: Apple throttles bursts of the song
search, the Download view then renders release cards from the Deezer
failover, and those rows carry no collection id, so the card opened with
no tracklist and no Get all — the edition could not be selected at all.
The lookup itself was never broken (the in-app album-tracks call answered
12 tracks for id 124906778 throughout).

Fix, without bypassing selection: a card with no id asks main by NAME, and
main resolves it only through the strict edition picker (artist, base
title, packaging labels and version markers must agree on exactly one
collection) before looking the tracklist up by id; the resolved id then
rides on the Get so the job carries the edition. Anything ambiguous reads
"Couldn't pin this edition in the catalogue — search it by name to pick
one." No identity check was loosened.

**Targeted take-label live check — passed.** Get all on *Little Creatures
(Deluxe Version)* with the "(Demo)"-titled copies in the library:
"12 tracks · 0 imported, 12 already in your library; nothing downloaded",
no staging directory, the 12 library rows and files unchanged (same
mtimes and sizes), library count unchanged. The take-label exception is
now live-verified as well as unit-tested.
