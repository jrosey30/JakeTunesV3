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
 * Two more ways to an answer, Jake-approved 10/18 — each recorded as the
 * answer's source so it can be audited and reverted:
 *   mb-lone-name — no album ties an MBID, but MusicBrainz lists exactly ONE
 *     artist by this name (or alias), at any score, it has a country or
 *     area, and none of his albums is credited to someone else. Only for the
 *     credit's primary name — never a shorter "&" / "," part ("Love" is not
 *     "Love, DEAN").
 *   wikidata / bandcamp — when MusicBrainz has the artist but no country:
 *     the links ON that MusicBrainz artist (one that passed the strict rule
 *     or mb-lone-name) — Wikidata P495 country of origin, else P740 place of
 *     formation, else P27 citizenship for a person; else the linked Bandcamp
 *     page's stated location. Never a web search by name.
 * Places become the library's own origin words: a country name, via the ISO
 * code (countryName) — "Austin" walks up MusicBrainz's areas to Texas, US.
 *
 * MusicBrainz busy (503 / 429 / 5xx / a timeout) is never an answer — nor is
 * Wikidata or Bandcamp busy: the lookup says 'busy', nothing is cached, and
 * the next sweep asks again. Every request waits on the app's shared
 * MusicBrainz throttle.
 */
import { normName } from './taste-profile.ts'
import { confirmedArtist, countryName, countryOfMbArtist, areaCodes, releaseGroupTitleMatches, type MbArtist } from './artist-tags.ts'

/** How the answer was reached: mb = strict (an album credits the MBID);
 *  mb-lone-name = the only artist of that name; wikidata / bandcamp = the
 *  country came from a link on that MusicBrainz artist (`via` = how the
 *  artist itself was identified). */
export type OriginSource = 'mb' | 'mb-lone-name' | 'wikidata' | 'bandcamp'
export type OriginLookup =
  | { kind: 'found'; origin: string; source: OriginSource; via?: 'mb' | 'mb-lone-name'; mbid: string; evidence: string }
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
const WD = 'https://www.wikidata.org'

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
/** "Heartbeat Brothers (Freddy Fresh & Fanagla Remix)" — a remixer, not the artist. */
const REMIX_BRACKET = /\s*[([][^)\]]*\b(?:remix|rework|edit|mix|version|dub)\b[^)\]]*[)\]]\s*$/i
/** The names to ask for one credit, most specific first: the credit without
 *  its featured guests or remixer (the primary), then its first comma / "vs."
 *  part, then that part's first "&" part. "Block & Crown, Paul Parsons" asks
 *  "Block & Crown, Paul Parsons", "Block & Crown", "Block" — a name only
 *  counts once one of his albums is credited to it, so the shorter names
 *  can't steal an origin. */
