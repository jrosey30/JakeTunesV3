# Sync audit — 2026-10-07

Jake: "everything should sync always across all devices. latest updates should always win."
Read-only audit (subagent, 64 tool calls). Status: **not met**. Fix in stages, one session each.

## Gaps, most-hit first (file:line from the audit)
1. **workmini ↔ laptop overwrite each other (proven).** `~/bin/jaketunes-workmini-index-sync.sh` swaps the laptop's library files onto workmini whenever SIZES differ (no timestamp check), under workmini's running app, which then re-saves its in-memory copy. 121 pushes / ~1.5 days; 273 entries differ; workmini holds 96 play counts, 158 skips, 1 genre/star edit the laptop never got; nothing returns workmini edits to the laptop.
2. **Phone plays never reach any desktop (proven).** Nothing in V3 reads `mobile-plays.json`. workmini plays also lost (gap 1).
3. **Phone field edits win forever (proven).** Phone overrides overlay desktop fields unconditionally (V3 index.ts:9498-9504; backend library.ts:205): a later desktop fix is undone on next launch.
4. **Stars.** Un-star resurrects (union merge, mobile-stars-merge.ts:13); phone un-star never lowers a desktop rating (App.tsx:836-852); phone stars reach desktop only at launch (App.tsx:764); phone retry queue replays only at cold launch. Plausible: autoBackup whole-file-pushes mobile-stars.json/mobile-plays.json to the NAS (index.ts:3988-3989, 4181) — the backend's live copies.
5. **Phone playlist removals/deletes never reach desktop (proven).** V3 never reads playlist-removals.json / mobile-playlist-deletions.json ("Bad Ass Music" deleted on phone still in laptop playlists.json); phone additions never cleared (App.tsx:869-886) → removed tracks come back.
6. **Pins.** Phone pins = UserDefaults only (PlaylistsView.swift:21); desktop sidebar reads playlist-pins.json once on mount (Sidebar.tsx:247-251); whole-set LWW (playlist-pins.ts:45) lets a stale machine overwrite newer pins.
7. **workmini nightly deploy failing since Aug 7 (proven, workmini-nightly.log):** test suite fails → artwork, sidecars, tape exchange reach workmini only on manual deploy.
8. **Phone listening log never arrives (proven).** Sync script pulls from homemini folders the backend doesn't write (sync.sh ~762-763); backend writes the NAS copy (477 KB) — laptop copy 5 KB from Sep 13. Hits KPIs / Year in Review.
9. **Stale-push guard counts songs only (plausible).** stale-push.ts:46-50 and its publish twin: same songs, older edits/counts can still push.
10. **Backend fragility (plausible).** Unparseable newest file → backend starts empty (recos, hubs, phone playlists); shared `.tmp` name for every write; hubs/phone-playlist files loaded once; reco tombstones capped at 1,000 and an origin:'user' add clears a delete.
11. **Hub reply can wipe a fresh edit (plausible):** edit during the ≤15 s converge request is overwritten (playlist-hub-sync.ts:82-102).
12. **Offline phone writes dropped/refused (proven by code).** Plays/listens sent once, dropped on failure (AudioPlayer.swift:152,166); playlist + Get Info edits refused offline; Get Info saves to the old cache key (LibraryStore.swift:413).
13. **Device-only by design:** EQ, crossfade, look, finish, queue, resume position.
14. **homemini's own desktop app:** its edits are overwritten when the laptop pushes + restarts it (sync.sh:384-399).

## Current rules (what exists)
- Song edits: phone overlay wins; desktop→phone ~15 s (publish_backend_library + 8 s poll); phone→desktop ≤ 5 min.
- Playlists (desktop): hub, newest modifiedAt wins whole playlist, string-compared stamps (desktopPlaylistHubRules.ts:62-100).
- Recommendations: homemini single writer, tombstones by id + song (reco-sync.ts:41).
- Artwork: rsync --update, first copy wins. iPod Pool: laptop single writer.

## Proposed stages (each: tests first, then live verification on all devices)
1. **Stop the bleeding:** gap 1 (workmini replica pushes only when laptop is newer by content + never under a running writer; return workmini's plays/edits), gap 8 (listening-log path), gap 7 (workmini deploy tests).
2. **One clock for edits:** per-field `modifiedAt` on overrides (desktop + phone), merge = newest field wins (fixes 3, 9); tombstones for deletes.
3. **Counts & stars:** phone/workmini plays as idempotent play EVENTS merged into playCount (2); stars as per-track LWW with tombstones (4).
4. **Playlists & pins:** removals/deletes as tombstones (5); pins as LWW synced via homemini + live sidebar reload (6); hub edit-race (11).
5. **Robustness:** offline outbox for phone writes (12); backend unique temps + reload + parse-fail fallback to last good (10).
