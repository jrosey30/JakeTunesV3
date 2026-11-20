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

---

## Part 2 — a drop after the copy (2026-11-20, evening)

**Branch:** `fix/ipod-sync-keeps-songs-every-step` (from `origin/main` 632f5b7c, which has #459 and #461)

### What happened

On the same Y2K iPod, all 416 songs copied. Then, while the song list was being put on the card, the iPod reset and the mount went stale. The log showed three tries in 40 ms, each `catalog copy onto the card failed: EIO … copyfile …/jaketunes-itunesdb-<pid> → /Volumes/Y2KPod/iPod_Control/iTunes/iTunesDB`. The run stopped with "never committed". It wrote no record, because the partial-on-card record was written only for a drop during the copy. The iPod came back later with all 416 files on it, and the next Sync started from 0. Jake: "it started over from 0 ughhhhhh".

### What changed

- **The steps after the copy ride out a drop too** (`ipod-activity-engine.ts`, §4 and §5 now run in one loop). These steps are the check across remounts, the gap fill, the song list (including artwork), and its proof. When one fails, the card itself decides whether it was a drop (`cardWentAway`). A drop is one of three things:
  - the card is gone;
  - another device is at the mount (st_dev);
  - a tiny file won't write and read back.

  There is no errno to go on at these steps ("never committed" is a sentence). A drop waits for the same iPod with the code the copy uses (`rideOutDrop`, factored out of the copy loop: identity plus probe, two answers in a row, the iPod followed to another `/Volumes` path, the same 3-drop limit per run). When the iPod is back, the loop runs again from the check across remounts. The songs are proven again, and the gap fill copies any song the drop took. Then the song list is written again. The UI says "The iPod reconnected — checking the songs again" or "The iPod reconnected — finishing the song list". A failure that isn't a drop ends the way it always did.
- **Never back.** The same stop as a copy drop (`dropStop`): no card is touched, and the record covers every confirmed song, which is all of them once the copy has finished. The next sync adopts them all, copies 0 and writes only the song list. The stop message names the step ("disconnected while its song list was being written and didn’t come back"). `sync-failure-copy.ts` maps it to the catalog step (or the verify step) with "The iPod disconnected." Each line in `ipod-drops.jsonl` now carries `step`.
- **A song list is never half-written.** The new iTunesDB goes onto the card as `iTunesDB.jaketunes-new`, is confirmed there (F_FULLFSYNC, size), and only then is renamed over `iTunesDB`. The firmware reads only `iTunesDB`, and an HFS+ rename is one journaled catalog change. A drop mid-write therefore leaves the old iTunesDB exactly as it was, with the half file next to it under the temporary name, which the next write replaces. `iTunesDB.bak` is still made once per run from the catalog the run started with.
- **The gap fill never writes into a card that isn't there.** Its `mkdir -p` would have made the card's folders on the Mac. A proof round whose remount fails on a vanished card stops at once, so the drop is seen once instead of four times.

### Adopting with no partial record (goal 3)

The partial record exists only when the run lived to write it. A run can also die with songs on the card and no record: the app quits, the Mac sleeps, or the run stops somewhere this code never reaches. For that case, the in-flight manifest (and the catalogued one that replaces it) now carries `cardRecord`:
- the iPod's identity (marker id, FireWire GUID, serial);
- for each song, its card path, identity, the exact size of the file this run copies, and the library master's size.

Songs fetched from homemini at copy time have no size yet and are left out. On the next full copy, a song with no partial-record adoption is adopted from `cardRecord` only when all of these hold:
1. the record is for this iPod (`sameIpod`; an iPod with no identity never adopts), and the manifest isn't sealed;
2. it is the same song this sync would copy (`stayVerdict`: id, card path, identity, both sizes);
3. the card file is exactly the recorded size;
4. after one cold remount, the card file reads back byte for byte the same as the file this sync would copy (`filesSameBytes`). If the remount fails, nothing is adopted this way.

**Why that is safe, and why size alone is not.** HFS+ journals a file's length, not its data. A file whose last blocks never left the drive's cache when the USB link reset can read back at full size with the wrong bytes, and `confirmWriteOnCard` itself only checks size after F_FULLFSYNC. Comparing every byte after a cold remount (no Mac cache) proves the card holds exactly what a copy would write, which is stronger than what the partial record proves. Reading costs time (one full read of each candidate, no writes); how long on a 3G is unmeasured. The tests corrupt one file at the right size; it is copied again and the rest are adopted. With the compare turned off, that test fails.

### Tests (`ipod-sync-drop.test.ts`)

- **Drop while the song list is written, back:** half the new list lands, then the card goes. The list is written again and sealed, each song is written once, and no temporary file is left. The drop line has `step: 'catalog'` and 12/12 songs.
- **Same drop, never back:**
  - the record lists all 12 songs;
  - the card's `iTunesDB` is still the old template byte for byte, and the half-written one is only under the temporary name;
  - the next sync is a full copy with 0 copied, 12 kept and every inode unchanged, and it seals.
- **Drop during the check across remounts, back:** checked again, sealed, nothing re-copied.
- **No partial record (deleted after a drop):** 4 songs adopted from the in-flight record and 8 copied. The one corrupted at full size is copied again.
- **In-flight record for another iPod:** nothing adopted, all 12 copied.
- **Unit tests:**
  - `cardWentAway`;
  - `parseInflightCard`: sealed, other iPod, no identity, old manifest;
  - `adoptFromInflight`: bytes, size, changed library file;
  - `filesSameBytes`;
  - the drop line's step.
- **Mutation-checked:** writing the list straight to `iTunesDB`, or skipping the byte compare, fails the tests.

### Limits

- The swap's interim song list (before anything leaves) and the wipe still stop the old way on a drop.
- After a drop at the song list, the result screen still says the iPod shows its previous list. That holds unless the rename had already happened when the iPod went: then it is the new list, unproven.
- Today's card can't be adopted retroactively: its in-flight manifest was written before this change and has no `cardRecord`. Its next Sync copies all 416 once more; after that, both records protect it.
