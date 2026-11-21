# 263 — iPod songs are never offloaded, and a Sync gets its own missing songs

2026-11-20. Branch `fix/ipod-songs-never-offloaded`.

## What happened

- 20:33Z, MacBook 97% full: the stream-convert pass offloaded Kraken (12558,
  `:iPod_Control:Music:F08:imported_12558.m4a`) to the `.jt-streamed` sentinel.
  12558 had been on punkPod since 11-14 (and Best of Bandcamp since 11-08).
- Then punkPod's Sync stopped at Get ready: "Can't get 1 song right now. Try
  Sync again later." homemini had the file (206 on /audio, audio-identity present).
- The banner added "The iPod may be half-synced", though nothing touched the card.

## Root causes

1. **Offload: the free-space floor on the keep set** (2026-11-13). Under 30 GB
   free, `gateFor` kept only the Top 1000; every other list song "lapsed" and
   the stream-convert queue took it. Not a stale keep-local, not `complete:false`,
   not a race: of the 154 offloads on 11-20, 89 were list songs and 0 were Top 1000.
2. **Stall: the Sync waited on the background download**, whose floor is 60 GB
   free (80 GB in the background). At 35 GB free it stopped every pass with
   "not enough room", `listFetchStep` turned any `stoppedBecause` into `stuck`,
   and that reason was logged with console.log only (never in main.log).
3. **Banner**: the rule matched "can't get .+ songs right now"; "1 song" fell
   through, and with no phase evidence the outcome was `unknown` = half-synced.

## Changes

- `src/main/ipod-keep-local.ts`: no floor; a list song is kept whatever the disk
  says. Keep set = keep file ∪ its Top 1000 ∪ the sidebar's `ipod-lists-cache.json`
  (homemini's newest answer). New `cleanAt` (last read where both sources
  answered); older than `KEEP_STALE_MS` (6 h), or never clean, the gate HOLDS
  (nothing offloaded), said once in main.log.
- `src/main/ipod-sync-fetch.ts` (new): a Sync's own fetch, by id, 4 rounds
  (waits 2/8/20 s). landed / gone (homemini has no file, 404, or its copy is
  provably another song) / failed.
- `src/main/ipod-local-start.ts`: one `land()` path (download, verify, restore,
  measure) for the background pass and the Sync; the Sync also checks the whole
  file against homemini's size + sha1. Not stopped by music playing or the
  60 GB floor (the restore keeps its 10 GB floor). IPC `ipod-local:fetch-for-sync`
  and `-stop`. Skip / stop reasons and each Sync fetch go to main.log (warn,
  `note`, once per change).
- `src/common/ipod-ready-on-mac.ts`: `listFetchStep` replaced by
  `listFetchOutcome` (go with songs left off / stopped / stuck) and
  `unavailableLine` ("1 song wasn't available, so it was left off.").
- `src/renderer/views/DeviceView.tsx`: a list iPod's Sync calls the fetch, then
  syncs without only the `gone` songs and says so in one line after.
- `src/common/sync-failure-copy.ts`: `songs?` — stops before the card say
  "Nothing on the iPod changed."

## Not changed

- The background download's floors (80 / 60 GB).
- Jake's own "Remove download" still offloads a song he picks.
- iPod playlists: their songs are a subset of the iPod's list by homemini's
  contract (409 `not-on-ipod`), so the list covers them.

## Tests

`ipod-keep-local` (Kraken through `runConvertPass` at 20:33Z; staleness; cache
union), `ipod-sync-fetch` (new), `ipod-ready-on-mac`, `sync-front-end-models`
(every stop-before-card line says nothing changed), `ipod-prefetch` wiring.
15 related files: 323/323 pass. `tsc` node clean; web has only the pre-existing
`qrcode-generator` module error (also on main with this node_modules).

## After merge

The 89 list songs offloaded on 11-20 come back by the background download only
when the Mac has 80 GB free; until then each Sync fetches what it needs.
