# Brief 251 — The iPod Sync page in plain words

**Date:** 2026-11-19
**Repo:** JakeTunes V3 (desktop)
**Why:** Jake, looking at "Can't sync 3 songs on iBANDCAMP's list: Song 13903 (it isn't in this library) and 2 more." and at the first-sync panel ("The first sync finished and was read back… Card check passed: the first and last songs written (30 of them) read back exactly as written." with a "Both are right" button): *"i cant keep seeing this crap"*, *"its these confusing messages. its AI slop. it needs to be simple"*.

## Do-Not-Touch: DeviceView.tsx

`src/renderer/views/DeviceView.tsx` is on CLAUDE.md's Do-Not-Touch list. Jake's request is for "every message on the Device / iPod Sync page", and those messages are written in that file, so this brief touches it, and only for its messages: the words; `SyncStatus.target`, so the progress strip no longer reads its count out of the words; showing no count after an aborted sync; and the left-off line's "Which ones" button. Nothing about how a sync runs changes. It is committed with `PROTECTED_OK=1` on that basis.

## The rules

1. One line each.
2. Words Jake would use. No track ids, no internal terms (read back, card check, list / pool, staged, catalog, seal, ledger). homemini only where he can act on it ("Getting 484 songs from homemini…").
3. No reasons in brackets, no "and N more".
4. Say what to do only when he has to do something.
5. When the app can fix it itself, it fixes it and says nothing.
6. Facts stay true: nothing says a sync worked when it didn't.

## What changed in behaviour (not just words)

