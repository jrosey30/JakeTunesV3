/**
 * Hub offload actions. Dry run, explicit start, and boot resume.
 *
 * The bulk scan does not run because the setting exists. bootHubOffload
 * resumes only when offload-migration.json says a start already happened,
 * or when argv is --offload-dry-run / --offload-start.
 *
 * Registered through the IPC registrar. Menu clicks call the same functions.
 */
import { dialog } from 'electron'
import { mkdir, readFile, writeFile, lstat, statfs, rename, unlink } from 'fs/promises'
import { dirname } from 'path'
import { join } from 'path'
import type { IpcRegistrar } from '../ipc-register.ts'
import { REFUSED_SENDER } from '../ipc-register.ts'
import { withCompanionInit } from '../hub-companion.ts'
import { colonPathToAbs } from '../activity-boardable.ts'
import {
  bootOffloadIntent,
  compareLocalToRaw,
  drainOffloadEnqueue,
  dryRunOffload,
  formatOffloadDryRun,
  hubOffloadActive,
  migrationResumeAction,
  offloadDryRunReportPath,
  offloadMigrationStatePath,
  offloadReplacementsPath,
  parseMigrationState,
  parseReplacementLog,
  FULL_BODY_TIMEOUT_MS,
  rawAudioUrl,
  readPrefixBody,
  rehydrateReplacements,
  stateForExplicitStart,
  urlAsksForTranscode,
  type OffloadMigrationState,
  type OffloadTrack,
} from '../offload-audio.ts'

export interface OffloadIpcHost {
  readStreamSource: () => Promise<string | null>
  readOffloadAudio: () => Promise<boolean>
  libraryPath: () => string
  userDataDir: () => string
  musicRoot: () => string
  hashFile: (abs: string, durationMs: number) => Promise<string | null>
  enqueue: (items: Array<{ ipodPath: string; fingerprint?: string; enqueuedAt: number }>) => Promise<void>
  ensureWorker: () => void
  kickPass: () => void
  audioBase: string
}

let host: OffloadIpcHost | null = null
let drainRunning = false

function sep(): string {
  return process.platform === 'win32' ? '\\' : '/'
}

function toAbs(colon: string): string {
  if (!host) throw new Error('offload host missing')
  return colonPathToAbs(colon, host.musicRoot(), sep())
}

async function loadTracks(): Promise<OffloadTrack[]> {
  if (!host) return []
  try {
    const lib = JSON.parse(await readFile(host.libraryPath(), 'utf-8')) as { tracks?: OffloadTrack[] }
    return Array.isArray(lib.tracks) ? lib.tracks : []
  } catch (err) {
    console.warn('[offload] library read failed:', err instanceof Error ? err.message : err)
    return []
  }
}

async function readState(): Promise<OffloadMigrationState | null> {
  if (!host) return null
  try {
    return parseMigrationState(await readFile(offloadMigrationStatePath(host.userDataDir()), 'utf-8'))
  } catch {
    return null
  }
}

async function saveState(state: OffloadMigrationState): Promise<void> {
  if (!host) return
  const file = offloadMigrationStatePath(host.userDataDir())
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(state), 'utf-8')
}

async function queueLength(): Promise<number> {
  if (!host) return 0
  try {
    const s = JSON.parse(await readFile(join(host.userDataDir(), 'stream-convert-queue.json'), 'utf-8')) as { items?: unknown[] }
    return Array.isArray(s?.items) ? s.items.length : 0
  } catch {
    return 0
  }
}

async function probePrefix(id: string | number) {
  if (!host) return { transportError: true, status: 0, body: null }
  const url = rawAudioUrl(host.audioBase, id)
  if (urlAsksForTranscode(url)) return { transportError: false, status: 0, body: null }
  try {
    const res = await fetch(url, withCompanionInit({
      headers: { Range: 'bytes=0-262143' },
      signal: AbortSignal.timeout(8000),
    }))
    if ((!res.ok && res.status !== 206) || !res.body) return { transportError: false, status: res.status, body: null }
    const body = await readPrefixBody(res.body)
    return { transportError: false, status: res.status, body: body.length ? body : null }
  } catch {
    return { transportError: true, status: 0, body: null }
  }
}

