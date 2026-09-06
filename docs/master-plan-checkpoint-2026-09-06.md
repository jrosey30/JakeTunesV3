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

Record Shop step 5 is complete as five slices (labels 6351ed7, Music Sources
93931e9, Downloads panel 5643d10, Browse 818e98f, Choose routing d68d2aa) plus
the isolated acceptance harness (f17970c). Legacy surfaces still standing, on
purpose, until their replacements are verified in Jake's own use: the sidebar
Download route (page mode with its queue bar and Setup drawer), and the
Bandcamp Store sidebar entry (the map keeps it through the transition).
Retiring them is a problem-space audit (CLAUDE.md), not a slice.

Next unfinished item: the **Desktop placement audit** — first pass (the
download flow) written as a document-only slice:
[desktop-placement-audit-2026-09-06.md](desktop-placement-audit-2026-09-06.md);
P1, P3, P4, P5 arbitrated and implemented the same day (see the audit's
"Arbitration and status"): Record Shop under STORE, Downloads = the panel's
row, missing-Qobuz notice, Bandcamp Store stays; parity run in Jake's order on
the isolated harness; Add by link's real-link test waits on Jake's link; the
legacy *Download page* row stays until parity plus everyday-use acceptance.
Then the **Activity Sync front end**, per
[jaketunes-6-plan.md](jaketunes-6-plan.md), on hold until Jake says go.

Follow-ups 4 and 6 above are resolved inside the Downloads panel (Choose
edition/version for refused verdicts; canceled jobs visible) and remain true
of the legacy Download bar only.

Mobile: the Now Playing queue-counter caption (under the album line) is a
separate, uncommitted change in JakeTunesMobile pending Jake's device look.

## Done — step 5, slice 1: literal labels (6351ed7)

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

## Done — step 5, slice 2: Music Sources placement (93931e9)

- New shared panel `components/MusicSourcesPanel.tsx`: the Qobuz account
  (password or token) and the download tool's status, the same markup and
  handlers the Download view's setup drawer had.
- Preferences gains a **Music Sources** tab (after Library) showing the panel,
  with a line pointing catalogue search and paste-a-link to Record Shop →
  Download. The Download drawer keeps "Paste a link" and reuses the same
  panel, so the legacy placement stays until this one is verified.
- Gate: 1,138 tests. Verified on the dev instance: Preferences → Music Sources
  shows "Connected · <account>" and "streamrip 2.1.0 · ready"; the drawer
  shows Paste a link + the two cards; header chips still read from the panel.
  Captures `sources-1-preferences-tab.png`, `sources-2-download-drawer.png`.
  Approved by Jake; committed. Not installed yet.

## Done — step 5, slice 3: the Downloads panel (5643d10)

- `src/common/downloads-panel-model.ts` (pure, tested): each scheduler job →
  one row with status, provenance ("from Alex" / "from your Listen List" /
  "pasted link"), edition identity (`album · 12 tracks · 2006 · iTunes 124906778`),
  counts and completion line for finished jobs, verdict + full explanation +
  refused candidates for failed ones. Actions follow the Counter's rule through
  the same `refusedSelection` projection: Cancel (queued/downloading), Retry
  (provider failure, canceled), **Choose edition / Choose version** for a refused
  verdict (never a repeat of the refused request). Order: in flight, needs a
  decision, canceled, done — newest first within a group.
- `components/DownloadsPanel.tsx` + `styles/downloads-panel.css`: a right-hand
  drawer mounted in App next to the play queue and Music Man (one drawer at a
  time), opened from anywhere by the sidebar Download badge (now a control:
  in-flight count while jobs move, "N done" once settled, absent when the queue
  is empty) or the `jaketunes-downloads-panel` window event. Choose edition /
  version prefill the Download view with the same request and provenance.
  Clear finished drops settled jobs. Details per row.
- Scheduler fix found by the panel: `downloadQueue.emit` now hands out a fresh
  array (jobs are mutated in place), so `useSyncExternalStore` readers — the
  legacy sidebar count included — see queued → downloading → done/canceled.
  Everything else about the scheduler, provenance, identity and completion
  details is untouched; the Download view's own queue bar stays until this
  replacement is verified.
- Gate: 1,144 tests (6 new). Live acceptance on the dev instance, playback idle,
  queue exercised through the real scheduler with an owned album and made-up
  requests that can never acquire anything (no library writes; `rip` never left
  a process behind):
  done (Little Creatures Deluxe, 0 imported · 12 already in your library, edition
  + completion line), downloading with elapsed clock + Cancel, canceled with
  Retry, refused song → Choose version, refused album → Choose edition (with
  provenance "from your Listen List"), Choose version → Download view prefilled,
  badge click over Songs opens the panel without leaving Songs, second click
  closes it, Clear finished empties it and hides the badge. Captures
  `dlp-0-empty.png` … `dlp-8-over-songs.png` in `diagnostics/step-inside-review/`.
