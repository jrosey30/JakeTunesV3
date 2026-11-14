/**
 * "Ready for an updated sync" (Jake, 2026-11-07: "i should get a notification
 * when my top 1000 changes....meaning its ready for an updated sync").
 *
 * For every iPod registered on this Mac, compare what a Sync would put on it
 * (its TARGET) with what the last sync put on it (its last-sync-manifest.json):
 *
 *   • the Original: homemini's Top 1000, best first, the songs that can go on,
 *     exactly as the one-button sync picks them (main/ipod-one-sync.ts
 *     planOriginal: pickFromTop1000, then the most-loved songs fill the seats).
 *     A filler song already on the iPod that the sync would keep is not "out".
 *   • every other iPod: its homemini list (newest first), at most IPOD_LIST_MAX, the
 *     songs that can go on.
 *
 * One macOS notification (and one ntfy push when a topic is set) per distinct
 * difference, never twice for the same in/out sets, at most once per iPod per
 * 6 hours (the next one says the latest totals). A list that homemini grows
 * only every 7 days or more (its brain.everyDays; the punkPod: 14, Jake
 * 2026-11-08: "only update punkpod once every other week") is told at most
 * once per that many days; the last cadence seen is kept with its state, so a
 * read that doesn't carry it still waits. The Original (the Top 1000) is
 * once a WEEK (Jake, 2026-11-08: "the top 1000 notofication comes once a week
 * not daily"): a change inside the week waits, and the notice at the week's end
 * says the net difference at that moment; back to no difference by then, nothing
 * is sent. The week counts from the last notice, kept in ipod-sync-ready.json,
 * so a restart doesn't reset it. No manifest = the iPod was
 * never synced from this Mac: one "not synced yet", once. Only the hub (the
 * MacBook) checks at all, so three Macs never triple-notify.
 *
 * When it runs: on the Top 1000 standings' 10-minute tick (top1000-scores.ts
 * onPulled; the Original only when the standings were adopted, or when a
 * notice is waiting out its quiet window), and whenever a list is read from homemini
 * (ipc/ipod-lists-ipc.ts onListRead). No timer of its own.
 *
 * Electron-free; every effect is injected (__tests__/ipod-sync-ready.test.ts).
 * The Electron half is ipod-sync-ready-start.ts.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pickFromTop1000 } from '../common/top1000-sync.ts'
import type { IpodDeviceMarker } from '../common/ipod-identity.ts'
import { IPOD_LIST_MAX } from '../common/ipod-list-doc.ts'

/** The Original carries this many (ONE_SYNC_SIZE in ipod-one-sync.ts). Another iPod: its list, at most IPOD_LIST_MAX. */
export const SYNC_READY_CAP = 1000
/** At most one notice per iPod in this window, however often its difference shifts. */
export const SYNC_READY_QUIET_MS = 6 * 3600 * 1000
/** The Original (the Top 1000): at most one notice a week. */
export const SYNC_READY_ORIGINAL_QUIET_MS = 7 * 24 * 3600 * 1000

/** A list whose grower runs this rarely or rarer gets one notice per run window. */
export const SYNC_READY_CADENCE_MIN_DAYS = 7

/**
 * How long an iPod's notices stay quiet after one is told. `everyDays`: the
 * list's grow cadence from homemini (non-Original iPods only).
 */
export function quietMsFor(device: { primary: boolean }, everyDays?: number): number {
  if (device.primary) return SYNC_READY_ORIGINAL_QUIET_MS
  if (typeof everyDays === 'number' && Number.isInteger(everyDays) && everyDays >= SYNC_READY_CADENCE_MIN_DAYS) return everyDays * 24 * 3600 * 1000
  return SYNC_READY_QUIET_MS
}
export const SYNC_READY_STATE_FILE = 'ipod-sync-ready.json'

export type IpodSyncDiff =
  /** No manifest: never synced from this Mac. */
  | { kind: 'never-synced'; targetCount: number }
  | { kind: 'same' }
  | { kind: 'differs'; in: number[]; out: number[] }

/**
 * Pure: songs in (target, not on the iPod) and songs out (on the iPod, not in the
 * target and not kept as a filler). The target is de-duplicated and capped at
 * `cap`, in its own order.
 */
