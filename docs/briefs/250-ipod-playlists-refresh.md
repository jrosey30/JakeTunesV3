# Brief 250: an iPod's playlists refresh by themselves

2026-11-19. 23 playlists were PUT to homemini for the Best of Bandcamp iPod
(`GET /api/ipod-playlists?device=a7f82840-2f4a-4efc-9707-28fc08b7a8f3` answers
23), but the MacBook's sidebar row showed none: `ipod-playlists-cache.json` still
held 0 for that device, saved 2026-11-19T02:23:13Z, and nothing asked again.

## Why

`useIpodPlaylists` (src/renderer/ipodPlaylists.ts) asks main for a fresh read
only when its effect runs: when `device`, `ipodName` or `enabled` changes. A
sidebar row stays mounted for the life of the window, so it read homemini once
at launch and never again. Writes made on this Mac re-read (`afterWrite`);
writes made anywhere else (the phone, another desktop, a script) never arrived.

## What changes

- `src/renderer/ipodPlaylistsLive.ts` (new, pure, no imports): which iPods are
  on screen (a count per device, so a sidebar row and an open page share one),
  and when to ask again:
  - **mount**: at once, as before;
  - **window focus**, or the window becoming visible;
  - **every 5 minutes** while the window is visible (`IPOD_PLAYLISTS_REFRESH_MS`);
  - **the library-version poll moving** (`hub-catalog-updated`, which only
    replicas such as workmini run; the canonical MacBook has no such poll, so
    there it is focus and the 5 minutes). homemini's library version does not
    move on an iPod playlist edit, so this signal only catches a playlist
    change that happens to ride along with a library change; focus and the
    5 minutes are what carry it.
  Focus, the timer and the library signal ask a device at most once per 30 s
  (`IPOD_PLAYLISTS_MIN_GAP_MS`), and every ask still goes through
  `refreshIpodPlaylists`, whose `inFlight` map makes asks that overlap one
  request. One timer and one set of listeners for all iPods, removed when the
  last row unmounts. A write still re-reads at once, outside the gap; if a read
  is already running it may have sent before the write was on disk, so the
  write's re-read waits for it to end and asks again (review of #438).
- `src/renderer/ipodPlaylists.ts`: `useIpodPlaylists` registers with it
  instead of asking once.

## Not changed

Main (`ipod-playlists-ipc.ts`, the desk, the cache file), homemini, the order,
the defaults, the write paths.

## Cost

One GET per iPod on screen per 5 minutes (7 iPods today), plus at most one per
iPod per 30 s on focus. Main's title map behind it is already cached for 60 s.

## Done looks like

- `src/main/__tests__/ipod-playlists-live.test.ts`: mount asks; focus,
  visible, timer and library signal ask; the 30 s gap holds; a hidden window's
  timer tick asks nothing; two watchers of one device share one entry; the
  timer and listeners go when the last watcher goes; the latest iPod name is
  the one asked with.
- `npm run check` green; the next desktop build carries it.
