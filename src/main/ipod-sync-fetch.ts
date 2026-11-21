/**
 * A list iPod's Sync gets its missing songs itself (2026-11-20, Brief 263).
 *
 * Until now a list iPod's Sync waited for the background download
 * (ipod-local-start.ts) to bring its missing songs to this Mac, and called the
 * sync stuck the moment that download stopped for any reason. On 2026-11-20 it
 * stopped because the MacBook had under 60 GB free (the background download's
 * floor), so punkPod's Sync ended at Get ready with "Can't get 1 song right
 * now" while homemini had the file and answered for it. Jake: "this shit needs
 * to just work. all the backend checks need to stay BACKEND."
 *
 * Now the Sync fetches exactly the songs it needs, at once, by id, through the
 * same verified fetch the background download uses (homemini's audio-identity
 * first, the whole file checked against it and against this Mac's own record
 * of the song). It does not wait for music to stop or for 60 GB free: it needs
 * a handful of songs, and the restore keeps its own 10 GB floor. Each song gets
 * a few tries with waits between them. What comes of it:
 *   • landed: the song is on this Mac now;
 *   • gone: homemini has no file for it, or its file is provably another song.
 *     The Sync goes ahead without it and says so in one line afterwards: one
 *     song must never keep a whole iPod from syncing;
 *   • unclean: homemini has a file, but it couldn't be fetched cleanly: every
 *     download failed homemini's own size and sha1 (`torn`, after every try),
 *     or homemini can't say what its file is and it isn't this Mac's record
 *     (`stuck`). Left off with one line, like `gone`: one song must never keep
 *     a whole iPod from syncing (Brief 263). A song re-tagged on homemini after
 *     it left this Mac is NOT this: homemini's own identity proves the download,
 *     and it lands (ipod-local-start.ts `land`, `acceptHomeminis`);
 *   • failed: still not here after every try (homemini not answering), or
 *     not tried again because this Mac has no room (`noRoom`: the whole fetch
 *     stops at once) or can't read its free space. The Sync stops before the
 *     card is touched, with one plain line (`reason`).
 *
 * Electron-free; every effect is injected (__tests__/ipod-sync-fetch.test.ts).
 */
import type { IdentityAnswer, IdentityEntry } from './audio-identity.ts'
import { diskWriteWouldBreachFloor, formatFreeSpaceRefuse, MATERIALIZE_FREE_FLOOR_BYTES } from './ipod-sync-materialize.ts'
import type { PrefetchItem } from './ipod-prefetch.ts'
import { NO_ROOM_FOR_SYNC_LINE, ROOM_UNKNOWN_LINE } from '../common/ipod-ready-on-mac.ts'

export type SyncFetchOne =
  | { ok: true }
  /**
   * gone: homemini has no file for this song. stuck: homemini's file can't be
   * proven and trying again can't help: left off, not retried. torn: the bytes
   * that came aren't homemini's own file (its size and sha1): tried again, and
   * left off if every try is torn. noRoom: this Mac can't take it (or can't read
   * its free space): the whole fetch stops at once.
   */
  | { ok: false; error: string; gone?: boolean; stuck?: boolean; torn?: boolean; noRoom?: boolean }

export interface SyncFetchDeps {
  /** The songs the sync needs that aren't on this Mac. */
  items: readonly PrefetchItem[]
  /** homemini's audio-identity for these ids. */
  ask: (ids: number[]) => Promise<IdentityAnswer>
  /** One verified fetch. `remote`: homemini's answer (undefined = it can't be asked). */
  fetchOne: (item: PrefetchItem, remote: IdentityEntry | undefined) => Promise<SyncFetchOne>
  /** Already on this Mac (another fetch got it meanwhile): counted landed, not fetched again. */
  isHere?: (item: PrefetchItem) => Promise<boolean>
  wait: (ms: number) => Promise<void>
  /** Jake pressed Stop. */
  shouldStop?: () => boolean
  /** Waits between rounds; one more round than waits. */
  backoffMs?: readonly number[]
}

export interface SyncFetchResult {
  landed: number[]
  gone: Array<{ id: number; why: string }>
  /** homemini has a file, but it couldn't be fetched cleanly: left off this time. */
  unclean: Array<{ id: number; why: string }>
  failed: Array<{ id: number; error: string }>
  stopped: boolean
  /** The one plain line for the Device page when songs failed for a reason Jake can act on, else null. */
  reason: string | null
}

export const SYNC_FETCH_BACKOFF_MS: readonly number[] = [2_000, 8_000, 20_000]

