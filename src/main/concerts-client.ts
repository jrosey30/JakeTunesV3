/**
 * Concerts client — the desktop's reader of homemini's show collector
 * (GET {MOBILE_BACKEND_URL}/api/concerts + /api/concerts/discover; the shape
 * and the rules are src/common/concerts-feed.ts).
 *
 * What the Home's Shows section and the Music Man draw, in order:
 *   1. homemini's answer — both routes, fetched with If-None-Match once a copy
 *      is cached, so most polls are a 304;
 *   2. the cached copy (userData/concerts.desktop-cache.json) while homemini is
 *      away — up to MAX_CACHE_AGE_MS since homemini last confirmed it, with the
 *      nights that have passed pruned off;
 *   3. no usable cache → the pre-feed path, asked by THIS Mac: Bandsintown for
 *      the top library artists + the venue calendars (venues.ts), reshaped into
 *      the same items (`legacy`, injected);
 *   4. that empty too → an older cache, still pruned, rather than nothing;
 *   5. nothing at all → source 'none' and the section stays quiet.
 *
 * A reply that isn't a concerts document (the 503 "warming up" error, HTML
 * from a proxy, torn JSON) never replaces a good cache. Read-only toward
 * homemini: GET only. (Going / I went writes go through
 * concerts-going-client.ts, 2026-10-29.)
 *
 * Pure of electron — fetch, the directory, the clock and the fallback are
 * injected, so it runs under node:test (__tests__/concerts-client.test.ts).
 * Same pattern as home-spotlight-client.ts.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeJsonAtomic } from './atomic-write.ts'
import { withCompanionInit } from './hub-companion.ts'
import {
  DAY_MS, listConcerts, nyDate, parseConcertsReply,
  type ConcertItem, type ConcertsFeedState, type ConcertsSource,
} from '../common/concerts-feed.ts'

export interface FetchReply { ok: boolean; status: number; json(): Promise<unknown>; headers?: { get(name: string): string | null } }
export type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<FetchReply>

export const CONCERTS_PATH = '/api/concerts'
export const CONCERTS_DISCOVER_PATH = '/api/concerts/discover'
export const CONCERTS_CACHE_FILE = 'concerts.desktop-cache.json'
/** A cached copy older than this (since homemini last confirmed it) has missed
 *  a week of announcements — the fallback asks the sources itself instead. */
export const MAX_CACHE_AGE_MS = 7 * DAY_MS
/** The fallback's own answer is reused this long (Bandsintown's and the venue
 *  scrapes' caches in external.ts / venues.ts are longer still). */
export const LEGACY_TTL_MS = 30 * 60_000

export interface ConcertsClientOptions {
  /** homemini backend origin, e.g. http://homemini:3000 (no trailing slash). */
  baseUrl: string
  /** Where the cache file lives (userData in the app). */
  dir: string
  /** The offline fallback: Bandsintown + venue calendars, as items. */
  legacy: () => Promise<ConcertItem[]>
  fetchImpl?: FetchLike
  now?: () => number
  log?: (msg: string) => void
  warn?: (key: string, msg: string) => void
  timeoutMs?: number
}

interface Part { body: unknown; etag: string | null }
interface CacheFile { concerts?: Part | null; discover?: Part | null; confirmedAt?: number }
interface Cache { concerts: Part; discover: Part | null; confirmedAt: number }

