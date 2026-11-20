# Brief 253 — Record Shop, Phase 1: one shop

**Date:** 2026-11-20
**Repo:** JakeTunes V3 (desktop)
**Plan:** Record Shop rework (approved by Jake 2026-11-19, recommended answers; Bandcamp is a tab). Source: `JakeTunesMobile/Dr. Claude/record-shop-rework-plan.html`. This is Phase 1 of 6.

## Why

The STORE section has four rows that lead to three screens and a slide-out panel: Record Shop (the `discovery` view), Bandcamp Store (the `store` view), Downloads (the panel) and the old Download page (the `download` view). The Record Shop's Browse tab *is* the old Download page with its chrome hidden, so the same search and the same queue are reachable two ways, and the page keeps a second queue bar the panel already shows. The same action is called Get, Get all, Tracks, "↓ Get" or "Pick the edition", depending on the screen. "Get all" does nothing, silently, when the album already has a job.

## Pre-flight

- STORE rows: `src/renderer/components/sidebar/Sidebar.tsx` (the `'store'` section).
- Routes: `src/renderer/components/MainContent.tsx` (`'discovery'`, `'store'`, `'download'`, and the back-compat `'listen-to-the-list'` / `'new-for-you'`).
- Tabs: `src/renderer/views/DiscoveryView.tsx`, remembered/requested in `views/discoveryTab.ts`.
- Search: `views/DownloadStore/DownloadView.tsx` (`mode="browse"` in the shop, `mode="page"` on the old route).
- Bandcamp: `views/BandcampStore/StoreView.tsx` (a placeholder rect for main's WebContentsView; hides the native view while an overlay is up).
- Panel: `components/DownloadsPanel.tsx` (opened by `toggleDownloadsPanel`, App owns it).
- Who sends you to Browse: `listen-to-the-list/ltlDownload.ts` (`prefillDownloadView` + `openBrowse`), `NewForYouView`, `ListenToTheListView`, `DownloadsPanel.chooseAgain`. All already address the shop's Browse (`target: 'browse'`); none dispatches `'download'` or `'store'`.
- Page memory: `renderer/nav-history.ts` (`savedLocation`, `restoreActionFor`), App's startup restore, `src/main/__tests__/nav-history.test.ts`.
- Back labels / breadcrumb: `utils/albumBackLabel.ts` (a `Record<ViewName, …>`), `components/chrome/Breadcrumb.tsx`.
- Usage log: `renderer/usageLog.ts` `usage()`, scrubbed by `common/usage-log.ts` (a detail key matching `query|search|…` is dropped whole).
- Dead code to confirm: `views/_archive/BandcampStore-v3/` (no importer), `useShopSession` in `record-shop/useShopSession.ts` (no caller; `useShopList` is used by DiscoveryView), `SHOP_BINS` in `common/record-shop-bins.ts`.

## Changes

### Phase A — one door

1. STORE shows **Record Shop** and **Downloads**. The Bandcamp Store and Download page rows go.
2. The Record Shop has four tabs: **For You**, **Search** (was Browse; tab id stays `browse`), **Listen List**, **Bandcamp** (the existing StoreView, unchanged, mounted only while its tab is on).
3. `'store'` and `'download'` leave `ViewName`. A session saved on either reopens on the Record Shop, on Bandcamp or Search (`savedLocation` + `legacyShopTab`, App's startup restore asks for the tab before it dispatches). Back labels and the breadcrumb lose their entries.

### Phase B — Downloads is the only place for progress

4. `DownloadView` is the shop's search only: the `page` mode, its header, its queue bar, its details list and the Music Sources panel in its drawer go (all unreachable once the route is gone). Each row keeps its own small state (Queued, timer, Cancel, Choose edition…), as the shop's search does today.
5. The Downloads panel can be opened on one entry (`showDownload(key)`): it scrolls to that row and marks it for a moment.

### Phase C — one word per action

6. A song: **Save**. An album: **Save album**. Everywhere in the shop: the search's buttons, the album tracklist's header (was "Get all"), For You's card (was "↓ Get"), the Listen List's row (was "Get" / "Tracks"), the panel's near-edition action and empty line. In-progress words follow: "Getting…" → "Saving…".
7. **Save album never does nothing.** When the album already has a job, it opens the Downloads panel on that job.

### Phase D — dead code

8. Delete `views/_archive/BandcampStore-v3/` and `useShopSession` (+ its private helpers). Keep `useShopList`.
9. `SHOP_BINS` stays: `binForGenre` returns a `ShopBin`, and the critic wall (`common/critic-picks.ts`) files picks with it. It is not dead.

### Phase E — search → save in the usage log

10. One event, `shop.search`, written when a search's results are left (a new search, the box cleared, the tab left, the window closing), carrying how it went: `len` (characters typed, never the words), `hits`, `songs`, `albums`, `ms` (time to answer), `how` (`typed` | `list`), `saves`, `firstSaveMs`, `albumSaves`. A search left within 1.5 s with no save is a keystroke on the way to another one and isn't written. The rules are pure (`common/shop-funnel.ts`), node-tested, and the test runs every event through `scrubEvent` so nothing is dropped as words.

## What NOT to change

- Search ranking, the catalogue calls, the edition picker (tracklist expand + its collection id), the queue (`downloadQueue.ts`) and main's resolve.
- What a save does: the same `enqueue` with the same `QResult`. Listen List rows still route albums to Search to pick an edition (Phase 2 makes that one click).
- The Bandcamp view, its overlay guard and purchase import.
- For You's crates, the Listen List's rows and keys, the panel's rows and actions.
- `listen-to-the-list` / `new-for-you` back-compat routes.

## Done when

- STORE has two rows; the shop has four tabs; Bandcamp works as a tab.
- Nothing references `'download'` or `'store'` as a view; a saved session on either reopens in the shop.
- Every save button in the shop says Save or Save album, and every one goes through `enqueue` into the Downloads panel; Save album on an album with a job opens the panel on it.
- `npm run check` green (both tsconfigs, full suite); nav-history tests updated for the removed views.

## Out of scope (later phases)

Album save without a detour (Phase 2), grouped search (3), edition offers (4), two lanes and a saved queue (5), the phone (6). `record-shop:resolve` (main) is left in place though its only renderer caller was `useShopSession`.