export function originNames(credit: string): { primary: string; names: string[] } {
  const primary = credit.replace(REMIX_BRACKET, '').replace(FEAT_BRACKET, '').split(FEAT)[0].trim() || credit.trim()
  const byComma = primary.split(/\s*,\s*|\s+vs\.?\s+/i)[0].trim()
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

type MbArea = { id?: string; name?: string; 'iso-3166-1-codes'?: string[]; 'iso-3166-2-codes'?: string[]; relations?: Array<{ type?: string; direction?: string; area?: MbArea }> }
type MbDetail = { id?: string; type?: string; country?: string; area?: MbArea; 'begin-area'?: MbArea; relations?: Array<{ type?: string; ended?: boolean; url?: { resource?: string } }> }

const codesCountry = (codes: string[]): string | undefined => { for (const c of codes) { const n = countryName(c); if (n) return n } return undefined }

/** A city area ("Austin", "Montréal", "Orange County") has no ISO code of its
 *  own; its parents do — walk "part of" up (≤ 4 hops) until one names a
 *  country. Two parents that disagree = no answer. */
async function areaCountry(get: Get, start: MbArea | undefined): Promise<string | undefined> {
  let area = start
  const seen = new Set<string>()
  for (let hop = 0; area?.id && hop < 4 && !seen.has(area.id); hop++) {
    seen.add(area.id)
    const a = await get(`${MB}/area/${encodeURIComponent(area.id)}?inc=area-rels&fmt=json`) as MbArea | null
    if (!a) return undefined
    const own = codesCountry(areaCodes(a))
    if (own) return own
    const parents = (a.relations ?? []).filter((x) => x.type === 'part of' && x.direction === 'backward' && x.area?.id).map((x) => x.area!)
    const named = new Set(parents.map((x) => codesCountry(areaCodes(x))).filter((x): x is string => !!x))
    if (named.size === 1) return [...named][0]
    if (named.size > 1 || parents.length !== 1) return undefined
    area = parents[0]
  }
  return undefined
}

type WdClaim = { mainsnak?: { snaktype?: string; datavalue?: { value?: unknown } }; rank?: string }
/** A Wikidata property's values at its best rank: preferred if any, else normal; never deprecated. */
export function wdBest(claims: WdClaim[] | undefined): unknown[] {
  const live = (claims ?? []).filter((c) => c.rank !== 'deprecated' && c.mainsnak?.snaktype === 'value')
  const preferred = live.filter((c) => c.rank === 'preferred')
  return (preferred.length ? preferred : live).map((c) => c.mainsnak?.datavalue?.value)
}
const wdItems = (claims: WdClaim[] | undefined): string[] =>
  [...new Set(wdBest(claims).map((v) => (v as { id?: unknown } | null)?.id).filter((x): x is string => typeof x === 'string' && /^Q\d+$/.test(x)))]
const wdStrings = (claims: WdClaim[] | undefined): string[] => [...new Set(wdBest(claims).filter((v): v is string => typeof v === 'string'))]
const QID = /^Q\d+$/

async function wdClaims(get: Get, qid: string, prop: string): Promise<WdClaim[]> {
  const body = await get(`${WD}/w/api.php?action=wbgetclaims&entity=${qid}&property=${prop}&format=json`) as { claims?: Record<string, WdClaim[]> } | null
  return body?.claims?.[prop] ?? []
}
/** A Wikidata country or place → the country's name: its own ISO code
 *  (P297), else the ISO code of its one country (P17). */
async function wdCountry(get: Get, qid: string): Promise<string | undefined> {
  const own = wdStrings(await wdClaims(get, qid, 'P297'))
  if (own.length) return own.length === 1 ? countryName(own[0]) : undefined
  const countries = wdItems(await wdClaims(get, qid, 'P17'))
  if (countries.length !== 1) return undefined
  const code = wdStrings(await wdClaims(get, countries[0], 'P297'))
  return code.length === 1 ? countryName(code[0]) : undefined
}

/** The artist's Wikidata item → its country: P495 country of origin, else
 *  P740 place of formation, else (a person, P31 = Q5 human) P27
 *  citizenship. A property whose values name two countries is skipped. */
export async function wikidataOrigin(get: Get, qid: string): Promise<{ origin: string; evidence: string } | undefined> {
  if (!QID.test(qid)) return undefined
  const body = await get(`${WD}/wiki/Special:EntityData/${qid}.json`) as { entities?: Record<string, { claims?: Record<string, WdClaim[]> }> } | null
  const claims = body?.entities ? Object.values(body.entities)[0]?.claims : undefined
  if (!claims) return undefined
  const person = wdItems(claims.P31).includes('Q5')
  for (const p of ['P495', 'P740', ...(person ? ['P27'] : [])]) {
    const items = wdItems(claims[p]).slice(0, 3)
    if (!items.length) continue
    const named = new Set<string>()
    for (const it of items) { const c = await wdCountry(get, it); if (c) named.add(c) }
    if (named.size === 1) return { origin: [...named][0], evidence: `Wikidata ${qid} ${p}` }
  }
  return undefined
}

const ENTITY: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' }
const decodeHtml = (s: string): string => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTITY[e.toLowerCase()] ?? m)
/** The location a Bandcamp page states under the band name ("Austin, Texas"). */
export function bandcampLocation(html: string): string | undefined {
  const m = html.match(/id="band-name-location"[\s\S]{0,600}?class="location\b[^"]*"[^>]*>([^<]*)</)
  const loc = m ? decodeHtml(m[1]).replace(/\s+/g, ' ').trim() : ''
  return loc || undefined
}

