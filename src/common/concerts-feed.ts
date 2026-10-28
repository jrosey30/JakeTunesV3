/**
 * Concerts feed — the desktop's half of homemini's show collector
 * (Jake, 2026-10-19: "need to be better at concerts!!!").
 *
 *   GET {MOBILE_BACKEND_URL}/api/concerts           Jake's artists, NYC only, soonest first
 *   GET {MOBILE_BACKEND_URL}/api/concerts/discover  "You'd like this": related artists he doesn't own
 *
 * The wire contract is ~/JakeTunesMobile docs/concerts-api-contract.md; the
 * backend that ranks is backend/src/util/concerts*.ts there. This file is
 * pure (no electron, no DOM): parsing, pruning a cached copy to the nights
 * still ahead, the badge rules, the card labels, the offline fallback's
 * shape, and the Music Man's narrowing. Main (concerts-client.ts,
 * ipc/concerts-ipc.ts, record-store/external-context.ts) and the renderer
 * (components/HomeShows.tsx) both read it.
 *
 * DATE ORDER, NEW YORK CITY ONLY (Jake, 2026-10-28: "concert suggestions are
 * never in date order. i need more focus on new york city/brooklyn near
 * 11211"). Taste picks the shows (tiers) and writes the reason line; it never
 * orders them. Every list the app draws goes through listConcerts(): past
 * nights pruned, the five boroughs only, soonest first (compareConcerts) — a
 * homemini answer already is; a cached copy from an older homemini, or the
 * Bandsintown + venue-calendar fallback, is made so here.
 */
import { nameKey } from './fold-text.ts'

export const DAY_MS = 86_400_000
/** The badge lasts a week from when the collector first saw the show.
 *  Same window as the backend's JUST_ANNOUNCED_DAYS (concertsAnnounce.ts);
 *  re-checked here because a cached copy outlives the backend's answer. */
export const JUST_ANNOUNCED_DAYS = 7
/** Shows are local to New York — dates, "today" and on-sale times are read there. */
export const CONCERTS_TZ = 'America/New_York'

const YMD = /^\d{4}-\d{2}-\d{2}$/

export interface RunNight {
  id: string
  date: string
  time: string | null
  url: string | null
  soldOut: boolean
  onSale: string | null
}

export interface ConcertLink { source: string; url: string }

/** One item = one RUN (a one-off is a run of one night), placed at its rank. */
export interface ConcertItem {
  id: string
  name: string
  url: string | null
  /** Local date YYYY-MM-DD (America/New_York) of the run's next night. */
  date: string
  time: string | null
  venue: string
  city: string | null
  state: string | null
  artists: string[]
  rank: number
  tier: number
  reason: string
  matchedArtist: string
  matchRole: 'headliner' | 'support'
  relatedTo: string[] | null
  headliners: string[]
  support: string[]
  onSale: string | null
  soldOut: boolean
  justAnnounced: boolean
  firstSeenAt: string | null
  neighbourhood: string | null
  northBrooklyn: boolean
  /** Miles from home (Williamsburg), null when the room has no point. */
  distanceMiles: number | null
  /** The room's borough; homemini sends it for every item since 2026-10-28.
   *  Null from an older answer or the fallback — inNyc decides by city then. */
  borough: string | null
  room: string | null
  links: ConcertLink[]
  rsvp: 'going' | 'not' | null
  runNights: number
  runDates: string[]
  runShows: RunNight[]
}

export interface ConcertsReply {
  items: ConcertItem[]
  generatedAt: string | null
  /** The backend's home label ("Williamsburg"). */
  home: string | null
}

/** Where what the Home draws came from:
 *  homemini — answered this session · cache — homemini's last answer, saved on
 *  disk · fallback — homemini and a usable cache both away, so this Mac asked
 *  Bandsintown + the venue calendars itself (the pre-feed path) · none. */
