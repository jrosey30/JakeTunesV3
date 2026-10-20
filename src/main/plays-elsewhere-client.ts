/**
 * Plays-elsewhere client (2026-10-20) — the desktop's half of
 * GET {MOBILE_BACKEND_URL}/api/plays/elsewhere (the wire contract and the
 * display-only rule are src/common/plays-elsewhere.ts).
 *
 * What the views count, in order:
 *   1. homemini's answer — fetched with If-None-Match once a copy is cached,
 *      so the 10-minute poll is usually a 304;
 *   2. the cached copy (userData/plays-elsewhere.desktop-cache.json) while
 *      homemini is away — with no age limit: a play heard is history, and an
 *      old copy is short, never wrong;
 *   3. otherwise nothing: this Mac's own counts, as before.
 *
 * On a replica (workmini) it is 'off' and never fetches — its own plays are in
 * the feed, so adding it there would count them twice.
 *
 * A reply that isn't the document (wrong version, HTML from a proxy, torn
 * JSON) never replaces a good cache. Read-only toward homemini: GET only. The
 * cache is the ONLY thing written, and only here — never library.json or the
 * overrides.
 *
 * Pure of electron — fetch, the directory and the clock are injected, so it
 * runs under node:test (__tests__/plays-elsewhere-client.test.ts).
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeJsonAtomic } from './atomic-write.ts'
import { withCompanionInit } from './hub-companion.ts'
import { parsePlaysElsewhere, PLAYS_ELSEWHERE_PATH, type PlaysElsewhere, type PlaysElsewhereState } from '../common/plays-elsewhere.ts'

export interface FetchReply { ok: boolean; status: number; json(): Promise<unknown>; headers?: { get(name: string): string | null } }
export type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<FetchReply>

export const PLAYS_ELSEWHERE_CACHE_FILE = 'plays-elsewhere.desktop-cache.json'

export interface PlaysElsewhereClientOptions {
  /** homemini backend origin, e.g. http://homemini:3000 (no trailing slash). */
  baseUrl: string
  /** Where the cache file lives (userData in the app). */
  dir: string
  /** true on a replica: never fetch, report 'off'. */
  isReplica: () => Promise<boolean>
  fetchImpl?: FetchLike
  now?: () => number
  log?: (msg: string) => void
  warn?: (key: string, msg: string) => void
  timeoutMs?: number
}

interface CacheFile { doc: unknown; etag?: string | null; confirmedAt?: number }

export interface PlaysElsewhereClient {
  /** What to count now — the cache or nothing, no network. */
  read(): Promise<PlaysElsewhereState>
  /** One GET (coalesced), then what to count. */
  refresh(): Promise<PlaysElsewhereState>
  /** Called when what to count changes (after a refresh). */
  onChange(cb: (state: PlaysElsewhereState) => void): () => void
}

export function createPlaysElsewhereClient(opts: PlaysElsewhereClientOptions): PlaysElsewhereClient {
  const fetchImpl: FetchLike = opts.fetchImpl ?? (fetch as unknown as FetchLike)
  const now = opts.now ?? Date.now
  const log = opts.log ?? ((m: string) => console.log(m))
  const warn = opts.warn ?? ((_k: string, m: string) => console.warn(m))
  const timeoutMs = opts.timeoutMs ?? 8000
  const url = `${opts.baseUrl.replace(/\/+$/, '')}${PLAYS_ELSEWHERE_PATH}`
  const cachePath = join(opts.dir, PLAYS_ELSEWHERE_CACHE_FILE)

  let wasUnreachable = false
  let liveThisSession = false
  const listeners = new Set<(s: PlaysElsewhereState) => void>()
  let lastEmitted = ''

  /** `raw` is the body as homemini sent it — what gets re-written on a 304. */
  async function readCache(): Promise<{ doc: PlaysElsewhere; raw: unknown; etag: string | null; confirmedAt: number } | null> {
    let raw: Partial<CacheFile> | null = null
    try { raw = JSON.parse(await readFile(cachePath, 'utf-8')) as Partial<CacheFile> } catch { return null /* none yet, or torn — treated as absent */ }
    const doc = raw && typeof raw === 'object' ? parsePlaysElsewhere(raw.doc) : null
    if (!doc) return null
    return { doc, raw: raw?.doc, etag: typeof raw?.etag === 'string' ? raw.etag : null, confirmedAt: typeof raw?.confirmedAt === 'number' ? raw.confirmedAt : 0 }
  }

  async function writeCache(doc: unknown, etag: string | null): Promise<void> {
    const file: CacheFile = { doc, etag, confirmedAt: now() }
    await writeJsonAtomic(cachePath, file)
  }

  function noteReachable(ok: boolean, why?: string): void {
    if (ok && wasUnreachable) { wasUnreachable = false; log('[plays-elsewhere] homemini reachable again') }
    if (!ok && !wasUnreachable) {
      wasUnreachable = true
      warn('unreachable', `[plays-elsewhere] homemini unreachable (${why ?? 'no answer'}) — counting the cached copy`)
    }
  }

  async function read(): Promise<PlaysElsewhereState> {
    if (await opts.isReplica()) return { doc: null, source: 'off', fetchedAt: null }
    const cache = await readCache()
    if (cache) return { doc: cache.doc, source: liveThisSession ? 'homemini' : 'cache', fetchedAt: cache.confirmedAt || null }
    return { doc: null, source: 'none', fetchedAt: null }
  }

  async function emit(): Promise<PlaysElsewhereState> {
    const state = await read()
    const json = JSON.stringify({ ...state, fetchedAt: null })
    if (json !== lastEmitted) {
      lastEmitted = json
      for (const cb of listeners) {
        try { cb(state) } catch (err) { warn('listener', `[plays-elsewhere] change listener threw: ${err instanceof Error ? err.message : String(err)}`) }
      }
    }
    return state
  }

  async function fetchOnce(): Promise<void> {
    if (await opts.isReplica()) return
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
      await writeCache(cache.raw, cache.etag)
      return
    }
    if (!res.ok) {
      // 404 = the route isn't deployed on homemini yet; 5xx = it's unwell. Either way: keep the cache.
      liveThisSession = false
      noteReachable(false, `GET ${res.status}`)
      return
    }
    const body = await res.json().catch(() => null)
    if (!parsePlaysElsewhere(body)) {
      liveThisSession = false
      noteReachable(false, 'GET returned no plays document')
      return
    }
    noteReachable(true)
    liveThisSession = true
    await writeCache(body, res.headers?.get('etag') ?? null)
  }

  let inFlight: Promise<PlaysElsewhereState> | null = null
  function refresh(): Promise<PlaysElsewhereState> {
    if (inFlight) return inFlight
    inFlight = (async () => {
      try {
        await fetchOnce()
      } catch (err) {
        warn('refresh', `[plays-elsewhere] refresh failed: ${err instanceof Error ? err.message : String(err)}`)
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
