// external-context.ts — the world-aware layer (Brief 037 §3.5, Phase 1b)
//
// The day-theme picker (Phase 1c) is what earns the "tears of joy" bar,
// and it only earns it if it knows what's happening OUTSIDE the
// library. "Big Thief is at Brooklyn Steel Friday — play Two Hands once
// before you go" is the line; it requires a show feed. This module
// gathers that outside world into one snapshot the day-theme prompt can
// read.
//
// It is a thin AGGREGATOR over src/main/external.ts, which already
// owns the actual network code (Last.fm, Pitchfork/Stereogum/Brooklyn
// Vegan RSS, Bandsintown, MusicBrainz) and is already fail-soft — every
// fetcher there returns [] / null instead of throwing. This module:
//   1. fans those fetchers out in parallel,
//   2. narrows them to what the store cares about (NYC shows in the
//      next 14 days; library-artist upcoming releases),
//   3. adds calendar context (day, part-of-day, season) the picker
//      uses for "Sunday morning" / seasonal threads,
//   4. caches the whole snapshot to disk for 6h so opening the store
//      repeatedly in a day doesn't re-hit five external APIs, and the
//      snapshot survives an app restart (the in-memory caches in
//      external.ts do not).
//
// Fail-soft is inherited: if every feed is down we still return a valid
// ExternalContext with empty arrays and the calendar block, and the
// picker falls back to a library-only theme (Brief §3.3 / §8).

import { join } from 'path'
import {
  getBrooklynWeather,
  getLastFmNyChart,
  getMusicNews,
  getNotableReleases,
  getTourDatesForArtists,
  getUpcomingReleasesForArtists,
  type MusicNewsItem,
  type TourDate,
  type UpcomingRelease,
} from '../external'
import { atomicWriteJson, readJsonOrNull, recordStoreBaseDir } from './cache'

// ── Public types ─────────────────────────────────────────────────────

export interface CalendarContext {
  /** YYYY-MM-DD local. */
  dateISO: string
  /** "Tuesday" — the picker uses this for weekend vs weekday threads. */
  dayOfWeek: string
  /** Coarse time bucket for "Sunday morning" / "late night" moods. */
  partOfDay: 'morning' | 'afternoon' | 'evening' | 'late-night'
  /** Northern-hemisphere season (Jake is in Brooklyn). */
  season: 'winter' | 'spring' | 'summer' | 'fall'
}

export interface StoreShow {
  artist: string
  venue: string
  city: string
  /** Event datetime, ISO. */
  date: string
  url: string
}

export interface StoreRelease {
  title: string
  artist: string
  /** May be partial (`2026`, `2026-09`). */
  releaseDate: string
}

export interface PressItem {
  source: string
  title: string
  url: string
}

/** The full outside-world snapshot the day-theme picker reads.
 *  Every field is best-effort; empty arrays / null mean "that feed was
 *  unavailable", never an error. */
export interface ExternalContext {
  /** ms epoch when this snapshot was gathered. Drives the 6h TTL. */
  fetchedAt: number
  calendar: CalendarContext
  weather: { tempF: number; condition: string; description: string } | null
  /** "Artist – Track" strings, what the US is scrobbling this week. */
  lastFmChart: string[]
  /** Recent music-press headlines (news, gossip already filtered out). */
  press: PressItem[]
  /** Pitchfork "Best New Albums" — the cultural new-release signal. */
  notableReleases: PressItem[]
  /** Library artists playing the NYC area in the next 14 days. The
   *  highest-value "cultural" theme source (Brief §3.5). */
  shows: StoreShow[]
  /** Upcoming releases by artists already in the library. */
  upcomingReleases: StoreRelease[]
}

// ── Tuning ───────────────────────────────────────────────────────────

/** Disk-cache TTL. Brief §1b: "All cached for 6h on disk." */
const CONTEXT_TTL_MS = 6 * 60 * 60 * 1000
/** Show lookahead window. Brief §1b: Bandsintown "next 14 days". */
const SHOW_WINDOW_DAYS = 14
/** How many of the user's top artists to query show/release feeds for.
 *  external.ts already caps Bandsintown at 60 and batches MusicBrainz;
 *  we pass the ranked list and let it slice. */
const MAX_ARTISTS_FOR_FEEDS = 60
const CONTEXT_FILE = 'external-context.json'

// ── Calendar ─────────────────────────────────────────────────────────

const DAY_NAMES = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
] as const