export type ConcertsSource = 'homemini' | 'cache' | 'fallback' | 'none'

export interface ConcertsFeedState {
  source: ConcertsSource
  items: ConcertItem[]
  discover: ConcertItem[]
  generatedAt: string | null
  home: string | null
  /** When homemini last confirmed what's drawn (ms epoch), null for fallback/none. */
  fetchedAt: number | null
  reachable: boolean | null
}

export const EMPTY_CONCERTS_STATE: ConcertsFeedState = {
  source: 'none', items: [], discover: [], generatedAt: null, home: null, fetchedAt: null, reachable: null,
}

// ── parsing ─────────────────────────────────────────────────────────────

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [])
/** Only http(s) links leave the app (openExternalUrl re-checks). */
const link = (v: unknown): string | null => {
  const s = str(v)
  return s && /^https?:\/\//i.test(s) ? s : null
}

function parseNight(raw: unknown): RunNight | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = str(r.id)
  const date = str(r.date)
  if (!id || !date || !YMD.test(date)) return null
  return { id, date, time: str(r.time), url: link(r.url), soldOut: r.soldOut === true, onSale: str(r.onSale) }
}

/** One wire item → ConcertItem, or null when it isn't a show we can draw.
 *  Missing optional fields get the one-off-night defaults, so an older
 *  backend (Ticketmaster-only shape) still draws. */
export function parseConcertItem(raw: unknown, fallbackRank = 0): ConcertItem | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = str(r.id)
  const date = str(r.date)
  const venue = str(r.venue)
  const artists = strs(r.artists)
  const name = str(r.name) ?? artists[0] ?? null
  if (!id || !date || !YMD.test(date) || !venue || !name) return null
  const headliners = strs(r.headliners).length ? strs(r.headliners) : artists.length ? [artists[0]] : [name]
  const support = Array.isArray(r.support) ? strs(r.support) : artists.slice(1)
  const url = link(r.url)
  const soldOut = r.soldOut === true
  const onSale = str(r.onSale)
  const time = str(r.time)
  const nights = (Array.isArray(r.runShows) ? r.runShows : []).map(parseNight).filter((n): n is RunNight => n !== null)
  const runDates = strs(r.runDates).filter((d) => YMD.test(d))
  // A run always lists THIS night; an item without run fields is a one-off.
  const runShows: RunNight[] = nights.length
    ? nights
    : (runDates.length ? runDates : [date]).map((d) => (d === date
      ? { id, date, time, url, soldOut, onSale }
      : { id: `${id}#${d}`, date: d, time: null, url, soldOut: false, onSale: null }))
  if (!runShows.some((n) => n.date === date)) runShows.unshift({ id, date, time, url, soldOut, onSale })
  runShows.sort((a, b) => a.date.localeCompare(b.date))
  const rsvp = r.rsvp === 'going' || r.rsvp === 'not' ? r.rsvp : null
  return {
    id, name, url, date, time, venue,
    city: str(r.city), state: str(r.state),
    artists: artists.length ? artists : [name],
    rank: num(r.rank) ?? fallbackRank,
    tier: num(r.tier) ?? 6,
    reason: str(r.reason) ?? '',
    matchedArtist: str(r.matchedArtist) ?? headliners[0],
    matchRole: r.matchRole === 'support' ? 'support' : 'headliner',
    relatedTo: Array.isArray(r.relatedTo) ? strs(r.relatedTo) : null,
    headliners, support, onSale, soldOut,
    justAnnounced: r.justAnnounced === true,
    firstSeenAt: str(r.firstSeenAt),
    neighbourhood: str(r.neighbourhood),
    northBrooklyn: r.northBrooklyn === true,
    distanceMiles: num(r.distanceMiles),
    borough: str(r.borough),
    room: str(r.room),
    links: (Array.isArray(r.links) ? r.links : [])
      .map((l) => (l && typeof l === 'object' ? { source: str((l as Record<string, unknown>).source) ?? '', url: link((l as Record<string, unknown>).url) } : null))
      .filter((l): l is ConcertLink => !!l && !!l.url),
    rsvp,
    runNights: runShows.length,
    runDates: runShows.map((n) => n.date),
    runShows,
  }
}

