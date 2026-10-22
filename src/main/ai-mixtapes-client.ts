/**
 * Daily AI tapes client (2026-10-22) — the desktop's half of homemini's AI
 * mixtape routes, the same two the phone calls (the rules and the wire parse
 * are src/common/ai-mixtapes.ts):
 *
 *   GET  {MOBILE_BACKEND_URL}/api/mixtapes             every tape; we keep the AI ones
 *   POST {MOBILE_BACKEND_URL}/api/mixtapes/ai/:id/keep { kept } — 200 = done
 *
 * What the rail and the shelf draw, in order:
 *   1. homemini's answer;
 *   2. the cached copy (userData/ai-mixtapes.desktop-cache.json) while homemini
 *      is away, with no age limit: a kept tape is permanent, and the phone's
 *      shelf paints its cache the same way (LibraryCache "mixtapes");
 *   3. otherwise nothing: the rail falls back to the plain mix cards and the
 *      shelf shows only this Mac's own tapes.
 *
 * A reply that is not the document never replaces a good cache. An EMPTY
 * list does: empty is the truth (every tape rolled over), not a failure — the
 * phone's MixesSection.load() rule, written after a deleted tape kept
 * repainting from a stale cache.
 *
 * The only write toward homemini is Keep, and only when Jake presses it. The
 * only file written here is the cache.
 *
 * Pure of electron — fetch and the directory are injected, so it runs under
 * node:test (__tests__/ai-mixtapes-client.test.ts).
 *
 * ⚠️ TWIN: JakeTunesMobile ios/JakeTunesMobile/LibraryAPI.swift `mixtapes()`
 *   and `keepAiMixtape(id:kept:)` — same routes, same body, same "only 200
 *   counts" rule.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeJsonAtomic } from './atomic-write.ts'
import { withCompanionInit } from './hub-companion.ts'
import { parseAiMixtapes, withAiTapeKept, aiTapeKeepPath, type AiMixtape, type AiMixtapesState } from '../common/ai-mixtapes.ts'

export interface FetchReply { ok: boolean; status: number; json(): Promise<unknown> }
export type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<FetchReply>

export const AI_MIXTAPES_PATH = '/api/mixtapes'
export const AI_MIXTAPES_CACHE_FILE = 'ai-mixtapes.desktop-cache.json'

export interface AiMixtapesClientOptions {
  /** homemini backend origin, e.g. http://homemini:3000 (no trailing slash). */
  baseUrl: string
  /** Where the cache file lives (userData in the app). */
  dir: string
  fetchImpl?: FetchLike
  log?: (msg: string) => void
  warn?: (key: string, msg: string) => void
  timeoutMs?: number
}

export interface AiMixtapesClient {
  /** What to draw now: the cache or nothing, no network. */
  read(): Promise<AiMixtapesState>
  /** One GET (coalesced), then what to draw. */
  refresh(): Promise<AiMixtapesState>
  /** Keep / unkeep one tape on homemini. ok only on HTTP 200. */
  keep(id: string, kept: boolean): Promise<{ ok: boolean; error?: string }>
  /** Called when what to draw changes. */
  onChange(cb: (state: AiMixtapesState) => void): () => void
}

interface CacheFile { tapes: unknown }

