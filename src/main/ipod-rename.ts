/**
 * Rename the plugged-in iPod (2026-11-07, Jake: "i actually want to name the
 * actual ipod punkPod not just a nickname. it shows up as JT Red").
 *
 * One click, one name, everywhere:
 *   1. the marker on the card (iPod_Control/jaketunes-device.json) and this
 *      Mac's ipod-devices.json — the marker is the identity, its id never changes
 *   2. the drive's own volume label (`diskutil rename`), so the Mac shows it too;
 *      the mount path moves (/Volumes/JT RED → /Volumes/punkPod) and the caller
 *      follows it, so nothing reads the move as an unplug and a new plug-in
 *   3. homemini's list name, for every iPod but the Original — best effort; when
 *      homemini is away the name waits on disk and goes with the next sync
 *   4. the iPod's own catalog name (the master playlist title) is written by the
 *      next sync from the marker (core/db_reader.py masterName)
 *
 * Refused while a sync runs, for an unknown iPod, and for a name a FAT32 drive
 * can't hold (common/ipod-name.ts).
 *
 * The deps are injected so node --test runs it with no iPod and no diskutil.
 */
import { execFile } from 'child_process'
import { promisify } from 'util'
import { readFile, writeFile, rename } from 'fs/promises'
import { join } from 'path'
import { checkIpodName } from '../common/ipod-name.ts'
import type { IpodDeviceMarker } from '../common/ipod-identity.ts'

export interface RenameIpodDeps {
  syncing: () => boolean
  mount: () => string | null
  renameMarker: (mount: string, name: string) => Promise<{ ok: true; device: IpodDeviceMarker; before: string } | { ok: false; error: string }>
  /** Rename the drive; resolves with where it is mounted now (null = couldn't tell). */
  renameVolume: (mount: string, label: string) => Promise<string | null>
  /** Tell homemini the list's new name; false = not now (it waits for the next sync). */
  renameOnHomemini: (deviceId: string, name: string) => Promise<boolean>
  /** Remember a name homemini hasn't heard yet. */
  queueHomeminiName: (deviceId: string, name: string) => Promise<void>
  /** The mount moved: follow it without calling it a new plug-in. */
  followMount: (newMount: string) => void
}

export type RenameIpodResult =
  | {
      ok: true
      device: IpodDeviceMarker
      /** Where the drive is mounted now. */
      mount: string
      /** One plain line when the drive's own name couldn't be changed. */
      driveNote: string | null
      /** 'n/a' for the Original (homemini keeps no list for it). */
      homemini: 'saved' | 'later' | 'n/a'
    }
  | { ok: false; error: string }

export async function renameIpod(deps: RenameIpodDeps, raw: unknown): Promise<RenameIpodResult> {
  const check = checkIpodName(raw)
  if (!check.ok) return check
  if (deps.syncing()) return { ok: false, error: 'Wait for the sync to finish, then rename the iPod.' }
  const mount = deps.mount()
  if (!mount) return { ok: false, error: 'No iPod is plugged in.' }

  const marked = await deps.renameMarker(mount, check.name)
  if (!marked.ok) return marked

  let nowAt = mount
  let driveNote: string | null = null
  try {
    const moved = await deps.renameVolume(mount, check.name)
    if (moved) {
      nowAt = moved
      if (moved !== mount) deps.followMount(moved)
    }
  } catch (err) {
    driveNote = `JakeTunes and the iPod now call it ${check.name}, but the Mac kept the drive’s old name (${err instanceof Error ? err.message : 'diskutil refused'}).`
  }

  let homemini: 'saved' | 'later' | 'n/a' = 'n/a'
  if (!marked.device.primary) {
    const saved = await deps.renameOnHomemini(marked.device.id, check.name).catch(() => false)
    homemini = saved ? 'saved' : 'later'
    if (!saved) await deps.queueHomeminiName(marked.device.id, check.name).catch((err) => console.warn('[ipod-rename] couldn’t keep the name for homemini:', err instanceof Error ? err.message : err))
  }
  return { ok: true, device: marked.device, mount: nowAt, driveNote, homemini }
}

// ── The real drive rename (macOS) ────────────────────────────────────────────

const execP = promisify(execFile)

