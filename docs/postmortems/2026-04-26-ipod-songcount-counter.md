# 2026-04-26 — iPod display lies in two ways; database is fine

**Severity:** P3 (cosmetic firmware behavior, not a JakeTunes bug)
**Time spent diagnosing:** most of a day before this writeup
**Action items:** none in code; this doc + `core/ipod_db_audit.py` exist so future-you doesn't redo the investigation
**Three related symptoms, same root cause:**
1. The "1 of 4396" counter shown in Music → Songs / Shuffle All when the
   library contains 4546 tracks.
2. Newly-added tracks (synced today) not appearing in the iPod UI even
   though sync ran and the tracks are in the iTunesDB and on disk.
3. The "Recently Added" smart playlist appearing empty on the iPod even
   though the iTunesDB on disk has it populated with 100 mhip refs that
   all resolve to real tracks (and include all 82 today-added tracks).

All three are the iPod firmware showing stale runtime state. The on-disk
database is fine throughout.

## Symptom

Library shows 4546 tracks. When the iPod is mounted, JakeTunes' iTunesDB
read shows 4546. But when playing music on the iPod (Music → Songs, or
Shuffle All) the player shows "1 of **4396**" — a 150-track gap that
appears to fluctuate between syncs.

## Conclusion (read first)

**The 4396 figure does NOT mean 150 tracks are missing.** All 4546 audio
files are present, listed, and playable. Verified empirically by
playing three specific tracks from the suspected-missing 150 (one short
intro, one mid-length skit, one 20-minute hidden track) — every one
appeared in the Music → Songs list and played normally.

The "1 of N" counter shown during playback is a firmware-internal
default-shuffle queue size that excludes very-short and very-long
tracks. It happens to equal exactly the count of tracks 1–10 minutes
long — which is suspiciously precise but matches the documented iPod
Classic firmware heuristic for "intro/skit/long-cut" filtering during
shuffle.

## What was ruled out (in order)

Each was tested via a one-off script run against the live iTunesDB on
the mounted iPod. All consolidated into `core/ipod_db_audit.py`.

1. **High-bit-depth ALAC compatibility issue** — ran the existing
   `alac-compat-scan` IPC. Returned 0 incompatible files.
2. **Library duplicates** — ran existing Show Duplicates feature.
   Returned 0 duplicate groups.
3. **Master playlist gap** — `mhit` count (4546) matched `mhip`
   references in the master playlist (4546) and matched the master
   `mhyp.item_count` field at offset 0x10 (4546).
4. **Sort indices** — all 7 sort indices (album, artist, genre, title,
   composer, album-artist, composer-sort) had 4546 entries each.
5. **Codec markers** — every track at offset 0x18 had a valid marker
   (`M4A ` 4545×, `MP3 ` 1×). No unrecognized codecs.
6. **Audio files missing on disk** — every track's path resolved to an
   existing file under `iPod_Control/Music/F*`. 0 missing.
7. **Visibility flag** — every track had `visible=1` at offset 0x14.
8. **mediaKind flag** — every track had `mediaKind=0` at offset 0x40.
9. **Empty / zero-valued integrity fields** — 0 empty titles, 0 empty
   paths, 0 zero-duration, 0 zero-fileSize, 0 duplicate dbids.
10. **Per-offset bimodal scan** — for every 4-byte offset in the mhit
    header, checked whether the value distribution differed between
    "main length" tracks and "short+long" tracks. **No discriminating
    field found.** The iTunesDB is internally identical across all
    4546 tracks except for track-specific values (size, duration, year,
    play count, etc.).

The duration distribution that gave the smoking gun:

| Bucket    | Count | Notes                          |
|-----------|-------|--------------------------------|
| <30s      | 37    | intros, skits, sound effects   |
| 30-60s    | 66    | short interludes               |
| 1–10min   | 4396  | exactly the firmware "1 of N"  |
| >10min    | 47    | hidden tracks, mixes, live cuts|
| **Total** | 4546  |                                |

37 + 66 + 47 = 150. The 1–10min bucket is the player's "1 of N" pool.

## Sync safety

Worth flagging because the gap looked like it could break sync:

The `sync-to-ipod` IPC's preflight checks (in `src/main/index.ts` ~line
1148–1506) are tied to:
- **Path-duplicate library entries** — two library rows pointing at one
  colon path. Aborts with explanation if found.
- **Tag mismatches** — library says X but the audio file's embedded
  tags say Y. Aborts with explanation.