function localISODate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function partOfDay(hour: number): CalendarContext['partOfDay'] {
  if (hour >= 5 && hour < 12) return 'morning'
  if (hour >= 12 && hour < 17) return 'afternoon'
  if (hour >= 17 && hour < 22) return 'evening'
  return 'late-night'
}

function season(month0: number): CalendarContext['season'] {
  // month0 is 0-11. Meteorological seasons, Northern hemisphere.
  if (month0 === 11 || month0 <= 1) return 'winter'
  if (month0 <= 4) return 'spring'
  if (month0 <= 7) return 'summer'
  return 'fall'
}

function buildCalendar(now: Date): CalendarContext {
  return {
    dateISO: localISODate(now),
    dayOfWeek: DAY_NAMES[now.getDay()],
    partOfDay: partOfDay(now.getHours()),
    season: season(now.getMonth()),
  }
}

// ── NYC show narrowing ───────────────────────────────────────────────
//
// Bandsintown returns every upcoming date for the user's artists,
// worldwide. The store only cares about shows Jake could actually go
// to. We match the NYC metro by city + region rather than coordinates
// (BIT gives us "Brooklyn, NY" strings, not lat/lon). Generous on the
// borough/neighborhood list, strict on the "NY" region so we don't
// catch "Brooklyn, OH" etc.

const NYC_CITY_PATTERNS: RegExp[] = [
  /\bnew york\b/i,
  /\bbrooklyn\b/i,
  /\bqueens\b/i,
  /\bbronx\b/i,
  /\bstaten island\b/i,
  /\bmanhattan\b/i,
  /\blong island city\b/i,
  /\bridgewood\b/i,
  /\bnyc\b/i,
]

function isNycShow(city: string): boolean {
  const c = city.toLowerCase()
  // Require the NY region tag so we don't match same-named cities in
  // other states ("Brooklyn, OH"). BIT city strings look like
  // "Brooklyn, NY" / "New York, NY".
  if (!/,\s*ny\b/.test(c) && !/,\s*new york\b/.test(c)) return false
  return NYC_CITY_PATTERNS.some((p) => p.test(c))
}

function narrowShows(dates: TourDate[], now: Date): StoreShow[] {
  const horizon = now.getTime() + SHOW_WINDOW_DAYS * 86_400_000
  const out: StoreShow[] = []
  for (const d of dates) {
    const ts = Date.parse(d.date)
    if (isNaN(ts) || ts < now.getTime() || ts > horizon) continue
    if (!isNycShow(d.city)) continue
    out.push({ artist: d.artist, venue: d.venue, city: d.city, date: d.date, url: d.url })
  }
  // Already sorted asc by external.ts, but we filtered — keep it sorted.
  out.sort((a, b) => a.date.localeCompare(b.date))
  return out
}

function toPress(items: MusicNewsItem[]): PressItem[] {
  return items.map((i) => ({ source: i.source, title: i.title, url: i.link }))
}

function toReleases(items: UpcomingRelease[]): StoreRelease[] {
  return items.map((r) => ({ title: r.title, artist: r.artist, releaseDate: r.releaseDate }))
}

// ── Library artist ranking ───────────────────────────────────────────
//
// The show / upcoming-release feeds are scoped to artists the user
// actually owns. Rank by total play count so a 60-artist cap keeps the
// people Jake listens to most, not a random alphabetical slice.

export interface ArtistTrack {
  artist: string
  albumArtist?: string
  playCount?: number
}

/** Top library artists by total play count, most-played first.
 *  Single home for "which artists do we query the world about" so the
 *  Phase-1c orchestrator and the verification probe don't each grow a
 *  copy. */
export function topLibraryArtists(tracks: ArtistTrack[], limit = MAX_ARTISTS_FOR_FEEDS): string[] {
  const plays = new Map<string, number>()
  for (const t of tracks) {
    const artist = (t.albumArtist && t.albumArtist.trim()) || (t.artist || '').trim()
    if (!artist) continue
    plays.set(artist, (plays.get(artist) ?? 0) + (Number(t.playCount) || 0))
  }
  return Array.from(plays.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([artist]) => artist)
}

// ── Disk cache ───────────────────────────────────────────────────────

function contextPath(userDataDir: string): string {
  return join(recordStoreBaseDir(userDataDir), CONTEXT_FILE)
}

// ── Public entry point ───────────────────────────────────────────────

export interface GatherInput {
  /** Top library artist names, most-played first. Use topLibraryArtists(). */
  artists: string[]
  /** JakeTunes user-data dir, for the 6h disk cache. */
  userDataDir: string
  /** Bypass the 6h cache (the store's "knock to refresh" path). */
  forceRefresh?: boolean
  /** Injectable clock for tests; defaults to now. */
  now?: Date
}

