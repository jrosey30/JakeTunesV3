/**
 * Is a rip finished? Jake, 2026-11-05: three songs in the library named "02. MJ Lenderman - Joker
 * Lips" with no artist. On a slow link the clock killed `rip` mid-transfer. streamrip writes to the
 * final file name as it goes and tags last, so the kill left a cut-off, untagged file that looked
 * like a result, and it was imported: 2:33 of a 3:01 song, named after the file. Pure, so the rules
 * have tests.
 */

/** What the file's tags say. */
export interface RipFileTags { title: string; artist: string; albumArtist?: string }

/**
 * streamrip tags a file as its last step, so a file with no title or no artist never finished.
 * Applies to a rip that exited on its own too: streamrip can exit nonzero after finishing, and it
 * can crash before tagging.
 */
export async function finishedRipFiles(files: string[], tagsOf: (file: string) => Promise<RipFileTags>): Promise<string[]> {
  const out: string[] = []
  for (const file of files) {
    const t = await tagsOf(file)
    if (t.title.trim() && (t.artist.trim() || (t.albumArtist ?? '').trim())) out.push(file)
    else console.warn(`[streamrip] refusing an untagged file, the rip never finished it: ${file.slice(file.lastIndexOf('/') + 1)}`)
  }
  return out
}

/** How much shorter than its own header a file may decode. */
export const RIP_SHORT_SEC = 2

/**
 * A dropped connection can end a transfer early with no error, and then streamrip tags what it got:
 * Tinashe's "Popstar" came in as 38 seconds of 2:47, tagged. A FLAC header still says the whole song,
 * so the file has to be decoded to know. Null from either side means it couldn't be measured, and a
 * file that can't be measured passes: the import's own checks stand behind it.
 */
export function cutShort(headerSec: number | null, decodedSec: number | null): boolean {
  if (headerSec == null || decodedSec == null) return false
  return headerSec - decodedSec > RIP_SHORT_SEC
}

/** ffmpeg's -stats prints "time=00:02:33.04" as it decodes: the last one is the length. */
export function decodedSecFromStats(stderr: string): number | null {
  const all = [...stderr.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)]
  const m = all[all.length - 1]
  if (!m) return null
  const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
  return Number.isFinite(sec) && sec > 0 ? sec : null
}

/** A transfer past its clock keeps going while bytes keep landing, up to this long in all. */
export const RIP_HARD_CAP_MS = 45 * 60 * 1000
/** How often a transfer past its clock is looked at. */
export const RIP_PROGRESS_CHECK_MS = 20 * 1000
/** Looks in a row with no new bytes before it's called dead (tagging takes a moment). */
export const RIP_QUIET_LOOKS = 2

/**
 * Should a rip past its deadline live on? Yes while its file is still growing: a slow link is not a
 * dead one, and stopping at the deadline throws away everything that landed. Nothing here is imported
 * unless the rip finishes on its own.
 */
export function createRipProgress(bytesNow: () => Promise<number>): () => Promise<boolean> {
  let last = -1
  let quiet = 0
  return async () => {
    const now = await bytesNow().catch(() => last)
    if (now > last) { last = now; quiet = 0; return true }
    quiet += 1
    return quiet < RIP_QUIET_LOOKS
  }
}