export async function fetchForSync(deps: SyncFetchDeps): Promise<SyncFetchResult> {
  const out: SyncFetchResult = { landed: [], gone: [], unclean: [], failed: [], stopped: false, reason: null }
  const backoff = deps.backoffMs ?? SYNC_FETCH_BACKOFF_MS
  const stop = deps.shouldStop ?? (() => false)
  let pending = [...new Map(deps.items.map((i) => [i.id, i])).values()]
  const lastError = new Map<number, string>()
  const torn = new Set<number>()
  let noRoom = false
  let roomUnknown = false
  for (let round = 0; round <= backoff.length && pending.length > 0 && !noRoom; round++) {
    if (round > 0) await deps.wait(backoff[round - 1])
    if (stop()) { out.stopped = true; break }
    let answer: IdentityAnswer
    try { answer = await deps.ask(pending.map((i) => i.id)) } catch { answer = { kind: 'unreachable' } }
    if (answer.kind === 'unreachable') {
      for (const i of pending) { lastError.set(i.id, 'homemini didn’t answer'); torn.delete(i.id) }
      continue
    }
    const next: PrefetchItem[] = []
    for (const item of pending) {
      if (noRoom) { lastError.set(item.id, lastError.get(item.id) ?? 'not enough room on this Mac'); next.push(item); continue }
      if (stop()) { out.stopped = true; next.push(item); continue }
      if (deps.isHere && (await deps.isHere(item).catch(() => false))) { out.landed.push(item.id); continue }
      const remote = answer.kind === 'answers' ? answer.byId.get(String(item.id)) : undefined
      if (answer.kind === 'answers' && remote === null) {
        out.gone.push({ id: item.id, why: 'homemini doesn’t have the file' })
        continue
      }
      let r: SyncFetchOne
      try { r = await deps.fetchOne(item, remote) } catch (err) { r = { ok: false, error: err instanceof Error ? err.message : String(err) } }
      if (r.ok) { out.landed.push(item.id); continue }
      if (r.gone) { out.gone.push({ id: item.id, why: r.error }); continue }
      if (r.stuck) { out.unclean.push({ id: item.id, why: r.error }); continue }
      if (r.noRoom) { noRoom = true; roomUnknown = r.error === ROOM_UNKNOWN_ERROR }
      if (r.torn) torn.add(item.id)
      else torn.delete(item.id)
      lastError.set(item.id, r.error)
      next.push(item)
    }
    pending = next
    if (out.stopped) break
  }
  if (!out.stopped) {
    for (const i of pending) {
      const error = lastError.get(i.id) ?? 'not fetched'
      // Every try came torn (and not because the fetch stopped for room): left off, not a stop.
      if (torn.has(i.id) && !noRoom) out.unclean.push({ id: i.id, why: error })
      else out.failed.push({ id: i.id, error })
    }
  }
  if (noRoom && !out.stopped) out.reason = roomUnknown ? ROOM_UNKNOWN_LINE : NO_ROOM_FOR_SYNC_LINE
  return out
}

/** The one log line a sync fetch leaves in main.log. */
export function syncFetchLogLine(ipodName: string, r: SyncFetchResult): string {
  const parts = [`[ipod-local] sync of ${ipodName}: fetched ${r.landed.length} song(s) from homemini`]
  if (r.gone.length) parts.push(`${r.gone.length} left off (first: id ${r.gone[0].id}: ${r.gone[0].why})`)
  if (r.unclean.length) parts.push(`${r.unclean.length} couldn’t be fetched cleanly, left off (first: id ${r.unclean[0].id}: ${r.unclean[0].why})`)
  if (r.failed.length) parts.push(`${r.failed.length} still missing (first: id ${r.failed[0].id}: ${r.failed[0].error})`)
  if (r.stopped) parts.push('stopped by Jake')
  return parts.join(' · ')
}

/**
 * Before one song is downloaded (review of #466): the download sat in its part
 * file, then the restore wrote a second copy beside it, and only then was the
 * 10 GB floor asked, so under the floor every try downloaded, refused, and tried
 * again, and with less free than the song it could fill the disk. Both copies are
 * counted (the part and the restore's temp exist at once). Unknown free space
 * (NaN) refuses, as the floor always has, but says so (`ROOM_UNKNOWN_ERROR`),
 * never "not enough room". null = room.
 */
export const ROOM_UNKNOWN_ERROR = 'couldn’t check free space on this Mac'
export function landingRoomRefusal(freeBytes: number, item: Pick<PrefetchItem, 'bytes'>, remote?: IdentityEntry, floor = MATERIALIZE_FREE_FLOOR_BYTES): string | null {
  if (!Number.isFinite(freeBytes)) return ROOM_UNKNOWN_ERROR
  const remoteSize = remote && typeof (remote as { size?: unknown }).size === 'number' ? Number((remote as { size: number }).size) : 0
  const need = Math.max(0, Number(item.bytes) || 0, remoteSize)
  if (!diskWriteWouldBreachFloor(freeBytes, need * 2, floor)) return null
  return `not enough room on this Mac: ${formatFreeSpaceRefuse(freeBytes, floor)}`
}

/**
 * One writer per song at a time (review of #466): the background download and a
 * Sync's fetch could land the same song at once. A second caller waits for the
 * first to finish, then runs (and finds the song already here).
 */
export function createKeyedLock<K>(): <T>(key: K, fn: () => Promise<T>) => Promise<T> {
  const tails = new Map<K, Promise<void>>()
  return async <T>(key: K, fn: () => Promise<T>): Promise<T> => {
    const before = tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const mine = new Promise<void>((resolve) => { release = resolve })
    const tail = before.then(() => mine)
    tails.set(key, tail)
    await before
    try {
      return await fn()
    } finally {
      release()
      if (tails.get(key) === tail) tails.delete(key)
    }
  }
}

