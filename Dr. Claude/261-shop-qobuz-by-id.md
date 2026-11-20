# Brief 261 — The Record Shop assumes it's on Qobuz

**Date:** 2026-11-20
**Repo:** JakeTunes V3 (desktop)
**Branch:** `feat/shop-qobuz-by-id` (from `origin/main` 39cc5f26: Record Shop Phases 1–5 and offers, Briefs 253–258)

Jake: "i want the store to become better at assuming what is on qobuz. theoretically an album or song is there. i press download song or album and the button somehow does what the download by link does in the downloader today."

## Why

- Download by link (`streamrip:download` / `streamrip:download-id`) runs `rip id qobuz <type> <id>` and imports. No search, no guessing.
- A shop Save runs the walk (`streamrip:download-by-query`): `rip search`, rank, up to 25 metadata calls, MusicBrainz, then up to three candidate downloads that get judged, then the album door, Bandcamp and SoundCloud. Its budget is 12 minutes for a song, more for an album.
- The shop already found the right Qobuz listing before the click: the lossless dot (`shop-qobuz-lossless`, Brief 256) and the album preflight (`check-qobuz-album`, Brief 255). Neither kept the id, so the download searched again.

## Measured first (read-only, 2026-11-20, Jake's own library)

30 songs and 30 albums sampled at random from `library.json` (live albums left out). Deezer and Qobuz were asked with the app's own Qobuz login. The token was never printed.

| Songs (30) | |
|---|---|
| Deezer matched the row (title, artist, length within 3 s) | 21 |
| …and gave an ISRC | 21 |
| Qobuz `catalog/search?query=<ISRC>` finds that ISRC | 20 of 21 |
| Qobuz `track/search?query=<ISRC>` finds it | 20 of 21 (9 with more than one id: compilations, reissues) |
| The row's words find an exact title + artist | 23 (only 7 with exactly one hit) |

| Albums (30 + 30, two samples) | |
|---|---|
| Deezer gave a UPC | 26, 29 |
| Qobuz `album/get?album_id=<UPC>` (first sample of 20) | 4 of 18 |
| Qobuz `catalog/search` / `album/search` by UPC (first sample) | 1 of 18 |
| The UPC is among the exact-name album hits of a words search | 18, 19 |
| Exactly one exact-name hit with the edition's size | 20, 20 |

So: **an ISRC search works on Qobuz; a UPC search does not.** A barcode is useful only to pick among the album hits a words search already returns.

## What was built

### 1. Resolving a row to a Qobuz id, in the background

`src/common/shop-qobuz-id.ts` (pure, the rules) — `resolvePlan(row, hits, { isrc?, upc? })`:

