/**
 * An iPod that drops off USB in the middle of a copy (Brief 260, 2026-11-20).
 *
 * Jake's Y2K iPod (a 3G, HFS+, 40 GB, plugged straight into the MacBook)
 * copied for eight minutes, then its USB device reset and remounted on its
 * own: every copy after that failed with EIO inside 35 ms, and the engine
 * stopped with "Only 366 of 416 songs confirmed" and took the 366 off again.
 * Jake: "this cant keep happening".
 *
 * What this file decides, so the engine can:
 *   • tell a vanished card (EIO / ENXIO / the mount gone) from a song that
 *     simply didn't copy;
 *   • wait for the SAME iPod to come back, by identity (the JakeTunes marker
 *     on the card, and SysInfo's FireWire GUID and serial when the card has
 *     them), never by the volume's name; another iPod plugged in is never
 *     written to;
 *   • remember, when it never comes back, exactly which files were confirmed
 *     on the card (path, size, the file's own mtime, the song's identity), so
 *     the next sync adopts them instead of copying them again;
 *   • write one line per drop that says when, how far in, and on which file.
 *
 * Pure apart from the default card reader, so node --test drives it.
 */
import { readFile, stat } from 'fs/promises'
import { join } from 'path'
import { IPOD_MARKER_REL, parseDeviceMarker } from '../common/ipod-identity.ts'
import { detectHardware, parseSysInfo, type IpodHardware } from '../common/ipod-onboarding.ts'
import { stayVerdict, type SwapCandidate, type SwapManifestRow } from './ipod-swap-sync.ts'
import { tsaNormalizeColonPath } from './ipod-sync-tsa.ts'

/** Errors that mean the device went away, not that one file failed. */
const DROP_CODES = new Set(['EIO', 'ENXIO', 'ENODEV', 'ENOTCONN', 'ESTALE', 'EBADF'])

export function errnoCode(err: unknown): string | null {
  const c = (err as { code?: unknown } | null)?.code
  return typeof c === 'string' ? c : null
}

/** EIO and friends are the device; ENOENT is the device only when the card itself is gone. */
export function looksLikeDrop(err: unknown, cardThere: boolean): boolean {
  if (!cardThere) return true
  const code = errnoCode(err)
  return code !== null && DROP_CODES.has(code)
}

/** Who this card is. Every field present before a drop must read the same after it. */
export interface IpodCardIdentity {
  markerId: string | null
  firewireGuid: string | null
  serial: string | null
  hardware: IpodHardware
}

export async function readCardIdentity(mount: string): Promise<IpodCardIdentity> {
  const [markerText, sysText] = await Promise.all([
    readFile(join(mount, ...IPOD_MARKER_REL), 'utf-8').catch(() => null),
    readFile(join(mount, 'iPod_Control', 'Device', 'SysInfo'), 'utf-8').catch(() => null),
  ])
  let markerId: string | null = null
  try { markerId = markerText ? parseDeviceMarker(JSON.parse(markerText))?.id ?? null : null } catch { markerId = null }
  const sys = sysText === null ? null : parseSysInfo(sysText)
  return {
    markerId,
    firewireGuid: sys?.firewireGuid?.trim().toUpperCase() || null,
    serial: sys?.serial?.trim().toUpperCase() || null,
    hardware: detectHardware(sys, null),
  }
}

/** Can this card be told apart from any other? A drop is only ridden out when it can. */
export function identityKnown(id: IpodCardIdentity): boolean {
  return !!(id.markerId || id.firewireGuid || id.serial)
}

/**
 * 'same': every identity the card had before is there and equal.
 * 'other': something it had before reads differently (another iPod).
 * 'unreadable': the card answers but its identity can't be read yet (still mounting).
 */
export function sameIpod(before: IpodCardIdentity, now: IpodCardIdentity): 'same' | 'other' | 'unreadable' {
  if (!identityKnown(before)) return 'unreadable'
  const pairs: Array<[string | null, string | null]> = [
    [before.markerId, now.markerId],
    [before.firewireGuid, now.firewireGuid],
    [before.serial, now.serial],
  ]
  let missing = false
  for (const [a, b] of pairs) {
    if (!a) continue
    if (!b) { missing = true; continue }
    if (a !== b) return 'other'
  }
  return missing ? 'unreadable' : 'same'
}

/** How long a drop is waited out, and how often the card is looked for. */
export const DROP_WAIT_MS = 120_000
export const DROP_POLL_MS = 2_000
/** A card that comes and goes more than this in one run is not a card to keep writing to. */
export const MAX_DROPS_PER_RUN = 3

export type DropWait =
  | { back: true; goneMs: number; mount: string }
  | { back: false; goneMs: number; why: 'timeout' | 'other-ipod' }

/**
 * Poll until this iPod answers again, at its old mount or at another one
 * (macOS can bring it back as "/Volumes/Name 1"), or `waitMs` passes. Another
 * iPod at the old mount ends the wait (it is never written to); another iPod
 * somewhere else is ignored.
 */
