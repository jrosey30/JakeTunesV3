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
 * the reveal lands, and Music News is one line under Shows (the phone's
 * Tonight news line). What left the Home is MOVED_OFF_HOME (a test holds each
 * one to a real door); what the plan cut is CUT_FROM_HOME.
 *
 * Phone twin in spirit (the "V7 and Mobile V3 stay aligned" rule): the phone's
 * new Home is hero → one For you rail → Tonight → Listening Room.
 *
 * Pure: no DOM, no React — main, renderer and tests share it.
 */
import { nameKey } from './fold-text.ts'

/** A Home section, top to bottom. */
export type HomeSection = 'welcome' | 'hero' | 'year-in-review' | 'shelves' | 'shows' | 'news'

export interface HomeLayoutInput {
  now: Date
  /** No songs at all: the welcome (import / Record Shop) instead of everything else. */
  libraryEmpty: boolean
  /** Shows the Shows band would draw: upcoming plus "you'd like this" (HomeShows). */
  shows: number
  /** Music News headlines (the one line under Shows, the phone's Tonight news line). */
  news: number
}

const NY = 'America/New_York'
/** Made once: building an Intl.DateTimeFormat is slow, and the Home asks on every render. */
const NY_MONTH = new Intl.DateTimeFormat('en-US', { timeZone: NY, month: 'numeric' })

/** The month (1–12) in New York, where Jake is and the Year in Review's clock runs. */
export function nyMonth(now: Date): number {
  return Number(NY_MONTH.format(now))
}

/** Year in Review is on the Home in December only (Jake, V7: "Year in Review on Home only in December"). */
export function yearInReviewOnHome(now: Date): boolean {
  return nyMonth(now) === 12
}

/** Where closing the Year in Review goes when there is no page to go back to:
 *  the Home in December (where its card is), Made for You the rest of the year. */
export function yearInReviewHomeView(now: Date): 'home' | 'made-for-you' {
  return yearInReviewOnHome(now) ? 'home' : 'made-for-you'
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
  if (i.news > 0) out.push('news')
  return out
}

/**
 * Where each thing that left the Home lives now (the approved V7 plan). `door`
 * is how you get there: a sidebar row, a shop tab, or the Home's own news line.
 */
export const MOVED_OFF_HOME = {
  'island-albums': { to: 'made-for-you', door: 'sidebar: Made for You', note: 'the Cover Flow and its jewel case (the editable shelf stays on Albums)' },
  'now-digging': { to: 'made-for-you', door: 'sidebar: Made for You', note: 'new bands you can’t stop playing, last 30 days' },
  'daily-mixes': { to: 'made-for-you', door: 'sidebar: Made for You', note: 'today’s tapes, your mixes, Make me a vibe' },
  'year-in-review': { to: 'made-for-you', door: 'sidebar: Made for You', note: 'the card, all year; on the Home too in December' },
  'new-this-week': { to: 'discovery', door: 'Record Shop › For You, at the top', note: 'Pitchfork’s best new albums, with previews' },
  'on-the-horizon': { to: 'discovery', door: 'Record Shop › For You, at the top', note: 'upcoming releases by your artists' },
  'music-news': { to: 'music-news', door: 'the Home’s news line › See All', note: 'headlines, your artists first' },
} as const

export type MovedFeature = keyof typeof MOVED_OFF_HOME

/** What the V7 plan cut outright. Their data still feeds other pages
 *  (Rediscover's picks the shop's For You, the listening facts the Artists
 *  page), but they are no longer drawn as their own bands anywhere. */
export const CUT_FROM_HOME = ['todays-pick', 'rediscover', 'listening-quote'] as const

// ── the hero's album ───────────────────────────────────────────────────

/**
 * The hero's fallback when there is no album you're living in: the album with
 * the most songs on On Repeat (ties: the one that comes first). `albumKeys` is
 * On Repeat's songs, in order, as album keys. Null for an empty list.
 */
export function topOnRepeatAlbum(albumKeys: readonly string[]): string | null {
  const count = new Map<string, number>()
  for (const k of albumKeys) if (k) count.set(k, (count.get(k) ?? 0) + 1)
  let best: string | null = null
  let bestN = 0
  for (const [k, n] of count) if (n > bestN) { best = k; bestN = n }   // Map keeps first-seen order: ties stay with the earlier
  return best
}

/** How long the hero holds its space waiting for an answer before drawing what it has. */
export const HERO_HOLD_MS = 1500

export type HeroChoice =
  | { kind: 'hold' }
  | { kind: 'living' }
  | { kind: 'on-repeat'; albumKey: string }
  | { kind: 'none' }

/**
 * Which album the hero draws, without ever flashing one and swapping it for
 * another on launch: the album you're living in wins; until homemini (or this
 * Mac's fallback) has answered, the hero holds its space, empty; after that,
 * On Repeat's top album; else nothing. `onRepeat` null = not known yet.
 * After HERO_HOLD_MS it stops waiting and draws what it has.
 */
export function heroChoice(i: { answered: boolean; living: boolean; onRepeat: readonly string[] | null; waitedMs: number }): HeroChoice {
  if (i.living) return { kind: 'living' }
  const patient = i.waitedMs < HERO_HOLD_MS
  if (!i.answered && patient) return { kind: 'hold' }
  if (i.onRepeat === null && patient) return { kind: 'hold' }
  const top = i.onRepeat ? topOnRepeatAlbum(i.onRepeat) : null
  return top ? { kind: 'on-repeat', albumKey: top } : { kind: 'none' }
}

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
