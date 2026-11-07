/**
 * A concert's crowd clip, mirrored into the NAS state dir so the phone's backend
 * (homemini, STATE_DIR = NAS) can serve it: GET /api/live-sets/:id/crowd.
 *
 * Cut once per show and never copied again here, so a copy this skips or fails
 * must still arrive. It does: the clip stays in userData/concert-crowd, and
 * JakeTunesMobile deploy/macbook-nas-sync.sh carries anything new in that folder
 * through homemini's own mount, add-only, away or home, within a minute or so.
 * This copy is the fast path at home, never the only one.
 */
import { copyFile, mkdir, rename, stat, unlink } from 'fs/promises'
import { join } from 'path'

export type CrowdMirrorResult = 'copied' | 'waits-for-sync'

export async function mirrorCrowdClipToNas(deps: {
  clipPath: string
  mergedTrackId: number
  nasDir: string
  nasAvailable: () => Promise<boolean>
  log?: (message: string) => void
  copy?: (from: string, to: string) => Promise<void>
  makeDir?: (dir: string) => Promise<unknown>
  publish?: (from: string, to: string) => Promise<void>
}): Promise<CrowdMirrorResult> {
  const log = deps.log ?? ((m: string) => console.warn(m))
  const copy = deps.copy ?? copyFile
  const makeDir = deps.makeDir ?? ((dir: string) => mkdir(dir, { recursive: true }))
  const publish = deps.publish ?? rename
  if (!(await deps.nasAvailable())) {
    log(`[concert-crowd] ${deps.mergedTrackId}: no NAS right now; the sync job carries the clip through homemini`)
    return 'waits-for-sync'
  }
  try {
    const dir = join(deps.nasDir, 'concert-crowd')
    await makeDir(dir)
    // Under a hidden name, then renamed. SMB can drop mid-copy, the sync job's retry only
    // adds, and a short file at the final name would stop it ever being repaired: the phone
    // would keep a torn clip while the log said the job carries it.
    const tmp = join(dir, `.${deps.mergedTrackId}.m4a.${process.pid}.tmp`)
    try {
      await copy(deps.clipPath, tmp)
      // A copy can come up short with no error, and that short file is what the rename makes permanent.
      if ((await stat(tmp)).size !== (await stat(deps.clipPath)).size) throw new Error('short copy')
      await publish(tmp, join(dir, `${deps.mergedTrackId}.m4a`))
    } catch (err) {
      await unlink(tmp).catch(() => { /* never made, or the share is gone */ })
      throw err
    }
    return 'copied'
  } catch (err) {
    log(`[concert-crowd] ${deps.mergedTrackId}: NAS copy failed (${err instanceof Error ? err.message : err}); the sync job carries the clip through homemini`)
    return 'waits-for-sync'
  }
}