export function diffIpodTarget(input: {
  target: readonly number[]
  onIpod: readonly number[] | null
  cap?: number
  keep?: ReadonlySet<number>
}): IpodSyncDiff {
  const cap = Math.max(0, Math.floor(input.cap ?? SYNC_READY_CAP))
  const target: number[] = []
  const targetSet = new Set<number>()
  for (const raw of input.target) {
    const id = Number(raw)
    if (!Number.isInteger(id) || id <= 0 || targetSet.has(id)) continue
    if (target.length >= cap) break
    target.push(id)
    targetSet.add(id)
  }
  if (input.onIpod === null) return { kind: 'never-synced', targetCount: target.length }
  const onSet = new Set(input.onIpod.map(Number))
  const songsIn = target.filter((id) => !onSet.has(id))
  const songsOut = [...onSet].filter((id) => !targetSet.has(id) && !input.keep?.has(id))
  return songsIn.length === 0 && songsOut.length === 0 ? { kind: 'same' } : { kind: 'differs', in: songsIn, out: songsOut }
}

/** Pure: one key per distinct difference (the sorted in and out sets). */
export function diffKey(d: { in: readonly number[]; out: readonly number[] }): string {
  const s = (a: readonly number[]) => [...a].sort((x, y) => x - y).join(',')
  return createHash('sha1').update(`in:${s(d.in)}|out:${s(d.out)}`).digest('hex').slice(0, 16)
}

export interface DeviceNoticeState {
  /** The difference last told (diffKey). */
  key?: string
  /** When a difference was last told (ms). */
  at?: number
  /** A difference is waiting out the quiet window. */
  pending?: boolean
  /** "Not synced yet" was told. */
  toldNeverSynced?: boolean
  /** The list's grow cadence last read from homemini (brain.everyDays); non-Original only. */
  everyDays?: number
}