export function createAiMixtapesClient(opts: AiMixtapesClientOptions): AiMixtapesClient {
  const fetchImpl: FetchLike = opts.fetchImpl ?? (fetch as unknown as FetchLike)
  const log = opts.log ?? ((m: string) => console.log(m))
  const warn = opts.warn ?? ((_k: string, m: string) => console.warn(m))
  const timeoutMs = opts.timeoutMs ?? 10_000
  const base = opts.baseUrl.replace(/\/+$/, '')
  const cachePath = join(opts.dir, AI_MIXTAPES_CACHE_FILE)

  let reachable: boolean | null = null
  let wasUnreachable = false
  let liveThisSession = false
  const listeners = new Set<(s: AiMixtapesState) => void>()
  let lastEmitted = ''

  async function readCache(): Promise<AiMixtape[] | null> {
    let raw: Partial<CacheFile> | null = null
    try { raw = JSON.parse(await readFile(cachePath, 'utf-8')) as Partial<CacheFile> } catch { return null /* none yet, or torn: treated as absent */ }
    // The cache stores the parsed list; re-parse it through the same gate.
    return raw && typeof raw === 'object' ? parseAiMixtapes({ items: Array.isArray(raw.tapes) ? (raw.tapes as AiMixtape[]).map(toWire) : null }) : null
  }

  async function writeCache(tapes: AiMixtape[]): Promise<void> {
    await writeJsonAtomic(cachePath, { tapes } satisfies CacheFile)
  }

  function noteReachable(ok: boolean, why?: string): void {
    reachable = ok
    if (ok && wasUnreachable) { wasUnreachable = false; log('[ai-mixtapes] homemini reachable again') }
    if (!ok && !wasUnreachable) {
      wasUnreachable = true
      warn('unreachable', `[ai-mixtapes] homemini unreachable (${why ?? 'no answer'}) — drawing the cached tapes`)
    }
  }

  async function read(): Promise<AiMixtapesState> {
    const cached = await readCache()
    if (cached) return { tapes: cached, source: liveThisSession && reachable ? 'homemini' : 'cache', reachable }
    return { tapes: [], source: 'none', reachable }
  }

  async function emit(): Promise<AiMixtapesState> {
    const state = await read()
    const json = JSON.stringify(state)
    if (json !== lastEmitted) {
      lastEmitted = json
      for (const cb of listeners) {
        try { cb(state) } catch (err) { warn('listener', `[ai-mixtapes] change listener threw: ${err instanceof Error ? err.message : String(err)}`) }
      }
    }
    return state
  }

  async function fetchOnce(): Promise<void> {
    let res: FetchReply
    try {
      res = await fetchImpl(`${base}${AI_MIXTAPES_PATH}`, withCompanionInit({ signal: AbortSignal.timeout(timeoutMs) }) as Record<string, unknown>)
    } catch (err) {
      liveThisSession = false
      noteReachable(false, err instanceof Error ? err.message : String(err))
      return
    }
    if (!res.ok) {
      liveThisSession = false
      noteReachable(false, `GET ${res.status}`)
      return
    }
    const tapes = parseAiMixtapes(await res.json().catch(() => null))
    if (!tapes) {
      liveThisSession = false
      noteReachable(false, 'GET returned no mixtapes document')
      return
    }
    noteReachable(true)
    liveThisSession = true
    await writeCache(tapes)
  }

  let inFlight: Promise<AiMixtapesState> | null = null
  function refresh(): Promise<AiMixtapesState> {
    if (inFlight) return inFlight
    inFlight = (async () => {
      try {
        await fetchOnce()
      } catch (err) {
        warn('refresh', `[ai-mixtapes] refresh failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      return emit()
    })().finally(() => { inFlight = null })
    return inFlight
  }

  async function keep(id: string, kept: boolean): Promise<{ ok: boolean; error?: string }> {
    let res: FetchReply
    try {
      res = await fetchImpl(`${base}${aiTapeKeepPath(id)}`, withCompanionInit({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kept }),
        signal: AbortSignal.timeout(15_000),
      }) as Record<string, unknown>)
    } catch (err) {
      noteReachable(false, err instanceof Error ? err.message : String(err))
      return { ok: false, error: 'unreachable' }
    }
    // The phone's rule: only a 200 is a Keep. A 404 means homemini has no such
    // tape (it rolled over); anything else is homemini being unwell.
    if (res.status !== 200) return { ok: false, error: `keep ${res.status}` }
    noteReachable(true)
    // Carry the flip into the cache now, so a relaunch while homemini is away
    // still shows the tape where Jake put it.
    // homemini already has the Keep: a cache that fails to write must not
    // turn it into a failure Jake is told about.
    try {
      const cached = await readCache()
      if (cached) await writeCache(withAiTapeKept(cached, id, kept))
      await emit()
    } catch (err) {
      warn('cache', `[ai-mixtapes] keep saved on homemini; cache update failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    return { ok: true }
  }

  return {
    read,
    refresh,
    keep,
    onChange(cb) { listeners.add(cb); return () => { listeners.delete(cb) } },
  }
}

/** Back to the wire shape, so the cache re-reads through the one parser. */
function toWire(t: AiMixtape): Record<string, unknown> {
  return {
    id: t?.id, title: t?.title, commentary: t?.commentary, createdAt: t?.createdAt,
    source: 'ai', kept: t?.kept === true,
    sides: [{ tracks: (Array.isArray(t?.trackIds) ? t.trackIds : []).map((id) => ({ id })) }],
  }
}
