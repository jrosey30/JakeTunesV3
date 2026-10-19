/**
 * Where an artist is from — the origin backfill's network half (2026-10-18).
 * genre-filer.ts owns the cache and the per-sweep budget; this only asks.
 *
 * Identity first, always (the MESH lesson, 10/11): a MusicBrainz artist
 * counts only when one of Jake's albums — a release group titled like it —
 * is credited to that MBID (confirmedArtist, unchanged). What changed is how
 * hard it looks before saying "unknown":
 *   - store suffixes come off the title first ("Not Enough Garys - EP",
 *     "Frozen Gary - Single", "HAUSDOGS02 [HD002]") — MusicBrainz titles
 *     carry neither, so the search never found them;
 *   - every one of his albums is tried, not just the first two, inside a
 *     bounded number of requests;
 *   - a multi-artist credit ("A & B", "A, B", "A feat. B") is the FIRST
 *     artist's origin. The whole credit is still asked first — "Earth, Wind
 *     & Fire" and "Love, DEAN" are one artist each — and the album proves
 *     which name is real.
 *
 * MusicBrainz busy (503 / 429 / 5xx / a timeout) is never an answer: the
 * lookup says 'busy', nothing is cached, and the next sweep asks again.
 * Every request waits on the app's shared MusicBrainz throttle.
 */
import { normName } from './taste-profile.ts'
import { confirmedArtist, countryName, countryOfMbArtist, releaseGroupTitleMatches, type MbArtist } from './artist-tags.ts'

export type OriginSource = 'mb'
export type OriginLookup =
  | { kind: 'found'; origin: string; source: OriginSource; mbid: string; evidence: string }
  | { kind: 'unknown'; note: string; mbid?: string }
  | { kind: 'busy'; note: string }

export interface OriginNet {
  throttle(): Promise<void>
  userAgent: string
  fetchFn?: typeof fetch
  /** Hard cap on requests for one artist (default ORIGIN_MAX_REQUESTS). */
  maxRequests?: number
}

/** One artist's lookup never costs more than this many requests (~18 s at the
 *  shared 1.1 s throttle); album searches stop at ORIGIN_MAX_ALBUM_QUERIES so
 *  the country lookup always has room. */
export const ORIGIN_MAX_REQUESTS = 16
export const ORIGIN_MAX_ALBUM_QUERIES = 8

const MB = 'https://musicbrainz.org/ws/2'

/** A store's title → the title MusicBrainz files it under: no " - EP" /
 *  " - Single", no trailing bracketed catalogue number ("[CAT001]"). */
export function cleanAlbumTitle(title: string): string {
  let s = title.trim(), prev = ''
  while (s !== prev) {
    prev = s
    s = s.replace(/\s*\[[^\]]*\]$/, '').replace(/\s+-\s+(?:EP|Single)$/i, '').trim()
  }
  return s || title.trim()
}

const FEAT_BRACKET = /\s*[([]\s*(?:feat\.?|ft\.?|featuring)\s[^)\]]*[)\]]/gi
const FEAT = /\s+(?:feat\.?|ft\.?|featuring)\s+/i
/** The names to ask for one credit, most specific first: the credit without
 *  its featured guests (the primary), then its first comma part, then that
 *  part's first "&" part. "Block & Crown, Paul Parsons" asks "Block & Crown,
 *  Paul Parsons", "Block & Crown", "Block" — a name only counts once one of
 *  his albums is credited to it, so the shorter names can't steal an origin. */
export function originNames(credit: string): { primary: string; names: string[] } {
  const primary = credit.replace(FEAT_BRACKET, '').split(FEAT)[0].trim() || credit.trim()
  const byComma = primary.split(/\s*,\s*/)[0].trim()
  const byAmp = byComma.split(/\s+&\s+/)[0].trim()
  const seen = new Set<string>()
  const names = [primary, byComma, byAmp].filter((n) => { const k = normName(n); if (!n || !k || seen.has(k)) return false; seen.add(k); return true })
  return { primary, names: names.length ? names : [primary] }
}

class Busy extends Error {}
class Spent extends Error {}
/** A phrase inside a Lucene query: quotes and backslashes escaped, or the
 *  query is malformed (400) — a definite non-answer, asked forever. */