/** A /api/concerts or /api/concerts/discover body → ConcertsReply, or null
 *  when the body isn't one (HTML from a proxy, the 503 warming-up error,
 *  torn JSON). Items that don't parse are dropped, not the document. Order
 *  is the wire's; listConcerts() makes it date order for drawing. */
export function parseConcertsReply(body: unknown): ConcertsReply | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  if (!Array.isArray(b.items)) return null
  const items = b.items.map((raw, i) => parseConcertItem(raw, i + 1)).filter((x): x is ConcertItem => x !== null)
  const home = b.home && typeof b.home === 'object' ? str((b.home as Record<string, unknown>).label) : null
  return { items, generatedAt: str(b.generatedAt), home }
}

/** Guard for a state that crossed IPC (the renderer's side). */
export function asConcertsState(v: unknown): ConcertsFeedState | null {
  if (!v || typeof v !== 'object') return null
  const s = v as Partial<ConcertsFeedState>
  if (!Array.isArray(s.items) || !Array.isArray(s.discover)) return null
  const source: ConcertsSource = s.source === 'homemini' || s.source === 'cache' || s.source === 'fallback' ? s.source : 'none'
  return {
    source, items: s.items, discover: s.discover,
    generatedAt: typeof s.generatedAt === 'string' ? s.generatedAt : null,
    home: typeof s.home === 'string' ? s.home : null,
    fetchedAt: typeof s.fetchedAt === 'number' ? s.fetchedAt : null,
    reachable: typeof s.reachable === 'boolean' ? s.reachable : null,
  }
}

// ── dates ───────────────────────────────────────────────────────────────

/** New York's calendar date for an instant, YYYY-MM-DD. */
export function nyDate(ms: number): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: CONCERTS_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms))
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** A source's date string → New York YYYY-MM-DD. A bare date or a wall-clock
 *  time without zone is already local; an instant (Z / offset) is converted.
 *  `new Date('2026-10-23')` is UTC midnight — Oct 22 in Brooklyn — so a bare
 *  date is never handed to Date. */
export function localYmd(s: string): string | null {
  if (YMD.test(s)) return s
  if (/^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(s)) return s.slice(0, 10)
  const t = Date.parse(s)
  return Number.isFinite(t) ? nyDate(t) : null
}

export function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
const ymdParts = (ymd: string) => { const [y, m, d] = ymd.split('-').map(Number); return { y, m, d } }

/** "Friday, October 23, 2026" — for tooltips. Read as a calendar date, no zone math. */
export function longDate(ymd: string): string {
  const { y, m, d } = ymdParts(ymd)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
}

// ── pruning a cached copy ───────────────────────────────────────────────

/** Drop the nights that have passed (New York `today`), and re-point each run
 *  at its next night — the way the backend builds a fresh answer. A run with
 *  no nights left is gone. Order is untouched. */
export function pruneToUpcoming(items: ConcertItem[], today: string): ConcertItem[] {
  const out: ConcertItem[] = []
  for (const it of items) {
    const ahead = it.runShows.filter((n) => n.date >= today)
    if (ahead.length === 0) continue
    if (ahead.length === it.runShows.length && it.date >= today) { out.push(it); continue }
    const next = ahead[0]
    out.push({
      ...it, id: next.id, date: next.date, time: next.time, url: next.url ?? it.url,
      soldOut: next.soldOut, onSale: next.onSale,
      runShows: ahead, runDates: ahead.map((n) => n.date), runNights: ahead.length,
    })
  }
  return out
}

// ── order + New York City only (2026-10-28) ─────────────────────────────