export async function waitForSameIpod(opts: {
  mount: string
  before: IpodCardIdentity
  read: (mount: string) => Promise<IpodCardIdentity>
  present: (mount: string) => Promise<boolean>
  /** Other mounted iPods to look at, besides `mount`. */
  others?: () => Promise<string[]>
  now: () => number
  sleep: (ms: number) => Promise<void>
  waitMs?: number
  pollMs?: number
  startedAt?: number
}): Promise<DropWait> {
  const start = opts.startedAt ?? opts.now()
  const waitMs = opts.waitMs ?? DROP_WAIT_MS
  const pollMs = opts.pollMs ?? DROP_POLL_MS
  const unread: IpodCardIdentity = { markerId: null, firewireGuid: null, serial: null, hardware: 'unknown' }
  // Twice in a row at the same place: a volume still mounting can answer once and vanish again.
  const streak = new Map<string, number>()
  for (;;) {
    const places = [opts.mount, ...((await opts.others?.().catch(() => [] as string[])) ?? []).filter((m) => m !== opts.mount)]
    for (const m of places) {
      if (!(await opts.present(m).catch(() => false))) { streak.delete(m); continue }
      const verdict = sameIpod(opts.before, await opts.read(m).catch(() => unread))
      if (verdict === 'other') {
        streak.delete(m)
        if (m === opts.mount) return { back: false, goneMs: opts.now() - start, why: 'other-ipod' }
        continue
      }
      const n = verdict === 'same' ? (streak.get(m) ?? 0) + 1 : 0
      streak.set(m, n)
      if (n >= 2) return { back: true, goneMs: opts.now() - start, mount: m }
    }
    if (opts.now() - start >= waitMs) return { back: false, goneMs: opts.now() - start, why: 'timeout' }
    await opts.sleep(pollMs)
  }
}

/** The one line a drop leaves in the log (and, as JSON, in ipod-drops.jsonl). */
export interface DropFacts {
  at: string
  ipod: string
  hardware: IpodHardware
  songsDone: number
  songsTotal: number
  bytesWritten: number
  secondsIn: number
  file: string
  error: string
  goneSeconds: number | null
  outcome: 'back' | 'never-back' | 'other-ipod' | 'too-many'
}

export function dropLogLine(d: DropFacts): string {
  const mb = (d.bytesWritten / 1e6).toFixed(0)
  const gone = d.goneSeconds === null ? '?' : `${d.goneSeconds.toFixed(1)}s`
  return `activity-sync: DROP at ${d.at} — ${d.ipod} (${d.hardware}) after ${d.songsDone}/${d.songsTotal} songs, ${mb} MB, ${d.secondsIn.toFixed(0)}s into the copy; writing "${d.file}" (${d.error}); gone ${gone}; ${d.outcome}`
}

/** UI lines, plain. */
export const DROP_WAITING_LINE = 'The iPod disconnected — waiting for it to come back…'
export const DROP_BACK_LINE = 'The iPod reconnected — carrying on'

// ── What stays on the card when the iPod never comes back ──

/** In the iPod's own state dir. */
export const PARTIAL_ON_CARD_FILE = 'activity-partial-on-card.json'
export const PARTIAL_FORMAT = 1

export interface PartialRow extends SwapManifestRow {
  /** The card file's mtime when it was confirmed: the exact file, not just its size. */
  mtimeMs: number
}

export interface PartialOnCard {
  format: typeof PARTIAL_FORMAT
  writtenAt: string
  ipod: { markerId: string | null; firewireGuid: string | null; serial: string | null }
  rows: PartialRow[]
}

export function buildPartialOnCard(id: IpodCardIdentity, rows: PartialRow[], now: string): PartialOnCard {
  return {
    format: PARTIAL_FORMAT,
    writtenAt: now,
    ipod: { markerId: id.markerId, firewireGuid: id.firewireGuid, serial: id.serial },
    rows,
  }
}

/** The rows, or null when the record is malformed or belongs to another iPod. */
export function parsePartialOnCard(raw: unknown, card: IpodCardIdentity): Map<number, PartialRow> | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.format !== PARTIAL_FORMAT || !Array.isArray(r.rows)) return null
  const ip = (r.ipod ?? {}) as Record<string, unknown>
  const recorded: IpodCardIdentity = {
    markerId: typeof ip.markerId === 'string' ? ip.markerId : null,
    firewireGuid: typeof ip.firewireGuid === 'string' ? ip.firewireGuid : null,
    serial: typeof ip.serial === 'string' ? ip.serial : null,
    hardware: 'unknown',
  }
  if (sameIpod(recorded, card) !== 'same') return null
  const out = new Map<number, PartialRow>()
  for (const row of r.rows as Array<Record<string, unknown>>) {
    const id = Number(row?.id)
    const destPath = tsaNormalizeColonPath(String(row?.destPath ?? ''))
    const identity = String(row?.identity ?? '')
    const size = Number(row?.size)
    const sourceSize = Number(row?.sourceSize ?? 0)
    const mtimeMs = Number(row?.mtimeMs)
    if (!Number.isInteger(id) || id < 0 || !destPath || !identity) return null
    if (!(size > 0) || !(sourceSize >= 0) || !(mtimeMs > 0)) return null
    if (out.has(id)) return null
    out.set(id, { id, destPath, identity, size, sourceSize, mtimeMs })
  }
  return out
}

/**
 * Adopt a file the stopped sync left on the card? The same song as this sync
 * would copy (stayVerdict: id, card path, identity, both sizes), and the card
 * still holds that exact file (size and mtime as confirmed).
 */
export function adoptFromPartial(c: SwapCandidate, row: PartialRow, onCard: { size: number; mtimeMs: number } | null): boolean {
  if (!onCard) return false
  if (stayVerdict(c, row) !== 'stay') return false
  return onCard.size === row.size && onCard.mtimeMs === row.mtimeMs
}

export async function cardFileFacts(abs: string): Promise<{ size: number; mtimeMs: number } | null> {
  const st = await stat(abs).catch(() => null)
  return st && st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null
}

// ── Gentler writes on the old hard-drive iPods ──

/** A breather every this many bytes, on a 1G–4G or mini only. */
export const OLD_IPOD_PAUSE_EVERY_BYTES = 200 * 1024 * 1024
export const OLD_IPOD_PAUSE_MS = 1_500

export function pacesWrites(hw: IpodHardware): boolean {
  return hw === '3g' || hw === '4g' || hw === 'mini' || hw === 'mini-1g' || hw === 'mini-2g'
}
