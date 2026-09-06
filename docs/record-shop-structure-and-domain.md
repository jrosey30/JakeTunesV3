# Record Shop structure and shared domain proposal

2026-09-05 · baseline `f11314a` · proposal for review, no runtime changes.

**Implementation checkpoint:** Jake approved proceeding with the proposed
structure. The first model/adapter slice is implemented; see
[shared model verification](record-shop-model-verification.md). Queue unification
and the Step Inside prototype are the next separate slices. The audit below
records the pre-implementation findings.

The Record Shop should own discovery, saved intentions, exact release inspection,
and acquisition. Step Inside should be another presentation of those same items
and actions. It must not introduce another catalogue, identity matcher, or queue.

## Baseline and evidence

The working tree was clean at the start. Git confirms the downloader slice is
committed as `f11314a`. Jake's live report establishes XTC bonus ownership,
Little Creatures Deluxe acquisition, and Little Creatures standard ownership.
The XTC standard catalogue case was unavailable, not a tested success. The
reported baseline is 1,091 passing tests; this documentation pass did not rerun
the suite or rebuild unchanged application code. `scripts/vern` completed as
`diagnostics/vern-20260905-134432.md`.

Live inspection of `/Applications/JakeTunes.app` succeeded using Computer Use.
Navigation only: no Get, Preview, Play, Restock, or data-editing actions.
Captures are local and gitignored:

- [The Racks](../diagnostics/record-shop-audit-2026-09-05/racks.png)
- [Step Inside](../diagnostics/record-shop-audit-2026-09-05/step-inside.png)
- [Listen List empty state](../diagnostics/record-shop-audit-2026-09-05/listen-list.png)

This is the Record Shop portion of the master Phase 2 audit. A complete
room-by-room typography and accessibility audit of all desktop surfaces remains
separate. These captures do not establish narrow-window, keyboard-only, or
screen-reader acceptance.

## Current map and ownership

| Surface | Implementation | Current responsibility / gap |
|---|---|---|
| Home | `views/HomeView.tsx` | Library overview, mixes, rediscovery, shows and discovery entry points. Keep as overview. |
| Library and playlists | `components/MainContent.tsx`, library views | Owned music and playback; preserve classic iTunes layout and protected contexts. |
| Record Shop | `views/DiscoveryView.tsx` | Route `discovery`; tabs The Racks and At the Counter. Live location label still says Discovery. |
| The Racks / New for You | `views/NewForYouView.tsx` | Feed cards, owned staff picks, reasons, genre shelves, daily records/songs, previews, + List. |
| Step Inside | `views/RecordStore/RecordStoreView.tsx` | Separate `recordstore` route and ShelfBundle; library playback, bins and persona dialogue. Live location says Record Store. |
| At the Counter / Listen to the List | `views/ListenToTheListView.tsx` | Saved inbox, friend attribution, Getting/Landed, keyboard triage and undo. Empty state verified live. |
| Download | `views/DownloadStore/DownloadView.tsx` | Catalogue search, release selection, Get, activity, failures, direct links and provider setup together. |
| Download queue | `views/DownloadStore/downloadQueue.ts` | In-memory queue survives navigation; item key uses source, media type and id. No restart durability established. |
| Listen List queue | `listen-to-the-list/ltlDownload.ts` | A second in-memory serial queue; query payload contains only artist and title. |
| Bandcamp Store | `views/BandcampStore`, `main/bandcamp-integration` | Provider browsing and acquisition; retain until all existing tasks have replacement routes. |
| Settings | `components/SettingsModal.tsx` | Existing settings; Qobuz credentials/tool checks currently also live in Download. |

`MainContent.tsx` preserves `new-for-you` and `listen-to-the-list` deep links as
aliases into Discovery. Keep these aliases during migration. The older placement
audit's description of Record Store as hidden is outdated: Step Inside visibly
opens it now.

## Findings that affect the model

1. **Music identity is lost at boundaries.** `FeedCard` has a kind, artist,
   title and preview metadata, but no collection id or ordered tracklist.
   `addToList` passes song/album/artist/source, dropping the recommendation
   explanation and any prospective exact-release evidence. `Recommendation`
   has no equivalent to the full requested-album contract.
2. **The two acquisition queues are independent.** `ltlDownload` has its own
   pending list and processing flag and calls `streamripDownloadByQuery`
   directly. It omits album intent, runtime and collection id. This is a
   source-backed migration gap; no new live download was attempted. The
   completed Download-page tests do not prove this separate caller's behavior.
3. **Saved, owned, and completed are different facts.** The list's `owned`
   flag is not the requested edition's ownership evidence. A queue job can
   complete with zero new imports. The Download summary displays completed
   item count as “in your library,” explaining the album-versus-track confusion
   in Jake's live report.
4. **Source and catalogue provider are different.** `Recommendation.source`
   is user/mm/radar; `friendOf` extracts a human source from note text. A Qobuz
   resolution must never replace “recommended by Alex” with “from Qobuz.”
