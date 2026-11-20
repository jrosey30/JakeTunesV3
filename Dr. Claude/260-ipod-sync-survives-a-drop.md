# Brief 260 — iPod sync survives a USB drop

**Date:** 2026-11-20
**Repo:** JakeTunes V3 (desktop)
**Branch:** `fix/ipod-sync-survives-drop` (from `origin/main` fe5575b2)

## Why

Jake's Y2K iPod (an iPod 3G, "Y2KPod", HFS+, 40 GB, USB product 0x1201, straight into the MacBook) ran an Activity Sync that copied for about 8 minutes (18:42:22 → 18:50:38Z). Then its USB device reset and remounted on its own (new IOUSB id, same volume), every remaining `copyFile` failed with EIO inside 35 ms (50 songs), and the engine stopped: "Only 366 of 416 songs confirmed on the card after copy … The songs copied this run were taken off the card again." Two syncs of the same iPod on Nov 17 also ended "Didn't finish". Jake: "this cant keep happening".

The engine treated a vanished card like 50 songs that failed to copy, and the stop path (`rewipeAndStop`) then deleted the 366 it had confirmed, so the next try started from zero on a drive that drops after minutes.

## What changed

- **`src/main/ipod-sync-drop.ts` (new, pure apart from the default card reader).** It tells a drop apart from an ordinary copy failure (`looksLikeDrop`: EIO / ENXIO / ENODEV / ENOTCONN / ESTALE / EBADF, or any error once `iPod_Control` is gone). It reads the card's identity (`readCardIdentity`: the JakeTunes marker id plus SysInfo's FireWire GUID and serial). `sameIpod` says a card is the same only when everything it had before reads the same. `waitForSameIpod` polls every 2 s for up to 2 min, needs two same answers in a row, follows the iPod to another `/Volumes` path, and ends at once if a different iPod appears at the old path. The file also holds the drop log line, the partial-card record (`activity-partial-on-card.json`) with its parser and adoption rule, and the pacing rule for old iPods.
- **Copy loop (`ipod-activity-engine.ts` §3b).** A drop stops the writes and tells the UI "The iPod disconnected — waiting for it to come back…". When the same iPod comes back:
  - every confirmed file is checked at its size;
  - songs whose write failed just before the drop get one more try;
  - the UI is told "The iPod reconnected — carrying on";
  - the loop carries on from the song it was writing.

  A song is never copied twice. If a song the card's catalog already names is missing after the drop, the sync stops the old way (it never patches that mid-copy). The iPod may drop 3 times in one run; the 4th drop stops it.
- **Never back, or another iPod.** `dropStop` doesn't touch any card. That matters because the old `rewipeAndStop` would have emptied Music on whatever iPod was now mounted at that path. It writes the confirmed files to `activity-partial-on-card.json` in this iPod's state dir: id, card path, identity, size, source size and the file's mtime, plus the iPod's identity. No catalog is written. The error ends with `DROP_KEPT_MARK`, so the result screen says "The songs copied so far stay on the iPod. Sync again: it copies only the rest." (`sync-failure-copy.ts`: new rules and an `IpodChanged` value of `drop-kept`).
- **The next sync adopts them.** The stopped run left an in-flight manifest, so the next sync is a full copy. Before the wipe, each song in that record becomes a kept song (spared by the wipe, never copied, counted as `kept`) when two things hold:
  - it is the same song this sync would copy, by `stayVerdict` (id, card path, identity, both sizes);
  - the card still holds that exact file, by size and mtime.

  Everything is then proven across remounts, catalogued, TSA-checked and sealed as usual. The record is deleted on seal, on a rewipe and on a swap stop.
- **Why keeping is safe.** The firmware reads only the iTunesDB. After a full-mode wipe the old catalog already names missing files, which is the same broken state today's rewipe leaves. No new catalog is written, and every file kept was fsync'd and confirmed. The record never applies to another iPod (identity), to a rewritten file (mtime) or to a changed library file (sizes and identity).
- **Gentler writes.** `confirmWriteOnCard` already runs fsync and F_FULLFSYNC after every file. On a 3G, 4G or mini (`detectHardware` from SysInfo), the loop also pauses 1.5 s every 200 MB, which adds about 5% to a long copy. Classic and modern iPods are unchanged. **This pause is unmeasured**: nothing shows it helps the drive, so drop it if the drop log shows no change.
- **Diagnostics.** Each drop writes one log line and one JSON line to `ipod-drops.jsonl` in the iPod's state dir. Each line has:
  - the time, the iPod and its model;
  - songs done of the total, MB written and seconds into the copy;
  - the file being written (title and card path) and its errno;
  - how long the iPod was gone, and the outcome (back, never-back, other-ipod or too-many).

  This shows whether drops come at the same file, the same byte count or the same minute.

## Tests

`src/main/__tests__/ipod-sync-drop.test.ts` runs the real engine on a fake card, using the same rig as the swap-engine tests. The card is renamed away mid-copy and the copy throws EIO; a fake clock runs the wait.

- **Drop, then back 10 s later:** the sync seals, every song is written once, and the five confirmed songs keep their inodes. The drop line reads 5 songs, 1.25 MB, the EIO and the file.
- **Back at "card 1":** every path follows the card, and it seals there.
- **Never back:** no catalog; five songs left on the card and in the record. The next sync is a full copy with 5 kept and 7 copied, the kept files untouched; it seals and the record is gone.
- **Another iPod at the same path:** no write after the drop, nothing removed, and the record doesn't apply to that iPod.
- **EIO on every write:** three times back, the fourth stops ("kept disconnecting").
- **Unit tests:** identity, drop classification, the wait (streak, timeout, other iPod), adoption (mtime, size, identity, changed library file), pacing, and the result screen.

## Not done / limits

- Drops are ridden out only in the copy step. A drop during the wipe, the verify remounts, the catalog write or the seal stops the way it always did.
- A streamed song (not on this Mac) is adopted only when its copy size is known up front. The next sync's preflight still probes or converts adopted songs before the wipe: no card writes, just time.
- With no marker, GUID or serial, a drop is never ridden out: the sync stops and keeps the files.
- Whether the 3G's resets are the drive, the cable, the port or power can't be fixed in code. `ipod-drops.jsonl` is there to find that out.