const phrase = (s: string): string => s.replace(/[\\"]/g, '\\$&')
const hostOf = (url: string): string => { try { return new URL(url).host } catch { return 'request' } }

/** Throttled, counted GET. null = a definite miss (4xx, unreadable body);
 *  throws Busy on 429 / 5xx / network / timeout, Spent past the cap. */
function requester(net: OriginNet): { get: (url: string, as?: 'json' | 'text') => Promise<unknown>; used: () => number } {
  const fetchFn = net.fetchFn ?? fetch
  const max = net.maxRequests ?? ORIGIN_MAX_REQUESTS
  let used = 0
  return {
    used: () => used,
    get: async (url, as = 'json') => {
      if (used >= max) throw new Spent(`gave up after ${used} requests`)
      used++
      await net.throttle()
      let res: Response
      try {
        res = await fetchFn(url, { headers: { 'User-Agent': net.userAgent, Accept: as === 'json' ? 'application/json' : 'text/html' }, signal: AbortSignal.timeout(10_000) })
      } catch (err) { throw new Busy(`${hostOf(url)} ${err instanceof Error ? err.name : 'failed'}`) }
      if (res.status === 429 || res.status >= 500) throw new Busy(`${hostOf(url)} ${res.status}`)
      if (!res.ok) return null
      try { return as === 'json' ? await res.json() : await res.text() } catch (err) {
        if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) throw new Busy(`${hostOf(url)} ${err.name}`)
        return null
      }
    },
  }
}
type Get = ReturnType<typeof requester>['get']

/** Every artist MusicBrainz lists whose name or alias folds equal to this one, at any score. */
async function sameNameArtists(get: Get, name: string): Promise<MbArtist[]> {
  const want = normName(name)
  if (!want) return []
  const q = encodeURIComponent(`artist:"${phrase(name)}" OR alias:"${phrase(name)}"`)
  const body = await get(`${MB}/artist?query=${q}&fmt=json&limit=100`) as { artists?: MbArtist[] } | null
  return (body?.artists ?? []).filter((a) => [a.name, ...(a.aliases ?? []).map((x) => x.name)].some((n) => normName(n) === want))
}

/** The MBIDs credited on release groups titled like `title` by `artist`; null when none is titled like it. */
async function albumCredits(get: Get, artist: string, title: string): Promise<string[] | null> {
  const q = encodeURIComponent(`releasegroup:"${phrase(title)}" AND artist:"${phrase(artist)}"`)
  const body = await get(`${MB}/release-group?query=${q}&fmt=json&limit=10`) as { 'release-groups'?: Array<{ title?: string; 'artist-credit'?: Array<{ artist?: { id?: string } }> }> } | null
  const hits = (body?.['release-groups'] ?? []).filter((r) => releaseGroupTitleMatches(r.title, title))
  if (!hits.length) return null
  return [...new Set(hits.flatMap((r) => (r['artist-credit'] ?? []).map((c) => c.artist?.id).filter((x): x is string => !!x)))]
}

/** Where the artist on this credit is from, proven by one of `albums`. */
export async function lookupArtistOrigin(credit: string, albums: string[], net: OriginNet): Promise<OriginLookup> {
  const r = requester(net)
  let mbid: string | undefined
  try {
    const { primary, names } = originNames(credit)
    const titles: string[] = []
    for (const a of albums) { const t = cleanAlbumTitle(a); if (t && !titles.some((x) => normName(x) === normName(t))) titles.push(t) }
    const credits = new Map<string, string[]>()     // title → MBIDs credited on it (any query)
    const queried = new Set<string>()
    let albumQueries = 0, sameNamed = 0
    let found: { a: MbArtist; title: string } | undefined
    for (const name of names) {
      const strict = (await sameNameArtists(r.get, name)).filter((a) => (a.score ?? 0) >= 80)
      sameNamed += strict.length
      if (!strict.length) continue
      const proven = (): { a: MbArtist; title: string } | undefined => {
        for (const [title, ids] of credits) { const c = confirmedArtist(strict, ids); if (c) return { a: strict.find((x) => x.id === c.id)!, title } }
        return undefined
      }
      found = proven()                             // an earlier name's album search may already credit this one
      for (const title of titles) {
        if (found) break
        // Ask with the primary credit (it matches the album's own credit),
        // then with this name only if the primary found no such album.
        for (const q of [...new Set([primary, name])]) {
          if (found || albumQueries >= ORIGIN_MAX_ALBUM_QUERIES) break
          const key = `${normName(q)}|${normName(title)}`
          if (queried.has(key) || (q !== primary && credits.has(title))) continue
          queried.add(key); albumQueries++
          const ids = await albumCredits(r.get, q, title)
          if (ids) credits.set(title, [...new Set([...(credits.get(title) ?? []), ...ids])])
          found = proven()
        }
      }
      if (found) break
    }
    if (!found) {
      const tried = `${albumQueries} album search${albumQueries === 1 ? '' : 'es'}`
      return { kind: 'unknown', note: sameNamed ? `no MusicBrainz artist of that name credited on his albums (${tried})` : 'no MusicBrainz artist of that name' }
    }
    mbid = found.a.id!
    let origin = countryName(found.a.country)
    if (!origin) origin = countryOfMbArtist(await r.get(`${MB}/artist/${encodeURIComponent(mbid)}?fmt=json`) as Parameters<typeof countryOfMbArtist>[0])
    if (!origin) return { kind: 'unknown', note: 'MusicBrainz has no country for the artist', mbid }
    return { kind: 'found', origin, source: 'mb', mbid, evidence: `credited on "${found.title}"` }
  } catch (err) {
    if (err instanceof Busy) return { kind: 'busy', note: err.message }
    if (err instanceof Spent) return { kind: 'unknown', note: err.message, mbid }
    throw err
  }
}
