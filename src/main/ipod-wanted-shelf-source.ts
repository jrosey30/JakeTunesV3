/**
 * The "For your iPods" shelf's I/O (2026-11-09): homemini's lists, the
 * library's ownership keys, Deezer, and a lookup cache on disk. The rules are
 * in ipod-wanted-shelf.ts.
 *
 *   • the lists: homemini's GET /api/ipod-lists (each list's `wanted`); no
 *     answer = the last good shelves, or none (the section simply isn't there)
 *   • ownership: the same keys the shop's "not in your library" uses
 *     (discover-feed ownershipChecks), so an owned artist never appears
 *   • Deezer, politely (one request per 120 ms); a found record is kept 30
 *     days, a miss 3 (ipod-wanted-lookups.json in the state dir)
 *   • the built shelves are kept for an hour in memory (an empty answer five
 *     minutes); force rebuilds
 */
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { IpodList, IpodListWanted } from '../common/ipod-list-doc.ts'
import { buildWantedShelves, lookupWanted, wantedLookupKey, type WantedHit, type WantedShelf } from './ipod-wanted-shelf.ts'

export const WANTED_LOOKUPS_FILE = 'ipod-wanted-lookups.json'
const HIT_TTL_MS = 30 * 86_400_000
const MISS_TTL_MS = 3 * 86_400_000
const SHELF_TTL_MS = 60 * 60_000
const EMPTY_SHELF_TTL_MS = 5 * 60_000

export interface WantedShelfSourceHost {
  stateDir: string
  lists: () => Promise<IpodList[] | null>
  libraryTracks?: () => Promise<unknown[]>
  warn?: (msg: string) => void
  fetchImpl?: typeof fetch
  sleepMs?: number
  now?: () => number
}

type Cache = Record<string, { at: number; hit: WantedHit }>

/** The ownership closures over the library, built the way the shop builds them (index.ts discover feed). */
export async function ownershipFromTracks(tracks: unknown[]) {
  const df = await import('./discover-feed.ts')
  const rows = tracks as Array<{ artist?: string; albumArtist?: string; album?: string; title?: string }>
  const artists = new Set<string>()
  const baseKeys = new Set<string>()
  for (const t of rows) {
    for (const who of [t.artist, t.albumArtist]) for (const n of df.artistContributors(String(who || ''))) { const k = df.normKey(n); if (k) artists.add(k) }
    const a = df.normKey(String(t.artist || ''))
    if (!a) continue
    for (const raw of [t.title, t.album]) { const b = df.baseTitleKey(String(raw || '')); if (b && b !== a) baseKeys.add(`${a}|${b}`) }
  }
  return df.ownershipChecks({ artists, albumKeys: new Set(df.ownedPairKeys(rows)), baseKeys })
}

export function createWantedShelfSource(host: WantedShelfSourceHost) {
  const now = host.now ?? Date.now
  const sleepMs = host.sleepMs ?? 120
  const fetchFn = host.fetchImpl ?? fetch
  const file = join(host.stateDir, WANTED_LOOKUPS_FILE)
  let built: { at: number; shelves: WantedShelf[] } | null = null
  let inflight: Promise<{ ok: boolean; shelves: WantedShelf[]; error?: string }> | null = null

  async function readCache(): Promise<Cache> {
    try { return JSON.parse(await readFile(file, 'utf8')) as Cache } catch { return {} }
  }
  async function writeCache(c: Cache): Promise<void> {
    try {
      await mkdir(host.stateDir, { recursive: true })
      const tmp = `${file}.tmp-${process.pid}`
      await writeFile(tmp, JSON.stringify(c))
      await rename(tmp, file)
    } catch (err) { host.warn?.(`[ipod-wanted] lookup cache not saved: ${(err as Error)?.message ?? err}`) }
  }

  async function build(): Promise<{ ok: boolean; shelves: WantedShelf[]; error?: string }> {
    const lists = await host.lists()
    if (!lists) return built ? { ok: true, shelves: built.shelves } : { ok: false, shelves: [], error: 'homemini did not answer' }
    const wanting = lists.filter((l) => l.wanted?.length)
    const owns = await ownershipFromTracks((await host.libraryTracks?.().catch(() => [])) ?? [])
    const cache = await readCache()
    let dirty = false
    const fetchJson = async (url: string): Promise<unknown> => {
      if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs))
      const res = await fetchFn(url, { signal: AbortSignal.timeout(10_000) })
      return res.json()
    }
    const lookup = async (w: IpodListWanted): Promise<WantedHit> => {
      const k = wantedLookupKey(w)
      const c = cache[k]
      if (c && now() - c.at < (c.hit ? HIT_TTL_MS : MISS_TTL_MS)) return c.hit
      let hit: WantedHit
      try { hit = await lookupWanted(w, { fetchJson }) } catch { return c?.hit ?? null }   // a Deezer hiccup is never cached as a miss
      cache[k] = { at: now(), hit }
      dirty = true
      return hit
    }
    const shelves = await buildWantedShelves(wanting, { fetchJson, ...owns }, lookup)
    if (dirty) await writeCache(cache)
    built = { at: now(), shelves }
    return { ok: true, shelves }
  }

  return {
    async get(force = false): Promise<{ ok: boolean; shelves: WantedShelf[]; error?: string }> {
      // An empty shelf is asked again after a few minutes: homemini may have
      // written the lists' `wanted` since (it did, the afternoon this shipped).
      const ttl = built?.shelves.length ? SHELF_TTL_MS : EMPTY_SHELF_TTL_MS
      if (!force && built && now() - built.at < ttl) return { ok: true, shelves: built.shelves }
      inflight ??= build().catch((err) => {
        host.warn?.(`[ipod-wanted] shelf failed: ${(err as Error)?.message ?? err}`)
        return built ? { ok: true, shelves: built.shelves } : { ok: false, shelves: [], error: String((err as Error)?.message ?? err) }
      }).finally(() => { inflight = null })
      return inflight
    },
  }
}