- **A song that is no longer in the library, or belongs to a full concert, is left off quietly.** The plan (`src/main/ipod-one-sync.ts`) used to list it as "can't go on". It still isn't synced (it never was), but the page no longer names it; the count and ids go to the log (`[one-sync] … aren't in this library`), because a desktop library that is behind homemini can make real songs look missing. That is where "Song 13903 (it isn't in this library)" came from.
- **The Original's fill note and the "homemini away, using the copy on this Mac" note are gone.** The app already fixes both by itself; the note goes to the log.
- **The card check says nothing when it passes.** It speaks only when Jake must act: "Unplug the iPod and plug it back in.", a bad card, or, when it can't run, "Play the last song on the iPod to check it." (the play test is then the only check).
- **The progress strip gets its song count as a number** (`SyncStatus.target`), not by reading "1,000 tracks" out of a sentence, so the words could change.
- **Every error that used to carry the raw error in brackets now logs it** (`console.warn`) and shows one plain line.
- The engine's own sentences are unchanged and stay behind **Details** on a stopped sync. During a sync the strip and the status bar show a song's name and nothing else of the engine's (`songTitleOnly`): no "TSA — inspecting…", "Writing iTunesDB...", "Wiping the iPod for a clean rebuild…".
- **A refusal before the iPod is touched reads as itself** (the plug-in health check, an unknown iPod, a list that won't fit, the page's own refusals): before, these fell through to "The sync stopped" + "Whether the iPod changed is not known". A test runs every one of them.
- **The header shows no count after an aborted sync** ("The last sync didn't finish."), since an aborted sync's count isn't what went on.

## Before → after

### The Sync area (`DeviceView.tsx`, `common/ipod-ready-on-mac.ts`, `common/ipod-one-sync-plan.ts`, `main/ipod-one-sync.ts`)

| Where | Before | After |
|---|---|---|
| Beside the name | punkPod · 847 songs ready | (same) · 847 songs ready |
| Everything on this Mac | All 5,426 songs ready on this Mac | *(nothing: the line beside the name already says ready)* |
| List iPod, songs missing | 484 songs not on this Mac yet (homemini isn't answering) — Sync gets them from homemini first | 484 songs aren't on this Mac yet. Sync gets them first. |
| Original, downloading | 484 songs still downloading — Sync will wait / Sync now leaves them off | 484 songs still downloading. |
| Original, stopped | 484 songs not on this Mac yet (reason) — Sync now leaves them off | 484 songs aren't on this Mac yet. |
| Leave-off confirm | 484 songs aren't on this Mac yet. Sync now and leave them off, or wait for the download? [Sync now (484 left off)] [Wait] | 484 songs aren't on this Mac yet. [Sync without them] [Wait] |
| While waiting | Getting 484 songs for punkPod from homemini before the sync… | Getting 484 songs from homemini… |
| Wait stuck | Can't sync punkPod yet: 484 songs aren't on this Mac (reason). Nothing on the iPod was changed. | Can't get 484 songs right now. Try Sync again later. |
| Wait stalled | Can't sync punkPod yet: 484 songs stopped arriving from homemini. Nothing on the iPod was changed. Try Sync again. | 484 songs stopped downloading. Press Sync to try again. |
| Left off, list iPod | Can't sync 3 songs on iBANDCAMP's list: Song 13903 (it isn't in this library) and 2 more. | *(not in the library: nothing)* · 1 song is damaged and was left off: Breeze. |
| Left off, many | 12 songs can't go on [Which ones] → "Artist — Title: its audio file is missing everywhere" | 12 songs are missing their files and were left off. [Which ones] → "Artist — Title" |
| Left off, mixed | — | 3 songs were left off: A, B, C. |
| Original fill | 940 from your Top 1000 can go on; your most-loved songs fill the other 60. | *(nothing: the app fills them)* |
| Plan: no iPod | No iPod is plugged in. | Plug in the iPod. |
| Plan: unknown iPod | JakeTunes doesn't know this iPod yet. Set it up first, then sync it. | Set up this iPod to sync it. |
| Plan: Top 1000 unreadable | homemini didn't answer, so punk's Top 1000 can't be read right now. Nothing on the iPod was changed. Try again when homemini is back. | Can't get the Top 1000 right now. Try again in a minute. |
| Plan: list unreadable | punkPod's list couldn't be read. Nothing on the iPod was changed. | Can't get punkPod's songs right now. Try again in a minute. |
| Plan: list empty | punkPod's list is empty. Songs are added by asking Claude, or by the brain. | punkPod has no songs yet. |
| Plan: none fit | None of the 851 songs on punkPod's list can go on it. Nothing on the iPod was changed. | None of punkPod's songs can go on it. |
| Loading | Reading what goes on this iPod… | Loading… |
| Unknown iPod | Set this iPod up above, then it gets its own Sync button. | Set up this iPod above to sync it. |
| No iPod on Sync | No iPod detected — plug it in and try again. | Plug in the iPod. |
| Check failed | Couldn't check which of punkPod's songs are on this Mac. Nothing on the iPod was changed. Try Sync again. | Couldn't get ready to sync. Press Sync again. |
| Changed mid-wait | punkPod or its list changed while its songs were downloading. Nothing on the iPod was changed. Press Sync again. | punkPod changed while its songs were downloading. Press Sync again. |
| Syncing | Syncing "punkPod" — 851 tracks… | Syncing 851 songs to punkPod… |
| Stop button | Cancel / Cancelling… / "Stop the current sync after the file in flight finishes" | Stop / Stopping… / "Stop the sync" |
| Stopped by Jake (status bar) | Sync cancelled (12 files copied before stop) | Sync stopped |
| Short count | Only 990 of 1000 songs actually stuck on the iPod after 3 tries — the card keeps dropping writes. A reformat is likely needed to reach 1000. | Only 990 of 1,000 songs stuck on the iPod. *(+ the stopped-sync line below)* |
| Done (status bar) | Synced 1000 to punkPod — all verified on the card. Give it a moment to finish counting up to 1000. | Synced 1,000 songs to punkPod. |
| Done (page) | Landed 1,000 of 1,000 — verified on the card, 3:15 PM. Swapped 7 songs: 7 out, 7 in. 993 stayed. [Dismiss] | Synced 1,000 songs. On the iPod, Settings › About should say 1,000. [OK] |
| Step strip | Prepare · Wipe/Remove · Copy · Verify · Catalog · Seal | Get ready · Clear/Remove · Copy · Check · Song list · Finish |
| Header | On the iPod now: 990 songs · Thu 3:15 PM (short of 1,000) — what the iPod holds now is not verified / Last verified: … | On the iPod: 1,000 songs · Thu 3:15 PM / Last sync: 990 songs · Thu 3:15 PM |
| Header, none | No sync recorded yet. | Not synced yet. |
| Songs: | ~1,000 workout (of 8,621 in library) | 1,000 *(the iPod's own count; — when none is plugged in)* |
| Rename | Renamed to punkPod. The iPod shows it after the next sync. homemini will hear the new name on the next sync. / JakeTunes and the iPod now call it punkPod, but the Mac kept the drive's old name (diskutil refused). | Renamed to punkPod. The iPod shows it after the next sync. |
| Rename, too long | "punkPodXXXXX" is 12 characters. An iPod's drive name can be at most 11. | Too long: 11 letters at most. |
| Rename, bad letters | Use letters, numbers, spaces and - _ ! # $ % & ' ( ) @ ^ { } ~ only. The iPod's drive can't hold other characters. | That name has a character the iPod can't use. |
| Rename, capitals | The iPod and JakeTunes will say punkPod. The Mac's Finder will show the drive as PUNKPOD (FAT32 drives keep names in capitals). | Finder shows it as PUNKPOD. |
| Full Sync confirm | Mirror the ENTIRE library to the iPod? All 8,676 songs copy at original quality. Anything on the iPod that isn't in the library — including the songs from the last Sync — is replaced. On the Mini this takes hours; keep it plugged in. | Put your whole library on the iPod? All 8,676 songs. Everything on the iPod now is replaced. It takes hours, so keep it plugged in. |
| Eject failed | Eject failed: (raw) / Nothing on the iPod was changed by the eject. Close anything reading the card (a booted simulator counts), then eject again. [Dismiss] | Couldn't eject the iPod. Close anything using it, then eject again. [OK] |

### A stopped sync (`common/sync-failure-copy.ts`)

One line now: what happened + whether the iPod changed + what to do (only when there is something to do). The old "Stopped at Verify: …" lead and second line are gone; the raw engine text stays in Details.

| Before (examples) | After |
|---|---|
| Stopped at Verify: Songs dropped off the card between two remounts. / The new songs are on the card, but the catalog was not replaced. The iPod will show the old list until you sync again. Sync again without unplugging. If it comes up short again, check the cable and the port before anything else. | Some songs didn't stay on the iPod. The iPod still shows its old songs until you sync again. Sync again. If it happens again, try another cable or USB port. |
| Stopped: What goes on this iPod couldn't be read from homemini. Nothing on the iPod was touched. / Nothing on the iPod was changed. Sync again once homemini is answering. | Couldn't get this iPod's songs. Nothing on the iPod changed. Try again in a minute. |
| Stopped at Copy: You stopped the sync. 312 copied before the stop. / The copied songs were cleared again and no catalog was written. The previous catalog stands, but its songs are no longer on the card — sync again before using the iPod. Sync again when ready. | You stopped the sync. The iPod's songs were cleared. Sync again before you use it. |
| Stopped at Seal: The songs are on the card but the set could not be sealed. / The new songs are on the card and a new catalog was written, but the card did not prove it. Do not trust the count the iPod shows until a sync seals. | The sync didn't finish. The iPod may show the wrong songs until you sync again. |
| Stopped: The sync stopped. / Whether the iPod changed is not known — check On This iPod before trusting any count. Open Details, then sync again with the iPod still plugged in. | The sync stopped. The iPod may be half-synced. Sync again before you use it. |
| (refusals before the iPod is touched: "Couldn't check which of…", a health stop, "won't fit", an unknown iPod) read as "The sync stopped" + "Whether the iPod changed is not known" | shown as written, e.g. "The card for punkPod is in a different iPod. Confirm below if that's right." / "5,000 songs won't fit on punkPod. Make the list shorter." |
| Status bar during a sync: Copying 312/1000 to iPod — Wiping the iPod for a clean rebuild… / Verifying 1000/1000 audio files… / Writing iTunesDB... / Sync cancelled (312 copied) / Sync failed — (engine sentence) | Copying 312 of 1,000 — (song) / Getting ready… / Checking the iPod… / Writing the song list… / Sync stopped / (the plain failure line) |

Every rule's words, in full: `src/common/sync-failure-copy.ts` (RULES and CHANGED_LINE).

### First sync and set-up (`IpodSetupSheet.tsx`, `common/ipod-onboarding.ts`, `main/ipod-card-proof.ts`)

| Where | Before | After |
|---|---|---|
| First sync | punkPod is set up. Press Sync punkPod on this page for its first sync. / 851 songs, 6.2 GB: about 9 minutes to 26 minutes, with the Mac awake and the screen unlocked. | punkPod is set up. Press Sync punkPod. / It takes about 9 minutes to 26 minutes. Keep the Mac awake. |
| Proof | The first sync finished and was read back: 851 songs. Eject punkPod, unplug it, and check these on the iPod itself: 1. Settings > About: Songs reads 851. 2. Music > Songs: the very last song plays, and skips to its middle without a pause. [Both are right] | Synced 851 songs. On the iPod, Settings › About should say 851. [Looks right] |
| Card check, waiting | Unplug the iPod and plug it back in. Then JakeTunes reads back the first and last songs it wrote, to check the card (about a minute). | Unplug the iPod and plug it back in. |
| Card check, passed | Card check passed: the first and last songs written (30 of them) read back exactly as written. | *(nothing)* |
| Card check, couldn't run | The card check couldn't run: … Playing the last song on the iPod is the check. | Play the last song on the iPod to check it. |
| Card check, failed | The card didn't keep what was written: 2 of the 30 songs read back came back different. This card is not sound, or not the size it says. Don't trust this iPod until the card is replaced. | This iPod's card didn't keep the songs. Replace the card before you use it. *(counts in the log)* |
| Done | punkPod is set up and checked. Set up Nov 20, 2026 · last synced Nov 21, 2026. / Its default playlists and On-The-Go are on the iPod. / BPM and key check: 412 of 851 songs on punkPod are checked. The rest are checked overnight and stay out of the BPM playlists until then. | punkPod is set up. / The BPM playlists for punkPod fill in overnight. *(only while some aren't checked)* |
| Unknown iPod bar | JakeTunes doesn't know this iPod yet. Until it's set up, JakeTunes won't sync it or read its play counts. | New iPod. Set it up to sync it. |
| Which iPod | Which iPod is this? Pick the list it will carry, or set it up as a brand-new iPod. / buttons "· has an iPod" | Which iPod is this? |
| Name | Give the iPod a short name (11 characters at most: it is the drive's name too). The list stays "punk". | Name the iPod (up to 11 letters). |
| Checks blocked | 2 things must be fixed before this iPod can be set up. Nothing on it was changed. | Fix these 2 first: *(the problems listed under it)* |
| Checks running | Checking the connection and the test file… / Not run yet: JakeTunes writes a 64 MB test file to the iPod, reads it back, and removes it. | Checking the iPod… / Testing the iPod's card… |
| Connection | The iPod dropped off the Mac 2 times in 8 looks. Plug it straight into the Mac (no hub), wait for it to settle, and check again. A sync over a connection like this leaves the iPod half-written. / The connection held for 8 looks in a row. | The iPod keeps dropping off. Plug it straight into the Mac and check again. / Connection is steady. |
| Card test | A test file written to the iPod came back exactly as written. / The iPod didn't keep what was written to it (reason). The card or the adapter needs looking at before any music goes on. | Card works. / The iPod's card didn't keep a test file. Replace the card first. |
| Model | This is an iPod Classic. A Classic only shows songs when the song database is signed for that exact iPod, and JakeTunes can't sign it yet. | JakeTunes can't sync an iPod Classic yet. |
| Rockbox | This iPod is running Rockbox, not Apple's software. … two commands that only you can run in Terminal (see the plan). Nothing was changed. | This iPod runs Rockbox. Remove Rockbox first. |
| Format | Formatted FAT32, the format JakeTunes syncs. / This drive isn't formatted the way an iPod needs (FAT32). Changing the format erases it, and JakeTunes doesn't do that for you. Nothing was changed. | Formatted right. / This iPod needs erasing first. Restore it in Finder, then plug it back in. |
| Fits | punk is 851 songs, 6.2 GB. It fits with 9.8 GB to spare. | 851 songs fit. |
| Battery | Battery and disk health can't be read from the Mac on these iPods. The play test at the end is the check. | *(nothing: nothing to do)* |
| Contents | The iPod is empty and has no song database yet. Setting up writes a blank one. | The iPod is empty. |
| Confirm | JakeTunes knows it as … / It calls itself "…" / The 1,203 songs on this iPod now will be replaced by the list at the first sync. / This iPod is X today. It will stop being X and become punk. | It's X. / The 1,203 songs on it will be replaced. / It stops being X and becomes punk. |
| Set-up steps | Make the iPod's folders (they are left alone where they already exist). / Write a blank song database. / Write JakeTunes' ID file… / Name the drive punkPod (the Mac shows PUNKPOD). / Record this iPod (model, software, size, serial)… | Name it punkPod. / Put the songs from punk on it at its first sync. |
| Picture | punk is drawn as an iPod mini; this is iPod (3rd generation). Update the picture to match? The colour stays what you pick. | Change the picture to match this iPod |
| Health, wrong body | The card says punkPod, but it is in a different iPod than the one set up on Nov 7, 2026. If this is punkPod with a new body, confirm that below; otherwise check which iPod this is. Nothing on it was changed. | The card for punkPod is in a different iPod. Confirm below if that's right. |
| Won't fit | These 5,000 songs need about 147 GB and punkPod holds 118 GB, so they won't fit. Nothing on the iPod was touched. Make the list shorter, or sync smaller (AAC) copies. | 5,000 songs won't fit on punkPod. Make the list shorter. *(sizes in the log)* |
| Health, database | punkPod's song database lists 990 songs; the last sync put 1,000 on. Something else wrote to it; the next sync is a full copy. | punkPod has 990 songs, not 1,000. The next sync fixes it. |
| Health, unreadable | punkPod's song database can't be read. The next sync rewrites it, as a full copy. | punkPod's songs can't be read. Sync to fix it. |
| Health, list changed | Last sync finished and was read back. The list has changed since (850 on the iPod, 851 on the list): ready to sync. | New songs are ready to sync. |
| Health blind | JakeTunes couldn't check punkPod before syncing: the Mac wouldn't say the drive's size. Unplug it, plug it in again, and sync. The sync was not started. | Unplug the iPod, plug it back in, and sync again. |
| Errors with raw text | Setting up didn't finish (EIO: …). / JakeTunes couldn't look at the iPod (…). Nothing on it was changed. / That couldn't be saved (…). | Couldn't set up the iPod. Try again. / Couldn't read the iPod. Unplug it and plug it back in. / Couldn't save that. Try again. *(raw text in the log)* |

### Sync History (`SyncHistorySheet.tsx`)

| Before | After |
|---|---|
| Sync · 1000 songs — 1000 of 1000 sealed / 990 of 1000 landed / did not finish | Sync — 1,000 songs / 990 of 1,000 went on / Didn't finish |
| Round Trip — 12 plays home | Plays from the iPod — 12 plays |
| Went on (7) / Came off (7) / Left off (3 of the 851 on the list) — nothing took their place | Added 7 / Removed 7 / Left off 3 |
| Artist — Title — its audio couldn't be converted for the iPod (damaged file) | Artist — Title — damaged |
| track 13903 | Unknown song |
| 2 On-The-Go list(s) / 4 unmatched record(s) | 2 On-The-Go playlists / 4 plays that didn't match a song |
| Same set as the sync before. | No changes. |
| Every sync's cargo — and every play the iPod brought home. / Reading the ledgers… / No syncs recorded yet. | Every sync, and the plays the iPod brought home. / Loading… / No syncs yet. |

## What did NOT change

- The engine (`ipod-activity-engine.ts`): its sentences, ledger and logs are untouched; the page reads its reasons through `leftOffKind`.
- What a sync does, what goes on an iPod, and when Sync asks before touching the card.
- Details on a stopped sync still shows the engine's own text (opt-in).

## Done looks like

- Every string above in place; tests that pinned old wording updated to the new.
- Typecheck and the iPod / sync test files green; independent review; PR merged on green; in the next desktop build.
