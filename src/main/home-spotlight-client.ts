/**
 * Home spotlight client (launch page "G", 2026-10-18) — the desktop's half of
 * GET {MOBILE_BACKEND_URL}/api/home-spotlight (the wire contract is
 * src/common/home-spotlight-doc.ts).
 *
 * What the Home draws, in order:
 *   1. homemini's document — fetched with If-None-Match once a copy is cached,
 *      so the 10-minute poll is usually a 304;
 *   2. the cached copy (userData/home-spotlight.desktop-cache.json) while
 *      homemini is away — up to MAX_CACHE_AGE_MS since homemini last
 *      confirmed it, because "81 plays in 30 days" stops being true;
 *   3. no usable cache → the same document computed from THIS Mac's own play
 *      history (computeLocal — the shared rulebook), with no Music Man line;
 *   4. nothing at all → { doc: null, source: 'none' } and the Home stays quiet.
 *
 * A reply that isn't a document (wrong version, HTML from a proxy, torn JSON)
 * never replaces a good cache. Read-only toward homemini: GET only.
 *
 * Pure of electron — fetch, the directory, the clock and the local fallback
 * are injected, so it runs under node:test (__tests__/home-spotlight-client.test.ts).
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeJsonAtomic } from './atomic-write.ts'
import { withCompanionInit } from './hub-companion.ts'
import {
  parseHomeSpotlight, isEmptySpotlight,
  type HomeSpotlightDoc, type HomeSpotlightState,
} from '../common/home-spotlight-doc.ts'

export interface FetchReply { ok: boolean; status: number; json(): Promise<unknown>; headers?: { get(name: string): string | null } }
export type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<FetchReply>

export const HOME_SPOTLIGHT_PATH = '/api/home-spotlight'
export const HOME_SPOTLIGHT_CACHE_FILE = 'home-spotlight.desktop-cache.json'
/** A cached document older than this (since homemini last confirmed it) is
 *  stale facts, not a fallback — the local computation draws instead. */
export const MAX_CACHE_AGE_MS = 7 * 86_400_000

export interface HomeSpotlightClientOptions {
  /** homemini backend origin, e.g. http://homemini:3000 (no trailing slash). */
  baseUrl: string
  /** Where the cache file lives (userData in the app). */
  dir: string
  /** The offline fallback: this Mac's own history through the rulebook. */
  computeLocal: () => Promise<HomeSpotlightDoc | null>
  fetchImpl?: FetchLike
  now?: () => number
  log?: (msg: string) => void
  warn?: (key: string, msg: string) => void
  timeoutMs?: number
}

interface CacheFile { doc: unknown; etag?: string | null; confirmedAt?: number }

export interface HomeSpotlightClient {
  /** What to draw now — cache or local, no network. */
  read(): Promise<HomeSpotlightState>
  /** One GET (coalesced), then what to draw. */
  refresh(): Promise<HomeSpotlightState>
  /** Called when what to draw changes (after a refresh). */
  onChange(cb: (state: HomeSpotlightState) => void): () => void
}

export function createHomeSpotlightClient(opts: HomeSpotlightClientOptions): HomeSpotlightClient {
  const fetchImpl: FetchLike = opts.fetchImpl ?? (fetch as unknown as FetchLike)
  const now = opts.now ?? Date.now
  const log = opts.log ?? ((m: string) => console.log(m))
  const warn = opts.warn ?? ((_k: string, m: string) => console.warn(m))
  const timeoutMs = opts.timeoutMs ?? 6000
  const url = `${opts.baseUrl.replace(/\/+$/, '')}${HOME_SPOTLIGHT_PATH}`
  const cachePath = join(opts.dir, HOME_SPOTLIGHT_CACHE_FILE)

  let reachable: boolean | null = null
  let wasUnreachable = false
  /** homemini answered this session and its document is the cache. */
  let liveThisSession = false
  const listeners = new Set<(s: HomeSpotlightState) => void>()
  let lastEmitted = ''

  async function readCache(): Promise<{ doc: HomeSpotlightDoc; etag: string | null; confirmedAt: number } | null> {
    let raw: Partial<CacheFile> | null = null
    try { raw = JSON.parse(await readFile(cachePath, 'utf-8')) as Partial<CacheFile> } catch { return null /* none yet, or torn — treated as absent */ }
    const doc = raw && typeof raw === 'object' ? parseHomeSpotlight(raw.doc) : null
    if (!doc) return null
    return { doc, etag: typeof raw?.etag === 'string' ? raw.etag : null, confirmedAt: typeof raw?.confirmedAt === 'number' ? raw.confirmedAt : 0 }
  }

  async function writeCache(doc: unknown, etag: string | null): Promise<void> {
    const file: CacheFile = { doc, etag, confirmedAt: now() }
    await writeJsonAtomic(cachePath, file)
  }

  function noteReachable(ok: boolean, why?: string): void {
    reachable = ok
    if (ok && wasUnreachable) { wasUnreachable = false; log('[home-spotlight] homemini reachable again') }
    if (!ok && !wasUnreachable) {
      wasUnreachable = true
      warn('unreachable', `[home-spotlight] homemini unreachable (${why ?? 'no answer'}) — drawing the cached copy or this Mac's own history`)
    }
  }

  async function local(): Promise<HomeSpotlightState> {
    let doc: HomeSpotlightDoc | null = null
    try { doc = await opts.computeLocal() } catch (err) {
      warn('local', `[home-spotlight] local fallback failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    return isEmptySpotlight(doc)
      ? { doc: null, source: 'none', reachable, fetchedAt: null }
      : { doc, source: 'local', reachable, fetchedAt: null }
  }

  async function read(): Promise<HomeSpotlightState> {
    const cache = await readCache()
    if (cache && now() - cache.confirmedAt <= MAX_CACHE_AGE_MS) {
      return { doc: cache.doc, source: liveThisSession && reachable ? 'homemini' : 'cache', reachable, fetchedAt: cache.confirmedAt || null }
    }
    return local()
  }

  async function emit(): Promise<HomeSpotlightState> {
    const state = await read()
    // fetchedAt moves on every good poll; only a change worth redrawing pushes.
    const json = JSON.stringify({ ...state, fetchedAt: null })
    if (json !== lastEmitted) {
      lastEmitted = json
      for (const cb of listeners) {
        try { cb(state) } catch (err) { warn('listener', `[home-spotlight] change listener threw: ${err instanceof Error ? err.message : String(err)}`) }
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
      await writeCache(cache.doc, cache.etag)        // confirmed fresh: restart its age
      return
    }
    if (!res.ok) {
      // 404 = the route isn't deployed on homemini yet; 5xx = it's unwell. Either way: fall back.
      liveThisSession = false
      noteReachable(false, `GET ${res.status}`)
      return
    }
    const body = await res.json().catch(() => null)
    const doc = parseHomeSpotlight(body)
    if (!doc) {
      liveThisSession = false
      noteReachable(false, 'GET returned no spotlight document')
      return
    }
    noteReachable(true)
    liveThisSession = true
    await writeCache(body, res.headers?.get('etag') ?? null)
  }

  // Coalesced: one GET in flight; callers during it share its answer.
  let inFlight: Promise<HomeSpotlightState> | null = null
  function refresh(): Promise<HomeSpotlightState> {
    if (inFlight) return inFlight
    inFlight = (async () => {
      try {
        await fetchOnce()
      } catch (err) {
        warn('refresh', `[home-spotlight] refresh failed: ${err instanceof Error ? err.message : String(err)}`)
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
