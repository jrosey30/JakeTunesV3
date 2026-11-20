# Brief 255 — Record Shop, Phase 2: albums save in one click, and "no" comes fast

**Date:** 2026-11-20
**Repo:** JakeTunes V3 (desktop)
**Plan:** Record Shop rework, Phase 2 of 6 (`JakeTunesMobile/Dr. Claude/record-shop-rework-plan.html`). Phase 1 was Brief 253 (#451).
**Scope addition (Jake, 2026-11-20):** "one click album saves or making it easier to see album tracklists and saving only a few songs from the album if i want".

## Why

- An album on For You or the Listen List could not be saved from where it was. Save album prefilled Search, ran the search again, opened the tracklist, and Jake pressed Save album a second time (`ltlDownload.ts` `select-edition` → `prefillDownloadView` + `openBrowse`).
- A refusal took minutes. The month's logs: ~22 album saves imported nothing because the exact edition wasn't on Qobuz; Kurt Vile's "Philadelphia's been good to me" took 250 s, Manning Fireworks 15 min twice. Most of that time was the walk staging a whole album (Qobuz, then a Bandcamp page) before refusing it.
- Seeing an album's songs, and taking only a few, meant the Search tab.

## Pre-flight (the seams, at `origin/main` e1f6591e)

- Album door of the walk: `src/main/streamrip-store/index.ts` `streamrip:download-by-query` (742). Qobuz album search + bare retry (≈770-781), `rankWithArtistAliases` (≈800), the album identity request (`buildRequestedAlbum`, ≈960-976; `itunesFindAlbum` when there is no collection id), ownership (≈980), the metadata probe of the top six (≈885), explicit gate / explicit-first (≈925-940, ≈1082-1094), the pre-stage listing check of the first three (`verifyAlbumCandidate`, 1127), then staging, then Bandcamp (`bandcampSearch(query, 'a')`, 1263; `bcNamed` / `bcPicks`).
- Listing fetch: `qobuzAlbumTrackList` (632) — `album/get` with per-track `streamable`.
- Rules: `src/main/album-identity.ts` `verifyAlbumCandidate` (296-385), `buildRequestedAlbum`.
- Apple: `src/main/download-search.ts` `itunesFindAlbum` (576, unique-or-nothing), `itunesAlbumTracks`. Apple's album **search** leaves explicit editions out; the artist's own album list (`lookup?id=<artist>&entity=album`) has them (as `fetchExplicitAlbumMap` already does).
- Queue: `src/renderer/views/DownloadStore/downloadQueue.ts` `enqueue` (173), `pump` (317): one job at a time.
- Rows: `src/renderer/listen-to-the-list/ltlDownload.ts` `recoToQueueResult` (80) answers `select-edition` for an album; `NewForYouView.tsx` `getReco` / `shopCard`; `ListenToTheListView.tsx` `getReco` / album row button; `DownloadView.tsx` `startGet`, `renderRelease` (inline tracklist), `renderAlbumTrack`.
- Panel: `src/common/downloads-panel-model.ts` reads `primary` / `detail` / `outcome` / `alternatives`; `refusedSelection` makes `not-found` / `exact-not-found` a refusal with Choose edition.
- Usage log: `common/usage-log.ts` (`LYRIC_KEY` drops word keys), Brief 253's `shop.search` (`common/shop-funnel.ts`).
- Artist pages: `components/artist/MoreFromList.tsx` rows play owned songs only; there is no get action on them, so nothing to change there.
- Measured on real Qobuz before writing (no download): Manning Fireworks and Philadelphia list every track **streamable**. Their refusals were transfers that came back short ("only 6 of 9 tracks arrived", a 0-byte stub), not a catalogue gap. A listing question cannot predict those; Phase 4/5 territory.

## Changes

### Phase A — the fast answer (main)

1. `check-qobuz-album` (streamrip-store): the walk's own steps up to the first byte, and no further — the same Qobuz album search (and bare retry), the same ranking and aliases, the same requested edition (`buildRequestedAlbum`, `itunesFindAlbum` when no id), ownership, the top six listings. The verdict is `album-preflight.ts judgeQobuzAlbum` (pure): the walk's explicit gate / explicit-first, its first three candidates, `verifyAlbumCandidate` unchanged. Answers:
   - `found` (a listing is this edition, every song streamable; or unverifiable, which the walk would stage; or the library has it all),
   - `no`: `not-on-qobuz`, `partial` (the edition with songs Qobuz can't stream, or a smaller edition holding at least half of this one's songs and nothing else), `edition-differs` (labelled other edition, other count, or a same-size copy whose songs don't line up), `clean-only`,
   - `unknown` (no login, Qobuz didn't answer a search or a considered listing, over 20 s, an error, the walk would reach candidates past the six, or a Bandcamp page the walk would stage).
2. A Qobuz "no" is checked against Bandcamp the walk's way (asked in parallel at the start): if the walk would stage a Bandcamp page, the answer is `unknown` and the walk runs exactly as today. A Bandcamp bot check stands as no pages, as in the walk.
3. `qobuzAlbumTrackList` takes an optional `heard` out-param (answered / Qobuz's 404). The walk passes nothing. Nothing else in the walk changes.
4. One log line per question: `[preflight] album “…” — …: no (partial 6/9) in 2600 ms`. Never the token.

### Phase B — the queue

5. An album query job asks the moment it is queued (and on every re-arm), beside the download in flight. A "no" ends it with `preflightVerdict` (outcome `not-found` / `exact-not-found`, one plain `primary`, a plain `detail`, the judged listings as `alternatives`, so Compare editions still works). `found` / `unknown` leave it queued; `pump` waits for an album's answer before starting it, then runs the walk unchanged. A preflight that throws or never answers (25 s) is `unknown`. Songs never ask. One at a time stays.

### Phase C — one click, the edition on the card

6. `list-album-editions` (`download-search.ts itunesAlbumEditions` + pure `album-editions.ts chooseAlbumEditions`): Apple's real editions of the record (the artist's, the base title, no recording version the row didn't ask for; clean edits dropped where the explicit one exists). The default carries the row's own labels, then the exact name, then no remaster stamp, then the earliest. Nothing carries the row's labels: nothing chosen, and the job goes by name as before.
7. For You (once on the list) and Listen List album rows: Save album saves at once (`saveRecoAlbum`), the job built as the Search tab's album save of that edition (`albumJobFor`). An "Edition" menu shows when there are two or more editions ("Deluxe Edition · 19 songs"); its last entry, "Other editions in Search…", is the full picker. A job already running or done opens Downloads on it. Concert rows keep the Search path.

### Phase D — the songs, and a few of them (scope addition)

8. A "Songs" button on every For You album card and Listen List album row opens the edition's tracklist in place (a small sheet, Esc closes). Tick songs, "Save N songs": each is the Search tab's song save of that edition's row (title, album, length pin the recording). "In your library" songs can't be ticked; songs already on their way show their state. "Save album" sits beside it. A Listen List row's sender rides on the songs, not the row: a few songs don't fulfil the album jot.
9. The Search tab's inline tracklist gets the same ticks and a "Save N songs" button in its header, beside Save album.

### Phase E — usage log

10. `shop.album-save`, one per album save, at its first answer: `ms` click → answer; `answer` found | no (preflight) or done | failed (the walk, when the preflight couldn't tell); `why`, `surface` (search | for-you | listen-list), `edition` (card | resolved | picked | none), `have` / `of`. No words; the test runs it through `scrubEvent`.

## Words added

Panel / card lines: "Not on Qobuz" · "Not on Qobuz yet" · "Qobuz has 6 of 9 songs" · "Only the Deluxe is on Qobuz" (also "the clean edition", "the live version", "the anniversary edition"…) · "Qobuz has a 15-song edition, not this one" · "Qobuz has a different edition" · "Qobuz’s copy differs from this edition". Details: "Qobuz doesn’t have this album. Nothing was downloaded." and the like. Controls: "Edition", "Other editions in Search…", "Choose…", "Songs", "Save N songs" / "Save songs", "Loading songs…", "Couldn’t load the songs.", "In your library", "Queued", "Saving…", "Saved", "Didn’t save". Tooltips: "Save the album", "See the songs and pick a few", "Which edition Save album takes".

## What NOT to change

- The walk: single-song behaviour, the album identity rules, the explicit-edition rules, Bandcamp staging after a Qobuz miss, the queue's one-at-a-time order.
- Bandcamp purchase import.
- `recoToQueueResult` (still `select-edition` for albums; the views act on it), bulk queue counts.

## Done when

- Save album on For You / Listen List / Search queues the album with no screen change; the Edition menu changes what is saved.
- A "no" shows in Downloads within ~20 s (measured ~2.5-3.7 s), with one plain line, and nothing downloads.
- A broken or slow preflight never blocks a download.
- Songs open in place; ticked songs save as songs; owned songs are left alone.
- `npm run check` green.

## Out of scope

One-tap offers after a no (Phase 4), lanes and a saved queue (5), the phone (6). Short transfers (a Qobuz album that lists every song but arrives short) still take the walk's time; that needs a missing-songs retry, not a question.
