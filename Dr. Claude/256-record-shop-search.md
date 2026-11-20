# Brief 256 — Record Shop, Phase 3: search that finds things

**Date:** 2026-11-20
**Repo:** JakeTunes V3 (desktop)
**Plan:** Record Shop rework, Phase 3 of 6 (`JakeTunesMobile/Dr. Claude/record-shop-rework-plan.html`). Phase 1 was Brief 253, Phase 2 Brief 255; Brief 254 (the toolbar's search switch) sends typed words here.

## Why

- Typing an artist gave a "Top match" and a shelf of albums **built from the songs that matched**, so an album with no matching song never showed, and an artist was never a result at all.
- There was no artist page and no album page in the shop: an album's songs opened inline under its card, and an artist's records were whatever the song search happened to return.
- Nothing said what Jake already had beyond an exact-name "In library", nothing said what was on his list, and nothing said whether Qobuz could deliver a record in lossless before he clicked.

## Pre-flight (the seams, at `origin/main` ebe16555)

- Search tab: `src/renderer/views/DownloadStore/DownloadView.tsx` — `runSearch` (`searchItunes` → `streamripSearch` fallback), the `ranked` memo (songs; albums derived from song hits; the hero), `renderRelease` with the inline tracklist + ticks (Brief 255), `renderHero`, `startGet` / `saveAlbum`, the prefill (`jaketunes-download-prefill`, `pendingExpandRef` opening an album), the funnel (`common/shop-funnel.ts`).
- Apple: `src/main/download-search.ts` — `searchItunesSuggestions` (song search + the artist-catalogue upgrade, its own `entity=musicArtist&limit=3` question), `fetchExplicitAlbumMap` / `resolveExplicitEdition` (the explicit rescue), `itunesAlbumTracks`, `itunesAlbumEditions`. IPC shims in `main/ipc/album-info-ipc.ts`.
- Apple's limits: ~330 searches and the home IP gets 403s; bursts come back empty. The song search already retries once after 400 ms.
- Qobuz: `src/main/streamrip-store/index.ts` — `readQobuzCreds`, `qobuzGet` (token in a header, never logged, no redirects), `searchCatalog` (the streamrip CLI, 5-15 s, used by the walk and the preflight).
- Editions: `views/DownloadStore/albumEditions.ts` (`loadEditions`, `albumJobFor`, `songJobsFor`, `saveSongsLabel`), `EditionMenu.tsx`, `AlbumTracklistSheet.tsx`; `common/album-preflight.ts` (`editionOptionLabel`, `AlbumSaveSurface`).
- Library search: `renderer/utils/searchIndex.ts` (`buildIndex`, `search`).
- Listen List: `listen-to-the-list/store.ts` (`getRecsCache`), `electronAPI.loadRecommendations` / `onRecommendationsUpdated`.
- Rails that read DownloadView's source: `structural-rails.test.ts` (the clean flag on an album track's save), `search-scope.test.ts` (prefill `how`).
- Measured before writing (one call, Jake's token, nothing printed but shapes): Qobuz `catalog/search?query=pink floyd&limit=50` answers albums + tracks with `streamable`, `hires_streamable`, `maximum_bit_depth`, `version`; 50 albums and 50 tracks in one call.

## Changes

### Phase A — the grouped answer (main, `main/shop-search.ts`; rules pure in `common/shop-search.ts`)

1. `shop-search` (IPC): one search asks Apple three things at once — the song search unchanged (`searchItunesSuggestions`), artists (`entity=musicArtist&limit=3`, the same question the song search's artist upgrade asks) and **albums searched directly** (`entity=album&limit=50`). A cleaned album row is repointed at its uncensored edition the song rows' way (`fetchExplicitAlbumMap` + `resolveExplicitEdition`).
2. `rankShop` (pure): an artist whose name **is** the words comes first (folded, "the" aside); other artists only when their name matches; at most 4. Albums by title + artist relevance; when the first artist is the words, that artist's own records come first, then an album before an EP before a single, Apple's order breaking ties; clean twins collapse to the explicit edition (`explicitWins`); karaoke/tribute acts dropped (`JUNK_ARTIST_NAME`); at most 30.
3. Apple is asked less, never more than before per new search: a whole answer is kept 10 minutes per folded query, every Apple question this module asks is kept 10 minutes (`appleJson`), two callers asking the same thing share one request, and a question that got no answer is left alone for 3 s. A throttled half answer is never kept. When the album search didn't answer (`albumsOk: false`), the screen builds albums from the song hits exactly as before.
4. `shop-artist-releases` (IPC): one `lookup?id=<artist>&entity=album&limit=200`, kept 10 minutes. `artistReleases` (pure): the artist's own records only (guest spots and compilations out), one row per record, **Albums / EPs / Singles, newest first**.
5. `releaseKind` (moved to `common/shop-search.ts`, re-exported by DownloadView): Apple's " - EP" / " - Single" stamp, else one track is a single, **else an album**. The old 2-6-tracks-is-an-EP rule filed Meddle, Animals and Wish You Were Here under EPs.

### Phase B — the screens (renderer)

6. The Search tab shows, in order: **In your library** (Jake's own matches from `searchIndex`, whole-word or better, at most 6, artists then albums then songs; clicking opens it in the library), **Artists** (round cards, an album cover as the picture since Apple gives artists none), **Albums** (the cover cards, Save album on each), **Songs** (the rows, Save on each). The "Top match" hero is gone.
7. **Artist page** inside the shop (`ShopArtistPage.tsx`): Albums / EPs / Singles, each a card with Save album, owned marked. Opened by clicking an artist. Two clicks from saved: the artist, then Save album.
8. **Album page** inside the shop (`ShopAlbumPage.tsx`): the clicked edition's tracklist, an Edition menu (Apple's editions via `loadEditions`, with the clicked edition always among them, `editionsWithCard`), Save album (`albumJobFor`, edition from the card or picked), Save on each song, and ticks + "Save N songs" (`songJobsFor`, Brief 255's few-songs save). Opened by clicking an album card; the Listen List / For You prefill now opens the album page instead of the inline tracklist. The inline tracklist under a card is gone (the page replaces it).
9. A page stack over the results: Back pops one ("‹ Results", "‹ Pink Floyd"). A new search closes the pages; the same words searched again on coming back to the tab keep them (`pageCache`).
10. Every save goes through DownloadView's `startGet` / `saveAlbum`: the same queue (one at a time), Phase 2's album preflight, the credential notice, the funnel; Save album on a record with a job opens Downloads on it. `startGet` keeps an album page's `editionFrom` ('picked') instead of overwriting it.

### Phase C — marks

11. "In your library" (`libraryMarks` / `ownedAlbum` / `ownsSong` / `ownsArtist`): a record matches by its exact name or its plain title ("Wish You Were Here (2011 Remaster)" finds Jake's "Wish You Were Here"), and says **"N songs in your library"** when he has fewer songs than it holds. "On your list" (`listMarks`): unfulfilled Listen List rows, songs by title + artist, albums by (plain) title + artist, artists by name; concerts and playlists never mark. The library wins when both apply (`markLine`). The list is read from its session cache, loaded once if the shop opens first, and again on `recommendations-updated`.

### Phase D — the lossless dot

12. `shop-qobuz-lossless` (IPC, streamrip-store): **one** Qobuz `catalog/search` per page (the search's words, the artist's name with limit 100, or "artist + album"), never one per row. Two in flight at most (`createLimiter`), an answer kept 30 minutes, a failed one left alone for a minute (`createAnswerCache`), in main and again in the renderer (`shopLossless.ts`). The token stays in main (`qobuzGet`); the renderer gets titles and artists. Nothing is logged.
13. `losslessOf` (pure): a green dot (gold for hi-res) only when a **streamable** Qobuz item has this exact title (Apple's " - Single"/" - EP" aside; Qobuz's title with or without its version) by the same artist. Anything else shows nothing: Qobuz's search is a page of the catalogue, so "not in the answer" is "don't know", never "no".

### Phase E — usage log

14. `shop.search` carries `artists` (how many artist cards). `shop.page` (`page: artist | album`, `depth`) when a page opens. No words: both pass `scrubEvent` (tested).

## Words added

Section heads: "In your library", "Artists", "Albums" (was "Releases"), "Songs". Marks: "In your library", "N songs in your library", "On your list". Pages: "Artist", "Album", "EP", "Single", "‹ Results", "Loading releases…", "Couldn’t load this artist’s records.", "No records listed for this artist.", "Loading songs…", "Couldn’t load the songs.", "Couldn’t find this edition. Search it by name to pick one.", "See songs" (card hover, was "See tracks"). Dot tooltips: "On Qobuz in lossless", "On Qobuz in hi-res"; on the album page "Lossless" / "Hi-res".

## What NOT to change

- The walk, the album preflight, the identity and explicit rules, the queue's one-at-a-time order, what a save sends (`albumQ`, `songQ`, `albumJobFor`, `songJobsFor`).
- `searchItunesSuggestions`, `fetchExplicitAlbumMap` and the other Apple helpers (called, not edited; their tests mock `fetch` call by call, so no cache was put inside them).
- Bandcamp: no Bandcamp search here (its search is a bot check to Node); the Bandcamp tab is unchanged.
- The Qobuz CLI search, the token handling, the Downloads panel, For You and the Listen List's own buttons (their Songs sheet and Edition menu stay as Brief 255 built them).

## Done when

- "Pink Floyd" shows the artist first, then the albums, then the songs, with Jake's own Pink Floyd above them.
- Any artist or album Jake can name is two clicks from saved: artist → Save album on its page, or Save album on the album card.
- Every result wears "In your library" / "On your list" where true; a dot shows only where Qobuz's one answer names the record.
- `node --test` on `shop-search.test.ts` and the related suites passes; both tsconfigs clean (apart from the known qrcode-generator error).

## Commit discipline

Branch `feat/record-shop-search`, one PR, not merged here. No build, no install.

## Out of scope (later)

- A Qobuz dot for a remastered name Apple lists plainly ("The Wall" vs Qobuz's "The Wall (Remastered 2011 Version)"): no dot today, never a false one. Matching across edition stamps needs the identity rules, Phase 4's ground.
- One-tap offers after a no (Phase 4), lanes and a saved queue (5), the phone (6).
- Artist pictures (Apple has none; an album cover stands in).
