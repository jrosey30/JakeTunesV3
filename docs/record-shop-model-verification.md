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

### Unavailable through the app's searched sources — 2026-09-06

Tom Clark, *Nervous Gallop - Single* (Absurd State, 2016; iTunes collection
1151252662: Nervous Gallop, Following Light Remix, Aluria Remix; credited to
Tom Clark, the cover reads "Tom Clark (UK)"). Traced on 2026-09-06 with the
same searches the app runs: Qobuz has no track or album for it under the
artist, the bare title, the cover's credit, the remixer or the label;
Bandcamp's search API returns nothing for the release, the artist or the
label; SoundCloud's single hit is a different Tom Clark song and was refused
on title. The "Not found" verdict was correct and no candidate was filtered
wrongly. Acquisition needs a direct link from wherever the label sells it.

UI follow-up (recorded, not changed): a "Not found" queue row still offers
Retry, which invites the identical search the message warns against.

## Live wiring — 2026-09-06 (built, not installed)

The Counter reads the live session and performs verbs through the same
modules the regular shop uses. Nothing in the regular shop's flow moved.

- `src/common/record-shop-live.ts` — the live session builder (pure):
  list jots → entries/items (`shopEntryFromLegacy`); scheduler items →
  jobs keyed by item, `jobId` = queue key; a job's query → the item's
  selection (the edition Jake chose, by iTunes id); a song jot selects
  itself. Ownership attaches only when its verdict was made for the item's
  current selection revision.
- `src/main/record-shop-resolve.ts` + `ipc/record-shop-ipc.ts` —
  `record-shop:resolve` (read-only): the tracklist behind an edition and
  ownership by recording identity, through `itunesAlbumTracks` and
  `matchLibraryOwnership`. A song without a runtime is reported
  `unknown`, never matched by title alone.
- `src/renderer/record-shop/useShopSession.ts` — list (same cache and
  loader as the Listen List, no suggestion fetch) + queue + resolve
  cache; verdicts drop when the library changes or a job lands.
- `src/renderer/record-shop/liveShopCommands.ts` — Get on a selected
  record enqueues the Download-view contract (collection id, count, year,
  provenance); a song goes through `queueRecoDownload`; a record without
  an edition, and Choose edition, go to the Download view prefilled;
  cancel/retry address the queue key; Play plays the owned rows in order;
  Preview uses the preview player. Every verb refuses `fx:` ids.
- Fixtures: only behind `#shopFixtures` in the window hash, with the
  recording bus; rails in `record-shop-isolation.test.ts`.

Read-only smoke on the dev build (03:20): the counter showed the live
list (1 item), `record-shop:resolve` answered Remain in Light with 8
tracks and a partial verdict (2 of 8, 598 ms), a song with a runtime
answered `none`, an unknown record answered `tracklist-unavailable`.

### Live-test plan (attended, after install)

Run with the Listen List open in one view and the Counter in the other;
every step is checked in BOTH.

1. **Save** — jot a song and an album in the Listen List. Counter: both
   appear (song offers Preview/Inspect/Get; album offers Inspect/Choose
   edition, "Pick edition").
2. **Edition selection** — Counter → Choose edition on the album. The
   Download view opens with the search run and the album card expanded.
   Get all. Both views: the row goes Queued → Getting…; Counter shows the
   chosen edition line (deluxe · N tracks · year) once the job carries it.
3. **Cancel / retry** — Counter → Cancel while downloading: both views show
   Canceled; Counter offers Retry only (no Get). Retry: attempt 2, job
   resumes.
4. **Completion** — let it finish. Counter: completion line
   ("N tracks · X imported, Y already in your library"), ownership
   refreshed to "All N in your library", verbs Inspect/Play, "On your
   shelf". Listen List: the row is auto-removed (its existing rule), so the
   Counter item disappears on the next list update — expected.
