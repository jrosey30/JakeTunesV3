# The IndieSleaze nano squeak: what was wrong, what changed, why it worked

Brief 265, 2026-11-24. Written for Jake; the technical detail is in the appendix.

## In short

The songs that squeaked were songs JakeTunes had converted to make them smaller. The app was
meant to convert them with Apple's encoder (the one iTunes always used), but a broken check
made it use ffmpeg's encoder every time instead, and nothing said so. The nano's chip doesn't
play ffmpeg's version cleanly. The same songs converted with Apple's encoder play clean.

The fix: the check now works, and if Apple's encoder is ever missing the app refuses to
convert and says so, instead of quietly using another encoder.

## What you heard

- About 85% of the nano's songs squeaked, by your count.
- The songs JakeTunes had converted squeaked ("Do I Wanna Know?", "Human", "Hustler").
- Songs copied as they were in the library did not: "A-Punk", "360", "Shuffle".

On the nano: 119 of 210 songs were converted by JakeTunes, 89 were the library's own AAC files
copied as is, and 2 were MP3s.

## The cause

Before converting, the app asks "is Apple's encoder (afconvert) on this Mac?". It asked by
running `afconvert --help` and checking that it finished without an error code. But
`afconvert --help` always finishes with error code 2, even when afconvert works perfectly.
So the answer was always "no", and every conversion went to the backup plan: ffmpeg's own
AAC encoder.

Nothing looked wrong, because the converted files were still saved under the name meant for
Apple's recipe (`afenc-cbr-44100-2-v3`). That was the July fix for the first squeaks: it
never actually ran.

**Proven:** running ffmpeg's recipe on the "Do I Wanna Know?" master again gives a file that
is byte for byte identical to the one on the nano. Apple's recipe gives a different file.

## How we narrowed it down (one thing at a time)

1. **Was the copy to the iPod damaged?** No. The file on the nano was byte for byte the same
   as the converted file on the Mac (SHA-256 for "Do I Wanna Know?" and "Human").
2. **Was the iPod's song list describing the file wrongly?** Not for these songs. Its sample
   rate, size, bitrate and length matched each file. (Every master on the nano is 44.1 kHz
   except two Libertines songs at 96 kHz.)
3. **Do unconverted songs squeak?** You played "A-Punk", "360" and "Shuffle": clean. So it
   was the converted files.
4. **One song, one change:** "Do I Wanna Know?" was replaced with Apple's encode, and its
   entry in the song list was corrected to the new file's size and bitrate. Nothing else
   changed. You heard it clean, and "Human" (still ffmpeg) still squeaked.
5. **Five-song gate:** "Do I Wanna Know?", "Human", "Hustler", "Maps", and "What Katie Did"
   (the 96 kHz master), all Apple's encode. All clean. The "say say say" in "Maps" is in the
   recording.

Before every change the iPod's song list and the original files were backed up on the Mac
(`~/Library/Application Support/JakeTunes/ipod-db-backups/2a2f2e5c-…/`).

## What changed in the app

- The check reads afconvert's list of what it can write, which it prints however it exits.
  On this Mac it now says yes.
- There is no ffmpeg fallback for iPod AAC any more. If afconvert is ever missing, the song is
  not converted and the sync names it. It is never copied as a different encode or as the
  big lossless file instead.
- The converted files have a new name (`…-v4`), so the old ffmpeg files are never used again.
  They are still on the Mac's disk; nothing was deleted.
