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

export type MbArtist = { id?: string; name?: string; score?: number; country?: string; area?: { id?: string; name?: string }; aliases?: Array<{ name?: string }>; tags?: Array<{ name: string; count?: number }> }
/** Name OR alias — the library may spell an artist the way MusicBrainz lists as
 *  an alias ("Молчат Дома" for Molchat Doma). */
export const MB_ARTIST_QUERY = (artist: string): string => encodeURIComponent(`artist:"${artist}" OR alias:"${artist}"`)
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

/** Every MusicBrainz artist whose name (or alias) is exactly this one, with
 *  ids — the candidates. A name alone is not an identity: "MESH" matched the
 *  Bristol synth-pop Mesh for a 2026 Philadelphia punk band (10/11).
 *  null on failure; [] when MusicBrainz knows nobody by that name. */
export async function musicBrainzArtistCandidates(artist: string, userAgent: string, fetchFn: typeof fetch = fetch): Promise<MbArtist[] | null> {
  try {
    const res = await fetchFn(`https://musicbrainz.org/ws/2/artist?query=${MB_ARTIST_QUERY(artist)}&fmt=json&limit=10`, {
      headers: { 'User-Agent': userAgent, Accept: 'application/json' }, signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    const want = normName(artist)
    if (!want) return []
    return (((await res.json()) as { artists?: MbArtist[] }).artists ?? [])
      .filter((a) => (a.score ?? 0) >= 80 && [a.name, ...(a.aliases ?? []).map((x) => x.name)].some((n) => normName(n) === want))
  } catch { return null }
}

/** The release group titled like Jake's album, by an artist of that name: its
 *  tags (per-album evidence) and the MusicBrainz artist ids credited on it —
 *  the proof of WHICH artist this is. null on failure. */
export async function musicBrainzAlbum(artist: string, album: string, userAgent: string, fetchFn: typeof fetch = fetch): Promise<{ tags: string[]; creditIds: string[] } | null> {
  try {
    const q = encodeURIComponent(`releasegroup:"${album}" AND artist:"${artist}"`)
    const res = await fetchFn(`https://musicbrainz.org/ws/2/release-group?query=${q}&fmt=json&limit=5`, {
      headers: { 'User-Agent': userAgent, Accept: 'application/json' }, signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { 'release-groups'?: Array<{ title?: string; tags?: Array<{ name: string; count?: number }>; 'artist-credit'?: Array<{ artist?: { id?: string } }> }> }
    const hits = (body['release-groups'] ?? []).filter((r) => releaseGroupTitleMatches(r.title, album))
    return {
      tags: hits[0] ? [...(hits[0].tags ?? [])].sort((a, b) => (b.count ?? 0) - (a.count ?? 0)).slice(0, 8).map((t) => t.name) : [],
      creditIds: [...new Set(hits.flatMap((r) => (r['artist-credit'] ?? []).map((c) => c.artist?.id).filter((x): x is string => !!x)))],
    }
  } catch { return null }
}

/** A release group titled like Jake's album: the same folded title, or one
 *  containing the other once the title is long enough to mean something. */
export function releaseGroupTitleMatches(rgTitle: string | undefined, album: string): boolean {
  const t = normName(rgTitle), want = normName(album)
  return t === want || (want.length > 4 && (t.includes(want) || want.includes(t)))
}

/** The candidate one of Jake's albums is actually credited to — or nobody.
 *  Unconfirmed means unknown: no tags, no origin, never a namesake's. */
export function confirmedArtist(candidates: MbArtist[], creditIds: string[]): { id?: string; tags: string[]; origin?: string } | undefined {
  const hit = candidates.find((c) => c.id && creditIds.includes(c.id))
  if (!hit) return undefined
  const tags = [...(hit.tags ?? [])].sort((a, b) => (b.count ?? 0) - (a.count ?? 0)).slice(0, 8).map((t) => t.name)
  return { id: hit.id, tags, origin: countryName(hit.country) }
}

/** The confirmed artist's country when the search result left it out: search
 *  omits the code when the area is a region ("England"), the artist lookup
 *  has it — or its area's ISO 3166-2 code ("GB-ENG") does. */
export async function musicBrainzCountryById(mbid: string, userAgent: string, fetchFn: typeof fetch = fetch): Promise<string | undefined | null> {
  try {
    const res = await fetchFn(`https://musicbrainz.org/ws/2/artist/${encodeURIComponent(mbid)}?fmt=json`, {
      headers: { 'User-Agent': userAgent, Accept: 'application/json' }, signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    return countryOfMbArtist((await res.json()) as MbCodes)
  } catch { return null }
}

type MbAreaCodes = { 'iso-3166-1-codes'?: string[]; 'iso-3166-2-codes'?: string[] }
type MbCodes = { country?: string; area?: MbAreaCodes; 'begin-area'?: MbAreaCodes }
/** The country an artist lookup states: its country code, else its area's or
 *  begin-area's ISO codes (3166-2 "GB-ENG" → GB). undefined when none. */
export function countryOfMbArtist(d: MbCodes | null | undefined): string | undefined {
  if (!d) return undefined
  const codes = [d.country, ...[d.area, d['begin-area']].flatMap((a) => areaCodes(a))]
  for (const c of codes) { const n = countryName(c); if (n) return n }
  return undefined
}
/** An area's ISO codes as country codes, 3166-1 first. */
export const areaCodes = (a: MbAreaCodes | null | undefined): string[] =>
  [...(a?.['iso-3166-1-codes'] ?? []), ...(a?.['iso-3166-2-codes'] ?? [])].map((c) => c.slice(0, 2))

/** MusicBrainz's ISO country code → the country's name. The area itself is
 *  often a region ("England" for Pink Floyd, "Long Island" for The Lemon
 *  Twigs) — dropping those left 326 known artists blank (10/11). Codes for
 *  non-countries (XW worldwide, XE Europe) give no origin. */
export function countryName(code: string | undefined): string | undefined {
  if (!code || !/^[A-Z]{2}$/.test(code) || code.startsWith('X')) return undefined
  try { const n = new Intl.DisplayNames(['en'], { type: 'region' }).of(code); return n && n !== code ? n : undefined } catch { return undefined }
}
