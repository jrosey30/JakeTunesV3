# Brief 265 Part 6: compatibility matrix

As of 2026-11-25, after #487, #494, #497, #499, #503 and #504 (in review), plus this PR.

Every cell is one of:
- **AUTOMATED**: a test in `npm test` covers it;
- **PHYSICAL**: shown by a real sync and Jake listening on the real iPod;
- **UNVERIFIED**: not established yet.

## Per iPod

| iPod | Format (profile default) | Firmware needs | iTunesDB describes the file | Conversion | Incremental sync | Status |
|---|---|---|---|---|---|---|
| **IndieSleaze** (nano, 8 GB) | AAC 256 (seed) | AAC-LC 44.1 kHz stereo; plays Apple's encode clean, squeaks on ffmpeg's: **PHYSICAL** (five-song gate, 2026-11-24) | Stamps from the converted file: **AUTOMATED**. Matched on the card for all 210 songs after the re-copy (read-only probe): **PHYSICAL** | Apple `afconvert` CBR only, refused without it: **AUTOMATED**. All 119 converted songs re-encoded and re-copied by hand (gate method): **PHYSICAL** | Converted songs kept through an emptied cache (landed record): **AUTOMATED**. First real sync after the re-copy: **UNVERIFIED** | Gate passed. Jake's spot-check of the full re-copy ("Zero", "Fuck Forever", "Cheated Hearts"): **UNVERIFIED** (not reported) |
| **Y2KPod** (3rd gen, 40 GB) | ALAC (seed; was AAC 256 in code) | ALAC 16-bit/44.1; iPod-safe ALAC rescue for hi-res/FLAC (unchanged) | ALAC masters stamp as before (not probed); rescues probed: **AUTOMATED** | None (ALAC = convert nothing, even with the Device page toggle on): **AUTOMATED** | Zero re-copy on the real engine with its real manifest sizes (373 + 46): **AUTOMATED** | Real sync under the ALAC profile: **UNVERIFIED** |
| **iBANDCAMP** (iPod Video, 256 GB) | ALAC (seed; Jake: "lets keep it") | ALAC 16-bit/44.1; rescues as above | As Y2KPod: **AUTOMATED** | None: **AUTOMATED** | Zero re-copy on the real engine with its real manifest sizes (4,010 + 1,415): **AUTOMATED** | Real sync: **UNVERIFIED** |
| **punkPod** (mini, 256 GB) | ALAC (seed) | ALAC (unchanged) | As before; not probed: **AUTOMATED** | None: **AUTOMATED** | Unchanged swap planner: **AUTOMATED** (existing suites) | Regression sync: **UNVERIFIED** |
| **Original** (mini, 128 GB) | ALAC (primary seed) | ALAC (unchanged) | As before (full-library engine; never overwrites a song its song list names, #499): **AUTOMATED** | None by default | Unchanged: **AUTOMATED** (existing suites) | Regression sync: **UNVERIFIED** |
| **Gen 1** (10 GB, in transit) | MP3 320 (seed) | MP3 is the documented baseline; WAV/AIFF and others to be tested on the unit before the profile is settled (Amendment 3) | `buildMp3Mirror`: libmp3lame CBR 44.1k stereo, ID3v2.3 + ID3v1 (recipe pinned): **AUTOMATED** | Every non-MP3 → MP3 320; MP3 untouched: **AUTOMATED** | **UNVERIFIED** | Everything on the device, including the 1st-gen iTunesDB write path: **UNVERIFIED** |

## Across every iPod

| | Status |
|---|---|
| One encoder path for AAC (Apple's), refused without it; the old `--help` check can't come back | AUTOMATED |
| ffmpeg-made v3 mirrors never reused (v4 key); the 119 on this Mac removed by the logged script | AUTOMATED + done (log in userData/logs) |
| Profiles keyed by the iPod's serial; renamed / recreated / moved / two cards | AUTOMATED |
| An unreadable profile file refuses the sync | AUTOMATED |
| The iTunesDB backed up on the Mac before every catalog write; restore path | AUTOMATED |
| Format change replaced in waves, originals kept until the catalog is committed; never a wipe; interrupted runs resumed from the journal | AUTOMATED (real engine, incl. the reviews' scenarios A–F) |
| A journal that can't be settled has a way out: restored with no song list file and no songs → the journal is dropped. With an empty song list file (Finder's restore), the sync is a full copy. With no file at all, the sync stops and asks for Finder setup, then syncs normally. If the song list can't be read 3 syncs in a row, the journal is dropped too. | AUTOMATED (this PR: G, G2, H) |
| No song list file on the iPod (missing, or not an iTunesDB): nothing is removed or wiped, the sync stops with a plain message. Before this, a full copy wiped the iPod and then failed writing the song list, leaving it empty. | AUTOMATED (this PR: G, H; mutation-checked) |
| Whether Finder's restore of each model leaves an iTunesDB behind | UNVERIFIED (needs a restore on the device; the sync covers both cases either way) |
| Convert cache: no default trimming; a limit never takes a copy a song on an iPod was made from; Empty only after a confirm that says the cost | AUTOMATED |
| Both engines read the same profile and stamp code | AUTOMATED |
| Hidden side names (`.name.jtorig`) on a FAT (iFlash) card | UNVERIFIED |
| A real format change, and a wave cut off, on a physical iPod | UNVERIFIED |

## What would move a cell to PHYSICAL
- **IndieSleaze:** Jake plays "Zero", "Fuck Forever" and "Cheated Hearts", then one normal Sync on the fixed build. It should swap nothing and keep all 210.
- **Y2KPod, iBANDCAMP, punkPod, Original:** one normal Sync each on the fixed build. Each should keep every song, with nothing converted or copied.
- **Gen 1:** on arrival, back up a Finder-made first iTunesDB as the template, sync one playlist, play an MP3, and test WAV/AIFF before recording the verified formats on its profile.