- Tests check all of this, including that `afconvert --help` really does exit with an error
  code (so the old mistake can't come back unnoticed) and that no ffmpeg AAC path exists.
- Also from the brief: the iPod's song list now takes sample rate, bitrate and length from the
  converted file itself, and the song list is backed up on the Mac before every sync rewrites
  it.

## What it means for each iPod

| iPod | Effect |
|---|---|
| IndieSleaze (nano) | Its ~114 remaining ffmpeg songs get Apple's encode, replaced the same careful way as the gate. |
| iBANDCAMP | Nothing on it was converted to AAC (its lossless songs went on as ALAC), so this squeak can't be on it. |
| Y2KPod | ALAC; nothing converted, nothing to replace. |
| Original, punkPod | ALAC; unchanged. |
| Gen 1 | MP3 uses a different converter (LAME through ffmpeg), not this one. Untested until it arrives. |

## What is proven and what isn't

- **Proven:** the squeaking files were ffmpeg's encode; the same songs encoded by Apple's
  encoder play clean on this nano (six songs counting the one before the gate, your ears);
  the copy and the song list were not the cause for the songs checked.
- **Not proven:** which difference inside ffmpeg's file the nano's chip trips on. The
  appendix lists the differences. We fixed it by changing the encoder, not by finding the
  one detail.
- **Not yet tested:** a full sync through the new code on any iPod.

---

## Technical appendix

### The probe

`afconvertAvailable()` (src/main/index.ts) ran
`promisify(execFile)('afconvert', ['--help'])`. execFile rejects on a non-zero exit;
`afconvert --help` exits 2 and `afconvert -hf` exits 1 on macOS 26.6. The catch returned
false, `buildAacMirror` took its "non-macOS / afconvert missing" branch:
`ffmpeg -c:a aac -b:a 256k -ar 44100 -ac 2 -map_metadata 0 -movflags +faststart`, and wrote the
result under `sha1(src|256|afenc-cbr-44100-2-v3)`.

Reproduction: that command on `F27/imported_14677.m4a` (ffmpeg 8.1.2) gives SHA-256
`2ac49b81…411fc3`, the nano's file and the cached mirror. The afconvert recipe
(ffmpeg → 44.1k/16/stereo WAV → `afconvert -d aac -f m4af -b 256000 -q 127 -s 0`) gives a
different file, 8,772,033 vs 8,848,965 bytes. Two afconvert runs of the same master give the
same size and differ in 12 bytes (container timestamps).

### Box-level differences

| | ffmpeg AAC (squeaks) | iTunes / library AAC (clean) | afconvert v4 (clean) |
|---|---|---|---|
| Encoder tag | `Lavf62.12.102` | `iTunes 12.1.3.6` or none | none |
| Layout | moov before mdat (faststart) | varies | ftyp, moov, free, mdat |
| esds bufferSizeDB | 0 | 6144 | 6144 |
| esds max / avg bitrate | 258450 / 258450 | 340208 / 256000 (A-Punk) | 260968 / 256000 |
| AudioSpecificConfig | 5 bytes `12 10 56 e5 00` (AAC-LC 44.1k stereo + explicit "no SBR" extension) | 2 bytes `12 10` | 2 bytes `12 10` |
| Encoder delay / gapless | edit list (`elst` media_time 1024) | iTunSMPB atom, no edit list | iTunSMPB atom, no edit list |
| `sgpd` / `sbgp` roll groups | present | absent | absent |
| Last packet | 36 samples (stts entry `(1, 36)`) | full 1024 | full 1024 |
| Packet size spread (stdev, bytes) | ~70–94 | ~174 (A-Punk) | — |

Plausible culprits, **not isolated**: the 5-byte ASC with the SBR extension, bufferSizeDB 0,
and the bitstream itself (ffmpeg's encoder makes different choices). The container items
(edit list, roll groups, short last packet) would more likely give a click at the start or end
than squeaks throughout. Testing any of these one by one would mean remuxing ffmpeg's stream
with one box changed and listening; not needed for the fix.

### Device

USB product id 0x1260 (believed to be a 2nd-generation nano; SysInfo is empty). The iTunesDB
has no hash58/hash72, so the hand edits for the test needed no checksum.

### Code

- `src/main/aac-mirror-recipe.ts`: `probeAfconvert` (reads `-hf`'s listing on stdout, stderr
  or the rejection), `AacEncoderMissingError`, `AAC_MIRROR_TOKEN = 'afenc-cbr-44100-2-v4'`,
  `aacMirrorCacheName`, the pinned argument lists.
- `buildAacMirror` throws `AacEncoderMissingError` instead of falling back; both engines skip
  and name the song (`isAacEncoderMissing`).
- `src/main/ipod-file-stamps.ts`, `src/main/ipod-db-backup.ts`: Part 3.
- Tests: `aac-mirror-recipe.test.ts`, `ipod-file-stamps.test.ts`, `ipod-db-backup.test.ts`,
  `background-priority.test.ts` (recipe pin now 3 converter calls).
- `scripts/ipod-forensic.py`: the read-only probe used here.
