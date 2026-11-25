# Brief 265 (expanded) — One device-aware conversion architecture for every iPod, and the end of the Nano squeak

Jake's direction, 2026-11-24: fix the Nano first, but design the solution for the
entire collection. This should be the last fundamental revisit of audio conversion
architecture: adding another iPod means configuring a device profile, not
rewriting the sync engine. Do not introduce architectural changes where existing
code already works.

**Status: APPROVED by Jake, 2026-11-24, with four amendments and one final
safeguard** — persistent device identity (Part 2), versioned landed records
(Part 5), Gen 1 capability verification on arrival (Part 4), iTunesDB backup +
recovery (Part 3), and on-device file retention with storage-aware wave
staging during format replacements (Parts 2–3) — each folded into its part
and marked. **Validation order: fix and physically validate IndieSleaze
first; the proven solution then extends across the collection.**

## The collection (Jake's table, 2026-11-24 — this supersedes the code)

| Device | Model | Storage | Preferred format |
|---|---|---|---|
| Original | iPod Mini | 128 GB | ALAC |
| PunkPod | iPod Mini | 256 GB | ALAC |
| iBandcamp | iPod Video | 256 GB | **ALAC** (amended: Jake, 2026-11-24, "lets keep it"; it holds ~4,000 lossless files, nothing re-copied) |
| Y2KPod | iPod 3rd Gen | 40 GB | **ALAC** |
| IndieSleaze | iPod Nano | 8 GB | AAC 256 kbps |
| TBD | iPod 1st Gen | 10 GB | MP3 320 kbps |

**Correction to current code:** `src/common/ipod-audio-format.ts` hardcodes
Y2KPod → AAC 256. Jake's preference is ALAC. The hardcoded map also covers only
three devices; the other three follow the global Device-page toggle. Both facts
are superseded by Part 2 of this brief.

## Audit facts this brief builds on (Muse, read-only, current main)

1. One encode function serves every conversion: `buildAacMirror`
   (`src/main/index.ts`) — ffmpeg decodes the master to 44.1 kHz / 16-bit /
   stereo WAV; Apple's afconvert encodes AAC-LC, m4af, `-q 127`, `-s 0` (true
   CBR). Cache token `afenc-cbr-44100-2-v3`. MP3 goes through `buildMp3Mirror`
   (ffmpeg/libmp3lame, CBR, ID3v2.3 + ID3v1). FLAC/hi-res rescue goes through
   `buildIpodSafeAlacMirror` (16-bit / 44.1 kHz / stereo ALAC). The recipes are
   sound; keep them.
2. Transfer is whole-file `copyFile` from the local sync-convert cache, then
   `confirmWriteOnCard` (F_FULLFSYNC + **size check only — no content hash**).
