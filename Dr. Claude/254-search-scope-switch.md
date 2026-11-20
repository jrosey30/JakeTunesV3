# Brief 254 — Search: JakeTunes or This page

**Date:** 2026-11-20
**Repo:** JakeTunes V3 (desktop)
**Asked by Jake, 2026-11-20:** "i also want to have better search in terms of a switch thats either all of jaketunes search or library/page search (so like if im on song page, it searches my library). i think they have this in apple music."

## Why

The toolbar search box only ever searches the whole library in a dropdown; it never narrows the page you're on. Albums and Artists each have their own filter box with different rules, Songs and playlists have a page filter (`lib.searchQuery`) that nothing writes any more, and the catalogue search lives three clicks away in the Record Shop. Apple Music puts a two-way switch on its search ("Apple Music | Library"). This brief gives the box the same: **JakeTunes** (everything, as today, plus a jump to the Record Shop) or **This page** (filter the page in place).

## Pre-flight

- Box: `components/playback/SearchPill.tsx` (local query, never writes `lib.searchQuery`); dropdown `SearchPanel.tsx` (library index `utils/searchIndex.ts`, `perSectionCap: 6`, Enter plays the top hit); mounted once in `Toolbar.tsx`.
- Page filter: `lib.searchQuery` / `SET_SEARCH` in `context/LibraryContext.tsx` (DO-NOT-TOUCH). `SET_VIEW` clears it; `VIEW_PLAYLIST`, `VIEW_SMART_PLAYLIST` and the detail actions do not. Readers: Songs (`hooks/useSortedTracks.ts`), Playlist (`PlaylistView.tsx`), Smart playlist (`SmartPlaylistView.tsx`), Albums and Artists (alongside their own boxes), empty states in Genres, CoverFlow, TrackGridView.
- Own boxes: `AlbumsView.tsx` (`albFilter`, name/artist), `ArtistsView.tsx` (`listFilter`, name/genre/family/country). Both pages stay mounted under album/artist pages (`keptView.ts`), so their box survives a trip into a record and back; `lib.searchQuery` would not (Back is a `SET_VIEW`).
- Record Shop search: `views/DownloadStore/DownloadView.tsx` takes a `jaketunes-download-prefill` event (captured at module scope if the view isn't mounted yet) and runs it; `listen-to-the-list/ltlDownload.ts` `openBrowse` asks for the Search tab and opens the shop. The usage log's `shop.search` says `how: typed | list` (`common/shop-funnel.ts`).
- UI prefs: `ui-state.json` through `electronAPI.saveUiState` (main merges a partial: `main/ipc/ui-state-ipc.ts`).
- ⌘F: find bar on Songs/Albums/Artists (`useFindState`), else the box (`App.tsx`). Unchanged.

## Changes

### Phase A — the rules, pure (`utils/searchScope.ts`, node-tested)

1. Pages with a page scope: Songs, Albums, Artists, a playlist, a smart playlist. Everything else: JakeTunes only, switch hidden.
2. Scope = the remembered choice when the page has a scope, else JakeTunes.
3. The page's name on the switch: Songs, Albums, Artists, the playlist's or smart playlist's name, cut to 16 characters with "…"; "Playlist" when it has none.
4. The Record Shop row: `Search the Record Shop for “…”` (query cut to 40), and the prefill it sends (`target: 'browse'`, `how: 'typed'`).
5. A page key (view + playlist id + smart id): the page filter belongs to one page.

### Phase B — the switch

6. Focused on a page with a scope, the box shows a two-way switch: **JakeTunes** | **<page>**. In JakeTunes with words, it heads the dropdown; otherwise it stands alone under the box. Clicking it keeps focus in the box.
7. **This page:** the box filters the page as you type (debounced 120 ms), no dropdown, placeholder "Search <page>". Esc clears it. Moving to another page clears it (the box clears `lib.searchQuery` itself on a page change, so the reducer stays as it is).
8. **Albums and Artists:** one filter. The page's own box and the toolbar box drive the same value (`utils/pageFilter.ts`, a small store per page), so they always show the same words. It lives as long as the page stays mounted, so a trip into an album and back keeps it, as the page box does today. Artists' one filter matches what both used to: name, genre, family, country, album and song titles. Albums': name, artist, any credited artist, song titles.
9. **JakeTunes:** today's dropdown, plus a last row "Search the Record Shop for “…”" (also under "No results"), reachable with ↓ and Enter. It opens the Record Shop on Search and runs the search (`jaketunes-download-prefill` + `openBrowse`). The prefill may say `how: 'typed'`, so the usage log counts it as typed.
10. The choice is remembered in `ui-state.json` as `searchScope` (`jaketunes` | `page`).
11. Fix the stale comment above Songs' ⌘F find state.

## What NOT to change

- `LibraryContext.tsx`, `GenresView.tsx` (both do-not-touch). So **Genres is not offered "This page" here**: it has no page filter today, only an empty state that reads one. Adding one needs Jake's OK to touch the file.
- The library index, its ranking, its cap, what a pick does, Enter-plays-the-top-hit.
- ⌘F, the find bar, `/`, App's Escape.
- The Record Shop's search, its queue and the prefill handling beyond the optional `how`.
- Songs / Playlist / Smart playlist filtering rules (`useSortedTracks`, the views' word match).

## Done when

- `node --test` on the new tests passes, plus the related existing tests (nav-history, shop funnel, anything that pins Albums/Artists/SearchPill source).
- `npx tsc -p tsconfig.web.json --noEmit` and `tsconfig.node.json` are clean (apart from the known qrcode-generator module error from a shared node_modules).
- On a supported page the switch shows and remembers; on Home it doesn't. In This page, Songs narrows as you type and the dropdown never opens; Albums' box and the toolbar box show the same words. In JakeTunes, the last row opens the Record Shop's Search with the words already searched.

## Commit discipline

One branch `feat/search-scope-switch`, one PR, not merged here. No build, no install.

## Out of scope / later

- Genres "This page" (needs a filter in a do-not-touch file).
- A key to flip the switch.
- Record Shop results inline in the dropdown.