/** Soonest first. Within one date: North Brooklyn rooms first, then nearer
 *  rooms (no known distance last), then the earlier start (no time last),
 *  then taste rank. A run is one item at its next night and sorts by it.
 *  ⚠️ TWIN: ~/JakeTunesMobile backend/src/util/concertsOrder.ts
 *  compareConcerts and ios/JakeTunesMobile/Concerts.swift ConcertOrder —
 *  same keys, same order; change all three together. */
export function compareConcerts(a: ConcertItem, b: ConcertItem): number {
  return a.date.localeCompare(b.date) ||
    Number(b.northBrooklyn) - Number(a.northBrooklyn) ||
    (a.distanceMiles ?? Infinity) - (b.distanceMiles ?? Infinity) ||
    (a.time ?? '99').localeCompare(b.time ?? '99') ||
    a.rank - b.rank ||
    a.id.localeCompare(b.id)
}

/** The city names sources print for rooms in the five boroughs.
 *  ⚠️ TWIN: ~/JakeTunesMobile backend/src/util/concertsVenues.ts
 *  CITY_BOROUGH and the phone's ConcertOrder.cityBoroughs — same list. */
const CITY_BOROUGH: Readonly<Record<string, string>> = {
  'new york': 'Manhattan', 'new york city': 'Manhattan', nyc: 'Manhattan', manhattan: 'Manhattan',
  brooklyn: 'Brooklyn',
  bronx: 'Bronx', 'the bronx': 'Bronx',
  'staten island': 'Staten Island',
  queens: 'Queens', 'long island city': 'Queens', astoria: 'Queens', flushing: 'Queens', corona: 'Queens',
  ridgewood: 'Queens', 'forest hills': 'Queens', jamaica: 'Queens', 'jackson heights': 'Queens',
  sunnyside: 'Queens', woodside: 'Queens', elmhurst: 'Queens', maspeth: 'Queens', glendale: 'Queens',
  'middle village': 'Queens', 'rockaway park': 'Queens', 'rockaway beach': 'Queens', 'far rockaway': 'Queens',
  'kew gardens': 'Queens', 'richmond hill': 'Queens', 'ozone park': 'Queens', 'howard beach': 'Queens',
  bayside: 'Queens', whitestone: 'Queens', 'college point': 'Queens', 'fresh meadows': 'Queens',
}

/** The borough a city name means, when the state is New York (or not
 *  given). Takes "Brooklyn" + "NY", or Bandsintown's one string "Brooklyn, NY". */
export function cityBorough(city: string | null, state: string | null): string | null {
  let c = String(city ?? '')
  let st = String(state ?? '')
  if (!st && c.includes(',')) {
    const i = c.lastIndexOf(',')
    st = c.slice(i + 1)
    c = c.slice(0, i)
  }
  st = st.trim().toUpperCase()
  if (st && st !== 'NY' && st !== 'NEW YORK') return null
  return CITY_BOROUGH[c.trim().toLowerCase().replace(/\s+/g, ' ')] ?? null
}

/** In the five boroughs: homemini's borough when it sent one (it lists New
 *  York City only), else the item's city. */
export function inNyc(item: ConcertItem): boolean {
  return !!item.borough || cityBorough(item.city, item.state) !== null
}

/** What a concerts row draws: the nights still ahead (pruneToUpcoming), New
 *  York City only, soonest first. */
export function listConcerts(items: ConcertItem[], today: string): ConcertItem[] {
  return pruneToUpcoming(items, today).filter(inNyc).sort(compareConcerts)
}

// ── badges ──────────────────────────────────────────────────────────────

export interface ConcertBadges {
  /** New since an earlier collector run, inside its 7-day week. */
  justAnnounced: boolean
  /** Public on-sale instant, only while it's still ahead. */
  onSaleAt: string | null
  /** 'all' — every night left is sold out; 'some' — part of a run is. */
  soldOut: 'all' | 'some' | null
}