async function confirmFull(abs: string, id: string | number) {
  if (!host) return { kind: 'unreachable' as const }
  return compareLocalToRaw({ localAbs: abs, id, audioBase: host.audioBase })
}

async function showText(title: string, message: string, interactive: boolean): Promise<void> {
  console.log(`[offload] ${title}\n${message}`)
  if (!interactive) return
  await dialog.showMessageBox({ type: 'info', title, message, buttons: ['OK'] })
}

async function confirmStart(message: string, interactive: boolean): Promise<boolean> {
  if (!interactive) return true
  const r = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Cancel', 'Start offload'],
    defaultId: 0,
    cancelId: 0,
    title: 'Offload audio to homemini',
    message,
  })
  return r.response === 1
}

async function runDry(interactive: boolean): Promise<{ ok: boolean; report?: string; error?: string }> {
  if (!host) return { ok: false, error: 'offload is not ready' }
  const source = await host.readStreamSource()
  const offload = await host.readOffloadAudio()
  const report = await dryRunOffload({
    tracks: await loadTracks(),
    lstat,
    colonToAbs: toAbs,
    hashPrefix: host.hashFile,
    probe: probePrefix,
    confirmFull,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  })
  const setting = offload
    ? 'library.offloadAudioToHomemini is on. This Mac still publishes library.json.'
    : 'library.offloadAudioToHomemini is off. Turn it on before Start. Leave streamSource empty.'
  const role = source === 'homemini'
    ? 'This machine is a replica (streamSource=homemini). Replica migration already runs at boot. Do not use hub Start here.'
    : 'This machine is the hub.'
  const text = `${formatOffloadDryRun(report)}\n${setting}\n${role}`
  try {
    const file = offloadDryRunReportPath(host.userDataDir())
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify({ ...report, settingOn: offload, isReplica: source === 'homemini', text }, null, 2), 'utf-8')
  } catch (err) {
    console.warn('[offload] could not write dry-run report:', err instanceof Error ? err.message : err)
  }
  await showText('Offload dry run', text, interactive)
  return { ok: true, report: text }
}

async function resumeDrain(state: OffloadMigrationState): Promise<void> {
  if (!host || drainRunning) return
  if (migrationResumeAction(state, await queueLength()) !== 'enqueue') {
    host.ensureWorker()
    host.kickPass()
    return
  }
  drainRunning = true
  try {
    const tracks = await loadTracks()
    await drainOffloadEnqueue({
      tracks,
      state,
      lstat,
      colonToAbs: toAbs,
      hashFile: host.hashFile,
      enqueue: async (items) => { await host!.enqueue(items) },
      saveState,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
    })
    host.ensureWorker()
    host.kickPass()
  } catch (err) {
    console.warn('[offload] enqueue failed:', err instanceof Error ? err.message : err)
  } finally {
    drainRunning = false
  }
}

async function runStart(interactive: boolean): Promise<{ ok: boolean; error?: string }> {
  if (!host) return { ok: false, error: 'offload is not ready' }
  const source = await host.readStreamSource()
  if (!hubOffloadActive({ streamSource: source, offload: await host.readOffloadAudio() })) {
    const message = source === 'homemini'
      ? 'This machine is a replica (streamSource=homemini). Hub offload was not started. Replica migration still runs at boot, and this Mac must keep publishing library.json — do not set streamSource on the hub.'
      : 'library.offloadAudioToHomemini is false. Set it true in app-settings.json, leave streamSource empty, then start again. Nothing was changed.'
    await showText('Offload not started', message, interactive)
    return { ok: false, error: message }
  }
  const ok = await confirmStart(
    'Local files become symlinks only after homemini serves the whole file at the same size and full sha1. A 256KB prefix is only a pre-filter. The hub keeps publishing library.json. Each replacement is logged so it can be pulled back.',
    interactive,
  )
  if (!ok) return { ok: false, error: 'cancelled' }
  const prev = await readState()
  const state = stateForExplicitStart(prev, new Date().toISOString(), await queueLength())
  await saveState(state)
  console.log(`[offload] start phase=${state.phase} cursor=${state.cursor}`)
  void resumeDrain(state)
  return { ok: true }
}

