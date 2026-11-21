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
 *   • failed: still not here after every try (homemini not answering), or
 *     not tried again because trying can't help: not enough room on this Mac
 *     (`noRoom`: the whole fetch stops at once), or homemini's file differs
 *     from this Mac's own record of the song (`stuck`: a re-tag changes the
 *     bytes, so it is not "gone", and there is no audio-only record on this
 *     Mac to prove the audio is the same). The Sync stops before the card is
 *     touched, with one plain line (`reason`).
 *
 * Electron-free; every effect is injected (__tests__/ipod-sync-fetch.test.ts).
 */
import type { IdentityAnswer, IdentityEntry } from './audio-identity.ts'
import { diskWriteWouldBreachFloor, formatFreeSpaceRefuse, MATERIALIZE_FREE_FLOOR_BYTES } from './ipod-sync-materialize.ts'
import type { PrefetchItem } from './ipod-prefetch.ts'
import { NO_ROOM_FOR_SYNC_LINE, notTheSameFileLine } from '../common/ipod-ready-on-mac.ts'

export type SyncFetchOne =
  | { ok: true }
  /**
   * gone: homemini has no file for this song. stuck: trying again can't help
   * (homemini's file isn't the one on record here): not retried. noRoom: this
   * Mac can't take it: the whole fetch stops at once.
   */
  | { ok: false; error: string; gone?: boolean; stuck?: boolean; noRoom?: boolean }

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
  failed: Array<{ id: number; error: string }>
  stopped: boolean
  /** The one plain line for the Device page when songs failed for a reason Jake can act on, else null. */
  reason: string | null
}

export const SYNC_FETCH_BACKOFF_MS: readonly number[] = [2_000, 8_000, 20_000]

export async function fetchForSync(deps: SyncFetchDeps): Promise<SyncFetchResult> {
  const out: SyncFetchResult = { landed: [], gone: [], failed: [], stopped: false, reason: null }
  const backoff = deps.backoffMs ?? SYNC_FETCH_BACKOFF_MS
  const stop = deps.shouldStop ?? (() => false)
  let pending = [...new Map(deps.items.map((i) => [i.id, i])).values()]
  const lastError = new Map<number, string>()
  let stuck = 0
  let noRoom = false
  for (let round = 0; round <= backoff.length && pending.length > 0 && !noRoom; round++) {
    if (round > 0) await deps.wait(backoff[round - 1])
    if (stop()) { out.stopped = true; break }
    let answer: IdentityAnswer
    try { answer = await deps.ask(pending.map((i) => i.id)) } catch { answer = { kind: 'unreachable' } }
    if (answer.kind === 'unreachable') {
      for (const i of pending) lastError.set(i.id, 'homemini didn’t answer')
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
      if (r.stuck) { stuck++; out.failed.push({ id: item.id, error: r.error }); continue }
      if (r.noRoom) noRoom = true
      lastError.set(item.id, r.error)
      next.push(item)
    }
    pending = next
    if (out.stopped) break
  }
  if (!out.stopped) for (const i of pending) out.failed.push({ id: i.id, error: lastError.get(i.id) ?? 'not fetched' })
  if (noRoom && !out.stopped) out.reason = NO_ROOM_FOR_SYNC_LINE
  else if (stuck > 0) out.reason = notTheSameFileLine(stuck)
  return out
}

/** The one log line a sync fetch leaves in main.log. */
export function syncFetchLogLine(ipodName: string, r: SyncFetchResult): string {
  const parts = [`[ipod-local] sync of ${ipodName}: fetched ${r.landed.length} song(s) from homemini`]
  if (r.gone.length) parts.push(`${r.gone.length} left off (first: id ${r.gone[0].id}: ${r.gone[0].why})`)
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
 * (NaN) refuses, as the floor always has. null = room.
 */
export function landingRoomRefusal(freeBytes: number, item: Pick<PrefetchItem, 'bytes'>, remote?: IdentityEntry, floor = MATERIALIZE_FREE_FLOOR_BYTES): string | null {
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
