/**
 * Listen More Weekly client (2026-10-20) — the desktop's half of homemini's
 * weekly playlist (Jake: "turn you should listen to more into like how
 * spotify has discover weekly. see all should take me to a new playlist that
 * the ai brain updates"). homemini mints it Monday 05:00 Eastern and keeps it
 * all week (JakeTunesMobile backend/src/util/listenMoreWeekly*.ts); this
 * client reads its song order from
 *
 *   GET {MOBILE_BACKEND_URL}/api/playlists/jaketunes-listen-more-weekly
 *   → { id, name, tracks: [{ id, … }] }
 *
 * and keeps the last good answer (userData/listen-more-weekly.desktop-cache.json)
 * for while homemini is away — up to MAX_CACHE_AGE_MS, a little over a week,
 * since the list itself only turns over on Mondays. Song ids are the shared
 * library ids, so the renderer resolves them against this Mac's library.
 *
 * A reply that isn't the playlist (404 before homemini has the route, HTML from
 * a proxy, torn JSON, no songs) never replaces a good cache. GET only.
 *
 * Pure of electron — fetch, the directory and the clock are injected
 * (__tests__/listen-more-weekly-client.test.ts).
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeJsonAtomic } from './atomic-write.ts'
import { withCompanionInit } from './hub-companion.ts'
import { LISTEN_MORE_WEEKLY_PATH, parseWeeklyPlaylist, type ListenMoreWeeklyState, type WeeklyPlaylist } from '../common/listen-more-weekly.ts'

export { LISTEN_MORE_WEEKLY_ID, LISTEN_MORE_WEEKLY_PATH, parseWeeklyPlaylist } from '../common/listen-more-weekly.ts'
export type { ListenMoreWeeklyState, WeeklyPlaylist } from '../common/listen-more-weekly.ts'

export interface FetchReply { ok: boolean; status: number; json(): Promise<unknown> }
export type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<FetchReply>

export const LISTEN_MORE_WEEKLY_CACHE_FILE = 'listen-more-weekly.desktop-cache.json'
export const MAX_CACHE_AGE_MS = 8 * 24 * 3_600_000

export interface ListenMoreWeeklyClientOptions {
  /** homemini backend origin, e.g. http://homemini:3000 (no trailing slash). */
  baseUrl: string
  dir: string
  fetchImpl?: FetchLike
  now?: () => number
  warn?: (key: string, msg: string) => void
  timeoutMs?: number
}

export interface ListenMoreWeeklyClient {
  read(): Promise<ListenMoreWeeklyState>
  refresh(): Promise<ListenMoreWeeklyState>
  onChange(cb: (state: ListenMoreWeeklyState) => void): () => void
}

export function createListenMoreWeeklyClient(opts: ListenMoreWeeklyClientOptions): ListenMoreWeeklyClient {
  const fetchImpl: FetchLike = opts.fetchImpl ?? (fetch as unknown as FetchLike)
  const now = opts.now ?? Date.now
  const warn = opts.warn ?? ((_k: string, m: string) => console.warn(m))
  const timeoutMs = opts.timeoutMs ?? 6000
  const url = `${opts.baseUrl.replace(/\/+$/, '')}${LISTEN_MORE_WEEKLY_PATH}`
  const cachePath = join(opts.dir, LISTEN_MORE_WEEKLY_CACHE_FILE)
  const listeners = new Set<(s: ListenMoreWeeklyState) => void>()
  let liveThisSession = false
  let lastEmitted = ''

  async function readCache(): Promise<{ playlist: WeeklyPlaylist; confirmedAt: number } | null> {
    try {
      const raw = JSON.parse(await readFile(cachePath, 'utf-8')) as { playlist?: unknown; confirmedAt?: unknown }
      const playlist = parseWeeklyPlaylist(raw?.playlist)
      if (!playlist) return null
      return { playlist, confirmedAt: typeof raw.confirmedAt === 'number' ? raw.confirmedAt : 0 }
    } catch {
      return null   // none yet, or torn — treated as absent
    }
  }

  async function read(): Promise<ListenMoreWeeklyState> {
    const cache = await readCache()
    if (cache && now() - cache.confirmedAt <= MAX_CACHE_AGE_MS) {
      return { playlist: cache.playlist, source: liveThisSession ? 'homemini' : 'cache', fetchedAt: cache.confirmedAt || null }
    }
    return { playlist: null, source: 'none', fetchedAt: null }
  }

  async function emit(): Promise<ListenMoreWeeklyState> {
    const state = await read()
    const json = JSON.stringify({ ...state, fetchedAt: null })
    if (json !== lastEmitted) {
      lastEmitted = json
      for (const cb of listeners) {
        try { cb(state) } catch (err) { warn('listener', `[listen-more-weekly] listener threw: ${err instanceof Error ? err.message : String(err)}`) }
      }
    }
    return state
  }

  async function fetchOnce(): Promise<void> {
    let res: FetchReply
    try {
      res = await fetchImpl(url, withCompanionInit({ signal: AbortSignal.timeout(timeoutMs) }) as Record<string, unknown>)
    } catch (err) {
      liveThisSession = false
      warn('unreachable', `[listen-more-weekly] homemini unreachable (${err instanceof Error ? err.message : String(err)}) — keeping the cached week`)
      return
    }
    if (!res.ok) {
      // 404 = homemini doesn't serve the playlist yet (or has no taste signal).
      liveThisSession = false
      return
    }
    const playlist = parseWeeklyPlaylist(await res.json().catch(() => null))
    if (!playlist) { liveThisSession = false; return }
    liveThisSession = true
    await writeJsonAtomic(cachePath, { playlist, confirmedAt: now() })
  }

  let inFlight: Promise<ListenMoreWeeklyState> | null = null
  function refresh(): Promise<ListenMoreWeeklyState> {
    if (inFlight) return inFlight
    inFlight = (async () => {
      try { await fetchOnce() } catch (err) {
        warn('refresh', `[listen-more-weekly] refresh failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      return emit()
    })().finally(() => { inFlight = null })
    return inFlight
  }

  return {
    read,
    refresh,
    onChange(cb) { listeners.add(cb); return () => { listeners.delete(cb) } },
  }
}
