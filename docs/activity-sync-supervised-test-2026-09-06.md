# Activity Sync front end — supervised device test (prepared 2026-09-06)

Nothing here runs until Jake is present and says go. No device operation
happens unattended. The slice stays **uninstalled** until these checks pass.

## The build

| | |
|---|---|
| Commit | `9d62f5f` on `unify/renovation-and-fixes` (tree clean) |
| Package | `release/mac-arm64/JakeTunes.app`, `app.asar` sha256 `faf5987db6e5…` (`release/PREPARED-REVISION.txt`) |
| Installed today | still `3a65f66` (the Record Shop placements build) |
| How the test runs | on the **dev instance** started from the same commit (`electron-dev`), which runs the real main process and the real engine from source — so the page under test is this slice while /Applications keeps the previous build. The packaged app is installed only after the checks pass, at an idle point. |

## What the 100-track sync will replace

The ledger's newest sync (`activity-sync-ledger.jsonl`):

| When | Set | Result |
|---|---|---|
| Sep 4, 3:27 PM | Activity Sync · **500 songs** (407 new on, 907 off vs the 1,000 before) | 500 of 500 landed, sealed |

An Activity Sync **wipes the iPod and rebuilds it to exactly the chosen set**
(the engine, unchanged). So the 100-track test sync removes all 500 of those
songs and writes 100. Nothing is lost that the app does not already hold:

- Plays made on the iPod since Sep 4 come home **at plug-in**, before any
  sync touches the card (`sync-engine/roundtrip.ts` reads `Play Counts` and
  the on-the-go lists on mount, read-only). The last Round Trip on record is
  Sep 4, 3:17 PM (8 plays). Plugging in for this test records the next one;
  its row appears in Recent syncs before we start.
- The 500-song set itself is in the ledger (picks + result rows) and, if it
  was saved, as a SYNCED SETS playlist. Its songs are library tracks; only
  the card copies go.

## How the iPod is left after testing

With a **fully verified, playable set**: the final step is a complete Activity
Sync at the size Jake picks (500 to match what is on it today, or any of
100 / 250 / 1,000), sealed, its landed count matched against the Mini's About
screen, then a normal eject. The cancellation test runs **before** that final
sync, never after — a cancel leaves the card with no playable songs (the
engine re-empties Music and writes no catalog), which is exactly what the
final sync repairs.

## Pre-flight (Jake present)

1. No simulator booted (`xcrun simctl list devices booted` → none; done
   2026-09-06 21:55) — a booted simulator is the known unmount dissenter.
2. Mini on a direct USB port, no hub. Mount stable: eight consecutive
   `ls /Volumes/JAKETUNES/iPod_Control/iTunes/iTunesDB` two seconds apart,
   all OK.
3. Playback idle in the installed app; quit it; start `electron-dev` from
   `9d62f5f`; wait for boot restore.
4. DEVICES › iPod appears (real mount, no `#deviceFixture`); the page header
   reads "On the iPod now: 500 songs · Thu 3:27 PM" (or "Last verified" if
   the Round Trip / detection says otherwise — note which).
5. Recent syncs shows the new Round Trip row at the top; note its play count.
6. On This iPod… → confirm the card lists 500 (the count we are replacing).

## The sequence

| # | Step | Expected on the page | Expected on the Mini / ledger | Stop if |
|---|---|---|---|---|
| T1 | Activity Sync, size **100**, Jake's profile, Confirm & Sync in the review | Strip walks Prepare → Wipe → Copy N/100 → Verify → Catalog → Seal with the live line and clock; result "Landed 100 of 100 — verified on the card, time"; header updates to "On the iPod now: 100 songs" after the ledger reload; Recent syncs gains "Activity Sync · 100 songs — 100 of 100 sealed" | Settings → About on the Mini: **Songs 100**; ledger result row `landed 100, sealedOk true` | any step's text disagrees with the LCD; the result line and About differ — record both, do not continue |
| T2 | Activity Sync again (size 100 is fine), **Cancel during Copy** | "Stopped at Copy: You stopped the sync. N copied before the stop." + "The copied songs were cleared again and no catalog was written. The previous catalog stands, but its songs are no longer on the card — sync again before using the iPod." Header flips to "Last verified: 100 songs … not verified". Details lists the steps reached. Recent syncs shows the aborted row | On This iPod… shows the catalog (100 records) with no music files, or the engine's own report in the log; About may still say 100 — that is the point of the line | the page claims anything other than "cleared again / previous catalog stands" |
| T3 | **Final** Activity Sync at Jake's chosen size (500 default), Confirm & Sync | Full strip; "Landed N of N — verified on the card"; header "On the iPod now: N songs"; Recent syncs: N of N sealed | About: **Songs N**, equal to the landed count; Artists menu A–Z | short or unsealed — leave the result on screen, record it, do not retry blindly |
| T4 | **Eject** from the page button | No notice; DEVICES row drops within a few seconds | Mini shows the eject-safe screen | "Eject failed: reason" appears — read the reason, close what it names (no simulator should be up), eject again. The forced-failure case is **harness-only** (already captured `sync-11-eject-failed`); we do not provoke one on a real write |

After T4: quit the dev instance, relaunch /Applications/JakeTunes (still
`3a65f66`). Install `9d62f5f` only when Jake calls the checks passed, at an
idle point, then relaunch and confirm the asar hash.

## What is recorded

For each step: a capture of the page (`diagnostics/step-inside-review/
device-T1…T4.png`), the LCD text, the ledger rows appended, the About count
Jake reads out. Any disagreement between the page, the ledger and About is
the finding; the engine is not touched to fix it.
