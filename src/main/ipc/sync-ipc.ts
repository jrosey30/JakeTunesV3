/**
 * Sync IPC: cancel, journal readout, iPod DB read, sync-to-ipod entry,
 * state-conflict reconcile surface.
 *
 * The ~900-line `runSyncToIpod` engine and `preview-ipod-sync` planner
 * stay in main/index.ts for this slice — they share mount/codec/convert
 * closures with the copy loop. Registration moves here so new sync
 * channels default-deny via createIpcRegistrar; host methods keep the
 * engine wiring in one place.
 */
import { app } from 'electron'
import { join } from 'path'
import { readFile } from 'fs/promises'
import type { IpcMainInvokeEvent } from 'electron'
import type { IpcRegistrar } from '../ipc-register.ts'
import { REFUSED_SENDER } from '../ipc-register.ts'
import { STATE_IS_NAS, NAS_STATE_DIR_PATH, isNasMounted } from '../state-dir.ts'

export interface StateConflict {
  file: string
  localPath: string
  nasPath: string
  localMtimeMs: number
  nasMtimeMs: number
  localSizeBytes: number
}

export interface SyncConvertOptions {
  enabled: boolean
  targetKbps: 128 | 192 | 256
}

export interface SyncIpcHost {
  /** Flip cancel flag; returns whether a sync was in flight. */
  requestSyncCancel: () => { wasRunning: boolean }
  /**
   * Full sync-to-ipod entry (concert filter, hang lock, journal, engine).
   * Body stays in index.ts next to runSyncToIpod.
   */
  syncToIpod: (
    tracks: Array<Record<string, unknown>>,
    playlists: Array<Record<string, unknown>>,
    convertOptions?: SyncConvertOptions,
    syncOpts?: { wipeFirst?: boolean },
  ) => Promise<unknown>
  /** Pull new tracks from device DB not already in the library. */
  syncIpodFromDevice: (existingIds: number[]) => Promise<unknown>
  readIpodDatabase: () => Promise<{
    tracks: Array<Record<string, unknown>>
    playlists: Array<{ name: string; trackIds: number[] }>
  }>
  getStateConflicts: () => StateConflict[]
  reconcileStateConflicts: (
    event: IpcMainInvokeEvent,
  ) => Promise<{ ok: boolean; pushed: number; backups: string[]; error?: string }>
}

function ipodSyncJournalPath(): string {
  return join(app.getPath('userData'), 'ipod-sync-journal.json')
}

export function registerSyncIpc(ipc: IpcRegistrar, host: SyncIpcHost): void {
  ipc.handle('cancel-sync', async () => {
    const { wasRunning } = host.requestSyncCancel()
    return { ok: true, wasRunning }
  }, { refuse: REFUSED_SENDER })

  // Pull side (authoritative — no boot race): the renderer asks once its
  // UI is actually mounted.
  ipc.handle('get-ipod-sync-journal', async (): Promise<{ phase: string; at?: string } | null> => {
    try {
      const j = JSON.parse(await readFile(ipodSyncJournalPath(), 'utf-8')) as { phase?: string; at?: string }
      return j?.phase ? { phase: j.phase, at: j.at } : null
    } catch { return null }
  }, { public: true })

  ipc.handle('get-ipod-db-tracks', async () => {
    try {
      const ipodData = await host.readIpodDatabase()
      return { ok: true, tracks: ipodData.tracks, playlists: ipodData.playlists, total: ipodData.tracks.length }
    } catch (err) {
      return { ok: false, error: String(err), tracks: [], playlists: [], total: 0 }
    }
  }, { public: true })

  // Sync: read iPod DB and return NEW tracks/playlists not already in the library
  ipc.handle('sync-ipod', async (_e, existingIds: number[]) => {
    return host.syncIpodFromDevice(existingIds)
  }, { public: true })

  ipc.handle('sync-to-ipod', async (_e, tracks: Array<Record<string, unknown>>, playlists: Array<Record<string, unknown>>, convertOptions?: SyncConvertOptions, syncOpts?: { wipeFirst?: boolean }) => {
    return host.syncToIpod(tracks, playlists, convertOptions, syncOpts)
  }, { refuse: { ok: false, copied: 0, error: 'refused-sender' } as const })

  ipc.handle('get-state-conflicts', (): {
    mode: 'NAS' | 'local-primary'; nasDir: string; localDir: string; nasMounted: boolean; conflicts: StateConflict[];
  } => {
    return {
      mode: STATE_IS_NAS ? 'NAS' : 'local-primary',
      nasDir: NAS_STATE_DIR_PATH,
      localDir: app.getPath('userData'),
      nasMounted: isNasMounted(),
      conflicts: host.getStateConflicts(),
    }
  }, { public: true })

  ipc.handle('reconcile-state-conflicts', async (event): Promise<{ ok: boolean; pushed: number; backups: string[]; error?: string }> => {
    return host.reconcileStateConflicts(event)
  }, { refuse: REFUSED_SENDER })
}
