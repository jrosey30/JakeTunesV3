# Brief 257 — Record Shop, Phase 4: when the exact edition isn't there

**Date:** 2026-11-20
**Repo:** JakeTunes V3 (desktop)
**Plan:** Record Shop rework, Phase 4 of 6 (`JakeTunesMobile/Dr. Claude/record-shop-rework-plan.html`). Phase 2 was Brief 255 (#454); Phase 3 (search, Brief 256) is built beside this one and touches none of the same code.
**Jake's decisions (2026-11-19, the plan's recommendations):** when his edition isn't there, the shop **asks** with one tap ("Save the Standard instead?") and never takes the closest silently. Part of an album is saved **only** when he taps "Save the 6 that exist".

## Why

- About 22 album saves last month imported nothing because the exact edition wasn't on Qobuz (main.log, Oct 20 – Nov 19: 22 "EXACT EDITION NOT FOUND", plus Manning Fireworks and Hullabaloo given up after 15–17 min). Phase 2 made the "no" fast; it still left nothing to save.
- Most of those were a bigger or smaller edition of the same record (31 vs 19 songs, 15 vs 14, 21 vs 17), or a transfer that came back short ("only 11 of 12 tracks arrived").
- Save all on the Listen List asked Qobuz, Bandcamp and SoundCloud for the same missing songs every time.
- A Bandcamp copy (128 kbps MP3) came in with nothing saying it was lossy until it was in the library.

## Pre-flight (the seams, at `origin/main` ebe16555)

- Preflight: `streamrip-store/index.ts` `check-qobuz-album`; verdict `main/album-preflight.ts` `judgeHeardListings` / `judgeQobuzAlbum`; shape and words `common/album-preflight.ts`.
- Rules (unchanged): `album-identity.ts` `verifyAlbumCandidate`, `buildRequestedAlbum`, `matchLibraryOwnership`; `streamrip-match.ts` `titleReads`.
- Apple: `download-search.ts` `itunesAlbumEditions` (drops clean edits where the explicit one exists), `itunesAlbumTracks`; `album-editions.ts` `editionLabelOf`.
- Queue: `renderer/views/DownloadStore/downloadQueue.ts` (`askPreflight`, `pump`, `retry`); jobs `albumEditions.ts` `albumJobFor`; groups (`QueueGroup`) fold song jobs under an album in the panel.
- Panel: `common/downloads-panel-model.ts`, `components/DownloadsPanel.tsx`. Rows: `ListenToTheListView.tsx` (album row), `NewForYouView.tsx` (`shopCard`), `ltlDownload.ts` `projectRecoStatus`.
- Listen List write path: `electronAPI.addRecommendation` (`recommendations-ipc.ts` `addRecommendationCore`).

## Changes

### Phase A — the offers (main)

1. When the preflight says no, `closest-edition-live.ts findOffers` gathers, within what's left of the 20 s budget (at most 8 s): Apple's editions of the record (the clean ones kept), the tracklists of those the size of a Qobuz listing of the record (at most 4), and the library. Too slow: the offers that need no Apple (the songs, the lossy copy) still come.
2. `closest-edition.ts` (pure) chooses:
   - **edition** — an Apple edition (never the asked one) that a Qobuz listing IS by `verifyAlbumCandidate`, unchanged, explicit rules included. Nearest: most of the asked songs, then fewest missing, fewest added, nearest size, same packaging words, earliest. For an explicit row, the clean edition only when nothing explicit is there, flagged `clean` so the words say so.
   - **songs** — the asked edition's songs that a same-record Qobuz listing holds (same title, same length within the contract's 20 s); owned songs left out; for an explicit row a listing Qobuz marks clean is never used. The rest are `missing`.
   - **bandcamp** — the page the walk would have staged after a Qobuz miss. It used to make the answer "unknown" and the walk took the MP3; it is now an offer, labelled lossy.
3. The "no" carries `offers`, `asked` (the packaging word, "Standard" otherwise) and `askedCount`. The log line names the offer kinds, never the token.

### Phase B — taking one (renderer)

4. `shopOffers.ts takeOffer`, only from a button:
   - edition → `albumJobFor` of that edition (its own preflight, the walk unchanged), with the row's origin: Jake chose this edition for that jot. Its key never equals the refused job's.
   - songs → one song save per song, pinned to the asked edition's own row (title, album, length), folded under the refused album (`origin.group`), carrying no recommendation id; the missing songs go on the Listen List as song rows (`kind: 'track'`, note "Not on Qobuz yet").
   - bandcamp → the same job again with `lossyOk` (no preflight; the walk runs as it always has).
   - songs-each → for an album the walk refused or gave up on because fewer songs arrived than listed: its songs one at a time, loaded from Apple at the tap.
5. `markOfferTaken` marks the refused row ("Saving the songs that exist"); a second tap does nothing. The Listen List row follows the newest job carrying it (`projectRecoStatus`, `itemForRecommendation`).
6. `OfferButtons.tsx` shows the question and one button per offer in Downloads, on the Listen List row and (compact) on the For You card. "Choose edition" stays, no longer the orange button when there's an offer.