/** Gather (or serve from 6h disk cache) the outside-world snapshot. */
export async function gatherExternalContext(input: GatherInput): Promise<ExternalContext> {
  const now = input.now ?? new Date()
  const file = contextPath(input.userDataDir)

  if (!input.forceRefresh) {
    const cached = await readJsonOrNull<ExternalContext>(file)
    if (cached && now.getTime() - cached.fetchedAt < CONTEXT_TTL_MS) {
      // Refresh the calendar block — the snapshot may have been written
      // this morning and read this evening; the part-of-day must track
      // the read, not the fetch. The feeds stay cached; only the cheap
      // local clock advances.
      return { ...cached, calendar: buildCalendar(now) }
    }
  }

  const artists = input.artists.slice(0, MAX_ARTISTS_FOR_FEEDS)

  // Fan out. Every fetcher in external.ts is fail-soft (returns []/null
  // on any error), so Promise.all never rejects here. allSettled would
  // be belt-and-suspenders but would also mask a real future regression
  // where a fetcher starts throwing — let it surface in dev instead.
  const [weather, lastFmChart, news, releases, tourDates, upcoming] = await Promise.all([
    getBrooklynWeather(),
    getLastFmNyChart(),
    getMusicNews(),
    getNotableReleases(),
    artists.length ? getTourDatesForArtists(artists) : Promise.resolve<TourDate[]>([]),
    artists.length ? getUpcomingReleasesForArtists(artists) : Promise.resolve<UpcomingRelease[]>([]),
  ])

  const ctx: ExternalContext = {
    fetchedAt: now.getTime(),
    calendar: buildCalendar(now),
    weather,
    lastFmChart,
    press: toPress(news).slice(0, 10),
    notableReleases: toPress(releases).slice(0, 8),
    shows: narrowShows(tourDates, now),
    upcomingReleases: toReleases(upcoming).slice(0, 12),
  }

  await atomicWriteJson(file, ctx).catch((err) => {
    // A cache-write failure must not fail the gather — we already have
    // the data in memory. Log and move on.
    console.warn('[record-store/external-context] cache write failed:', err)
  })

  return ctx
}

// ── Prompt formatting ────────────────────────────────────────────────
//
// Mirrors the format*ForPrompt helpers in external.ts: turn the
// snapshot into a compact text block the day-theme Sonnet call reads as
// TEXTURE, not a fact dump. Empty feeds contribute no lines, so a
// fully-offline gather yields just the calendar header.

export function formatExternalContextForPrompt(ctx: ExternalContext): string {
  const lines: string[] = []
  const { calendar: cal } = ctx

  lines.push(
    `Today is ${cal.dayOfWeek} ${cal.partOfDay.replace('-', ' ')}, ${cal.season}, in Brooklyn (${cal.dateISO}).`,
  )

  if (ctx.weather) {
    const desc = ctx.weather.description || ctx.weather.condition
    lines.push(`Weather: ${ctx.weather.tempF}°F, ${desc.toLowerCase()}.`)
  }

  if (ctx.shows.length) {
    lines.push('Library artists playing NYC in the next two weeks:')
    for (const s of ctx.shows.slice(0, 6)) {
      const when = s.date.slice(0, 10)
      lines.push(`  - ${s.artist} at ${s.venue}, ${s.city} (${when})`)
    }
  }

  if (ctx.upcomingReleases.length) {
    lines.push('Upcoming releases from artists in the library:')
    for (const r of ctx.upcomingReleases.slice(0, 6)) {
      lines.push(`  - ${r.artist} — ${r.title} (${r.releaseDate})`)
    }
  }

  if (ctx.lastFmChart.length) {
    lines.push(`Scrobbling in the US this week (Last.fm): ${ctx.lastFmChart.slice(0, 6).join(', ')}.`)
  }

  if (ctx.notableReleases.length) {
    lines.push('Pitchfork Best New Albums right now:')
    for (const p of ctx.notableReleases.slice(0, 4)) {
      lines.push(`  - ${p.title}`)
    }
  }

  if (ctx.press.length) {
    lines.push('Recent music-press headlines (use ONE as a hook only if it fits):')
    for (const p of ctx.press.slice(0, 5)) {
      lines.push(`  - [${p.source}] ${p.title}`)
    }
  }

  return lines.join('\n')
}
