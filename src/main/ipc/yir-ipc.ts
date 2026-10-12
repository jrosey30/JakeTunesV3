/**
 * Year in Review IPC (2026-10-12). 'yir:get' hands the renderer the mirrored
 * facts for a year (src/main/yir-mirror.ts); the mirror refreshes shortly
 * after boot and then every 30 minutes (the facts change once a night).
 */
import { app } from 'electron'
import type { IpcRegistrar } from '../ipc-register.ts'
import { REFUSED_SENDER } from '../ipc-register.ts'
import { refreshYirMirror, readYirMirror } from '../yir-mirror.ts'
import { nasAvailable, NAS_STATE_DIR_PATH } from '../state-dir'
import { MOBILE_BACKEND_URL } from './recommendations-ipc.ts'

const refresh = (year: number): Promise<'http' | 'nas' | null> => refreshYirMirror({
  year,
  localDir: app.getPath('userData'),
  nasDir: NAS_STATE_DIR_PATH,
  backendUrl: MOBILE_BACKEND_URL.replace(/\/audio$/, ''),
  nasAvailable,
}).catch(() => null)

export function registerYirIpc(ipc: IpcRegistrar): void {
  const thisYear = (): number => new Date().getFullYear()
  ipc.handle('yir:get', async (_e, year?: number) => {
    const y = Number.isInteger(year) ? Number(year) : thisYear()
    let facts = await readYirMirror(app.getPath('userData'), y)
    // First look on a machine that has never mirrored them: fetch now.
    if (!facts && (await refresh(y))) facts = await readYirMirror(app.getPath('userData'), y)
    return facts
  }, { refuse: REFUSED_SENDER })
  setTimeout(() => { void refresh(thisYear()) }, 8_000)
  setInterval(() => { void refresh(thisYear()) }, 30 * 60_000)
}