3. iTunesDB stamping is inconsistent: `fileSize` is re-stamped from the actual
   on-card file before the DB write; `sampleRate` is stamped from the **library
   track** (the master's rate) and bitrate is not re-stamped from the file at
   all. For a converted track whose master is 48/96 kHz, the DB describes a
   different file than the one on the device.
4. History: the 2026-07-11 squeaks were ffmpeg-native AAC + 48 kHz pass-through
   (~1,135 files, Mini hardware decoder, software-clean). The current recipe is
   the fix for that generation — which is why Part 1 must establish which
   generation the Nano's on-device files actually are before anything is
   re-encoded.
5. Two sync engines (sync-engine, ipod-activity-engine) share the mirror
   builders and the card helpers. Any change lands in both, with the
   `core/db_reader.py` twins kept in step, per the TWIN comments.

---

## Part 1 — Diagnose the Nano (do this first, in this order)

The squeak has three candidate origins — encode generation, DB metadata,
transfer — and they are to be isolated, not fixed in a pile.

1. **Forensic probe.** Pull 2–3 squeaking files off the Nano itself
   (`iPod_Control/Music/F##/`), their cached mirrors, and their ALAC masters.
   For each, record: sample rate, channels, bitrate + mode (CBR/VBR), encoder
   string, duration vs master; **SHA-256 of the on-device file vs its cache
   mirror** (byte-identical or not); the iTunesDB mhit sampleRate/bitrate/
   fileSize vs the file's actual values. State which encode generation each
   squeaky file belongs to (ffmpeg-native? 48 kHz? VBR? current afconvert CBR?).
2. **Isolate metadata from encoding.** Take ONE squeaking song. Change nothing
   about its audio file; correct only its iTunesDB stamps to match the file
   (Part 3 logic, applied by hand or by a stamps-only resync). Jake listens.
   If the squeak is gone, metadata was the cause and no re-encode is needed.
3. **Isolate encoding.** If it still squeaks, replace that one file with a fresh
   current-recipe encode (stamps correct) and listen again.
4. **Alternative configurations** (only if a current-recipe afconvert CBR file
   still squeaks on the Nano): afconvert `-s 2` (VBR-constrained, the
   `convertAudio` aac@44100 recipe), then ffmpeg native AAC capped at
   44.1k/stereo. One variable at a time, same song, Jake's ears are the gate.
5. **Transfer verdict:** if the on-device file is byte-identical (hash) to a
   mirror that plays clean everywhere else, transfer is exonerated in writing
   in the PR.
6. **Gate:** the five-song test set (one known squeaker, one 48 kHz+ master if
   the library has one, three ordinary 44.1k ALAC) passes with zero squeaks on
   the physical Nano before any full 206-song resync is run.

## Part 2 — Device profiles (stored, per-device, no code changes to adjust)

Replace the hardcoded `FORMATS` map in `src/common/ipod-audio-format.ts` with
stored per-device profiles:

- **Keyed by persistent device identity where available** (Amendment 1, Jake,
  2026-11-24): the profile follows the physical iPod — its serial number /
  device identity as resolved by `src/common/ipod-identity.ts` — not merely its
  playlist/list id. The list id remains as a fallback key for a device whose
  identity can't be read, and as the migration path for the three profiles the
  hardcoded map keys today: on first profile-store read, a list-id entry is
  adopted onto the device's persistent identity when both are present. A
  renamed list, a recreated list, or a re-detected device must never orphan or
  duplicate a profile.
- **Stored in the existing device-settings state**, alongside the Device page's
  convert setting — not a new store, not a config file users edit by hand.
- **Profile fields:** target codec (`alac` | `aac` | `mp3`), target kbps for
  lossy targets (128/192/256/320), enabled flag. The Device page edits these
  per device; changing one never requires a code change or a new brief.
- **Seed defaults** (used only when a device has no stored profile yet) are
  Jake's table above: both Minis ALAC, iBandcamp ALAC (amended), Y2KPod ALAC,
  IndieSleaze AAC 256, Gen 1 MP3 320. Devices with no profile and no seed
  follow the existing global Device-page behavior, exactly as today.
- `convertOptionsForIpod` keeps its contract (a device's own format wins over
  the passed-in setting) but reads the profile store instead of the constant.
- **"ALAC" as a target means:** lossless masters go on as they are, subject to
  the existing playability rules — the ipod-safe ALAC mirror (16-bit /
  44.1 kHz / stereo) still rescues FLAC, multichannel, and over-ceiling files,
  and the existing `exceedsIpodPlayableCeiling` behavior is unchanged.
- **Format-change replacement:** when a device's profile changes (the Y2KPod
  AAC→ALAC correction is the first live case), the planner must treat on-device
  files that don't match the new target as replaceable: an AAC mirror sitting
  on an ALAC-profile device is queued for replacement by the master (or its
  ipod-safe mirror), and a lossless file on a newly-lossy-profile device is
  queued for conversion — reusing the existing retroactive-shrink logic's
  shape, driven by the profile instead of the global toggle. Unchanged tracks
  whose on-device file already matches the profile are never recopied.
  **Retention during replacement (final safeguard, Jake, 2026-11-24):** the
  original on-device file is never deleted until its replacement has been
  transferred, verified on the device, AND the new iTunesDB referencing the
  replacement has been successfully committed. A database backup alone cannot
  restore deleted audio — see the staging rules in Part 3.

## Part 3 — iTunesDB metadata describes the transferred file

- For every track, the DB stamps — fileSize, sampleRate, bitrate, duration —
  are taken from the **actual file that will sit on the device** (master,
  mirror, or ipod-safe ALAC), probed once and cached by path alongside
  `codecByAbsPath`. fileSize already works this way; make the other three
  consistent with it.
- Applies to converted and unconverted tracks alike (an unconverted track's
  stamps then trivially match its master, as they should).
- Both sync engines + the `core/db_reader.py` twins (`sample_rate_for_itunesdb`,
  mediatype) stay in step. Mediatype stays 1; no stamp is ever 0.
- Nothing else about the DB writer changes: playlists, artwork, play counts,
  ratings, and ordering logic are untouched.

### Backup before modification, and recovery (Amendment 4, Jake, 2026-11-24)