export interface ConcertsClient {
  /** What to draw now — cache or the fallback's last answer, no network. */
  read(): Promise<ConcertsFeedState>
  /** GET both routes (coalesced); the fallback when they fail; then what to draw. */
  refresh(): Promise<ConcertsFeedState>
  /** Called when what to draw changes (after a refresh). */
  onChange(cb: (state: ConcertsFeedState) => void): () => void
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function createConcertsClient(opts: ConcertsClientOptions): ConcertsClient {
  const fetchImpl: FetchLike = opts.fetchImpl ?? (fetch as unknown as FetchLike)
  const now = opts.now ?? Date.now
  const log = opts.log ?? ((m: string) => console.log(m))
  const warn = opts.warn ?? ((_k: string, m: string) => console.warn(m))
  const timeoutMs = opts.timeoutMs ?? 8000
  const base = opts.baseUrl.replace(/\/+$/, '')
  const cachePath = join(opts.dir, CONCERTS_CACHE_FILE)

  let reachable: boolean | null = null
  let wasUnreachable = false
  /** homemini answered this session and its answer is the cache. */
  let liveThisSession = false
  let legacyMemo: { at: number; items: ConcertItem[] } | null = null
  const listeners = new Set<(s: ConcertsFeedState) => void>()
  let lastEmitted = ''

  async function readCache(): Promise<Cache | null> {
    let raw: Partial<CacheFile> | null = null
    try { raw = JSON.parse(await readFile(cachePath, 'utf-8')) as Partial<CacheFile> } catch { return null /* none yet, or torn — treated as absent */ }
    if (!raw || typeof raw !== 'object' || !raw.concerts || !parseConcertsReply(raw.concerts.body)) return null
    const part = (p: Part | null | undefined): Part | null => (p && typeof p === 'object' ? { body: p.body, etag: typeof p.etag === 'string' ? p.etag : null } : null)
    return { concerts: part(raw.concerts)!, discover: part(raw.discover), confirmedAt: typeof raw.confirmedAt === 'number' ? raw.confirmedAt : 0 }
  }

  function noteReachable(ok: boolean, why?: string): void {
    reachable = ok
    if (ok && wasUnreachable) { wasUnreachable = false; log('[concerts] homemini reachable again') }
    if (!ok && !wasUnreachable) {
      wasUnreachable = true
      warn('unreachable', `[concerts] homemini unreachable (${why ?? 'no answer'}) — drawing the cached copy, or asking Bandsintown + the venue calendars`)
    }
  }

  function fromCache(cache: Cache, source: ConcertsSource): ConcertsFeedState {
    const today = nyDate(now())
    const c = parseConcertsReply(cache.concerts.body)!
    const d = cache.discover ? parseConcertsReply(cache.discover.body) : null
    return {
      source,
      items: listConcerts(c.items, today),
      discover: listConcerts(d?.items ?? [], today),
      generatedAt: c.generatedAt, home: c.home,
      fetchedAt: cache.confirmedAt || null, reachable,
    }
  }
  const drawable = (s: ConcertsFeedState) => s.items.length > 0 || s.discover.length > 0
  const cacheFresh = (c: Cache | null): c is Cache => !!c && now() - c.confirmedAt <= MAX_CACHE_AGE_MS

  async function read(): Promise<ConcertsFeedState> {
    const cache = await readCache()
    if (cacheFresh(cache)) {
      const s = fromCache(cache, liveThisSession && reachable ? 'homemini' : 'cache')
      if (drawable(s)) return s
    }
    if (legacyMemo && legacyMemo.items.length) {
      return { source: 'fallback', items: listConcerts(legacyMemo.items, nyDate(now())), discover: [], generatedAt: null, home: null, fetchedAt: null, reachable }
    }
    if (cache) {
      const s = fromCache(cache, 'cache')       // older than a week, still better than an empty section
      if (drawable(s)) return s
    }
    return { source: 'none', items: [], discover: [], generatedAt: null, home: null, fetchedAt: null, reachable }
  }

  async function emit(): Promise<ConcertsFeedState> {
    const state = await read()
    // fetchedAt moves on every good poll; only a change worth redrawing pushes.
    const json = JSON.stringify({ ...state, fetchedAt: null })
    if (json !== lastEmitted) {
      lastEmitted = json
      for (const cb of listeners) {
        try { cb(state) } catch (err) { warn('listener', `[concerts] change listener threw: ${errText(err)}`) }
      }
    }
    return state
  }

  const get = (path: string, part: Part | null | undefined) => {
    const conditional = part?.etag ? { headers: { 'If-None-Match': part.etag } } : {}
    return fetchImpl(`${base}${path}`, withCompanionInit({ ...conditional, signal: AbortSignal.timeout(timeoutMs) }) as Record<string, unknown>)
  }

  /** One reply → the part to keep: a fresh body, the cached one on 304, or null. */
  async function partOf(res: FetchReply, cached: Part | null | undefined): Promise<Part | null> {
    if (res.status === 304 && cached) return cached
    if (!res.ok) return null
    const body = await res.json().catch((err: unknown) => { warn('json', `[concerts] reply was not JSON: ${errText(err)}`); return null })
    return parseConcertsReply(body) ? { body, etag: res.headers?.get('etag') ?? null } : null
  }

  async function fetchOnce(): Promise<void> {
    const cache = await readCache()
    const [cRes, dRes] = await Promise.allSettled([get(CONCERTS_PATH, cache?.concerts), get(CONCERTS_DISCOVER_PATH, cache?.discover)])
    // /api/concerts decides reachability; /discover is best-effort beside it.
    if (cRes.status === 'rejected') {
      liveThisSession = false
      noteReachable(false, errText(cRes.reason))
      return
    }
    const concerts = await partOf(cRes.value, cache?.concerts)
    if (!concerts) {
      // 503 = the collector is warming up; 404 = the route isn't deployed; else not a document.
      liveThisSession = false
      noteReachable(false, cRes.value.ok ? 'GET returned no concerts document' : `GET ${cRes.value.status}`)
      return
    }
    let discover = cache?.discover ?? null
    if (dRes.status === 'fulfilled') {
      const d = await partOf(dRes.value, cache?.discover)
      if (d) discover = d
      else warn('discover', `[concerts] /discover unusable (HTTP ${dRes.value.status}) — keeping the last "You'd like this"`)
    } else {
      warn('discover', `[concerts] /discover failed (${errText(dRes.reason)}) — keeping the last "You'd like this"`)
    }
    noteReachable(true)
    // What the Home draws is read back from the cache, so it only counts as
    // live once the write landed (a failed write throws to refresh's warn).
    await writeJsonAtomic(cachePath, { concerts, discover, confirmedAt: now() } satisfies CacheFile, false)
    liveThisSession = true
  }

  async function runLegacy(): Promise<void> {
    if (legacyMemo && now() - legacyMemo.at < LEGACY_TTL_MS) return
    try {
      const items = await opts.legacy()
      legacyMemo = { at: now(), items }
      log(`[concerts] fallback (Bandsintown + venue calendars): ${items.length} shows`)
    } catch (err) {
      warn('legacy', `[concerts] fallback failed: ${errText(err)}`)
    }
  }

  // Coalesced: one refresh in flight; callers during it share its answer.
  let inFlight: Promise<ConcertsFeedState> | null = null
  function refresh(): Promise<ConcertsFeedState> {
    if (inFlight) return inFlight
    inFlight = (async () => {
      try {
        await fetchOnce()
        if (!liveThisSession) {
          const cache = await readCache()
          if (!cacheFresh(cache) || !drawable(fromCache(cache, 'cache'))) await runLegacy()
        }
      } catch (err) {
        warn('refresh', `[concerts] refresh failed: ${errText(err)}`)
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
