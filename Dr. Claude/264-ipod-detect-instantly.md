# 264 — See a plugged-in iPod at once

2026-11-20. Jake: iPods are recognised too slowly after plug-in.

## Why it was slow

- The sidebar polls `check-ipod-mounted` every 2.5 s → `findIpodMount` (`src/main/platform.ts`).
- Any miss set a **10 s negative cache**: for 10 s the check answered "no iPod" without looking. Plug in just after a miss and the iPod waited up to 10 s plus macOS's own mount time.
- After the cache ran out, a miss also ran `diskutil list -plist external` (and possibly `diskutil mount`, 15 s timeout) **inside** the check, so the poll waited on it, every 10 s, with no iPod plugged in.
- Volumes were checked one after another; a share the `mount` table didn't name as network could hold the whole answer.

## What changed

1. **/Volumes is watched** (`src/main/volumes-watch.ts`, started in `src/main/index.ts` on macOS, closed in `before-quit`). Any change drops the negative cache at once (`noteVolumesChanged`) and, ~300 ms after the burst settles, sends `ipod-volumes-changed`; the sidebar checks immediately (`Sidebar.tsx`, `onIpodVolumesChanged` in preload/types). The 2.5 s poll stays as the backup. A watcher that can't start or errors closes itself and logs "polling only".
2. **Negative cache 2 s**, and a miss within 5 s of a /Volumes change never sets it (the iPod may be mid-mount).
3. **No check can hang on a network volume.** Network mounts are still dropped by the mount table (`mount` now time-boxed, 3 s). Every remaining volume is checked at once, each time-boxed at 500 ms; the first iPod to answer wins. A stalled check is reused, never stacked, so a sleeping share can't fill the fs threadpool.
4. **diskutil fallback**: at most once every 10 s, and the sidebar poll (`findIpodMount({ remount: 'background' })`) never waits on it; if it mounts an iPod, /Volumes changes and the watcher brings the check back. Other callers (sync recovery, eject, capacity, cold-start DB read) still wait for it, as before.
5. **Timing log**: `[ipod-detect] FOUND iPod at <mount> — N ms after /Volumes changed`.

`isIpodMount` itself is unchanged (no time-box), because the sync engine uses it to prove a mount is still the iPod; a slow USB stat there must not read as "gone".

## Tests

`src/main/__tests__/ipod-detect-instantly.test.ts`: 2 s cache; a volumes change clears it and a fresh miss isn't cached; the FOUND line carries the ms; a never-resolving stat on a share doesn't delay the iPod; a hung share alone ends the pass within the budget and its stat isn't stacked; the poll never waits on diskutil and it runs at most every 10 s; other callers still wait; the watcher debounces, closes, and falls back to polling on error or when it can't start. Mutation-checked (removing the cache clear, the fresh-change rule, the diskutil rate limit, or the time-box each fails a test).