- **Before any sync that will write a device's iTunesDB or replace files under
  a format change, back up that device's current iTunesDB** (and iTunesSD
  where the device uses one) to the device's state dir on the Mac, timestamped,
  keeping the last several backups per device. No backup, no DB write — the
  sync refuses rather than proceeding unprotected.
- **Recoverability invariant:** a failed or interrupted sync leaves the device
  in one of two consistent states — the old DB describing the old files, or
  the new DB describing the fully-transferred new files. The existing order of
  operations already supports this (files transfer and verify first; the DB is
  written last): state it as an invariant the code must keep, and make the
  recovery path explicit — restoring a backup DB over a device whose sync died
  mid-replacement returns it to the pre-sync catalog, and the next sync
  requeues whatever the landed records (Part 5) say is missing or stale.
- Format-replacement syncs (Part 2) get the backup before the **first file
  replacement**, not just before the DB write.
- **File retention and storage-aware staging (final safeguard, Jake,
  2026-11-24):** a DB backup restores the catalog, not the audio. During a
  format replacement, the outgoing on-device file stays on the device until
  its replacement is transferred, verified on the device (size, and the
  existing confirm/remount machinery), and the new iTunesDB pointing at the
  replacement has been committed. Only then is the old file deleted.
  Replacements therefore proceed in **waves sized to the device's free
  space**: stage and verify as many replacements as fit alongside the
  originals, commit the DB, delete that wave's originals (freeing space),
  then continue. On a nearly-full device (IndieSleaze: 206 lossless songs on
  8 GB) a wave may be only a few songs — that is expected, not an error. If
  free space cannot hold even one replacement alongside its original, the
  sync stops and reports it; it never deletes first to make room. An
  interrupted wave leaves the pre-wave DB valid: uncommitted replacement
  files are orphans the next sync cleans up, and no track is ever left
  pointing at a deleted file.

## Part 4 — First-generation MP3 protocol (prepare now, verify on arrival)

The device (EOE refurbished 1st-gen, 10 GB) is in transit, not yet in hand.
Prepare the protocol; mark every part of it UNVERIFIED until the physical
device passes a sync + playback test.

- Preferred target: MP3 320 kbps CBR, 44.1 kHz, stereo, ID3v2.3 + ID3v1 —
  which is exactly what `buildMp3Mirror` already produces. No new encoder work.
- Profile seeded for the Gen 1 list id (already in code:
  `f8ff5c4e-f4d1-41a7-9c4c-57cca2f867ca`), to be adopted onto the device's
  persistent identity on arrival (Part 2).
- **MP3 320 is the preferred format, not an assumption about the firmware's
  limits** (Amendment 3, Jake, 2026-11-24). Do not hardcode "MP3 only" into
  the profile system. On the device's arrival, verify its actual firmware
  capabilities empirically — MP3 is the documented baseline; WAV/AIFF and any
  other claimed format are tested on the physical unit before the profile is
  treated as settled — and record the verified capability set on the profile.
  Until then the working rule is: every non-MP3 source converts to the MP3
  target; MP3 sources go on untouched.
- Known open risk, stated plainly: the 1st-gen iTunesDB write path itself is
  unproven (blank-catalog DB header behavior on 1.x firmware). That is a
  database question, not an audio question — this brief does not claim to
  settle it. The test matrix (Part 6) lists Gen 1 DB compatibility as
  UNVERIFIED until the device is in hand and a Finder-created first DB has
  been backed up as the template, per the existing 1st-gen plan.

## Part 5 — Cache management (local, managed, never the NAS, never the library)

Jake's ruling: a managed local conversion cache is acceptable for performance.
Original masters untouched; no converted files on the NAS; no duplicate
library. Build the management layer the current cache lacks:

- **Partial cleanup:** on app startup, sweep `sync-convert-cache` for
  `*.partial.*` and delete them. (Today the WAV partial is cleaned in a
  `finally` and the m4a partial on encode failure, but a hard kill strands
  both.)
- **Configurable size limit + automatic pruning:** a settings value (GB) for
  the cache cap; when exceeded, prune least-recently-used mirrors first.
  Pruning must never delete a mirror mid-sync.
- **Manual clear:** a Device-page (or Settings) action that empties the cache,
  with the same mid-sync protection.