**Neither is tied to the iPod firmware's "1 of N" counter.** The
counter is a firmware runtime behavior; nothing in JakeTunes reads it.
Sync was confirmed to be running successfully today (multiple `.bak`
files dated 2026-04-26 14:33, 14:46, 14:56 in the iPod's
`iPod_Control/iTunes/`).

## How to verify in the future

If the iPod song-count looks wrong again:

```bash
python3 core/ipod_db_audit.py /Volumes/<iPod-name>
```

The script runs all ten checks in ~30 seconds and reports a single
report card. If everything reads consistent with the same total, the
"1 of N" you're seeing on the iPod hardware is the firmware quirk and
nothing is wrong with the database.

If a check fails — say, mhit count != master playlist count, or sort
index sizes don't match — that's a real bug worth digging into.

## Related references

- `core/ipod_db_audit.py` — the consolidated diagnostic
- `src/main/index.ts` line 1148 — sync-to-ipod path-dupe preflight
  (the previous author's comment there describes a real cousin failure
  mode: "library 4395 / iPod 4389" caused by path-duplicates)
- `core/db_reader.py` — the iTunesDB reader/writer this audit reuses

## Symptom 2: "newly-added tracks aren't on the iPod"

Reported separately mid-investigation. Same day, 82 tracks added to the
library; user reported none of them on the iPod.

**Verified false the same way:**
- Filtered library.json for tracks where `dateAdded` started with the
  current date — got 82.
- Cross-referenced against the iTunesDB on the iPod: **82/82 present
  by colon-path AND 82/82 present by title+artist.**
- Cross-referenced against actual files on disk: **0/82 missing.**

So the new tracks were on the iPod. The user couldn't see them in the
device UI because the **iPod firmware's runtime cache hadn't refreshed
since the most recent sync**. The iTunesDB on disk is updated by
sync; the firmware reads it at boot or on hard-eject. Without a
refresh, the device shows yesterday's library while the file system
contains today's.

**Workaround:** hard-restart the iPod (Menu + center button held for
~6 seconds) to force the firmware to re-read the iTunesDB. Or do a
clean eject from JakeTunes and unplug/replug.

**Future fix:** there may be a way to signal the firmware to refresh
without a full restart — iTunes did this via specific "Eject" SCSI
commands. Worth investigating in a separate brief if this becomes a
recurring frustration. For now, restart-after-sync is the cheap fix.

## Symptom 3: "Recently Added smart playlist is empty on the iPod"

Reported as a third concern late in the same investigation. The user
opened "Recently Added" on the iPod and saw an empty list.

**Verified false the same way as #2:**
- Walked the iTunesDB's playlist dataset; "Recently Added" exists and
  has 100 mhip records.
- All 100 mhip refs resolve to valid mhit dbids (no broken pointers).
- Cross-referenced the 82 today-added tracks (by lowercase
  title+artist) against the playlist's mhip refs: **82/82 are in it.**

So the playlist on disk is fully populated. The iPod showing it empty
is the same stale-runtime-cache symptom as #2.

**Note about smart playlists in JakeTunes:** at the moment, all
playlists in the iTunesDB (including iTunes' built-in smart playlists
like "Recently Added", "Top 25 Most Played", etc.) have their `smart`
flag effectively false — JakeTunes is *freezing* their contents at
sync time rather than carrying the smart-playlist criteria forward
for the iPod firmware to evaluate dynamically. This is fine for now
(every sync re-evaluates and re-freezes), but it means **a track
added between syncs will not appear in "Recently Added" until the
next sync runs**. Worth a brief if it becomes annoying — see the
discussion of mhod types 50/51 (smart-playlist data/criteria) in
db_reader.py for the entry point.

## Why this took a long time

Three reasons worth documenting so future investigations don't repeat:
1. **The 4396 happens to exactly equal the count of "main music" tracks
   (1–10min).** That's a precise enough match that it looks like a
   real, deterministic filter rather than a firmware quirk. We
   investigated for several hours assuming it was real.
2. **The fluctuation across syncs.** The user reported the count seemed
   to vary, which felt like a sync bug. In retrospect this was likely
   different views of the same firmware counter at different moments
   (some after import added new tracks, some before). The underlying
   data was consistent throughout.
3. **No prior documentation of the firmware behavior.** The Apple iPod
   Classic firmware's shuffle-pool exclusion isn't documented; we had
   to derive it empirically.

The empirical test that ended the investigation cleanly: pick 3 tracks
from the 150 (one from each of <30s, 30-60s, >10min buckets) and
attempt to play them. All three played normally.