- **A song:** same title and artist (the dot's matching), the same length within 3 s or the same ISRC, the explicit rule, and on the row's own album. A copy on another album or on a compilation is no plan, so Brief 231's real-album rules stay with the walk. Several copies left are the same recording on the same album: the hi-res one. Apple's **cleaned** row is never a plan, because its length is the clean edit's.
- **An album:** same name and artist, the explicit rule, and the edition's size (`tracks_count`). The UPC picks among the editions still standing, and **never overrules the size**: a barcode Deezer matched to a Deluxe is a Deluxe. Two editions left with no barcode to choose is no plan. A row with no size is no plan.
- **The explicit rule** (as the walk's `judgeHitsByMeta`): an explicit row, or Apple's cleaned edition of an explicit record, takes only a copy Qobuz flags explicit. Any other row takes the explicit copy when there is one among the matches.
- No plan shows nothing and Save walks as today. Nothing here ever says "no".

Where the evidence comes from:

- **(a) The page's own answer.** `qobuzHitsOf` now keeps `id`, `explicit` (parental_warning), `durationSec`, `album`, `albumArtist`, `isrc` on tracks and `upc`, `tracksCount` on albums. The renderer resolves a row against the page's hits synchronously, so this asks nothing new.
- **(b) Main, `shop-qobuz-resolve`**, only for rows that were drawn and that (a) didn't settle, in batches of at most 20, two at a time:
  - a song: the row's own words on Qobuz (the dot's cache), then Deezer search → track → ISRC → Qobuz `catalog/search?query=<ISRC>` → the same rules → Qobuz `track/get` must carry that very ISRC;
  - an album: the row's words on Qobuz, then (only if several editions stand) Deezer album → UPC → the rules.
  - Deezer is asked at most 45 times in any 5 s (`createRateWindow`; its limit is 50). Answers, including "no plan", are kept 6 hours. A question with no answer is left alone 10 minutes. Nothing is logged: no titles, never the token.
- **(c) The album preflight.** `judgeQobuzAlbum`'s "found" now carries the id of the listing that passed (`{ answer: 'found', id }`). That listing was already held to the edition.

### 2. Carrying the id

- `QobuzHit.id`, `AlbumPreflight` `found.id`.
- `downloadQueue.ts` `qobuzPlanOf(job)`: an album found by its preflight goes by that id (`how: 'preflight'`). Otherwise the plan the shop resolved for the row is used. Never for a source edition (Compare editions) or a lossy pick. The pump sends `qobuz: { id, how }` with `streamripDownloadByQuery`.

### 3. The by-id download, and the fallback

`streamrip-store/index.ts`: the handler body is now `downloadByQuery(opts)`. With a valid plan (`isQobuzId`, a known `how`):

- No `rip search`. The walk's own preparation still runs: Apple's length when needed, MusicBrainz's real album for a song, Apple's tracklist and the library-ownership check for an album.
- **Album:** `album/get` for the id → the explicit rule → `verifyAlbumCandidate` on the listing **before** a byte moves → `rip id qobuz album <id>` → `verifyAlbumCandidate` on the staged files → `finishAlbum` (the walk's own import and completion accounting).
- **Song:** a row with no clock walks (`no-clock`) → `track/get` → `judgeHitsByMeta` (the right recording, the explicit flag) → the explicit rule → not a compilation → on the wanted album → `rip id qobuz track <id>` → `judgeStaged` on the file (exact and on the album) → import.
- **Any check failing:** the staged files go, the landing count resets, and the walk runs exactly as before (`downloadByQuery({ ...opts, qobuz: undefined })`) with its own budget. There is no second click. The answer says `via: 'walk'`, the plan's `how`, and `fellBack` (gone, no-answer, explicit, listing, no-clock, wrong-recording, other-album, compilation, stage, judge).
- Unchanged: one job per lane (Phase 5: the job, its cancel and its staging folders are the same job's), Needs-you offers (the preflight still runs first and still ends a "no"), the not-found memory (checked before the pump, and noted on the walk's end), shelf saves (`markShelfSave` at the top; the by-id import goes through `importStaged`, which joins the shelf list).

### 4. The shop shows it

`DownloadView` (song and album rows) and `ShopAlbumPage` (the album and each song): where the page's answer drew no dot but a sure plan exists, the same dot shows, titled "On Qobuz" (or "On Qobuz in hi-res"). The album page's header reads "On Qobuz". Drawing a row is what asks for its plan, so only rows on screen are resolved.

### 5. Usage log

One `shop.download-path` line per shop job, at its end: `{ lane, via: id | walk, how?, fell? }`, ok, and ms. Only fixed words, no title and no id (usage-log.ts's no-words rule). This is the by-id vs walk counter.

## Measured after (the same 30 songs and 30 albums)

Measured with the real rules and the real pre-download checks: `judgeHitsByMeta`, `isCompilationCopy` and `onWantedAlbum` on Qobuz's own `track/get` for songs, and `verifyAlbumCandidate` on Qobuz's own `album/get` for albums. The album's request was built from the library's own tracklist, in place of Apple's. It was a one-off script, not in the repo.

| | plan | by | passes the pre-download checks |
|---|---|---|---|
| Songs | 21 of 30 | 20 from the row's words, 1 from the ISRC | 21 of 21 |
| Albums | 24 of 30 | 24 from the words (one edition of that size); the UPC added none | 20 of 24 (2 disc layout, 2 tracklist: those walk) |

A song's plan took a median of 0.6 s to resolve, in the background. In use, most album saves get their id from the preflight, which has already held the listing to Apple's edition.

**Time saved.** A by-id save skips `rip search` (about 2 s, measured), the up-to-25 metadata calls and the artist-alias lookup. Most of all it skips every candidate that would have downloaded and then been refused (a full rip each, minutes for an album), plus the album door's searches. When the walk's first candidate was already right, the saving is only those few seconds. When the walk would have refused one to three candidates first, the saving is one to three whole downloads. A plan the checks refuse costs one `track/get` / `album/get` (under a second) before the walk, or one rip when only the downloaded file shows the problem.

## What-NOT-changed

- The walk itself, the judge, the album identity contract, the explicit gates: untouched. By id runs them on one item instead of several.
- `streamrip:download` / `download-id` (the Download view's link and pick): untouched.
- The preflight's "no" and its offers: untouched. Only "found" carries an id.

## Tests

- `src/main/__tests__/shop-qobuz-id.test.ts`: resolution rules, including a wrong edition by UPC refused, a compilation ISRC preferring the real album, explicit / clean / Apple's cleaned row, near titles, twin ids. Also the parse of Qobuz's answer, the IPC row's shape, Deezer's pick, the rate window and the usage line.
- `src/main/__tests__/streamrip-by-id.test.ts`: the real handler with a fake `rip` and fake Qobuz and Apple answers. By id, a song and an album import with no `rip search`. Each check (wrong recording by Qobuz's length, explicit, compilation, a file that fails the judge, a 404 id, no clock, the listing of another edition, an explicit record with a clean listing) walks instead, nothing is imported by id, and staging is left empty. Mutation-checked: removing the listing check or the compilation check fails it.
- `album-save-queue.test.ts`: the preflight's id and a resolved plan reach main, a lossy pick never goes by id, one `shop.download-path` line per job with no words.
- `album-preflight.test.ts`: "found" now names the listing.
