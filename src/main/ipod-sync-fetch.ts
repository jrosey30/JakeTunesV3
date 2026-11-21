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
 *   • failed: still not here after every try (homemini not answering, no room).
 *     The Sync stops before the card is touched, as before.
 *
 * Electron-free; every effect is injected (__tests__/ipod-sync-fetch.test.ts).
 */
import type { IdentityAnswer, IdentityEntry } from './audio-identity.ts'
import type { PrefetchItem } from './ipod-prefetch.ts'

export type SyncFetchOne =
  | { ok: true }
  /** gone: this song can't be had from homemini (no file, or its file isn't this song). */
  | { ok: false; error: string; gone?: boolean }

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
}

export const SYNC_FETCH_BACKOFF_MS: readonly number[] = [2_000, 8_000, 20_000]

export async function fetchForSync(deps: SyncFetchDeps): Promise<SyncFetchResult> {
  const out: SyncFetchResult = { landed: [], gone: [], failed: [], stopped: false }
  const backoff = deps.backoffMs ?? SYNC_FETCH_BACKOFF_MS
  const stop = deps.shouldStop ?? (() => false)
  let pending = [...new Map(deps.items.map((i) => [i.id, i])).values()]
  const lastError = new Map<number, string>()
  for (let round = 0; round <= backoff.length && pending.length > 0; round++) {
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
      lastError.set(item.id, r.error)
      next.push(item)
    }
    pending = next
    if (out.stopped) break
  }
  if (!out.stopped) for (const i of pending) out.failed.push({ id: i.id, error: lastError.get(i.id) ?? 'not fetched' })
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