function plistString(xml: string, key: string): string | null {
  const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(xml)
  if (!m) return null
  return m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, '\'').replace(/&amp;/g, '&')
}

/** Rename a mounted FAT drive by its device id (never by a name another disk could share)
 *  and wait for macOS to remount it; resolves with the new mount point. */
export async function renameMacVolume(mount: string, label: string): Promise<string | null> {
  const before = await execP('diskutil', ['info', '-plist', mount], { timeout: 10_000 })
  const dev = plistString(before.stdout, 'DeviceIdentifier')
  if (!dev || !/^disk\d+s\d+$/.test(dev)) throw new Error('couldn’t tell which disk this is')
  await execP('diskutil', ['rename', dev, label], { timeout: 30_000 })
  for (let i = 0; i < 20; i++) {
    const after = await execP('diskutil', ['info', '-plist', dev], { timeout: 10_000 }).catch(() => null)
    const at = after ? plistString(after.stdout, 'MountPoint') : null
    if (at) return at
    await new Promise((r) => setTimeout(r, 250))
  }
  return null
}

// ── Names homemini hasn't heard yet ──────────────────────────────────────────

const PENDING_FILE = 'ipod-list-renames.json'

/** Names homemini hasn't heard yet, by iPod id: the device rename's and the list rename's (one queue, the newest wins). */
export async function readPendingNames(stateDir: string): Promise<Record<string, string>> {
  return readPending(stateDir)
}

async function readPending(stateDir: string): Promise<Record<string, string>> {
  try {
    const raw = JSON.parse(await readFile(join(stateDir, PENDING_FILE), 'utf-8')) as Record<string, unknown>
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw || {})) if (typeof v === 'string' && v) out[k] = v
    return out
  } catch {
    return {}
  }
}

async function writePending(stateDir: string, pending: Record<string, string>): Promise<void> {
  const path = join(stateDir, PENDING_FILE)
  const tmp = `${path}.tmp-${process.pid}`
  await writeFile(tmp, JSON.stringify(pending, null, 2), 'utf-8')
  await rename(tmp, path)
}

export async function queueHomeminiName(stateDir: string, deviceId: string, name: string): Promise<void> {
  const pending = await readPending(stateDir)
  pending[deviceId] = name
  await writePending(stateDir, pending)
}

/** Before reading an iPod's list (every sync does): send a name homemini missed. */
export async function flushHomeminiName(
  stateDir: string,
  deviceId: string,
  send: (deviceId: string, name: string) => Promise<boolean>,
): Promise<'none' | 'sent' | 'still-waiting'> {
  const pending = await readPending(stateDir)
  const name = pending[deviceId]
  if (!name) return 'none'
  const ok = await send(deviceId, name).catch(() => false)
  if (!ok) return 'still-waiting'
  const now = await readPending(stateDir)
  if (now[deviceId] === name) {
    delete now[deviceId]
    await writePending(stateDir, now)
  }
  return 'sent'
}

/**
 * Every name homemini hasn't heard yet (or one iPod's): before each list read and on the 5-minute
 * retry (main/ipc/ipod-lists-ipc.ts). 'drop' = homemini will never take it (a name another list has,
 * no such list): it leaves the queue, and the list shows homemini's name again. A name changed again
 * while one was in flight stays for the next flush.
 */
export async function flushAllHomeminiNames(
  stateDir: string,
  send: (deviceId: string, name: string) => Promise<'done' | 'retry' | 'drop'>,
  only?: string,
  warn?: (msg: string) => void,
): Promise<'none' | 'sent' | 'still-waiting'> {
  const pending = await readPending(stateDir)
  const ids = Object.keys(pending).filter((id) => only === undefined || id === only)
  if (!ids.length) return 'none'
  let waiting = false
  for (const id of ids) {
    const name = pending[id]
    const out = await send(id, name).catch(() => 'retry' as const)
    if (out === 'retry') { waiting = true; continue }
    if (out === 'drop') warn?.(`[ipod-list] homemini won't take the name "${name}" for ${id}; dropped`)
    const now = await readPending(stateDir)
    if (now[id] === name) {
      delete now[id]
      await writePending(stateDir, now)
    }
  }
  return waiting ? 'still-waiting' : 'sent'
}