// Places a Bandcamp location ends with that aren't country names. US states
// and Canadian provinces/territories, the UK's nations, the usual short forms.
// Georgia is both a state and a country — ambiguous, so no answer.
const US_STATES = ['Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut', 'Delaware', 'Florida', 'Georgia', 'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa', 'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland', 'Massachusetts', 'Michigan', 'Minnesota', 'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada', 'New Hampshire', 'New Jersey', 'New Mexico', 'New York', 'North Carolina', 'North Dakota', 'Ohio', 'Oklahoma', 'Oregon', 'Pennsylvania', 'Rhode Island', 'South Carolina', 'South Dakota', 'Tennessee', 'Texas', 'Utah', 'Vermont', 'Virginia', 'Washington', 'West Virginia', 'Wisconsin', 'Wyoming', 'District of Columbia', 'D.C.']
const CA_PROVINCES = ['Alberta', 'British Columbia', 'Manitoba', 'New Brunswick', 'Newfoundland and Labrador', 'Nova Scotia', 'Ontario', 'Prince Edward Island', 'Quebec', 'Saskatchewan', 'Northwest Territories', 'Nunavut', 'Yukon']
const ALIASES: Record<string, string> = {
  USA: 'US', 'U.S.A.': 'US', US: 'US', 'U.S.': 'US', 'United States of America': 'US',
  UK: 'GB', 'U.K.': 'GB', 'Great Britain': 'GB', England: 'GB', Scotland: 'GB', Wales: 'GB', 'Northern Ireland': 'GB',
  'The Netherlands': 'NL', 'Czech Republic': 'CZ', Turkey: 'TR', 'Ivory Coast': 'CI', 'Hong Kong': 'HK', 'Trinidad & Tobago': 'TT',
}
let PLACES: Map<string, Set<string>> | undefined
const placeKey = (s: string): string => normName(s).replace(/ /g, '')
/** place key → the country NAMES it could be (legacy codes like FX and UK
 *  name the same country as FR and GB — one name, not two). */
function places(): Map<string, Set<string>> {
  if (PLACES) return PLACES
  const m = new Map<string, Set<string>>()
  const add = (place: string, code: string): void => { const k = placeKey(place), n = countryName(code); if (k && n) m.set(k, (m.get(k) ?? new Set()).add(n)) }
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  for (const a of A) for (const b of A) { const code = a + b, n = countryName(code); if (n && !['EU', 'EZ', 'UN', 'QO', 'ZZ'].includes(code)) add(n, code) }
  for (const s of US_STATES) add(s, 'US')
  for (const s of CA_PROVINCES) add(s, 'CA')
  for (const [s, c] of Object.entries(ALIASES)) add(s, c)
  return (PLACES = m)
}
/** "Austin, Texas" / "London, UK" / "Montréal, Québec" / "Lyon, France" →
 *  the country name the library uses. Only the last part counts; anything
 *  unrecognised or ambiguous is no answer, never a guess. */
export function placeToCountry(loc: string | undefined): string | undefined {
  const parts = (loc ?? '').split(',').map((x) => x.trim()).filter(Boolean)
  const named = parts.length ? places().get(placeKey(parts[parts.length - 1])) : undefined
  return named?.size === 1 ? [...named][0] : undefined
}
async function bandcampOrigin(get: Get, url: string): Promise<{ origin: string; evidence: string } | undefined> {
  let u: URL
  try { u = new URL(url) } catch { return undefined }
  if (!/^https?:$/.test(u.protocol) || !(u.hostname === 'bandcamp.com' || u.hostname.endsWith('.bandcamp.com'))) return undefined
  const html = await get(u.toString(), 'text')
  const loc = typeof html === 'string' ? bandcampLocation(html) : undefined
  const origin = placeToCountry(loc)
  return origin ? { origin, evidence: `Bandcamp ${u.hostname}: ${loc}` } : undefined
}

/** Where the artist on this credit is from: identity first (strict, then the
 *  lone same-name match), then the country (MusicBrainz, then the links on
 *  that MusicBrainz artist). */
