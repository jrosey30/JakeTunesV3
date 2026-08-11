/**
 * Library backup / restore IPC + last-sync snapshot readout.
 *
 * Extracted from main/index.ts. Logic stays in backup.ts /
 * sync-orchestrator.ts; this file only owns channel registration.
 */
import type { IpcRegistrar } from '../ipc-register.ts'
import { REFUSED_SENDER } from '../ipc-register.ts'
import { listBackups, snapshotLibrary, restoreBackup } from '../backup.ts'
import { getLastSyncSnapshot } from '../sync-orchestrator.ts'
import type { BrowserWindow } from 'electron'

export interface BackupIpcHost {
  getMainWindow: () => BrowserWindow | null
}

export function registerBackupIpc(ipc: IpcRegistrar, host: BackupIpcHost): void {
  // 4.5: settings UI reads this to display "Last backup: 3 min ago — Imports"
  // in the Sync tab. Pulled on tab open (and periodically while visible)
  // so the user gets the current state without subscribing to push events.
  ipc.handle('get-last-library-sync', async () => {
    return getLastSyncSnapshot()
  }, { public: true })

  // 4.5.0-117 — library backup/restore (Phase 0). Logic in src/main/backup.ts.
  ipc.handle('list-backups', async () => {
    return { ok: true, backups: await listBackups() }
  }, { public: true })

  ipc.handle('create-backup', async () => {
    const info = await snapshotLibrary('manual')
    return info
      ? { ok: true, backup: info }
      : { ok: false, error: 'Nothing to back up (library empty or unreadable).' }
  }, { refuse: REFUSED_SENDER })

  ipc.handle('restore-backup', async (_e, file: string) => {
    const res = await restoreBackup(file)
    // On success, library.json was rewritten — tell the renderer to reload.
    if (res.ok) host.getMainWindow()?.webContents.send('library-external-change')
    return res
  }, { refuse: { ok: false, error: 'refused-sender' } as const })
}