/** The badge rules (Jake approved 2026-10-19): "Just announced" for 7 days,
 *  plus the on-sale time when it's in the future. The backend already gates
 *  `justAnnounced` on taste tier and its own 7-day window; this re-checks the
 *  window against `firstSeenAt`, because a copy cached on Monday is still on
 *  screen the next Tuesday. No timestamp, no badge.
 *  ⚠️ TWIN: ~/JakeTunesMobile/backend/src/util/concertsAnnounce.ts
 *  isJustAnnounced / JUST_ANNOUNCED_DAYS — same window, same clock
 *  (firstSeenAt, [0, 7 days)); change both together. */
export function concertBadges(item: ConcertItem, nowMs: number): ConcertBadges {
  const seen = item.firstSeenAt ? Date.parse(item.firstSeenAt) : NaN
  const justAnnounced = item.justAnnounced && Number.isFinite(seen) && nowMs - seen >= 0 && nowMs - seen < JUST_ANNOUNCED_DAYS * DAY_MS
  const sale = item.onSale ? Date.parse(item.onSale) : NaN
  const onSaleAt = Number.isFinite(sale) && sale > nowMs ? item.onSale : null
  let soldOut: ConcertBadges['soldOut'] = null
  if (item.runShows.length > 1) {
    const n = item.runShows.filter((s) => s.soldOut).length
    soldOut = n === item.runShows.length ? 'all' : n > 0 ? 'some' : null
  } else if (item.soldOut || item.runShows[0]?.soldOut) {
    soldOut = 'all'
  }
  return { justAnnounced, onSaleAt, soldOut }
}

/** "On sale Fri, Oct 24, 10 AM" (New York time). */
export function formatOnSale(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return 'On sale soon'
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CONCERTS_TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).formatToParts(new Date(t))
  const get = (k: string) => parts.find((p) => p.type === k)?.value ?? ''
  const minute = get('minute')
  const clock = `${get('hour')}${minute && minute !== '00' ? `:${minute}` : ''} ${get('dayPeriod')}`.trim()
  return `On sale ${get('weekday')}, ${get('month')} ${get('day')}, ${clock}`
}

// ── card labels ─────────────────────────────────────────────────────────

/** The date stamp on a card. A run reads as its range: NOV / 19–22, or
 *  NOV–DEC / 30–3 when it crosses a month, plus "4 nights". */
export function runStamp(item: ConcertItem, today: string): { month: string; day: string; nights: number; year: number | null } {
  const first = ymdParts(item.runDates[0] ?? item.date)
  const last = ymdParts(item.runDates[item.runDates.length - 1] ?? item.date)
  const nights = Math.max(1, item.runNights)
  const yearNow = ymdParts(today).y
  const year = first.y !== yearNow ? first.y : null
  if (nights <= 1) return { month: MONTHS[first.m - 1], day: String(first.d), nights: 1, year }
  const month = first.m === last.m && first.y === last.y ? MONTHS[first.m - 1] : `${MONTHS[first.m - 1]}–${MONTHS[last.m - 1]}`
  return { month, day: `${first.d}–${last.d}`, nights, year }
}

/** Who the card is about. A support-slot match is about the opener Jake plays
 *  (the reason line says "opening for <headliner>"), not the headliner. */
export function cardBill(item: ConcertItem): { artist: string; openingFor: string | null } {
  if (item.matchRole === 'support') {
    const h = item.headliners[0] ?? null
    return { artist: item.matchedArtist, openingFor: h && nameKey(h) !== nameKey(item.matchedArtist) ? h : null }
  }
  return { artist: item.headliners[0] ?? item.artists[0] ?? item.name, openingFor: null }
}

const OPENING_SUFFIX = /\s*\(opening for [^)]*\)\s*$/i

