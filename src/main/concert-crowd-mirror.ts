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
import { copyFile, mkdir } from 'fs/promises'
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
}): Promise<CrowdMirrorResult> {
  const log = deps.log ?? ((m: string) => console.warn(m))
  const copy = deps.copy ?? copyFile
  const makeDir = deps.makeDir ?? ((dir: string) => mkdir(dir, { recursive: true }))
  if (!(await deps.nasAvailable())) {
    log(`[concert-crowd] ${deps.mergedTrackId}: no NAS right now; the sync job carries the clip through homemini`)
    return 'waits-for-sync'
  }
  try {
    const dir = join(deps.nasDir, 'concert-crowd')
    await makeDir(dir)
    await copy(deps.clipPath, join(dir, `${deps.mergedTrackId}.m4a`))
    return 'copied'
  } catch (err) {
    log(`[concert-crowd] ${deps.mergedTrackId}: NAS copy failed (${err instanceof Error ? err.message : err}); the sync job carries the clip through homemini`)
    return 'waits-for-sync'
  }
}
