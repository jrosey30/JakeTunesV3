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
 *   • tell a vanished card (iPod_Control gone, another device at the mount,
 *     or a tiny file that won't write and read back) from a song that simply
 *     didn't copy: an EIO alone is a bad sector as often as a drop;
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
import { createReadStream } from 'fs'
import { open, readFile, stat, unlink } from 'fs/promises'
import { join } from 'path'
import type { IpodModel } from '../common/ipod-covers.ts'
import { IPOD_MARKER_REL, parseDeviceMarker } from '../common/ipod-identity.ts'
import { detectHardware, parseSysInfo, type IpodHardware } from '../common/ipod-onboarding.ts'
import { stayVerdict, type SwapCandidate, type SwapManifestRow } from './ipod-swap-sync.ts'
import { tsaNormalizeColonPath } from './ipod-sync-tsa.ts'

/** Errors that MAY mean the device went away; alone they never prove it (a bad sector answers EIO too). */
const DROP_CODES = new Set(['EIO', 'ENXIO', 'ENODEV', 'ENOTCONN', 'ESTALE', 'EBADF'])
const DROP_CODE_IN_TEXT = /\b(EIO|ENXIO|ENODEV|ENOTCONN|ESTALE|EBADF)\b/

export function errnoCode(err: unknown): string | null {
  const c = (err as { code?: unknown } | null)?.code
  return typeof c === 'string' ? c : null
}

/** The errno of a failure: its code, or one named in its message (confirmWriteOnCard gives a reason string). */
export function failureCode(err: unknown): string | null {
  const c = errnoCode(err)
  if (c) return c
  const text = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  return DROP_CODE_IN_TEXT.exec(text)?.[1] ?? null
}

/**
 * What a failed copy was (2026-11-20, the review of #459). An EIO alone is not
 * a drop: a bad sector on one file of an old hard-drive iPod, or a read error
 * on the Mac's own copy of the song, answers EIO while the iPod sits there.
 * Before this, four of those ended the whole sync with "try another cable".
 *   'drop'      the card really went: iPod_Control gone, the mount is another
 *               device now, or a tiny file can't be written and read back.
 *   'source'    the Mac's own file can't be read: one copy miss, no retry.
 *   'card-file' the card is fine but this file failed: one retry, then a miss.
 *   'miss'      anything else: the old copy-miss path (#47), no retry.
 */
export type CopyFailure = 'drop' | 'source' | 'card-file' | 'miss'

export function classifyCopyFailure(f: {
  code: string | null
  cardThere: boolean
  /** The mount answers as the same device it was (st_dev). False = it went and came back as another. */
  sameDevice: boolean
  /** The song's source file reads whole on the Mac. */
  sourceReadable: boolean
  /** A tiny file on the card was written, flushed, read back and removed. */
  cardProbeOk: boolean
}): CopyFailure {
  if (!f.cardThere || !f.sameDevice) return 'drop'
  if (f.code === null || !DROP_CODES.has(f.code)) return 'miss'
  if (!f.sourceReadable) return 'source'
  if (!f.cardProbeOk) return 'drop'
  return 'card-file'
}

/** Reads the whole file and throws nothing: true when every byte came back. */
export async function fileReadsWhole(abs: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    try {
      const s = createReadStream(abs, { highWaterMark: 1024 * 1024 })
      s.on('data', () => {})
      s.on('end', () => resolve(true))
      s.on('error', () => resolve(false))
    } catch {
      resolve(false)
    }
  })
}

/**
 * Is the card really answering? A wedged mount can answer stat from cache, so
 * write a tiny file under iPod_Control, flush it to the device, read it back
 * and remove it. Any step failing is false.
 */
export async function probeCardWrites(mount: string): Promise<boolean> {
  const p = join(mount, 'iPod_Control', `.jt-probe-${process.pid}-${Date.now()}`)
  const want = Buffer.from(`jaketunes ${Date.now()} ${Math.random()}`)
  let ok = false
  try {
    const fh = await open(p, 'w')
    try {
      await fh.writeFile(want)
      await fh.sync()
    } finally {
      await fh.close()
    }
    ok = (await readFile(p)).equals(want)
  } catch {
    ok = false
  }
  try {
    await unlink(p)
  } catch (err) {
    if (errnoCode(err) !== 'ENOENT') ok = false
  }
  return ok
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
  | { back: true; goneMs: number; mount: string; sawGone: boolean }
  | { back: false; goneMs: number; why: 'timeout' | 'other-ipod' | 'cancelled' }

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
  /** The write-and-read check a card must pass before it counts as back (probeCardWrites). */
  probe?: (mount: string) => Promise<boolean>
  /** Cancel ends the wait at the next look. */
  isCancelled?: () => boolean
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
  let sawGone = false
  for (;;) {
    if (opts.isCancelled?.()) return { back: false, goneMs: opts.now() - start, why: 'cancelled' }
    const places = [opts.mount, ...((await opts.others?.().catch(() => [] as string[])) ?? []).filter((m) => m !== opts.mount)]
    for (const m of places) {
      if (!(await opts.present(m).catch(() => false))) {
        if (m === opts.mount) sawGone = true
        streak.delete(m)
        continue
      }
      const verdict = sameIpod(opts.before, await opts.read(m).catch(() => unread))
      if (verdict === 'other') {
        streak.delete(m)
        if (m === opts.mount) return { back: false, goneMs: opts.now() - start, why: 'other-ipod' }
        continue
      }
      let n = verdict === 'same' ? (streak.get(m) ?? 0) + 1 : 0
      // Answering from a cache is not back: it must take a write and give it back.
      if (n >= 2 && opts.probe && !(await opts.probe(m).catch(() => false))) n = 0
      streak.set(m, n)
      if (n >= 2) return { back: true, goneMs: opts.now() - start, mount: m, sawGone }
    }
    if (opts.now() - start >= waitMs) return { back: false, goneMs: opts.now() - start, why: 'timeout' }
    if (opts.isCancelled?.()) return { back: false, goneMs: opts.now() - start, why: 'cancelled' }
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
  outcome: 'back' | 'never-back' | 'other-ipod' | 'too-many' | 'cancelled'
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

/**
 * `listModel`: the model homemini's iPod list says this iPod is (ipod-lists'
 * `model`), used only when SysInfo alone can't tell (a 3G's SysInfo can be
 * sparse). 'classic' and 'default' never pace.
 */
export function pacesWrites(hw: IpodHardware, listModel?: IpodModel | null): boolean {
  if (hw === '3g' || hw === '4g' || hw === 'mini' || hw === 'mini-1g' || hw === 'mini-2g') return true
  return hw === 'unknown' && (listModel === '3g' || listModel === 'mini')
}

/** The pause, in slices, so a cancel is heard within a quarter second. */
export async function pauseUnlessCancelled(ms: number, sleep: (ms: number) => Promise<void>, isCancelled: () => boolean): Promise<void> {
  const slice = 250
  for (let left = ms; left > 0 && !isCancelled(); left -= slice) await sleep(Math.min(slice, left))
}