- **Cache loss must not cause retransfers:** today the planner's keep-decision
  for a converted track leans on the cached mirror's size. Add a persistent
  per-device **landed record**, written at sync time from `writtenById`. Per
  Amendment 2 (Jake, 2026-11-24), each entry records: destination path,
  on-device file size, **source-file revision** (the master's path + mtime +
  size at encode time), **target bitrate**, and **encoding recipe version**
  (the cache-key token, e.g. `afenc-cbr-44100-2-v3`). The planner consults the
  landed record first, and a track is kept **only when every field still
  matches**: the on-device file is the recorded size, the device's profile is
  unchanged, the source revision is unchanged, and the recipe version is
  current. Any mismatch requeues that track alone — a re-ripped master, a
  bitrate change, or a recipe bump must never leave stale audio on a device
  because a size happened to match. With all fields matching, the track is
  kept even with an empty cache; a mirror is rebuilt only when the track
  actually needs (re)copying.
- Cache keys keep the recipe token, so a future recipe change still
  invalidates mirrors exactly as v3 did.

## Part 6 — Compatibility test matrix (deliverable of the PR)

A table in the PR, one row per device, columns: preferred format · firmware
requirements · DB metadata verified · conversion behavior · incremental sync ·
status. Every cell is labeled one of:

- **AUTOMATED** — covered by a unit/integration test that runs in `npm test`.
- **PHYSICAL** — verified by an actual sync + playback on the real device.
- **UNVERIFIED** — not yet established; say so, don't imply it.

Minimum automated coverage:

- Profile resolution: stored profile wins; seed defaults match Jake's table
  (incl. Y2KPod = ALAC); unknown device falls back to today's behavior.
- Format-change replacement: AAC-on-device + profile→ALAC queues replacement;
  matching files are kept; profile→lossy queues conversion of lossless only.
- DB stamps: a converted track's sampleRate/bitrate/fileSize equal its
  mirror's probed values, incl. a 48 kHz master → 44.1 kHz stamps case.
- Cache: partial sweep deletes only partials; pruning respects the cap and
  LRU order; landed record keeps tracks after a cache clear (planner-level
  test, no device).
- Profile identity: a profile keyed to a device's persistent identity survives
  a list rename and a list recreation; the list-id fallback adopts onto the
  persistent identity without duplicating the profile.
- Landed-record invalidation: a changed source revision (mtime/size), a
  changed target bitrate, or a bumped recipe version each requeue exactly the
  affected track; a full match keeps it with an empty cache.
- DB backup: a DB-writing sync writes a timestamped backup first and refuses
  to proceed without one; restoring a backup over an interrupted
  format-replacement sync yields the pre-sync catalog, and the following sync
  requeues only the tracks the landed records mark stale or missing.
- Replacement staging: an original is deleted only after its replacement is
  verified and the DB commit referencing it succeeds; wave sizing never
  exceeds free space; a simulated interruption mid-wave leaves a valid DB
  and zero tracks pointing at deleted files; a device with room for zero
  replacements reports and stops instead of deleting.
- Recipe pins: `buildAacMirror` / `buildMp3Mirror` argument pins in the style
  of `background-priority.test.ts` (afconvert AAC-LC CBR 44.1k stereo;
  libmp3lame CBR 44.1k stereo ID3v2.3).
- Both engines consume the same profile + stamp code paths (no forked logic).

Physical gates (Jake's ears, real hardware):

- Nano five-song test (Part 1) — before the 206 resync.
- Y2KPod: one playlist sync under its corrected ALAC profile; on-device AAC
  files from any earlier sync are replaced, ALAC plays.
- iBandcamp: one playlist sync through the corrected AAC pipeline; no squeaks.
- Minis: regression — an ALAC playlist sync behaves exactly as before.
- Gen 1: everything UNVERIFIED until the device arrives.

## Guardrails

- ALAC sync/playback behavior for the Minis and PunkPod must not change,
  except that their target now comes from a profile instead of a toggle.
- Preserve device playlists, artwork, metadata, play counts, and ratings.
- Incremental sync stays incremental: no profile, stamp, or cache change may
  cause a mass recopy of unchanged, correctly-formatted tracks. The landed
  record (Part 5) exists precisely to guarantee this.
- Masters are never written by any part of this work. Conversion output lives
  only in the local cache and on the devices.
- `npm run build` is the gate; `npm test` for the main-process tests.
- File this brief under `Dr. Claude/` in the repo with the PR.

## Sequencing

1. Part 1 forensic + isolation (Nano) — facts before code.
2. Part 3 DB stamps (it is Part 1's isolation tool and a fix either way).
3. Part 2 profiles + Y2KPod correction + format-change replacement.
4. Part 5 cache management + landed record.
5. Part 4 Gen 1 prep (code-side only; verification waits for the hardware).
6. Part 6 matrix assembled across the above; physical gates as devices allow.