async function runRehydrate(interactive: boolean): Promise<{ ok: boolean; restored?: number; error?: string }> {
  if (!host) return { ok: false, error: 'offload is not ready' }
  let text = ''
  try {
    text = await readFile(offloadReplacementsPath(host.userDataDir()), 'utf-8')
  } catch {
    const message = 'No offload-replacements.jsonl yet. Nothing to pull back.'
    await showText('Undo offload', message, interactive)
    return { ok: false, error: message }
  }
  const records = parseReplacementLog(text)
  const result = await rehydrateReplacements({
    records,
    freeBytes: async () => {
      const s = await statfs(host!.musicRoot())
      return Number(s.bavail) * Number(s.bsize)
    },
    fetchFull: async (id) => {
      try {
        const url = rawAudioUrl(host!.audioBase, id)
        if (urlAsksForTranscode(url)) return null
        const res = await fetch(url, withCompanionInit({
          signal: AbortSignal.timeout(FULL_BODY_TIMEOUT_MS),
        }))
        if (!res.ok) return null
        return Buffer.from(await res.arrayBuffer())
      } catch {
        return null
      }
    },
    currentKind: async (record) => {
      try {
        const st = await lstat(toAbs(record.path))
        if (st.isSymbolicLink()) return 'symlink'
        if (st.isFile()) return 'file'
        return 'missing'
      } catch {
        return 'missing'
      }
    },
    writeBack: async (record, bytes) => {
      const abs = toAbs(record.path)
      const tmp = abs + '.rehydrate.tmp'
      try { await unlink(tmp) } catch { /* no partial from an earlier try */ }
      await writeFile(tmp, bytes)
      await rename(tmp, abs)
    },
  })
  const message = result.stoppedBecause
    ? `Pulled ${result.restored} file(s) back, skipped ${result.skipped}. Stopped: ${result.stoppedBecause}`
    : `Pulled ${result.restored} file(s) back, skipped ${result.skipped}.`
  await showText('Undo offload', message, interactive)
  return { ok: !result.stoppedBecause, restored: result.restored, error: result.stoppedBecause ?? undefined }
}

export function registerOffloadIpc(ipc: IpcRegistrar, h: OffloadIpcHost): void {
  host = h
  ipc.handle('offload-audio-dry-run', async () => runDry(true), { refuse: REFUSED_SENDER })
  ipc.handle('offload-audio-start', async () => runStart(true), { refuse: REFUSED_SENDER })
  ipc.handle('offload-audio-rehydrate', async () => runRehydrate(true), { refuse: REFUSED_SENDER })
}

export function menuHubOffload(action: 'dry-run' | 'start' | 'rehydrate'): void {
  if (action === 'dry-run') void runDry(true)
  else if (action === 'start') void runStart(true)
  else void runRehydrate(true)
}

/** Called once after the library path is resolved. Does not scan unless a start is on record or argv asks. */
export function bootHubOffload(argv: string[]): void {
  void (async () => {
    if (!host) return
    const offload = await host.readOffloadAudio()
    const state = await readState()
    const intent = bootOffloadIntent(argv, state, await queueLength(), offload)
    if (intent === 'none') return
    if (intent === 'dry-run') {
      await runDry(false)
      return
    }
    if (intent === 'start') {
      await runStart(false)
      return
    }
    if (state) {
      console.log(`[offload] resuming ${state.phase} at cursor ${state.cursor}`)
      await resumeDrain(state)
    }
  })()
}
