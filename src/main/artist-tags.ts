/**
 * Artist genre tags from MusicBrainz, cached (2026-10-10, Rocksurgence step 1).
 *
 * The Record Shop's cards mostly carry no genre (the daily Deezer lanes have
 * none), so the taste profile's genre gate needs another source: the
 * community tags on the artist's MusicBrainz entry ("math rock", "post-punk"…).
 * Looked up once per artist and cached in userData/artist-tags.json.
 *
 * Fail-open by design: an artist we couldn't look up is NOT blocked (and the
 * failure isn't cached, so the next generation retries). MusicBrainz allows
 * about one request a second, so each generation looks up at most a capped
 * number of new artists; the rest fill in on later days.
 */
import { readFile, writeFile, rename } from 'fs/promises'
import { normName } from './taste-profile.ts'

export interface TagEntry { tags: string[]; at: number }
export type TagCache = Record<string, TagEntry>

export const TAG_TTL_MS = 120 * 24 * 3600 * 1000

export async function loadTagCache(file: string): Promise<TagCache> {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as unknown
    return raw && typeof raw === 'object' ? (raw as TagCache) : {}
  } catch { return {} }
}

export async function saveTagCache(file: string, cache: TagCache): Promise<void> {
  const tmp = `${file}.tmp`
  await writeFile(tmp, JSON.stringify(cache))
  await rename(tmp, file)
}

/** The artist's top tags, or undefined if never looked up / expired. */
export function cachedTags(cache: TagCache, artist: string, now: number): string[] | undefined {
  const e = cache[normName(artist)]
  return e && now - e.at < TAG_TTL_MS ? e.tags : undefined
}

/** Look up tags for artists not in the cache, at most `maxLookups` per call.
 *  Returns how many were looked up. `fetchTags` resolves null on failure. */
export async function ensureArtistTags(
  artists: string[],
  cache: TagCache,
  opts: { fetchTags: (artist: string) => Promise<string[] | null>; now: number; maxLookups?: number; sleepMs?: number },
): Promise<number> {
  const max = opts.maxLookups ?? 40
  const todo = [...new Set(artists.map((a) => a.trim()).filter(Boolean))].filter((a) => cachedTags(cache, a, opts.now) === undefined)
  let n = 0
  for (const a of todo.slice(0, max)) {
    if (n > 0 && (opts.sleepMs ?? 1100) > 0) await new Promise((r) => setTimeout(r, opts.sleepMs ?? 1100))
    const tags = await opts.fetchTags(a)
    n++
    if (tags) cache[normName(a)] = { tags, at: opts.now }
  }
  return n
}

/** MusicBrainz artist search → the exact-name match's tags, most-voted first. */
export async function musicBrainzTags(artist: string, userAgent: string, fetchFn: typeof fetch = fetch): Promise<string[] | null> {
  try {
    const q = encodeURIComponent(`artist:"${artist}"`)
    const res = await fetchFn(`https://musicbrainz.org/ws/2/artist?query=${q}&fmt=json&limit=5`, {
      headers: { 'User-Agent': userAgent, Accept: 'application/json' }, signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { artists?: Array<{ name?: string; score?: number; tags?: Array<{ name: string; count?: number }> }> }
    const want = normName(artist)
    const hit = (body.artists ?? []).find((a) => normName(a.name) === want && (a.score ?? 0) >= 80)
    if (!hit) return []   // a real answer: MusicBrainz doesn't know them — cache it
    return [...(hit.tags ?? [])].sort((a, b) => (b.count ?? 0) - (a.count ?? 0)).slice(0, 8).map((t) => t.name)
  } catch { return null }
}