/**
 * A song re-tagged on homemini after it left this Mac (review of #469): tag
 * rewrites reach homemini, so its file stops matching this Mac's eviction or
 * offload receipt, and nothing ever rewrote the receipt, so that one song was
 * "not the same file" for good. When a Sync's download proves itself against
 * homemini's OWN identity (size and whole-file sha1), homemini's file is the
 * song now: it lands, and the receipt it replaced is superseded here, so later
 * checks agree. The receipt files themselves (evictions.log, the offload log)
 * are history and are never rewritten.
 *
 * Keyed by the library path. An override applies only while the receipt on
 * file is still the one it replaced: a newer eviction of that path (its own new
 * receipt) wins.
 */
export const SUPERSEDED_RECEIPTS_FILE = 'ipod-receipts-superseded.json'
export interface ReceiptPair { fullSha1?: string; evicted?: { md5: string; bytes: number } }
export interface SupersededReceipt { id: number; was: ReceiptPair; now: { sha1: string; md5: string; bytes: number }; at: number }
export type SupersededReceipts = Record<string, SupersededReceipt>

const HEX40 = /^[0-9a-f]{40}$/
const HEX32 = /^[0-9a-f]{32}$/

export function parseSupersededReceipts(text: string | null): SupersededReceipts {
  if (!text) return {}
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return {} }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: SupersededReceipts = {}
  for (const [path, v] of Object.entries(raw as Record<string, unknown>)) {
    const r = v as Partial<SupersededReceipt> | null
    if (!r || typeof r !== 'object' || !r.now || !r.was) continue
    const now = r.now as { sha1?: unknown; md5?: unknown; bytes?: unknown }
    if (typeof now.sha1 !== 'string' || !HEX40.test(now.sha1) || typeof now.md5 !== 'string' || !HEX32.test(now.md5)) continue
    if (!Number.isSafeInteger(now.bytes) || Number(now.bytes) <= 0) continue
    const was = r.was as ReceiptPair
    const wasOk: ReceiptPair = {}
    if (typeof was.fullSha1 === 'string') wasOk.fullSha1 = was.fullSha1.toLowerCase()
    if (was.evicted && typeof was.evicted.md5 === 'string' && Number.isSafeInteger(was.evicted.bytes)) wasOk.evicted = { md5: was.evicted.md5.toLowerCase(), bytes: was.evicted.bytes }
    if (!wasOk.fullSha1 && !wasOk.evicted) continue
    out[path] = { id: Number(r.id) || 0, was: wasOk, now: { sha1: now.sha1, md5: now.md5, bytes: Number(now.bytes) }, at: Number(r.at) || 0 }
  }
  return out
}

/** The doc with `item`'s receipt superseded by homemini's file; unchanged when the item carries no receipt. */
export function supersedeReceipt(doc: SupersededReceipts, item: Pick<PrefetchItem, 'id' | 'colon' | 'fullSha1' | 'evicted'>, now: { sha1: string; md5: string; bytes: number }, at: number): SupersededReceipts {
  if (!item.fullSha1 && !item.evicted) return doc
  const was: ReceiptPair = {}
  if (item.fullSha1) was.fullSha1 = item.fullSha1.toLowerCase()
  if (item.evicted) was.evicted = { md5: item.evicted.md5.toLowerCase(), bytes: item.evicted.bytes }
  return { ...doc, [item.colon]: { id: item.id, was, now: { sha1: now.sha1.toLowerCase(), md5: now.md5.toLowerCase(), bytes: now.bytes }, at } }
}

/** This Mac's receipts with each still-current superseded one replaced by homemini's file. */
export function applySupersededReceipts<E extends { md5: string; bytes: number }>(
  fullSha1ByPath: ReadonlyMap<string, string>,
  evictedByPath: ReadonlyMap<string, E>,
  doc: SupersededReceipts,
): { fullSha1ByPath: Map<string, string>; evictedByPath: Map<string, { md5: string; bytes: number }> } {
  const sha1s = new Map(fullSha1ByPath)
  const evicted = new Map<string, { md5: string; bytes: number }>(evictedByPath)
  for (const [path, r] of Object.entries(doc)) {
    const curSha1 = sha1s.get(path)?.toLowerCase()
    const curEv = evicted.get(path)
    const sameSha1 = (curSha1 ?? '') === (r.was.fullSha1 ?? '')
    const sameEv = !curEv && !r.was.evicted
      || (!!curEv && !!r.was.evicted && curEv.md5.toLowerCase() === r.was.evicted.md5 && curEv.bytes === r.was.evicted.bytes)
    if (!sameSha1 || !sameEv) continue   // this Mac has a newer receipt for the path: it wins
    if (r.was.fullSha1) sha1s.set(path, r.now.sha1)
    if (r.was.evicted) evicted.set(path, { ...curEv, md5: r.now.md5, bytes: r.now.bytes })
  }
  return { fullSha1ByPath: sha1s, evictedByPath: evicted }
}