5. **Step Inside uses a different item vocabulary.** `ShelfItem` distinguishes
   library album, library track, external release and crate. `FeedCard` uses
   song/album/artist. Display mode must not decide whether an item can be saved,
   inspected, played or acquired.

## Proposed map and terminology

```text
Home / Library / Playlists — existing roles
Record Shop
  For You      — AI picks, reasons, named persona shelves, rediscovery
  Browse       — search, genres, releases and exact edition inspection
  Listen List  — deliberate saved items; source filters incl. Recommendations
  Step Inside  — optional immersive presentation, same items and commands
Downloads      — persistent activity control/panel reachable across views
Settings
  Music Sources — credentials, providers, quality and fallback settings
```

The journey is Discover → optional Save → Inspect edition → Get → Downloads
→ Library. Saving must not be mandatory before acquisition. An artist or vague
note opens Browse; it cannot itself be treated as an exact download request.

| Existing element | Decision | Proposed treatment |
|---|---|---|
| Record Shop sidebar entry | Keep | One destination, one consistent location label. |
| The Racks | Rename primary label | For You; retain The Racks as optional subtitle. |
| At the Counter / Listen to the List | Rename | Listen List, with saved-item count. “At the Counter” may describe acquisition activity. |
| New for You / Discovery routes | Merge visibly | Retain route aliases; no extra sidebar destinations. |
| Recommendations | Define | Named-source recommendations, presented as a Listen List filter/source group, not another page. AI persona picks belong in For You. |
| Download catalogue search | Move | Browse within Record Shop, using the existing exact selection pipeline. |
| Download activity | Move, then demote route | Compact global Downloads panel. Keep current route until progress, cancel, retry, Details and results are at parity. |
| Provider setup | Move | Settings → Music Sources; no credentials on discovery cards. |
| Paste a link | Keep secondary | Browse → Add by link; validate with existing URL rules. |
| Bandcamp Store | Keep during transition | Link from Browse; only remove sidebar duplication after purchase/account/direct-link tasks are audited. |
| Step Inside | Keep, reconnect | Optional view of the shared shop session, with explicit return and preserved selected item. |
| Home, Music Man, library, playlists | Keep | Deep-link into the shop; no new navigation sections required. |

Daily 25-record/25-song policy stays intact. Do not silently cut the feed to make
a small rack; introduce an explicit Show all view if presentation is condensed.
Keep existing no-reshuffle-during-browse behavior and preview-player isolation.

## Shared domain definition (proposed contract v1)

“Shared” first means main process, regular shop, Step Inside, Listen List and
Downloads. It does not authorize a Mobile schema rollout. Mobile adapters and
sync compatibility require the later cross-product phase.

| Entity | Required meaning and fields |
|---|---|
| `ShopItem` | Stable opaque `itemId`; discriminated kind `recording`, `release`, `artist`, `concert`, or `note`; raw title/artist, display metadata, catalogue references with explicit provider and entity kind. Unknown evidence stays unknown. |
| `RecordingSelection` | Immutable selected recording snapshot using the existing `RequestedRecording` semantics: artist/title/album, runtime and tolerance, version markers, explicitness policy, year and known provider ids/ISRC. |
| `ReleaseSelection` | Immutable selected edition snapshot using `RequestedAlbum`: raw title/artist, collection id/UPC where known, track/disc counts and ordered per-disc tracklist with runtime/version evidence. A base album title is not an edition id. |
| `RecommendationEntry` | Stable recommendation id, `itemId`, source kind and source id/name, reason, optional because-artist, generated/received time, original lane and existing feedback identifiers. Multiple people can recommend the same item. |
| `ListenListEntry` | Preserve existing recommendation UUID and timestamps; reference `itemId` and contributing recommendation ids; personal note, saved time and existing fulfillment/tombstone semantics. Saving is independent of ownership or job state. |
| `OwnershipAssessment` | `unknown`, `none`, `partial`, or `complete`; selection revision and library revision checked; expected/owned counts and per-position matching library ids. Produced by existing ownership contract, never by card text or artwork. |
| `AcquisitionJob` | Unique job id, immutable recording/release selection, origin item/list ids, attempt number, timestamps, status, provider attempts and structured result. Exact outcome/alternatives/primary/detail survive every presentation. |
| `AcquisitionResult` | Expected, imported, already-owned and missing track counts when known; imported library ids; existing completion line; verdict and failure details. Job count remains a separately labelled metric. |
| `ShopShelf` | Stable shelf id, ordered item/recommendation references, label, curator/source, generated/stale time and optional genre bin. Presentation mode cannot generate a different selection. |

Artist, concert, and note variants remain discoverable/savable. Do not coerce
concerts into album requests or remove the existing archive/concert route.

### Identity and evidence rules

- Keep raw catalogue names separate from display names. Packaging cleanup for
  display must not erase requested edition evidence.
- Names can suggest candidates, never mint a verified cross-provider identity.
  Provider ids are namespaced (`itunes:collection` versus `itunes:track`).
- Reuse `exact-recording.ts` and `album-identity.ts` verdicts and ownership;
  do not write shop-specific matching regexes. If common TypeScript DTOs are
  extracted, keep the existing main/renderer twins together and test adapters.