export async function lookupArtistOrigin(credit: string, albums: string[], net: OriginNet): Promise<OriginLookup> {
  const r = requester(net)
  let mbid: string | undefined
  try {
    const { primary, names } = originNames(credit)
    const titles: string[] = []
    for (const a of albums) { const t = cleanAlbumTitle(a); if (t && !titles.some((x) => normName(x) === normName(t))) titles.push(t) }
    const credits = new Map<string, string[]>()     // title → MBIDs credited on it (any query)
    const queried = new Set<string>()
    const sameName = new Map<string, MbArtist[]>()  // name → every same-name artist, any score
    let albumQueries = 0
    /** One album search, at most once per (artist phrase, title), inside the album cap. */
    const searchAlbum = async (q: string, title: string): Promise<void> => {
      const key = `${normName(q)}|${normName(title)}`
      if (queried.has(key) || albumQueries >= ORIGIN_MAX_ALBUM_QUERIES) return
      queried.add(key); albumQueries++
      const ids = await albumCredits(r.get, q, title)
      if (ids) credits.set(title, [...new Set([...(credits.get(title) ?? []), ...ids])])
    }
    let found: { a: MbArtist; how: 'mb' | 'mb-lone-name'; evidence: string } | undefined
    for (const name of names) {
      const all = await sameNameArtists(r.get, name)
      sameName.set(name, all)
      const strict = all.filter((a) => (a.score ?? 0) >= 80)
      if (!strict.length) continue
      const proven = (): typeof found => {
        for (const [title, ids] of credits) { const c = confirmedArtist(strict, ids); if (c) return { a: strict.find((x) => x.id === c.id)!, how: 'mb', evidence: `credited on "${title}"` } }
        return undefined
      }
      found = proven()                             // an earlier name's album search may already credit this one
      for (const title of titles) {
        if (found || albumQueries >= ORIGIN_MAX_ALBUM_QUERIES) break
        // Ask with the primary credit (it matches the album's own credit),
        // then with this name only if the primary found no such album.
        await searchAlbum(primary, title)
        if (name !== primary && !credits.has(title)) await searchAlbum(name, title)
        found = proven()
      }
      if (found) break
    }
    if (!found) {
      // (A) The only artist MusicBrainz knows by the credit's primary name.
      const lone = sameName.get(primary) ?? []
      if (lone.length === 1 && lone[0].id && (lone[0].country || lone[0].area?.name)) {
        for (const title of titles) await searchAlbum(primary, title)
        const credited = [...credits.values()]
        const theirs = credited.some((ids) => ids.includes(lone[0].id!))
        const someoneElse = credited.some((ids) => ids.length && !ids.includes(lone[0].id!))
        if (theirs || !someoneElse) found = { a: lone[0], how: 'mb-lone-name', evidence: `the only MusicBrainz artist named "${primary}"` }
        else return { kind: 'unknown', note: `his album is credited to another MusicBrainz artist, not the only "${primary}"` }
      }
    }
    if (!found) {
      const many = (sameName.get(primary) ?? []).length
      const tried = `${albumQueries} album search${albumQueries === 1 ? '' : 'es'}`
      return { kind: 'unknown', note: [...sameName.values()].some((l) => l.length) ? `${many > 1 ? `${many} artists named "${primary}", ` : ''}none credited on his albums (${tried})` : 'no MusicBrainz artist of that name' }
    }
    mbid = found.a.id!
    const done = (origin: string, source: OriginSource, evidence: string): OriginLookup =>
      ({ kind: 'found', origin, source, ...(source === 'wikidata' || source === 'bandcamp' ? { via: found!.how } : {}), mbid: mbid!, evidence })
    const fromSearch = countryName(found.a.country)
    if (fromSearch) return done(fromSearch, found.how, found.evidence)
    const detail = await r.get(`${MB}/artist/${encodeURIComponent(mbid)}?inc=url-rels&fmt=json`) as MbDetail | null
    const fromMb = countryOfMbArtist(detail) ?? await areaCountry(r.get, detail?.area) ?? await areaCountry(r.get, detail?.['begin-area'])
    if (fromMb) return done(fromMb, found.how, found.evidence)
    // (B) MusicBrainz has the artist, not the country: the links on THAT artist.
    const links = (detail?.relations ?? []).filter((x) => !x.ended && x.url?.resource)
    const qid = links.find((x) => x.type === 'wikidata')?.url!.resource!.match(/\/(Q\d+)$/)?.[1]
    const wd = qid ? await wikidataOrigin(r.get, qid) : undefined
    if (wd) return done(wd.origin, 'wikidata', wd.evidence)
    for (const bc of links.filter((x) => x.type === 'bandcamp').slice(0, 2)) {
      const b = await bandcampOrigin(r.get, bc.url!.resource!)
      if (b) return done(b.origin, 'bandcamp', b.evidence)
    }
    return { kind: 'unknown', note: `${found.how === 'mb' ? 'confirmed' : 'only same-name'} MusicBrainz artist, no country there${qid ? ' or on Wikidata' : ''}${links.some((x) => x.type === 'bandcamp') ? ' or Bandcamp' : ''}`, mbid }
  } catch (err) {
    if (err instanceof Busy) return { kind: 'busy', note: err.message }
    if (err instanceof Spent) return { kind: 'unknown', note: err.message, mbid }
    throw err
  }
}