- Review round (Jake): the Download row now carries a persistent door to the
  panel (a small panel glyph); only the count inside it hides when the queue is
  empty. The count never calls a failed, refused or canceled job "done": moving
  jobs → "N"; any failed/refused → "N need attention"; canceled among the
  finished → "N finished"; "N done" only when every settled job is. Refused-candidates details verified visually with a temporary
  in-memory queue fixture on the dev instance (an exact-not-found album with two
  refused candidates pushed into the live queue array, no request made, nothing
  acquired). `download-queue-snapshots.test.ts` locks the scheduler snapshot
  fix: every status transition reaches subscribers as a new array.
- Observed today, recorded without attribution: the Listen List's Cups jot
  (D-Stone) is gone; the library holds "Cups (D Stone Edit)" by D Stone,
  imported 2026-09-06 13:21Z (`imported_11732.m4a`, played three times that
  morning), and the hub tombstone `identity:cups|dstone` is the newest entry.
  None of this session's work touched the jot or the track; who acquired it is
  unconfirmed.

## Done — step 5, slice 4: Browse migration

- Record Shop gains a **Browse** tab (For You · Browse · Listen List): the
  Download view mounted in a new `browse` mode — same search, ranking,
  previews, edition cards and the exact-selection Get through the one
  scheduler. Trimmed of what moved: no page heading, no Qobuz/streamrip chips
  or Setup (Preferences → Music Sources), no queue bar (the Downloads panel).
  "Paste a link" survives as **Add by link** beside the search field. Layout
  approved by Jake; empty state reads "Search for songs, albums or artists.
  Preview where available, then choose what to get."; the link card points
  account setup at Preferences → Music Sources. Captures `browse-1…5`.
- The sidebar Download route is the untouched `page` mode; prefill from the
  Counter / Listen List still opens that route until Browse is verified
  (recorded follow-up: point prefill at Record Shop → Browse).

## Done — step 5, slice 5: Choose actions route into Record Shop → Browse

- `views/discoveryTab.ts` remembers the shop tab and lets any view request
  one; `openBrowse(dispatch)` (ltlDownload) = request Browse + SET_VIEW
  discovery. Prefill events now carry `target: 'browse'`; a mounted Download
  view of the other mode ignores them, so the captured prefill reaches Browse
  whether it is already mounted or mounts fresh.
- Routed: Listen List "Tracks" (select-edition) and browse-only Gets, the
  Counter's Get-selection and Choose edition/version, and the Downloads
  panel's Choose edition/version. The sidebar Download route stays.
- Verified on the dev instance with a temporary main-process list fixture
  (two jots served through the read IPC; hook removed before commit) —
  fresh mount from the Listen List, from the Counter and from the legacy
  Download route; already-mounted Browse (same input element, query replaced);
  provenance retained on the job (`entryId`, `sourceLabel: Alex`); exact
  edition selected (iTunes 124906778 · 12 tracks · 2006); one shared job —
  the Counter row showed the Browse-started job's completion and ownership,
  and the Listen List released the owned record. Captures `route-1…6`.
- Side effect found and REVERSED: the first harness run served a fixture list
  through the read IPC only, so the Listen List's release of the owned fixture
  record posted a real delete to the hub, leaving tombstones
  `identity:album:talkingheads~littlecreaturesdeluxeversion` and
  `fixture-lc-album`; both removed from both hub copies (backups
  `.pre-untomb2-20260906`), hub list and tombstone count verified unchanged
  afterwards.
- Acceptance harness, properly isolated (Jake's ask): `src/main/reco-hub.ts`
  is now the ONE hub transport. `JT_RECO_FIXTURE=<seed.json>` in an unpackaged
  build selects an in-memory hub — reads, adds, completion releases and deletes
  all stay inside it, the NAS fallback is closed, and the local cache/outbox
  move to `recommendations.fixture.json` / `recommendations-outbox.fixture.json`.
  Live fulfilment is unchanged (same URLs, methods, identity params).
  `reco-hub.test.ts` locks it, including completion-triggered cleanup never
  touching the network. Re-run of the flow under the harness: release and
  toss landed on the fixture hub (main log), real local files' md5 and the
  hub's list + 998 tombstones unchanged. Launch entry `electron-dev-fixture`
  in ~/.claude/launch.json; no temporary source hooks remain.