### Phase C — the not-found memory

7. `common/not-found-memory.ts` (pure) + `main/not-found-memory-store.ts` (`shop-not-found.json` in the app data dir, temp + rename, pruned to a week and 400 rows). Songs only: an album's no comes from the preflight in seconds.
8. A NEW song job (a Save all, a Save after a restart) whose exact request (artist, title, album, length, explicit/clean) was found nowhere in the last week is answered at once: "Not found 3 days ago", with Retry. Re-arming a job (Retry, Save on a failed row) is a manual retry: the key is forgotten and the walk asks. Remembered only for not-found / exact-not-found with every lane asked; never provider trouble, a cancel, or "wasn't searched". A save forgets the key.

### Phase D — lossy, said

9. The Bandcamp offer says "as a lossy MP3" and its button "Save the MP3 (lossy)". A finished save whose match came from Bandcamp or SoundCloud shows "Lossy MP3 from Bandcamp" in Downloads.

### Phase E — usage log

10. `shop.offer` when an offer is taken: `offer` (kind), `have` / `missing` / `of`, `clean`. `shop.album-save` gains `offer` ("edition+songs") on a no. No words.

## Words added

"The Deluxe isn’t on Qobuz. The Standard (11 songs) is. Save that?" · "The explicit edition isn’t on Qobuz. The clean edition (14 songs) is. Save that?" · "The Expanded edition isn’t on Qobuz. The clean 9-song edition (9 songs) is." · "Qobuz has 6 of 9 songs. Save those 6 and keep the other 3 on your Listen List?" · "Qobuz has all 19 songs, on a 31-song edition. Save those 19?" · "Only Bandcamp has it, as a lossy MP3. Save that?" · "Try its songs one at a time?". Buttons: "Save the Standard", "Save the 12-song one", "Save the clean one", "Save the 6 that exist", "Save the 19 songs", "Save the MP3 (lossy)", "Save the 12 songs one by one". Tooltips: the differences ("Without “A” and “B” · 8 more songs · “C” runs 0:40 longer"), "On your Listen List: …", "A 128 kbps MP3 from Bandcamp, not CD quality". Taken: "Saving the other edition instead", "Saving the songs that exist", "6 on the way, 3 on your Listen List". Memory: "Not found 3 days ago" / "Nothing was searched this time. It’s asked again after a week, or now if you press Retry." Done row: "Lossy MP3 from Bandcamp".

## What NOT to change

- The walk, the album identity rules, the explicit-edition rules, one download at a time.
- The preflight's own verdicts (Phase 2); it still never blocks: a broken or slow offer search leaves the "no" as it was.
- Songs saved from an offer never fulfil the album jot.
- Search (Phase 3).

## Done when — the replay

Read-only replay (`album/search` + `album/get` on Qobuz, Apple lookups; nothing downloaded) of the 24 album refusals Oct 20 – Nov 19 (22 edition-not-found, 2 given up): **23 of 24 would offer something.**
- 11 get a "no" with offers: 10 "Save the N songs" (8 from a bigger edition: No Bad Memories 19 of 31, Damaged 14 of 15, Pink Flag 17 of 21 …; Father of Peace and Atom Heart Mother from one the same size), and Enter the Wu-Tang (Expanded): "the clean 9-song edition" or "Save the 14 that exist" (1 on the Listen List).
- 12 more now answer "found" or "can't tell" (Qobuz or Apple has moved since, or the edition is settled differently): the walk runs, and if it comes back short (Philadelphia, Manning Fireworks, Hullabaloo) or refuses, the row offers the songs one by one.
- Animals (Pink Floyd): Apple can't name one edition by title alone, so no tracklist and no offer. A one-click save names the edition (Phase 2), which gives it one.
No edition offer came up in the replay except Wu-Tang: Apple rarely lists the other edition Qobuz has, so the songs offer carries most of it.

## Tests

`src/main/__tests__/closest-edition.test.ts` (44): the difference words, the question and the buttons, the nearest edition (contract-exact only, never the asked one, explicit before clean, clean says clean, never explicit matched to a clean listing), the partial split (owned left out, length pinned, no clean listing for an explicit row, no stranger or live record), the lossy label, the memory (key changes, a week, Retry forgets, only real answers, pruning), no words in the usage log, and the scheduler with main stubbed (nothing taken without a tap, 6 songs + 3 list rows, a second tap does nothing, the edition job, the lossy rerun, songs-each). `downloads-panel-model.test.ts` now expects the songs-each offer on a walk-refused album.

## Left for later

- A single song's Bandcamp or SoundCloud copy is still taken by the walk; it is labelled lossy in Downloads after, not before (there is no song preflight).
- The album jot stays on the Listen List beside the song rows a partial save adds; Jake tosses it if he wants.
- Phase 5: offers survive a restart only once the queue does.
- When the album check can't tell (no login, no answer, too slow), the full download still runs and can take a Bandcamp MP3 without asking.
