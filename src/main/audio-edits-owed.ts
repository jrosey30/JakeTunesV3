/**
 * The audio edits no music leg has carried yet (2026-11-06).
 *
 * A Get Info edit rewrites the file's tags, often at the same size. Only the sync script's
 * quick leg can carry that to the NAS, the copy Plex reads: the full leg is --size-only and
 * hop 1 only adds. It looks back 10 minutes, so an edit made away from home, or with the NAS
 * breaker open, went nowhere. So every rewrite leaves a line here, and the quick leg takes the
 * list and clears it only once it has carried it.
 *
 * Append-only, one absolute path a line. The script takes the file aside by rename, so an
 * append during its leg just starts a new file.
 *
 * ⚠️ TWIN: Dr. Claude/scripts/jaketunes-homemini-sync.sh OWED_EDITS reads this file, at this path.
 */
import { appendFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'

export const AUDIO_EDITS_OWED_FILE = 'audio-edits-owed.txt'

/** The script's folder, not Electron's userData, so a dev run's edit to the real library still
 *  counts. Null outside the app: tests run writeTagsToFile on temp files, and no line of theirs
 *  belongs in the real list. */
export function audioEditsOwedPath(): string | null {
  if (!process.versions.electron) return null
  return join(homedir(), 'Library', 'Application Support', 'JakeTunes', AUDIO_EDITS_OWED_FILE)
}

/** Never throws: the edit itself has already landed, and only its trip to the NAS is at stake. */
export async function noteAudioEditOwed(
  filePath: string,
  opts: { listPath?: string | null; log?: (message: string) => void } = {},
): Promise<void> {
  const listPath = opts.listPath === undefined ? audioEditsOwedPath() : opts.listPath
  if (!listPath) return
  try {
    await appendFile(listPath, `${filePath}\n`)
  } catch (err) {
    (opts.log ?? ((m: string) => console.warn(m)))(`[audio-edits-owed] could not note ${filePath}: ${err instanceof Error ? err.message : err}`)
  }
}