/** The reason line. Ranked list: the backend's words ("Heavy rotation: 13
 *  plays in 90 days"), minus the "(opening for …)" the card already shows.
 *  "You'd like this": "Because you play Geese" / "… Geese and Fat Dog". */
export function cardReason(item: ConcertItem, kind: 'ranked' | 'discover'): string {
  if (kind === 'ranked') return item.reason.replace(OPENING_SUFFIX, '')
  const related = (item.relatedTo ?? []).slice(0, 2)
  if (related.length) return `Because you play ${related.join(' and ')}`
  const m = /^You'd like this: like (.+)$/i.exec(item.reason.replace(OPENING_SUFFIX, ''))
  return m ? `Because you play ${m[1]}` : item.reason.replace(OPENING_SUFFIX, '') || "You'd like this"
}

/** "20:00:00" → "8 PM", "19:30" → "7:30 PM". */
export function formatShowTime(time: string | null): string | null {
  const m = time ? /^(\d{1,2}):(\d{2})/.exec(time) : null
  if (!m) return null
  const h = Number(m[1])
  const clock = `${h % 12 === 0 ? 12 : h % 12}${m[2] === '00' ? '' : `:${m[2]}`}`
  return `${clock} ${h < 12 ? 'AM' : 'PM'}`
}

/** "4 nights: Nov 19, 20, 21, 22" / "2 nights: Nov 30, Dec 1" — tooltips. */
export function runNightsLine(item: ConcertItem): string | null {
  if (item.runDates.length <= 1) return null
  let lastMonth = -1
  const days = item.runDates.map((ymd) => {
    const { m, d } = ymdParts(ymd)
    const label = m === lastMonth ? String(d) : `${MONTHS[m - 1].charAt(0)}${MONTHS[m - 1].slice(1).toLowerCase()} ${d}`
    lastMonth = m
    return label
  })
  return `${item.runDates.length} nights: ${days.join(', ')}`
}

/** "Greenpoint", "Manhattan" — the backend's neighbourhood, else the city. */
export function whereLine(item: ConcertItem): string {
  return item.neighbourhood ?? [item.city, item.state].filter(Boolean).join(', ')
}

/** The official ticket link (venue / promoter first — the backend's order). */
export function ticketUrl(item: ConcertItem): string | null {
  return item.url ?? item.links[0]?.url ?? null
}

/** Ticket link for one night of a run. */
export function nightUrl(item: ConcertItem, night: RunNight): string | null {
  return night.url ?? ticketUrl(item)
}

// ── offline fallback (the pre-feed path, reshaped) ──────────────────────

/** Bandsintown's shape (external.ts TourDate) and venues.ts's VenueShow. */
export interface LegacyShow { artist: string; date: string; venue: string; city: string; url: string; venueKey?: string; known?: boolean }

/** Nights of one act at one room closer than this are one run — the
 *  backend's rule (a weekly residency is one run; LCD Soundsystem's November
 *  and December Knockdown stands, 18 days apart, are two). */
export const RUN_GAP_DAYS = 7

/**
 * The pre-feed sources as ConcertItems, so the Home draws one shape however
 * the data arrived. `rank` (the taste stand-in): Bandsintown's library-artist
 * shows in its own order, then venue-calendar shows by library artists,
 * then everything else at the rooms. The rows draw them through
 * listConcerts() like homemini's — New York City only, by date — so
 * Bandsintown's Jersey and Long Island dates never show.
 * ⚠️ TWIN: homemini's feed (~/JakeTunesMobile backend concertsService.ts):
 * same filter, same order, reached by listConcerts. Nights of the same act at the same room fold into runs, split
 * where nights are more than RUN_GAP_DAYS apart.
 */