/** Pure: tell Jake now? And the state to keep either way. `quietMs`: quietMsFor(device). */
export function decideNotice(prev: DeviceNoticeState | undefined, diff: IpodSyncDiff, nowMs: number, quietMs: number = SYNC_READY_QUIET_MS): { notify: boolean; next: DeviceNoticeState } {
  const p: DeviceNoticeState = { ...(prev ?? {}) }
  if (diff.kind === 'never-synced') {
    if (p.toldNeverSynced || diff.targetCount === 0) return { notify: false, next: p }
    return { notify: true, next: { ...p, toldNeverSynced: true } }
  }
  if (diff.kind === 'same') return { notify: false, next: { ...p, pending: false } }
  const key = diffKey(diff)
  if (key === p.key) return { notify: false, next: { ...p, pending: false } }
  if (p.at !== undefined && nowMs - p.at < quietMs) return { notify: false, next: { ...p, pending: true } }
  return { notify: true, next: { ...p, key, at: nowMs, pending: false } }
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

/** How the notice names the iPod ("The Original", "punkPod"). */
export function spokenIpodName(device: { name: string; primary: boolean }): string {
  return device.primary && device.name === 'Original' ? 'The Original' : device.name
}

/** Pure: the notice's words. Null when there is nothing to say. */
export function noticeText(device: { name: string; primary: boolean }, diff: IpodSyncDiff): { title: string; body: string } | null {
  const title = 'JakeTunes'
  const who = spokenIpodName(device)
  if (diff.kind === 'same') return null
  if (diff.kind === 'never-synced') {
    return device.primary
      ? { title, body: `${who} hasn’t been synced from this Mac yet. Its Top 1000 is ready to go on.` }
      : { title, body: `${who} hasn’t been synced from this Mac yet. ${plural(diff.targetCount, 'song', 'songs')} on its list are ready to go on.` }
  }
  const nIn = diff.in.length
  const nOut = diff.out.length
  if (device.primary) {
    return { title, body: `Top 1000 this week: ${nIn.toLocaleString('en-US')} in, ${nOut.toLocaleString('en-US')} out. ${who} is ready for an updated sync.` }
  }
  if (nOut === 0) return { title, body: `${who}: ${plural(nIn, 'new song', 'new songs')} ready to sync.` }
  if (nIn === 0) return { title, body: `${who}: ${plural(nOut, 'song', 'songs')} to come off. Ready for an updated sync.` }
  return { title, body: `${who}: ${plural(nIn, 'new song', 'new songs')} in, ${nOut.toLocaleString('en-US')} out. Ready for an updated sync.` }
}

/** What can go on an iPod, from this Mac's library (null = the library couldn't be read). */
export interface SyncBoarding {
  canBoard(id: number): boolean
  /** The one-button sync's filler for the Original: the most-loved songs not in `taken`. */
  fill(taken: Set<number>, needed: number): number[]
}

export interface IpodSyncReadyDeps {
  stateDir: string
  /** Only the hub (the MacBook) checks and tells. Unsure = not the hub. */
  isHub: () => Promise<boolean>
  devices: () => Promise<IpodDeviceMarker[]>
  /** The ids the last sync put on this iPod; null = no manifest (never synced here). Throws = unreadable. */
  onIpod: (device: IpodDeviceMarker) => Promise<number[] | null>
  /** homemini's Top 1000, ranked best first; null = not answering. */
  top1000: () => Promise<number[] | null>
  /** homemini's list for a non-Original iPod, newest first (with its grow cadence when it has one); null = no clean answer. */
  list: (device: IpodDeviceMarker) => Promise<number[] | { ids: number[]; everyDays?: number } | null>
  boarding?: () => Promise<SyncBoarding | null>
  /** The macOS notification. Clicking it opens the Device page. */
  notify: (n: { title: string; body: string; deviceId: string }) => void
  /** The phone (ntfy). Best-effort. */
  push: (n: { title: string; body: string }) => Promise<unknown>
  now?: () => number
  log?: (msg: string) => void
}

export interface IpodSyncReadyRunner {
  /** One pass. `original`: check the Original (the Top 1000 moved). `lists`: check every other iPod. */
  check(opts: { original?: boolean; lists?: boolean }): Promise<void>
  /** The standings tick (top1000-scores.ts onPulled). */
  pulled(adopted: boolean): void
  /** A list was just read from homemini (ipc/ipod-lists-ipc.ts): check that iPod with those ids. */
  listRead(device: IpodDeviceMarker, listIdsNewestFirst: number[], everyDays?: number): void
  /** For the Device page / tests: the last difference per iPod id. */
  lastDiff(deviceId: string): IpodSyncDiff | null
}

type StateFile = Record<string, DeviceNoticeState>

export function createIpodSyncReady(deps: IpodSyncReadyDeps): IpodSyncReadyRunner {
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((m: string) => console.log(m))
  const statePath = join(deps.stateDir, SYNC_READY_STATE_FILE)
  const diffs = new Map<string, IpodSyncDiff>()
  let chain: Promise<void> = Promise.resolve()

  async function readState(): Promise<StateFile> {
    try {
      const raw = JSON.parse(await readFile(statePath, 'utf-8')) as unknown
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as StateFile : {}
    } catch { return {} }
  }
  async function writeState(s: StateFile): Promise<void> {
    await mkdir(deps.stateDir, { recursive: true })
    const tmp = `${statePath}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(s, null, 2))
    await rename(tmp, statePath)
  }

  async function targetFor(device: IpodDeviceMarker, boarding: SyncBoarding | null, given?: { ids: number[]; everyDays?: number }): Promise<{ target: number[]; keep: Set<number>; cadence?: { everyDays?: number } } | null> {
    if (device.primary) {
      const ranked = await deps.top1000().catch(() => null)
      if (!ranked || ranked.length === 0) return null
      if (!boarding) return { target: ranked.slice(0, SYNC_READY_CAP), keep: new Set() }
      const picked = pickFromTop1000(ranked, { gap: SYNC_READY_CAP, exclude: new Set(), syncable: (id) => boarding.canBoard(id) }).picked
      const keep = new Set(picked.length < SYNC_READY_CAP ? boarding.fill(new Set(picked), SYNC_READY_CAP - picked.length) : [])
      return { target: picked, keep }
    }
    const answer = given ?? await deps.list(device).catch(() => null)
    if (!answer) return null
    // A bare id list says nothing about the cadence; an { ids, everyDays } answer
    // is homemini's word on it (no everyDays = the list has none).
    const ids = Array.isArray(answer) ? answer : answer.ids
    const cadence = Array.isArray(answer) ? undefined : { everyDays: answer.everyDays }
    const capped = ids.slice(0, IPOD_LIST_MAX)
    return { target: boarding ? capped.filter((id) => boarding.canBoard(id)) : capped, keep: new Set(), ...(cadence ? { cadence } : {}) }
  }

  async function pass(only: (d: IpodDeviceMarker) => boolean, given?: { deviceId: string; answer: { ids: number[]; everyDays?: number } }): Promise<void> {
    if (!(await deps.isHub().catch(() => false))) return
    const devices = (await deps.devices().catch(() => [] as IpodDeviceMarker[])).filter(only)
    if (devices.length === 0) return
    const boarding = deps.boarding ? await deps.boarding().catch(() => null) : null
    const state = await readState()
    let changed = false
    for (const device of devices) {
      let onIpod: number[] | null
      try { onIpod = await deps.onIpod(device) } catch (err) {
        log(`[sync-ready] ${device.name}: last sync's manifest unreadable (${(err as Error)?.message ?? err}) — skipped`)
        continue
      }
      const t = await targetFor(device, boarding, given && given.deviceId === device.id ? given.answer : undefined)
      if (!t) continue   // homemini away / no list: say nothing, keep the state
      const diff = diffIpodTarget({ target: t.target, onIpod, keep: t.keep, cap: device.primary ? SYNC_READY_CAP : IPOD_LIST_MAX })
      diffs.set(device.id, diff)
      // The cadence: this read's when it says, else the last one seen (a read that
      // doesn't carry it still waits out the window homemini last named).
      const prev = state[device.id]
      const everyDays = device.primary ? undefined : t.cadence ? t.cadence.everyDays : prev?.everyDays
      const quietMs = quietMsFor(device, everyDays)
      const { notify, next: decided } = decideNotice(prev, diff, now(), quietMs)
      const next: DeviceNoticeState = { ...decided }
      delete next.everyDays
      if (everyDays !== undefined) next.everyDays = everyDays
      if (JSON.stringify(next) !== JSON.stringify(state[device.id] ?? {})) { state[device.id] = next; changed = true }
      const waiting = device.primary ? ' — waiting for the week'
        : quietMs > SYNC_READY_QUIET_MS ? ` — waiting out the ${Math.round(quietMs / 86_400_000)} days` : ' — waiting out the 6 hours'
      if (diff.kind === 'differs') log(`[sync-ready] ${device.name}: ${diff.in.length} in, ${diff.out.length} out${notify ? ' — told' : next.pending ? waiting : ''}`)
      if (!notify) continue
      const text = noticeText(device, diff)
      if (!text) continue
      try { deps.notify({ ...text, deviceId: device.id }) } catch (err) { log(`[sync-ready] notification failed: ${(err as Error)?.message ?? err}`) }
      await Promise.resolve(deps.push(text)).catch((err) => log(`[sync-ready] phone push failed: ${(err as Error)?.message ?? err}`))
    }
    if (changed) await writeState(state).catch((err) => log(`[sync-ready] could not save ${SYNC_READY_STATE_FILE}: ${(err as Error)?.message ?? err}`))
  }

  function queue(job: () => Promise<void>): Promise<void> {
    chain = chain.then(job).catch((err) => log(`[sync-ready] check failed: ${(err as Error)?.message ?? err}`))
    return chain
  }

  const runner: IpodSyncReadyRunner = {
    check(opts) {
      return queue(() => pass((d) => (d.primary ? !!opts.original : !!opts.lists)))
    },
    pulled(adopted) {
      void queue(async () => {
        // The Original: when the standings moved, or when a notice is waiting out its quiet hours.
        let original = adopted
        if (!original) {
          const state = await readState()
          const devices = await deps.devices().catch(() => [] as IpodDeviceMarker[])
          original = devices.some((d) => d.primary && state[d.id]?.pending)
        }
        await pass((d) => (d.primary ? original : true))
      })
    },
    listRead(device, ids, everyDays) {
      if (device.primary) return
      void queue(() => pass((d) => d.id === device.id, { deviceId: device.id, answer: { ids, everyDays } }))
    },
    lastDiff(deviceId) {
      return diffs.get(deviceId) ?? null
    },
  }
  return runner
}

/** The ids in a last-sync-manifest.json; null when there is none. Throws when it exists but can't be read. */
export async function readManifestIds(manifestPath: string): Promise<number[] | null> {
  let raw: string
  try { raw = await readFile(manifestPath, 'utf-8') } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null
    throw err
  }
  const m = JSON.parse(raw) as { tracks?: Array<{ id?: unknown }> }
  if (!Array.isArray(m?.tracks)) throw new Error('no tracks in the manifest')
  return m.tracks.map((t) => Number(t?.id)).filter((id) => Number.isInteger(id) && id > 0)
}
