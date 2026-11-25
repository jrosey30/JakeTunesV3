/**
 * The nightly check's orphan job, the part that deletes: the app's own
 * leftover temp files in the music folder (self-care-core.ts isAppTempFile:
 * a tag write's `.tagwrite-` copy, a `.tmp`), a day old or more. Song files
 * nobody points at are only counted (scanLibraryOrphans) and shown in
 * "Needs You"; Jake decides about those.
 *
 * Never follows a link and never walks into one, so it can't reach the vault
 * through a linked folder. The caller asks `localAudioDropRefused` first: on
 * homemini, or on a music folder that isn't on this Mac's own disk, nothing is
 * deleted at all.
 */
import { lstat, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { isAppTempFile } from './self-care-core.ts'

export interface TempSweep { removed: number; bytes: number; stopped: boolean }

export async function removeAppTempFiles(root: string, opts: { now: number; stillQuiet: () => boolean; log: (m: string) => void }): Promise<TempSweep> {
  const out: TempSweep = { removed: 0, bytes: 0, stopped: false }
  const walk = async (dir: string): Promise<void> => {
    let ents: import('node:fs').Dirent[]
    try { ents = await readdir(dir, { withFileTypes: true }) } catch (err) {
      opts.log(`[self-care] could not list ${dir}: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    for (const e of ents) {
      if (out.stopped) return
      if (!opts.stillQuiet()) { out.stopped = true; return }
      const p = join(dir, e.name)
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) { await walk(p); continue }
      if (!e.isFile()) continue
      // Name first (cheap), then the age from lstat.
      if (!isAppTempFile(e.name, 0, opts.now)) continue
      const st = await lstat(p).catch(() => null)
      if (!st || !st.isFile() || !isAppTempFile(e.name, st.mtimeMs, opts.now)) continue
      try {
        await unlink(p)
        out.removed++
        out.bytes += st.size
        opts.log(`[self-care] removed leftover ${p}`)
      } catch (err) {
        opts.log(`[self-care] could not remove ${p}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
  await walk(root)
  return out
}