export function legacyConcertItems(tour: LegacyShow[], venues: LegacyShow[], nowMs: number): ConcertItem[] {
  const today = nyDate(nowMs)
  type Run = { show: LegacyShow; nights: Array<{ date: string; url: string }>; library: boolean; source: string }
  const runs = new Map<string, Run>()
  const order: string[] = []
  const seenNight = new Set<string>()
  const add = (s: LegacyShow, library: boolean, source: string): void => {
    const date = localYmd(s.date)
    const who = nameKey(s.artist, '')
    if (!date || date < today || !who) return
    const night = `${who}|${date}`
    if (seenNight.has(night)) return              // the same night from both sources
    seenNight.add(night)
    const key = `${who}|${nameKey(s.venueKey || s.venue, '')}`
    const run = runs.get(key)
    if (run) { run.nights.push({ date, url: s.url }); return }
    runs.set(key, { show: s, nights: [{ date, url: s.url }], library, source })
    order.push(key)
  }
  for (const s of tour) add(s, true, 'bandsintown')
  const byDate = (a: LegacyShow, b: LegacyShow) => (localYmd(a.date) ?? '').localeCompare(localYmd(b.date) ?? '')
  for (const s of [...venues].filter((v) => v.known).sort(byDate)) add(s, true, 'venue')
  for (const s of [...venues].filter((v) => !v.known).sort(byDate)) add(s, false, 'venue')

  const split: Array<{ run: Run; nights: Run['nights'] }> = []
  for (const key of order) {
    const run = runs.get(key)!
    let cur: Run['nights'] = []
    for (const n of [...run.nights].sort((a, b) => a.date.localeCompare(b.date))) {
      if (cur.length && n.date > addDays(cur[cur.length - 1].date, RUN_GAP_DAYS)) { split.push({ run, nights: cur }); cur = [] }
      cur.push(n)
    }
    split.push({ run, nights: cur })
  }

  return split.map(({ run, nights }, i): ConcertItem => {
    const id = `legacy:${i + 1}`
    const runShows: RunNight[] = nights.map((n, j) => ({ id: j === 0 ? id : `${id}#${n.date}`, date: n.date, time: null, url: link(n.url), soldOut: false, onSale: null }))
    const url = runShows[0].url
    return {
      id, name: run.show.artist, url, date: runShows[0].date, time: null,
      venue: run.show.venue, city: run.show.city || null, state: null,
      artists: [run.show.artist], rank: i + 1, tier: 6,
      reason: run.library ? 'In your library' : 'At one of your rooms',
      matchedArtist: run.show.artist, matchRole: 'headliner', relatedTo: null,
      headliners: [run.show.artist], support: [],
      onSale: null, soldOut: false, justAnnounced: false, firstSeenAt: null,
      neighbourhood: null, northBrooklyn: false, distanceMiles: null, borough: null, room: null,
      links: url ? [{ source: run.source, url }] : [], rsvp: null,
      runNights: runShows.length, runDates: runShows.map((n) => n.date), runShows,
    }
  })
}

// ── the Music Man ───────────────────────────────────────────────────────

export interface MusicManShow { artist: string; venue: string; city: string; date: string; url: string; reason: string; nights: number }

/** What the Record Store's day-theme prompt hears about: the `limit` (10)
 *  best taste matches in New York City in the next `days` (default 30),
 *  told soonest first. Taste picks which shows, the date orders them (Jake,
 *  2026-10-28) — the soonest ten would be whatever is on this week, however
 *  far down his taste. */
export function musicManShows(items: ConcertItem[], nowMs: number, opts: { days?: number; limit?: number } = {}): MusicManShow[] {
  const today = nyDate(nowMs)
  const horizon = addDays(today, opts.days ?? 30)
  return listConcerts(items, today)
    .filter((i) => i.date <= horizon)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, opts.limit ?? 10)
    .sort(compareConcerts)
    .map((i) => ({
      artist: cardBill(i).artist,
      venue: i.venue,
      city: whereLine(i),
      date: i.date,
      url: ticketUrl(i) ?? '',
      reason: cardReason(i, 'ranked'),
      nights: i.runNights,
    }))
}