- A selected edition remains immutable through Save, Inspect, Get and Retry.
  Enrichment may fill gaps; contradictory counts or edition evidence requires
  reselection rather than silently changing the job.
- Loose recommendations can be saved immediately. Resolve/select a catalogue
  edition before album Get; unsupported or ambiguous evidence explains the
  choice needed. Preserve the strict name-only XTC refusal.
- Owned recordings can satisfy a requested album without rewriting their old
  album tags. Little Creatures standard can be fully owned after Deluxe without
  a second import. Ownership is not permission to retag or delete anything.
- Model saved, ownership, availability, preview and job state independently.
  An item can be saved and partly owned while its job is downloading.
- Preview URL, hook recording and full-library playback are distinct. An album
  preview identifies the hook track; absent previews do not imply unavailable
  albums. Use the existing preview player and refresh behavior.

### Commands and state

`saveItem`, `inspectSelection`, `previewItem`, `playOwned`, `getSelection`,
`cancelJob`, and `retryJob` have the same meaning in both shop presentations.
Main remains the authority for verification and import. The renderer displays
evidence and initiates commands; it does not approve candidates itself.

Existing queue statuses map to queued → downloading → done/failed/canceled.
Verification/ownership can initially be progress details, not invented durable
states. Retry creates a new attempt for the same selected identity. Cancel
must stop the actual owning job; view unmount only unsubscribes.

Adopt one scheduler before adding a second new Get surface. Migrate
`ltlDownload` into an adapter of the existing Downloads queue, preserving its
recommendation-id status projection. Keep global serialization and existing
cancel behavior. Restart recovery needs a separately tested persistence design;
do not describe the current memory queue as restart-safe.

Successful detail example: “12 tracks · 10 imported, 2 already in your library.”
Compact aggregate example: “1 album completed.” Never substitute one for the
other. `done` requires no missing tracks; partial import remains a failure with
already imported tracks retained.

## Typography and visual findings

| Priority | Evidence | Recommendation |
|---|---|---|
| P1 migration risk | Two queue owners and incomplete Listen List payload | Establish one acquisition adapter before enabling Get in the prototype. No live failure asserted here. |
| P2 | Live: Discovery → Record Shop → Record Store; The Counter opens Listen to the List | One location vocabulary and literal primary tabs. |
| P2 | Live: What I've Learned and several staff shelves precede external daily shelves | Put concise context above the fold; preserve all picks with deliberate sections/Show all. Do not hide quota content. |
| P2 | Live empty list says “Drop ... above” while capture shows only + Add | Empty-state copy should name the visible Add action. |
| P2 | `variables.css`: body 11.25px, label 10.25px, title 12.25px; Download uses size tokens such as 26px; feed title 22px; list base title 18px | Define title/table/body/metadata roles locally first; do not globally enlarge `--font-title` used elsewhere. |
| P2 | Feed badges as small as 8.5px, reasons 10.5px; list contains legacy ellipsis rules | Exact title, version, status and failure reasons must be readable/inspectable. Verify computed styles and long content in the prototype. |
| P2 | Live teal tabs, copper sidebar, orange Step Inside action inside silver chrome | Use Lion silver/blue for controls; reserve orange for intelligence/brand. Use existing `lion-controls.css` blue (#3b66a8 border) and the screenshot's silver shell as references. |
| P3 | Step Inside's illustrated room, cream text and monospace dialogue differ from white shelf UI | Retain intentional atmosphere; use the same action labels, focus behavior and selection details. Do not flatten editorial artwork. |
| P3 | Step Inside bins expose AX labels but the wide-room screenshot relies on illustrated hotspots | Test persistent visible labels, keyboard focus and Reduce Motion in the prototype. No current keyboard failure claimed. |

No P0 runtime defect was established in this audit. Contrast and truncation
issues above are inspection targets, not measured accessibility certifications.

## Reviewable implementation order

1. Approve this domain definition and location/terminology map.
2. Add common DTOs plus adapters and fixture tests; no navigation or visual
   changes. Verify selection survives feed → saved item → catalogue → queue.
3. Unify the Listen List queue adapter and result projection. Preserve feedback,
   friends, undo, fulfillment sync and exact-download behavior. Review independently.
4. Build the Step Inside prototype using the same fixture items, selection
   details and command interfaces. Include regular-view return, focus, narrow
   layout, Reduce Motion and missing artwork. No new AI generator or downloader.
5. After visual acceptance, connect live data; then implement literal labels,
   Music Sources placement, Downloads panel and Browse migration as separate
   small changes. Retain legacy routes until each replacement is verified.

Required regression fixtures: XTC bonus owned, plain ambiguous XTC unresolved,
Little Creatures Deluxe partial ownership, standard already owned, live/remix
variants, unavailable exact edition, interrupted/partial import, no preview,
duplicate recommendation sources, artist-only note, and an archived concert.

Decision checkpoint: locations and terminology require review under the master
brief's Phase 2 / STOP 2. This proposal does not authorize installing, committing,
pushing, changing protected playback/library code, or deploying Mobile changes.
