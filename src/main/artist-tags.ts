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

type MbArtist = { name?: string; score?: number; country?: string; area?: { name?: string }; aliases?: Array<{ name?: string }>; tags?: Array<{ name: string; count?: number }> }
/** Name OR alias — the library may spell an artist the way MusicBrainz lists as
 *  an alias ("Молчат Дома" for Molchat Doma). */
const MB_ARTIST_QUERY = (artist: string): string => encodeURIComponent(`artist:"${artist}" OR alias:"${artist}"`)
export function matchMbArtist(artists: MbArtist[] | undefined, artist: string): MbArtist | undefined {
  const want = normName(artist)
  if (!want) return undefined
  return (artists ?? []).find((a) => (a.score ?? 0) >= 80 && [a.name, ...(a.aliases ?? []).map((x) => x.name)].some((n) => normName(n) === want))
}

/** MusicBrainz artist search → the exact-name match's tags, most-voted first. */
export async function musicBrainzTags(artist: string, userAgent: string, fetchFn: typeof fetch = fetch): Promise<string[] | null> {
  try {
    const res = await fetchFn(`https://musicbrainz.org/ws/2/artist?query=${MB_ARTIST_QUERY(artist)}&fmt=json&limit=5`, {
      headers: { 'User-Agent': userAgent, Accept: 'application/json' }, signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    const hit = matchMbArtist(((await res.json()) as { artists?: MbArtist[] }).artists, artist)
    if (!hit) return []   // a real answer: MusicBrainz doesn't know them — cache it
    return [...(hit.tags ?? [])].sort((a, b) => (b.count ?? 0) - (a.count ?? 0)).slice(0, 8).map((t) => t.name)
  } catch { return null }
}

/** The artist's MusicBrainz entry: most-voted tags plus where they're from
 *  (genre filer, 2026-10-11). null on failure; tags [] when unknown. */
export async function musicBrainzArtist(artist: string, userAgent: string, fetchFn: typeof fetch = fetch): Promise<{ tags: string[]; origin?: string } | null> {
  try {
    const res = await fetchFn(`https://musicbrainz.org/ws/2/artist?query=${MB_ARTIST_QUERY(artist)}&fmt=json&limit=5`, {
      headers: { 'User-Agent': userAgent, Accept: 'application/json' }, signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    const hit = matchMbArtist(((await res.json()) as { artists?: MbArtist[] }).artists, artist)
    if (!hit) return { tags: [] }
    const tags = [...(hit.tags ?? [])].sort((a, b) => (b.count ?? 0) - (a.count ?? 0)).slice(0, 8).map((t) => t.name)
    // Only a country-level area counts as an origin; a bare city with no country stays blank.
    return { tags, origin: hit.country && hit.area?.name ? hit.area.name : undefined }
  } catch { return null }
}

/** Tags on the album's MusicBrainz release group — the per-album evidence. */
export async function musicBrainzAlbumTags(artist: string, album: string, userAgent: string, fetchFn: typeof fetch = fetch): Promise<string[] | null> {
  try {
    const q = encodeURIComponent(`releasegroup:"${album}" AND artist:"${artist}"`)
    const res = await fetchFn(`https://musicbrainz.org/ws/2/release-group?query=${q}&fmt=json&limit=5`, {
      headers: { 'User-Agent': userAgent, Accept: 'application/json' }, signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { 'release-groups'?: Array<{ title?: string; tags?: Array<{ name: string; count?: number }> }> }
    const want = normName(album)
    const hit = (body['release-groups'] ?? []).find((r) => { const t = normName(r.title); return t === want || (want.length > 4 && (t.includes(want) || want.includes(t))) })
    return hit ? [...(hit.tags ?? [])].sort((a, b) => (b.count ?? 0) - (a.count ?? 0)).slice(0, 8).map((t) => t.name) : []
  } catch { return null }
}