5. **Ownership refresh** — jot an album you already own in full. Counter
   → Choose edition → Get all on the owned edition: main answers from the
   library (no rip), Counter reads complete; Inspect lists every track
   "in library". Then jot a partly-owned deluxe: Inspect marks the owned
   originals; Get imports only the missing ones.
6. **Play** — on an owned record, Play starts the first owned track with
   the rest queued in running order; the Now Playing pill agrees.
7. **Get (song)** — Get on the song jot queues it (same job the Listen
   List's Get would make: one row in the queue bar, provenance carried).
8. **Refused edition** — pick an edition the sources lack (a live
   variant). Both views: "Exact edition not found"; Counter offers
   Details / Choose edition, never Retry/Get.
9. **Isolation** — set `#shopFixtures` in the window hash and reopen the
   room: the fixture set with the Prototype pill; Get/Play only log. Clear
   the hash: the live list returns.

Known limits to watch: the Listen List shows ownership only through
completion and the hub sweep (no identity chip there yet); a Counter
verdict for an album jot without a chosen edition stays "unknown" by
design; iTunes throttling can delay Inspect tracklists.

### Live-test run — 2026-09-06 (installed 09:38 build; Jake paused playback for it)

Captures: `diagnostics/step-inside-review/live-1-getting.png` … `live-6-fixtures.png`.

| Step | Result |
|---|---|
| Save | Song + record jots through the app's add path appear at the counter with the model's verbs (song: Preview/Inspect/Get; record: Inspect/Choose edition, "Pick edition"). **Defect found:** a second album jot by the same artist is deduped against the first ("Little Creatures (Deluxe Version)" returned the "Remain in Light (Deluxe Version)" row) — the add path's fallback key ignores the album. Pre-existing; not touched. |
| Edition selection | Choose edition → Download view prefilled ("Talking Heads Remain in Light"), search run, both editions listed; the deluxe card was NOT auto-expanded (the plain edition took the hero slot — recorded follow-up). Expanded by hand, Get all. Counter: "deluxe · 12 tracks · 1980", "2 of 12 in your library", Getting…, Inspect/Play/Cancel. Downloads: the same job, one row. |
| Cancel / retry | Cancel from the counter: Canceled, Retry only (no Get), rip process gone. Downloads: the canceled job is NOT shown (the queue bar renders active/failed/done only). Retry from the counter: "Getting… · attempt 2" in the counter, the job back in the Downloads bar. |
| Completion | Counter: "12 tracks · 10 imported, 2 already in your library · attempt 2", ownership refreshed to "All 12 in your library", Inspect/Play/On your shelf; Inspect 12 tracks, 12 in library, iTunes collection 124922154. Readable until the regular shop's At the Counter tab was opened, which auto-removed the row (hub list confirmed). Afterwards Downloads still carried "1 in your library" and the failed details. |
| Ownership refresh (owned record) | Little Creatures (Deluxe): Choose edition → Get all → no rip; counter "12 tracks · 0 imported, 12 already in your library", All 12, Inspect 12/12 in library. |
| Play | Play on the owned record started playback (Now Playing, pmset assertion) in running order; paused again afterwards. Twice. |
| Song Get | Cups (Jake's own jot) and Nervous Gallop: queued from the counter (Queued → Getting… with Cancel), both refused as Not found; counter offers Details / Choose version with "Refused"; the regular shop's list shows "Retry" for the same rows (recorded wording follow-up — same meaning, different verb). Downloads: "2 failed" + full details panel. |
| Fixture isolation | `#shopFixtures`: 13 fixture rows, Prototype pill. Get, Play and Choose edition on fixtures: queue unchanged, no rip, no playback, 0 download log lines. Hash cleared: the live list (4 rows) returned. |

**Library side effects:** +10 rows (11733–11742), Talking Heads "Remain in
Light" deluxe: six 2005-remaster album tracks and four Unfinished Outtakes,
titles carrying the source's "(2005 Remastered Album Version)" stamp. Test
jots removed from the hub list afterwards (Once In a Lifetime, Nervous
Gallop, Little Creatures); Cups left as found. No other writes.

**Fixed during the run:** the counter's list reader trusted the regular
shop's cache, so a jot added by any other path never appeared; it now
shows the cache at once and always re-reads the mirror (rebuilt, reinstalled).

**Known limits seen:** a song jot has no runtime, so its ownership stays
"unknown" even after its album was imported (Once In a Lifetime); the
queue is renderer memory, so a relaunch forgets finished jobs.

### Correction pass — 2026-09-06 (built + installed 09:54; NOT committed)

**Album-jot identity.** A songless row that names a record is now its own
identity: `album:<artist>~<album>` (edition words included), never the
artist alone; `artist:` remains only for songless, albumless rows. The
add path dedupes by shared identity keys (album-aware) and the strict
fallback key includes the album. Parity fixtures updated on both sides;
the backend twin source (`~/JakeTunesMobile/backend/src/util/reco-identity.ts`)
carries the identical change, tested (10/10) — **not deployed**: the hub
on homemini still runs the old keys.

Live (installed build): "+ List" on two record cards from the racks
produced two rows (different artists). A second record by the same artist
through the racks' exact add payload was no longer deduped on the desktop
— but the hub returned the first record's row for it (its old identity
code), so the fix is complete only once the backend twin is deployed. A
repeat of the same record is still deduped (`deduped: true`).

**Hub tombstone hazard (found):** deleting a songless row under the old
hub code tombstones `identity:artist:<artist>`. The 2026-09-06 cleanup
deletes left `identity:artist:talkingheads` on the hub, so until the
backend twin is deployed (and that entry cleared or re-added), a Talking
Heads record or artist jot can be refused by the hub. Do not delete album
jots on the hub before the deploy.

**Downloads: finished jobs inspectable.** The queue's Details panel now
lists done jobs — edition facts (album/song, track count, year, iTunes
id), imported / already-owned counts and the completion line — and the
Details button shows when only done jobs remain. Built and installed; the
targeted live check (owned song → done → list auto-removal → Details) was
interrupted: Jake was using the app, so driving stopped. Unverified live.

**Library event during this pass (facts):** at 09:48:49 a library save
shrank the library 10644 → 10634 (−10) with the sync deferred
(metadata-edit); the ten Remain in Light rows (11733–11742) are gone and
their files are not on disk or in the Trash. Nothing in this pass touches
the library or those files; the only preceding write was Jake's own add
(GEEKIN — Nemzzz, 11743, 09:44). Cause not established from logs.

Follow-ups kept separate: tracklist auto-expansion (hero case), canceled
jobs invisible in the Downloads bar.

### Deploy + verification — 2026-09-06 10:10–10:40 (still uncommitted)

- Deletion investigation closed (Jake's call).
- Backend twin deployed to homemini by hand: source copied, its own suite
  10/10 on node 26, `tsc` built dist 10:11, launchd service kickstarted;
  port 3000 is owned by the restarted process. The tracked source on
  homemini was then restored to HEAD so the auto-deploy can fast-forward
  when the commit lands (dist keeps the new keys until then; a manual
  rebuild on homemini before the push would drop them). A stale second
  `dist/server.js` process (node 22, ~31 h old) sits on homemini without a
  listener — left alone.
- Tombstone: only `identity:artist:talkingheads` removed from both hub
  copies (NAS + durable local), each backed up as
  `recommendations-deleted.json.pre-untomb-20260906`; live list 988 → 987.
- Desktop → hub → desktop: "Stop Making Sense" and "Fear of Music" by
  Talking Heads (the racks' exact add payload) → two ids on the desktop,
  both on the hub, both back on the desktop after a fresh mirror; an exact
  repeat of "Fear of Music" → `deduped: true`, same id.
- Downloads details after auto-removal: "Little Creatures (Deluxe
  Version)" (owned 12/12) → Get all ran no rip; counter read
  "deluxe · 12 tracks · 1985", "All 12 in your library", "12 tracks · 0
  imported, 12 already in your library"; the regular list's tab removed
  the row (hub confirmed); Downloads → Details listed the job:
  "album · 12 tracks · 2006 · iTunes 124906778", "0 imported · 12 already
  in your library", completion line intact. (The panel also carried
  Jake's own beabadoobee import from this session, 14 imported.)
- Fear of Music was NOT acquired: iTunes lists only the 15-track bonus
  edition and Jake owns the 11-track record, so Get would have ripped
  four tracks. Test jots removed afterwards (Cups kept); the hub now
  tombstones `identity:album:…` keys for those, never the artist.
- Captures: `diagnostics/step-inside-review/live-8-*.png`, `live-9-downloads-done-details.png`.

### Follow-up recorded — 2026-09-06: enrichment must not imply another edition

The regular shop's list showed the record jots under their iTunes
enrichment names ("Stop Making Sense (Live) [Special New Edition]",
"Fear of Music (Remastered Bonus Track Version)") while the Counter showed
them as written. Enrichment may add artwork and a preview, but a displayed
name that names a different edition silently selects or implies that
edition. Follow-up: the list must display the jot as written (or make the
enriched edition an explicit, reversible choice), and the enrichment's
edition must never become the selection. Separate from the live-wiring
work; not fixed here.

## Downloads panel acceptance — 2026-09-06 afternoon (dev instance, playback idle)

Rows come from the one scheduler; the checks used an owned album and two
made-up requests ("Nobody Lives Here") so nothing could be acquired.

| Check | Result |
|---|---|
| Empty panel | "Nothing in the queue" + hint; sidebar badge absent (`dlp-0-empty.png`). |
| Done job keeps identity + details | Little Creatures (Deluxe Version): `album · 12 tracks · 2006 · iTunes 124906778`, `0 imported · 12 already in your library`, Details → "12 tracks · 0 imported, 12 already in your library" (`dlp-1-done.png`, `dlp-2-done-details.png`). No import, no rip. |
| In flight | "Downloading · 1s", provenance "from Alex", Cancel only (`dlp-3-downloading.png`). |
| Canceled job visible | "Canceled" row with Retry; badge "2 done"; no rip process left (`dlp-4-canceled.png`). |
| Retry → refused song | "Needs a choice · Not found", full explanation in Details, action **Choose version** (no Retry) (`dlp-5-refused-song.png`). |
| Refused album | "from your Listen List", edition line retained, **Choose edition** (`dlp-6-refused-album.png`). Ordered: needs-a-choice rows above Done. |
| Choose version | Panel closes, Download view opens prefilled "Nobody Lives Here Song That Does Not Exist"; legacy queue bar still shows the same jobs (`dlp-7-choose-version-prefill.png`). |
| Reachable across views | Badge click on Songs opens the panel over Songs, selection stays Songs; second click closes (`dlp-8-over-songs.png`). |
| Clear finished | Rows 0, badge hidden, empty state back. |
| Fixture isolation | No fixture code involved; live scheduler only. |

Library side effects: none (0 imported everywhere; no staging leftovers; `rip`
never running after cancel). Scheduler change: `emit` snapshots the array so
`useSyncExternalStore` readers update — the pre-existing sidebar count had the
same blind spot.

### Review round (same afternoon)

| Check | Result |
|---|---|
| Door with an empty queue | The Download row's panel glyph is always present; no count. From Songs and from Record Shop it opens the empty state ("Nothing in the queue"), selection unchanged (`door-1-songs-empty.png`, `door-2-recordshop-empty.png`). |
| Count inside the door | "1 done" after the owned Deluxe Get, "2 done" with the fixture, hidden again after Clear finished (`door-3-count-closed.png`). |
| Refused candidates | Temporary in-memory fixture (an exact-not-found Remain in Light deluxe with two refused candidates pushed into the live queue array; no request made, nothing acquired): row reads Needs a choice · from Alex · edition line · Exact edition not found · Choose edition; Details lists both candidates with reason and provider (`fixture-1-refused-candidates.png`). Cleared afterwards. |
| Snapshot regression | `download-queue-snapshots.test.ts`: queued → downloading → done each reach a subscriber as a new array; cancel mid-flight publishes a new snapshot equal to `getQueue()`. |

## Browse migration acceptance — 2026-09-06 (dev instance, playback idle)

| Check | Result |
|---|---|
| Tab | Record Shop tabs read For You · Browse · Listen List; Browse mounts the Download view in `browse` mode: no page heading, no Qobuz/streamrip chips, no Setup, no queue bar; "Add by link" beside the search field (`browse-1-empty.png`). |
| Search + Get | "Talking Heads Little Creatures" → Top match (owned) + the Deluxe release card; Get on the owned Deluxe → done through the one scheduler, the sidebar door reads "1 done", no queue bar inside Browse (`browse-2-results.png`, `browse-3-got-owned.png`). No import, no rip. |
| Add by link | Opens the paste card retitled "Add by link", no Music Sources panel inside it (`browse-4-add-by-link.png`). |
| Legacy route | Sidebar Download still renders the full page: heading, Qobuz + streamrip chips, Setup, queue bar showing the same done job (`browse-5-legacy-download-route.png`). |
| Tab memory | Leaving Record Shop and returning lands on Browse again. |

Follow-up recorded: prefill from the Counter / Listen List still opens the
legacy Download route; point it at Record Shop → Browse once Browse is verified.

## Choose actions → Record Shop → Browse — 2026-09-06 (dev instance, list fixture)

| Check | Result |
|---|---|
| Listen List → Browse (fresh) | "Tracks" on the fixture Little Creatures jot switched to Browse with "Talking Heads Little Creatures" searched (`route-1-listenlist-to-browse.png`). |
| Exact edition + provenance | Get on the Deluxe release: job key `…littlecreaturesdeluxeversion`, collectionId 124906778, 12 tracks, 2006; origin entryId `fixture-lc-album`, "from Alex"; done with 0 imported · 12 already owned (`route-2-browse-get-provenance.png`). |
| One shared job | Counter row: "12 tracks · 0 imported, 12 already in your library", "All 12 in your library", On your shelf; Listen List released the owned record. |
| Counter → Browse (fresh) | Get on the made-up song → Not found → Choose version → Browse with the song searched, "Nothing matched that." (`route-4-counter-choose-to-browse.png`). |
| Panel → Browse (already mounted) | With Browse showing "XTC Skylarking", Choose version from the Downloads panel replaced the query in the SAME input element (`route-5-panel-choose-mounted.png`). |
| From the legacy route | Choose version while the legacy Download page was mounted landed on Browse with the query; the legacy page did not consume the prefill (`route-6-legacy-route-choose.png`). |

No music acquired; no rip left running. Hub tombstones created by the
fixture's release were removed (see checkpoint).

### Harness isolation re-run (same day, `JT_RECO_FIXTURE`)

| Check | Result |
|---|---|
| Fixture served | Listen List shows the two fixture jots; read meta `backendReachable: true` from the fixture hub. |
| Completion → release | Get on the owned Deluxe completed; the list released the fixture record (count 2 → 1); main log: "1 delete(s) landed on the FIXTURE hub". |
| Explicit toss | The second fixture jot tossed; fixture list empty, fixture outbox empty. |
| Real state untouched | `recommendations.json` / `recommendations-outbox.json` md5 identical before and after; hub list still one item; tombstones still 998 with the same tail. |
| Fixture files | `recommendations.fixture.json` / `recommendations-outbox.fixture.json` created under the state dir, removed after the run. |
