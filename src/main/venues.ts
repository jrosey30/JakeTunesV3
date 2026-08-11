/**
 * venues.ts — "At Your Venues": what's coming to Jake's rooms, regardless of
 * whether the artist is anywhere in his library.
 *
 * 2026-08-08, Jake: "i know i said concerts should be based on my library, but
 * i do live in brooklyn where there are a lot of concerts and i never see
 * anything for Warsaw…, Brooklyn Paramount, Brooklyn Steele, Brooklyn Bowl
 * even etc" — and then: "theres all those rave venues in east williamsburg and
 * bushwick i want those in too."
 *
 * WHY THIS EXISTS SEPARATELY FROM getTourDatesForArtists():
 * Bandsintown's free tier is ARTIST-scoped only — /artists/{name}/events.
 * Venue and location endpoints return "Missing Authentication Token" (verified
 * 2026-08-08). So a band playing Warsaw that Jake doesn't already own is
 * invisible to that API by construction. The only way to answer "what's
 * happening at MY rooms" is to ask the rooms.
 *
 * Every recipe below was verified live against real upcoming events before it
 * was written down; the per-venue gotchas are recorded next to each fetcher
 * because they were each paid for once already.
 *
 * DESIGN RULES
 *  - Fail SOFT and INDEPENDENTLY. A dead venue must never take down the lane;
 *    these are ten small unofficial scrapes and some will rot. Each fetcher is
 *    wrapped so a throw yields [] and the others still render.
 *  - Cache hard (6h). These calendars change daily at most, and one of them
 *    (Brooklyn Steel's) is a 13.9 MB blob.
 *  - Never claim more precision than the source gives.
 */
import type { TourDate } from './external.js'

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36'
const CACHE_MS = 6 * 60 * 60 * 1000
let cache: { at: number; shows: VenueShow[] } | null = null

export interface VenueShow extends TourDate {
  /** The room, as a stable key — the display name lives in `venue`. */
  venueKey: string
  /** True when this came from the venue lane rather than a library-artist query. */
  fromVenue: true
}

async function get(url: string, headers: Record<string, string> = {}): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, redirect: 'follow' })
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
  return res.text()
}

/** Pull every JSON-LD MusicEvent/Event object out of a page. */
function jsonLdEvents(html: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  const walk = (o: unknown): void => {
    if (Array.isArray(o)) { o.forEach(walk); return }
    if (o && typeof o === 'object') {
      const rec = o as Record<string, unknown>
      const t = rec['@type']
      if (t === 'MusicEvent' || t === 'Event' || (Array.isArray(t) && t.includes('MusicEvent'))) out.push(rec)
      Object.values(rec).forEach(walk)
    }
  }
  const re = /<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    try { walk(JSON.parse(m[1])) } catch { /* a malformed block is not fatal */ }
  }
  return out
}

const mk = (venueKey: string, venue: string, city: string, artist: string, date: string, url: string): VenueShow | null => {
  const a = (artist || '').replace(/\s+/g, ' ').trim()
  if (!a || !date) return null
  return { venueKey, venue, city, artist: a, date, url: url || '', fromVenue: true }
}

// ── JSON-LD venues ──────────────────────────────────────────────────────────
// Warsaw (Greenpoint) and Brooklyn Paramount both publish clean schema.org
// MusicEvent blocks on their homepages. Cheapest, most durable shape we found.
async function ldVenue(key: string, name: string, home: string): Promise<VenueShow[]> {
  const events = jsonLdEvents(await get(home))
  return events.map((e) => {
    const loc = e.location as Record<string, unknown> | undefined
    const locName = typeof loc?.name === 'string' ? loc.name : name
    return mk(key, locName || name, 'Brooklyn, NY',
      String(e.name ?? ''), String(e.startDate ?? ''), String(e.url ?? home))
  }).filter((x): x is VenueShow => x !== null)
}

// ── Bowery Presents / AEG (Brooklyn Steel, Music Hall of Williamsburg) ──────
// The venue pages carry no JSON-LD; their event list is an unauthenticated
// Azure blob shared across ALL Bowery rooms, filtered client-side by venueId.
// ⚠️ 13.9 MB and Azure does NOT gzip it — fetch at most once per cache window,
// never per page load. Cancelled shows carry ticketing.statusId === 2.
const AEG_FEED = 'https://aegwebprod.blob.core.windows.net/json/events/59/events.json'
const AEG_ROOMS: Array<{ key: string; id: string; name: string }> = [
  { key: 'brooklyn-steel', id: '126144', name: 'Brooklyn Steel' },
  { key: 'music-hall-williamsburg', id: '125933', name: 'Music Hall of Williamsburg' },
]
let aegCache: { at: number; rows: unknown[] } | null = null
async function aegRooms(): Promise<VenueShow[]> {
  if (!aegCache || Date.now() - aegCache.at > CACHE_MS) {
    const body = JSON.parse(await get(AEG_FEED)) as { events?: unknown[] }
    aegCache = { at: Date.now(), rows: Array.isArray(body.events) ? body.events : [] }
  }
  const out: VenueShow[] = []
  for (const raw of aegCache.rows) {
    const e = raw as Record<string, any>
    const room = AEG_ROOMS.find((r) => r.id === String(e?.venue?.venueId))
    if (!room) continue
    if (String(e?.ticketing?.statusId) === '2') continue        // cancelled
    // *Text variants only — `title.headliners` is raw anchor markup.
    const s = mk(room.key, room.name, 'Brooklyn, NY',
      String(e?.title?.headlinersText ?? ''),
      String(e?.eventDateTimeISO ?? ''),
      String(e?.ticketing?.eventUrl ?? ''))
    if (s) out.push(s)
  }
  return out
}

