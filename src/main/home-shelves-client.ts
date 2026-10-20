/**
 * Home shelves client (2026-10-20) — the desktop's half of
 * GET {MOBILE_BACKEND_URL}/api/home-shelves (the wire contract is
 * src/common/home-shelves-doc.ts; the rules src/common/home-shelves.ts).
 *
 * What the Home draws, in order:
 *   1. homemini's document — fetched with If-None-Match once a copy is cached,
 *      so the 10-minute poll is usually a 304;
 *   2. the cached copy (userData/home-shelves.desktop-cache.json) while
 *      homemini is away — up to MAX_CACHE_AGE_MS since homemini last
 *      confirmed it (the gems rotate daily and "14 plays" ages fast);
 *   3. otherwise { doc: null, source: 'none' }: the RENDERER builds the same
 *      rows from this Mac's own library and history (localHomeShelves), because
 *      the taste score the hidden gems need lives in the renderer.
 *
 * A reply that isn't a document (wrong version, HTML from a proxy, torn JSON)
 * never replaces a good cache. Read-only toward homemini: GET only.
 *
 * Pure of electron — fetch, the directory and the clock are injected, so it
 * runs under node:test (__tests__/home-shelves-client.test.ts).
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeJsonAtomic } from './atomic-write.ts'
import { withCompanionInit } from './hub-companion.ts'
import { parseHomeShelves, type HomeShelves, type HomeShelvesState } from '../common/home-shelves-doc.ts'

export interface FetchReply { ok: boolean; status: number; json(): Promise<unknown>; headers?: { get(name: string): string | null } }
export type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<FetchReply>

export const HOME_SHELVES_PATH = '/api/home-shelves'
export const HOME_SHELVES_CACHE_FILE = 'home-shelves.desktop-cache.json'
export const MAX_CACHE_AGE_MS = 24 * 3_600_000

export interface HomeShelvesClientOptions {
  /** homemini backend origin, e.g. http://homemini:3000 (no trailing slash). */
  baseUrl: string
  /** Where the cache file lives (userData in the app). */
  dir: string
  fetchImpl?: FetchLike
  now?: () => number
  log?: (msg: string) => void
  warn?: (key: string, msg: string) => void
  timeoutMs?: number
}

interface CacheFile { doc: unknown; etag?: string | null; confirmedAt?: number }

export interface HomeShelvesClient {
  /** What to draw now — the cache or nothing, no network. */
  read(): Promise<HomeShelvesState>
  /** One GET (coalesced), then what to draw. */
  refresh(): Promise<HomeShelvesState>
  /** Called when what to draw changes (after a refresh). */
  onChange(cb: (state: HomeShelvesState) => void): () => void
}

export function createHomeShelvesClient(opts: HomeShelvesClientOptions): HomeShelvesClient {
  const fetchImpl: FetchLike = opts.fetchImpl ?? (fetch as unknown as FetchLike)
  const now = opts.now ?? Date.now
  const log = opts.log ?? ((m: string) => console.log(m))
  const warn = opts.warn ?? ((_k: string, m: string) => console.warn(m))
  const timeoutMs = opts.timeoutMs ?? 6000
  const url = `${opts.baseUrl.replace(/\/+$/, '')}${HOME_SHELVES_PATH}`
  const cachePath = join(opts.dir, HOME_SHELVES_CACHE_FILE)

  let reachable: boolean | null = null
  let wasUnreachable = false
  let liveThisSession = false
  const listeners = new Set<(s: HomeShelvesState) => void>()
  let lastEmitted = ''

  /** `raw` is the document as homemini sent it — what gets re-written on a
   *  304 (the parsed rows are a different shape and would not re-parse). */
  async function readCache(): Promise<{ doc: HomeShelves; raw: unknown; etag: string | null; confirmedAt: number } | null> {
    let raw: Partial<CacheFile> | null = null
    try { raw = JSON.parse(await readFile(cachePath, 'utf-8')) as Partial<CacheFile> } catch { return null /* none yet, or torn — treated as absent */ }
    const doc = raw && typeof raw === 'object' ? parseHomeShelves(raw.doc) : null
    if (!doc) return null
    return { doc, raw: raw?.doc, etag: typeof raw?.etag === 'string' ? raw.etag : null, confirmedAt: typeof raw?.confirmedAt === 'number' ? raw.confirmedAt : 0 }
  }

  async function writeCache(doc: unknown, etag: string | null): Promise<void> {
    const file: CacheFile = { doc, etag, confirmedAt: now() }
    await writeJsonAtomic(cachePath, file)
  }

  function noteReachable(ok: boolean, why?: string): void {
    reachable = ok
    if (ok && wasUnreachable) { wasUnreachable = false; log('[home-shelves] homemini reachable again') }
    if (!ok && !wasUnreachable) {
      wasUnreachable = true
      warn('unreachable', `[home-shelves] homemini unreachable (${why ?? 'no answer'}) — drawing the cached copy or this Mac's own history`)
    }
  }

  async function read(): Promise<HomeShelvesState> {
    const cache = await readCache()
    if (cache && now() - cache.confirmedAt <= MAX_CACHE_AGE_MS) {
      return { doc: cache.doc, source: liveThisSession && reachable ? 'homemini' : 'cache', reachable, fetchedAt: cache.confirmedAt || null }
    }
    return { doc: null, source: 'none', reachable, fetchedAt: null }
  }

  async function emit(): Promise<HomeShelvesState> {
    const state = await read()
    const json = JSON.stringify({ ...state, fetchedAt: null })
    if (json !== lastEmitted) {
      lastEmitted = json
      for (const cb of listeners) {
        try { cb(state) } catch (err) { warn('listener', `[home-shelves] change listener threw: ${err instanceof Error ? err.message : String(err)}`) }
      }
    }
    return state
  }

  async function fetchOnce(): Promise<void> {
    const cache = await readCache()
    let res: FetchReply
    try {
      const conditional = cache?.etag ? { headers: { 'If-None-Match': cache.etag } } : {}
      res = await fetchImpl(url, withCompanionInit({ ...conditional, signal: AbortSignal.timeout(timeoutMs) }) as Record<string, unknown>)
    } catch (err) {
      liveThisSession = false
      noteReachable(false, err instanceof Error ? err.message : String(err))
      return
    }
    if (res.status === 304 && cache) {
      noteReachable(true)
      liveThisSession = true
      await writeCache(cache.raw, cache.etag)        // confirmed fresh: restart its age
      return
    }
    if (!res.ok) {
      // 404 = the route isn't deployed on homemini yet; 5xx = it's unwell. Either way: fall back.
      liveThisSession = false
      noteReachable(false, `GET ${res.status}`)
      return
    }
    const body = await res.json().catch(() => null)
    if (!parseHomeShelves(body)) {
      liveThisSession = false
      noteReachable(false, 'GET returned no shelves document')
      return
    }
    noteReachable(true)
    liveThisSession = true
    await writeCache(body, res.headers?.get('etag') ?? null)
  }

  let inFlight: Promise<HomeShelvesState> | null = null
  function refresh(): Promise<HomeShelvesState> {
    if (inFlight) return inFlight
    inFlight = (async () => {
      try {
        await fetchOnce()
      } catch (err) {
        warn('refresh', `[home-shelves] refresh failed: ${err instanceof Error ? err.message : String(err)}`)
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
