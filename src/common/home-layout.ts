/**
 * The desktop Home's layout (V7, 2026-11-24 — Jake's approved design, the
 * "Desktop Home, after" mock). The Home used to be ~16 rows; now it is:
 *
 *   1. Tonight on JakeTunes   one album: cover, title, artist · year, one line
 *                             tying it to an upcoming show when there is one,
 *                             one Music Man line, ▶ Play and Shuffle
 *   2. three shelves          Listen more, On repeat, Recently added (See All)
 *   3. Shows                  upcoming shows / "Were you there?"
 *
 * Year in Review joins the Home in December only (after the hero), the month
 * the reveal lands. Everything else that was on the Home moved, never deleted:
 * MOVED_OFF_HOME says where, and a test holds each destination to a real door.
 *
 * Phone twin in spirit (the "V7 and Mobile V3 stay aligned" rule): the phone's
 * new Home is hero → one For you rail → Tonight → Listening Room.
 *
 * Pure: no DOM, no React — main, renderer and tests share it.
 */
import { nameKey } from './fold-text.ts'

/** A Home section, top to bottom. */
export type HomeSection = 'welcome' | 'hero' | 'year-in-review' | 'shelves' | 'shows'

export interface HomeLayoutInput {
  now: Date
  /** No songs at all: the welcome (import / Record Shop) instead of everything else. */
  libraryEmpty: boolean
  /** Shows the Shows band would draw: upcoming plus "you'd like this" (HomeShows). */
  shows: number
}

const NY = 'America/New_York'

/** The month (1–12) in New York, where Jake is and the Year in Review's clock runs. */
export function nyMonth(now: Date): number {
  const m = new Intl.DateTimeFormat('en-US', { timeZone: NY, month: 'numeric' }).format(now)
  return Number(m)
}

/** Year in Review is on the Home in December only (Jake, V7: "Year in Review on Home only in December"). */
export function yearInReviewOnHome(now: Date): boolean {
  return nyMonth(now) === 12
}

/**
 * Which sections the Home draws, in order. Each one may still draw nothing
 * when its own data is empty: the hero with no album, a shelf with no songs,
 * the Year in Review card before this Mac has the year's facts. This decides
 * what is ALLOWED on the Home; nothing outside this list is.
 */
export function homeSections(i: HomeLayoutInput): HomeSection[] {
  if (i.libraryEmpty) return ['welcome']
  const out: HomeSection[] = ['hero']
  if (yearInReviewOnHome(i.now)) out.push('year-in-review')
  out.push('shelves')
  if (i.shows > 0) out.push('shows')
  return out
}

/**
 * Where each thing that left the Home lives now. `door` is how you get there:
 * a sidebar row (its label) or a tab. Nothing here was deleted.
 */
export const MOVED_OFF_HOME = {
  'island-albums': { to: 'made-for-you', door: 'sidebar: Made for You', note: 'the Cover Flow and its jewel case (the editable shelf stays on Albums)' },
  'now-digging': { to: 'made-for-you', door: 'sidebar: Made for You', note: 'new bands you can’t stop playing, last 30 days' },
  'daily-mixes': { to: 'made-for-you', door: 'sidebar: Made for You', note: 'today’s tapes, your mixes, Make me a vibe' },
  'listening-quote': { to: 'made-for-you', door: 'sidebar: Made for You', note: 'the Music Man’s line about your listening' },
  'rediscover': { to: 'made-for-you', door: 'sidebar: Made for You', note: 'owned artists you’ve overlooked' },
  'year-in-review': { to: 'made-for-you', door: 'sidebar: Made for You', note: 'the card, all year; on the Home too in December' },
  'todays-pick': { to: 'home', door: 'the hero', note: 'the hero’s album when there is no album you’re living in' },
  'new-this-week': { to: 'discovery', door: 'Record Shop › News', note: 'Pitchfork’s best new albums, with previews' },
  'on-the-horizon': { to: 'discovery', door: 'Record Shop › News', note: 'upcoming releases by your artists' },
  'music-news': { to: 'discovery', door: 'Record Shop › News', note: 'headlines, your artists first' },
} as const

export type MovedFeature = keyof typeof MOVED_OFF_HOME

// ── the hero's show line ───────────────────────────────────────────────

/** The bits of a concerts feed item the hero needs (common/concerts-feed.ts ConcertItem). */
export interface HeroShow {
  /** New York YYYY-MM-DD of the run's next night. */
  date: string
  venue: string
  artists: readonly string[]
  headliners?: readonly string[]
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "2026-12-05" → "Dec 5" (a calendar day: never handed to Date, which would read it as UTC). */
export function shortDay(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd)
  if (!m) return ymd
  return `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}`
}

/**
 * The hero's line about a show: the soonest show on or after `today` (New
 * York YYYY-MM-DD) whose bill names the hero's artist — "Live at Brooklyn
 * Paramount, Dec 5". Null when there is none; the hero never invents one.
 */
export function heroShowLine(artist: string, shows: readonly HeroShow[], today: string): string | null {
  const key = nameKey(artist)
  if (!key) return null
  let best: HeroShow | null = null
  for (const s of shows) {
    if (!s.date || s.date < today || !s.venue) continue
    const names = [...s.artists, ...(s.headliners ?? [])]
    if (!names.some((n) => nameKey(n) === key)) continue
    if (!best || s.date < best.date) best = s
  }
  return best ? `Live at ${best.venue}, ${shortDay(best.date)}` : null
}

/** "Geese · 2025", or the artist alone when the year is unknown. */
export function heroByline(artist: string, year: string | number | null | undefined): string {
  const y = typeof year === 'number' ? (year > 0 ? String(year) : '') : String(year ?? '').trim()
  return /^\d{4}$/.test(y) ? `${artist} · ${y}` : artist
}
