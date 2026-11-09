/**
 * "iPod color…" (2026-11-09). Jake: "if i dont have one use a default ipod photo
 * to which i can customize color". Choosing a colour for an iPod list's cover:
 *
 *   1. on the hub (the MacBook) it is kept in this Mac's ipod-colors.json, which
 *      wins over the registry colour (main/ipod-lists-gather.ts). The registry
 *      entry is updated too, but a plug-in rewrites the registry from the card's
 *      marker (the marker wins there), and the marker is left alone, so the
 *      choice needs its own file to stay put;
 *   2. homemini's list takes it (PATCH { color }) so the phone shows it. When
 *      homemini is away the colour waits in ipod-list-colors-pending.json and
 *      goes on the next list read, refresh or the 5-minute retry
 *      (main/ipc/ipod-lists-ipc.ts). Same pattern as main/ipod-rename.ts.
 *
 * Deps injected so node --test runs it without homemini.
 */
import { readFile, writeFile, rename, mkdir } from 'fs/promises'
import { dirname, join } from 'path'
import { normalizeIpodColor } from '../common/ipod-covers.ts'
import { parseDeviceMarker } from '../common/ipod-identity.ts'

export const CHOSEN_FILE = 'ipod-colors.json'
export const PENDING_FILE = 'ipod-list-colors-pending.json'
const REGISTRY_FILE = 'ipod-devices.json'

async function readMap(path: string): Promise<Record<string, string>> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown>
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw || {})) {
      const c = normalizeIpodColor(v)
      if (c && /^[a-z0-9-]{6,64}$/.test(k)) out[k] = c
    }
    return out
  } catch {
    return {}
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf-8')
  await rename(tmp, path)
}

/** Colours Jake picked on this Mac, by iPod id. */
export function readChosenColors(stateDir: string): Promise<Record<string, string>> {
  return readMap(join(stateDir, CHOSEN_FILE))
}

export function readPendingColors(stateDir: string): Promise<Record<string, string>> {
  return readMap(join(stateDir, PENDING_FILE))
}

/** This Mac's registry entry for the iPod takes the colour (when it has one). The card's marker is untouched. */
export async function setRegistryColor(stateDir: string, deviceId: string, color: string): Promise<boolean> {
  const path = join(stateDir, REGISTRY_FILE)
  let raw: { devices?: unknown[] }
  try {
    raw = JSON.parse(await readFile(path, 'utf-8')) as { devices?: unknown[] }
  } catch {
    return false
  }
  const devices = Array.isArray(raw.devices) ? raw.devices : []
  let hit = false
  const next = devices.map((d) => {
    const m = parseDeviceMarker(d)
    if (!m || m.id !== deviceId) return d
    hit = true
    return { ...(d as Record<string, unknown>), color }
  })
  if (!hit) return false
  await writeJson(path, { ...raw, devices: next })
  return true
}

export interface ChooseColorDeps {
  stateDir: string
  /** PATCH homemini's list { color }; true = homemini has it. */
  send: (deviceId: string, color: string) => Promise<boolean>
  /** The hub keeps the choice in ipod-colors.json and the registry; a replica only tells homemini. */
  hub: boolean
}

export type ChooseColorResult =
  | { ok: true; color: string; homemini: 'saved' | 'later'; registry: boolean }
  | { ok: false; error: string }

export async function chooseIpodColor(deps: ChooseColorDeps, deviceId: unknown, raw: unknown): Promise<ChooseColorResult> {
  if (typeof deviceId !== 'string' || !/^[a-z0-9-]{6,64}$/.test(deviceId)) return { ok: false, error: 'No iPod.' }
  const color = normalizeIpodColor(raw)
  if (!color) return { ok: false, error: 'That isn’t a colour JakeTunes knows.' }
  let registry = false
  if (deps.hub) {
    const chosen = await readChosenColors(deps.stateDir)
    chosen[deviceId] = color
    await writeJson(join(deps.stateDir, CHOSEN_FILE), chosen)
    registry = await setRegistryColor(deps.stateDir, deviceId, color).catch(() => false)
  }
  // Waiting on disk before homemini is asked: a crash mid-send can't lose it.
  const pending = await readPendingColors(deps.stateDir)
  pending[deviceId] = color
  await writeJson(join(deps.stateDir, PENDING_FILE), pending)
  const flushed = await flushPendingColors(deps.stateDir, deps.send, deviceId)
  return { ok: true, color, homemini: flushed === 'sent' ? 'saved' : 'later', registry }
}

/**
 * Send colours homemini hasn't heard yet (all, or one iPod's). A colour changed
 * again while one was in flight stays waiting for the next flush.
 */
export async function flushPendingColors(
  stateDir: string,
  send: (deviceId: string, color: string) => Promise<boolean>,
  only?: string,
): Promise<'none' | 'sent' | 'still-waiting'> {
  const pending = await readPendingColors(stateDir)
  const ids = Object.keys(pending).filter((id) => only === undefined || id === only)
  if (!ids.length) return 'none'
  let waiting = false
  for (const id of ids) {
    const color = pending[id]
    const ok = await send(id, color).catch(() => false)
    if (!ok) { waiting = true; continue }
    const now = await readPendingColors(stateDir)
    if (now[id] === color) {
      delete now[id]
      await writeJson(join(stateDir, PENDING_FILE), now)
    }
  }
  return waiting ? 'still-waiting' : 'sent'
}