// ── Next.js payload venues ─────────────────────────────────────────────────
// Elsewhere ships __NEXT_DATA__; Pacha NY (the room formerly known as Avant
// Gardner / Brooklyn Mirage — Chapter 11, reopened under Pacha in June 2026)
// ships an RSC flight payload whose events array we slice by brace matching.
function sliceBalanced(text: string, startIdx: number): string | null {
  let depth = 0
  for (let i = startIdx; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {                                   // skip strings wholesale
      i++
      while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; i++ }
      continue
    }
    if (c === '[' || c === '{') depth++
    else if (c === ']' || c === '}') { depth--; if (depth === 0) return text.slice(startIdx, i + 1) }
  }
  return null
}

async function pacha(): Promise<VenueShow[]> {
  const body = await get('https://pacha-nyc.com/events', { RSC: '1' })
  const at = body.indexOf('"initialEvents":')
  if (at < 0) return []
  const arrStart = body.indexOf('[', at)
  const slice = arrStart >= 0 ? sliceBalanced(body, arrStart) : null
  if (!slice) return []
  const rows = JSON.parse(slice) as Array<Record<string, any>>
  const out: VenueShow[] = []
  for (const e of rows) {
    // Per-artist rows: the top-level name is a marketing title that often
    // bundles a whole bill ("Loco Dice, Seth Troxler…: All Night Long").
    const artists: string[] = Array.isArray(e.artists) && e.artists.length
      ? e.artists.map((a: any) => String(a?.name ?? '')).filter(Boolean)
      : [String(e.name ?? '')]
    const room = String(e?.location?.name ?? 'Pacha New York')
    for (const a of artists) {
      const s = mk('pacha-nyc', room, 'Brooklyn, NY', a, String(e.start_date ?? ''),
        e.slug ? `https://pacha-nyc.com/event/${e.slug}` : 'https://pacha-nyc.com/events')
      if (s) out.push(s)
    }
  }
  return out
}

async function elsewhere(): Promise<VenueShow[]> {
  const html = await get('https://www.elsewherebrooklyn.com/')
  const m = /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i.exec(html)
  if (!m) return []
  const data = JSON.parse(m[1]) as Record<string, unknown>
  const out: VenueShow[] = []
  const walk = (o: unknown): void => {
    if (Array.isArray(o)) { o.forEach(walk); return }
    if (o && typeof o === 'object') {
      const r = o as Record<string, any>
      const title = r.title ?? r.name
      const date = r.date ?? r.startDate ?? r.start_date ?? r.doorsTime
      if (typeof title === 'string' && typeof date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(date)) {
        const s = mk('elsewhere', 'Elsewhere', 'Brooklyn, NY', title, date,
          typeof r.url === 'string' ? r.url : 'https://www.elsewherebrooklyn.com/')
        if (s) out.push(s)
      }
      Object.values(r).forEach(walk)
    }
  }
  walk(data)
  return out
}

// ── The room list ───────────────────────────────────────────────────────────
// Each entry fails independently; a rotted scrape costs its own venue only.
// (Good Room is deliberately http:// — its TLS cert is self-signed and expired
// in May 2024, so https fails outright. Verified 2026-08-08.)
const FETCHERS: Array<{ key: string; run: () => Promise<VenueShow[]> }> = [
  { key: 'warsaw', run: () => ldVenue('warsaw', 'Warsaw', 'https://www.warsawconcerts.com/') },
  { key: 'brooklyn-paramount', run: () => ldVenue('brooklyn-paramount', 'Brooklyn Paramount', 'https://www.brooklynparamount.com/') },
  { key: 'aeg-rooms', run: aegRooms },
  { key: 'pacha-nyc', run: pacha },
  { key: 'elsewhere', run: elsewhere },
]

/**
 * Every upcoming show at Jake's rooms, soonest first, de-duplicated.
 * Never throws: a venue that fails contributes nothing and is logged once.
 */
export async function getVenueShows(): Promise<VenueShow[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.shows
  const settled = await Promise.allSettled(FETCHERS.map((f) => f.run()))
  const shows: VenueShow[] = []
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') shows.push(...r.value)
    else console.warn(`[venues] ${FETCHERS[i].key} failed:`, r.reason?.message || r.reason)
  })
  const now = Date.now()
  const seen = new Set<string>()
  const fresh = shows
    .filter((s) => {
      const t = Date.parse(s.date)
      if (!Number.isFinite(t) || t < now - 12 * 60 * 60 * 1000) return false   // drop past
      const k = `${s.artist.toLowerCase()}|${s.venueKey}|${s.date.slice(0, 10)}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    .sort((a, b) => a.date.localeCompare(b.date))
  cache = { at: Date.now(), shows: fresh }
  return fresh
}
