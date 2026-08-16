/**
 * Sync IPC: cancel, journal readout, iPod DB read, sync-to-ipod entry,
 * preview-ipod-sync planner, state-conflict reconcile surface.
 *
 * The ~900-line `runSyncToIpod` engine stays in main/index.ts — it shares
 * mount/codec/convert closures with the copy loop. Preview registration
 * + planner body live here behind a small host for mount / codec hint /
 * readIpodDatabase so new sync channels default-deny via createIpcRegistrar.
 */
import { app } from 'electron'
import { join } from 'path'
import { readFile, stat } from 'fs/promises'
import type { IpcMainInvokeEvent } from 'electron'
import type { IpcRegistrar } from '../ipc-register.ts'
import { REFUSED_SENDER } from '../ipc-register.ts'
import { safeIpcError } from '../safe-ipc-error.ts'
import { STATE_IS_NAS, NAS_STATE_DIR_PATH, isNasMounted } from '../state-dir.ts'
import { parseTsaSeal, tsaInspectSeal, tsaRelFromColon, tsaNormalizeColonPath } from '../ipod-sync-tsa.ts'

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

/** Lossless extension / codec sets shared with the sync convert cache. */
const LOSSLESS_EXTS = new Set(['.alac', '.flac', '.wav', '.wave', '.aiff', '.aif'])
const LOSSLESS_CODECS = new Set(['alac', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_s16be', 'pcm_s24be'])
const SYNC_CONVERT_CACHE_SUBDIR = 'sync-convert-cache'

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
    syncOpts?: { wipeFirst?: boolean; origin?: string },
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
  /** Current iPod mount path, or null if none detected. */
  getIpodMount: () => string | null
  /**
   * Local library root with the trailing iPod_Control/Music segment
   * already stripped (same as MUSIC_DIR.replace(...)).
   */
  getLocalLibraryRoot: () => string
  /** Path separator for the host OS (Windows vs POSIX). */
  getPathSep: () => string
  /** Codec hint from the abs-path map (empty string if unknown). */
  getCodecHint: (absPath: string) => string
}

function ipodSyncJournalPath(): string {
  return join(app.getPath('userData'), 'ipod-sync-journal.json')
}

function ipodTsaSealPath(): string {
  return join(app.getPath('userData'), 'ipod-activity-tsa-seal.json')
}

/**
 * Read-only sync preview — same keep/copy planner the copy loop uses.
 * Files that exist on the device (F00–F49 walk) and byte-size match local
 * or the cached AAC mirror → keep; else copy. Leaving = unclaimed device files.
 */
async function previewIpodSync(
  host: SyncIpcHost,
  tracks: Array<Record<string, unknown>>,
  convertOptions?: SyncConvertOptions,
): Promise<{
  ok: boolean
  error?: string
  plan: Array<{ id: number; action: 'keep' | 'copy' }>
  leaving: Array<{ path: string; title: string; artist: string }>
  deviceFileCount?: number
}> {
  try {
    const IPOD_MOUNT = host.getIpodMount()
    if (!IPOD_MOUNT) return { ok: false, error: 'No iPod detected', plan: [], leaving: [] }
    const LOCAL_MOUNT = host.getLocalLibraryRoot()
    const pathSep = host.getPathSep()
    const { readdir: rd } = await import('fs/promises')
    const { createHash } = await import('crypto')

    // Ground truth: every real audio file on the device, by basename.
    const filesByBasename = new Map<string, { path: string; size: number }>()
    for (let i = 0; i < 50; i++) {
      const sub = join(IPOD_MOUNT, 'iPod_Control', 'Music', `F${String(i).padStart(2, '0')}`)
      const entries = await rd(sub).catch(() => [] as string[])
      for (const fn of entries) {
        if (fn.startsWith('._') || filesByBasename.has(fn)) continue
        const full = join(sub, fn)
        const st = await stat(full).catch(() => null)
        if (st && st.isFile()) filesByBasename.set(fn, { path: full, size: st.size })
      }
    }

    const claimed = new Set<string>()
    const plan: Array<{ id: number; action: 'keep' | 'copy' }> = []
    for (const t of tracks) {
      const id = Number(t.id)
      const colonPath = String(t.path || '')
      if (!colonPath) { plan.push({ id, action: 'copy' }); continue }
      const baseName = colonPath.split(':').pop() || ''
      const dot = baseName.lastIndexOf('.')
      const m4aName = dot > 0 ? baseName.slice(0, dot) + '.m4a' : baseName
      const localFile = join(LOCAL_MOUNT, colonPath.replace(/:/g, pathSep))
      const candNames = baseName === m4aName ? [baseName] : [baseName, m4aName]
      let action: 'keep' | 'copy' = 'copy'
      for (const nm of candNames) {
        const dev = filesByBasename.get(nm)
        if (!dev) continue
        claimed.add(nm) // this device slot belongs to the set either way
        // Mirrors the planner: byte-identical original = keep, unless a
        // convert pass wants to shrink a (known-)lossless source.
        const ls = await stat(localFile).catch(() => null)
        if (ls && dev.size === ls.size) {
          const ext2 = localFile.slice(localFile.lastIndexOf('.')).toLowerCase()
          const hint = (host.getCodecHint(localFile) || '').toLowerCase()
          const lossless = LOSSLESS_EXTS.has(ext2) || hint === 'alac' || LOSSLESS_CODECS.has(hint)
          if (!(convertOptions?.enabled && lossless)) { action = 'keep'; break }
        }
        // Mirrors the copy loop's last-mile skip: a cached AAC mirror
        // whose size matches the device file means zero bytes move.
        if (convertOptions?.enabled) {
          const hash = createHash('sha1').update(`${localFile}|${convertOptions.targetKbps}|afenc-cbr-44100-2-v3`).digest('hex').slice(0, 16)
          const cs = await stat(join(app.getPath('userData'), SYNC_CONVERT_CACHE_SUBDIR, `${hash}.m4a`)).catch(() => null)
          if (cs && dev.size === cs.size) { action = 'keep'; break }
        }
      }
      plan.push({ id, action })
    }

    // Leaving = real device files no track in the set claims. The post-sync
    // orphan cleanup deletes exactly these. Titles best-effort from the DB.
    const titleByColon = new Map<string, { title: string; artist: string }>()
    try {
      const db = await host.readIpodDatabase()
      for (const dt of db.tracks as Array<Record<string, unknown>>) {
        titleByColon.set(String(dt.path || ''), { title: String(dt.title || ''), artist: String(dt.artist || '') })
      }
    } catch { /* DB unreadable → basenames only */ }
    const leaving: Array<{ path: string; title: string; artist: string }> = []
    for (const [nm, f] of filesByBasename) {
      if (claimed.has(nm)) continue
      const rel = f.path.slice(IPOD_MOUNT.length + 1)
      const colon = ':' + rel.split(pathSep).join(':')
      const meta = titleByColon.get(colon)
      leaving.push({ path: colon, title: meta?.title || nm, artist: meta?.artist || '' })
    }
    return { ok: true, plan, leaving, deviceFileCount: filesByBasename.size }
  } catch (err) {
    return { ok: false, error: safeIpcError(err, 'io-failed'), plan: [], leaving: [] }
  }
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

  // Read-only: did the sealed activity set drift? Never copies, never repairs.
  ipc.handle('inspect-ipod-tsa-seal', async () => {
    try {
      let raw: unknown
      try {
        raw = JSON.parse(await readFile(ipodTsaSealPath(), 'utf-8'))
      } catch {
        return { ok: true, sealed: false, drifted: false, target: 0, present: 0, missing: [] as Array<{ id: number; destPath: string; reason: string }> }
      }
      const seal = parseTsaSeal(raw)
      if (!seal) {
        return { ok: true, sealed: false, drifted: false, target: 0, present: 0, missing: [] as Array<{ id: number; destPath: string; reason: string }> }
      }
      const mount = host.getIpodMount()
      if (!mount) {
        return { ok: true, sealed: true, drifted: false, unmounted: true, target: seal.target, present: 0, missing: [] as Array<{ id: number; destPath: string; reason: string }> }
      }
      const sep = host.getPathSep()
      const onCard = new Map<string, number>()
      for (const p of seal.passengers) {
        const destPath = tsaNormalizeColonPath(p.destPath)
        const dest = join(mount, tsaRelFromColon(destPath, sep))
        try {
          onCard.set(destPath, (await stat(dest)).size)
        } catch { /* missing */ }
      }
      const { present, missing } = tsaInspectSeal(seal, onCard)
      return {
        ok: true,
        sealed: true,
        drifted: missing.length > 0,
        target: seal.target,
        present,
        missing: missing.slice(0, 20),
      }
    } catch (err) {
      return { ok: false, error: safeIpcError(err, 'io-failed'), sealed: false, drifted: false, target: 0, present: 0, missing: [] }
    }
  }, { public: true })

  ipc.handle('get-ipod-db-tracks', async () => {
    try {
      const ipodData = await host.readIpodDatabase()
      return { ok: true, tracks: ipodData.tracks, playlists: ipodData.playlists, total: ipodData.tracks.length }
    } catch (err) {
      return { ok: false, error: safeIpcError(err, 'io-failed'), tracks: [], playlists: [], total: 0 }
    }
  }, { public: true })

  // Sync: read iPod DB and return NEW tracks/playlists not already in the library
  ipc.handle('sync-ipod', async (_e, existingIds: number[]) => {
    return host.syncIpodFromDevice(existingIds)
  }, { public: true })

  ipc.handle('sync-to-ipod', async (_e, tracks: Array<Record<string, unknown>>, playlists: Array<Record<string, unknown>>, convertOptions?: SyncConvertOptions, syncOpts?: { wipeFirst?: boolean; origin?: string }) => {
    return host.syncToIpod(tracks, playlists, convertOptions, syncOpts)
  }, { refuse: { ok: false, copied: 0, error: 'refused-sender' } as const })

  // Read-only preview of the keep/copy plan — same planner as the copy loop.
  ipc.handle('preview-ipod-sync', async (_e, tracks: Array<Record<string, unknown>>, convertOptions?: SyncConvertOptions) => {
    return previewIpodSync(host, tracks, convertOptions)
  }, { public: true })

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
