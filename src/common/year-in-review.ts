/**
 * Year in Review — the facts (2026-10-10; Jake: "ensure that year in review
 * 2026 is going to be a hit", delivered every December 17th).
 *
 * Class A only: facts read straight from the plays and the library — no
 * brain, no embeddings, no model guessing (docs/brain-improvement-2026h2.md,
 * "two trust classes"). Every fact carries the evidence it stands on, and the
 * coverage block says plainly which months the history does not reach, so
 * the Review never passes off a partial year as a whole one.
 *
 * Built on the one listening history (listening-history.ts): plays only —
 * skips, glances and mechanical bursts never count toward a top list.
 * Calendar facts (days, hours, weekdays) are in Jake's zone, America/New_York.
 *
 * Pure: no I/O. scripts/year-in-review.mts feeds it the files.
 */
import type { Listen } from './listening-history.ts'

export const YIR_TIME_ZONE = 'America/New_York'

export interface YirTrack {
  id: number
  title?: string
  artist?: string
  albumArtist?: string
  album?: string
  genre?: string
  duration?: number
  dateAdded?: string
  rating?: number
  /** How the song arrived: a store source ('streamrip' | 'bandcamp' |
   *  'squid') means it was found through JakeTunes; empty = the old
   *  collection being imported. */
  source?: string
}

/** Acquisitions made through JakeTunes itself. dateAdded alone cannot mean
 *  "discovered": 2026 is the year the whole collection moved into JakeTunes
 *  (2,190 imports in April, 2,129 more in May), so nearly every song carries
 *  a 2026 add date. The source field is what tells a find from a move. */
export const FOUND_SOURCES: ReadonlySet<string> = new Set(['streamrip', 'bandcamp', 'squid'])

export interface YirConcert {
  artist: string
  album: string
  createdAt?: string
  venue?: string
  city?: string
  date?: string
  notes?: string
  mergedTrackId?: number
}

export interface YirMixtape { title: string; createdAt?: string; songs: number }

export interface YirInput {
  year: number
  listens: readonly Listen[]
  library: readonly YirTrack[]
  concerts?: readonly YirConcert[]
  mixtapes?: readonly YirMixtape[]
  top?: number
}

export interface Ranked { name: string; artist?: string; plays: number; minutes?: number }

export interface YearInReview {
  year: number
  coverage: {
    firstListen: string | null
    lastListen: string | null
    /** Months (01–12) with at least one play. */
    monthsWithPlays: string[]
    /** Months before the first play — not in any JakeTunes log. */
    monthsBeforeHistory: string[]
    playsByDevice: Record<string, number>
  }
  totals: {
    plays: number
    minutes: number
    /** Plays whose song length is known (minutes cover only these). */
    minutesKnownFor: number
    daysListened: number
    longestStreak: { days: number; from: string | null; to: string | null }
    /** The busiest calendar day, with its first and last play (local hour).
     *  A 255-play day is the music never stopping, not 255 choices, so the
     *  span travels with the count and the page can say which it was. */
    biggestDay: { date: string | null; plays: number; firstHour: number | null; lastHour: number | null }
  }
  honesty: { skips: number; glances: number; mechanical: number; realSkipRate: number | null }
  topSongs: Ranked[]
  topArtists: Ranked[]
  topAlbums: Ranked[]
  topGenres: Ranked[]
  months: Array<{ month: string; plays: number; topArtist: Ranked | null; topSong: Ranked | null }>
  clock: { byHour: number[]; byWeekday: number[] }
  firstPlay: { ts: string; artist: string; title: string } | null
  /** The most plays one song got inside any 7-day stretch. */
  onRepeat: { artist: string; title: string; plays: number; weekOf: string } | null
  discoveries: {
    /** Artists who entered the library through a JakeTunes find this year
     *  (their earliest library song is store-sourced and dated this year). */
    newArtists: Ranked[]
    newArtistCount: number
    /** Songs found through JakeTunes this year, by month. */
    foundByMonth: Record<string, number>
    foundTotal: number
  }
  /** Found through JakeTunes this year AND rated 4+ stars. */
  starredClass: { count: number; top: Ranked[] }
  concerts: Array<YirConcert & { plays: number }>
  mixtapes: YirMixtape[]
}

const dateParts = new Intl.DateTimeFormat('en-CA', { timeZone: YIR_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short' })
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Local calendar parts of an instant in Jake's zone. */
export function localParts(iso: string): { year: number; month: string; date: string; hour: number; weekday: number } {
  const p = Object.fromEntries(dateParts.formatToParts(new Date(iso)).map((x) => [x.type, x.value]))
  return { year: Number(p.year), month: p.month, date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, weekday: WEEKDAYS.indexOf(p.weekday) }
}

const norm = (s: string | undefined): string => (s || '').toLowerCase().trim()
const dayMs = 86400000
const dayIndex = (date: string): number => Date.parse(`${date}T00:00:00Z`) / dayMs

function rank(counts: Map<string, Ranked>, top: number): Ranked[] {
  return [...counts.values()].sort((a, b) => b.plays - a.plays || (b.minutes ?? 0) - (a.minutes ?? 0)).slice(0, top)
}
function bump(map: Map<string, Ranked>, key: string, init: () => Ranked, minutes = 0): void {
  const r = map.get(key) ?? init()
  r.plays++
  if (minutes) r.minutes = (r.minutes ?? 0) + minutes
  map.set(key, r)
}

export function buildYearInReview(input: YirInput): YearInReview {
  const { year } = input
  const top = input.top ?? 25
  const byId = new Map(input.library.map((t) => [t.id, t]))
  const inYear = input.listens.filter((l) => localParts(l.ts).year === year)
  const plays = inYear.filter((l) => l.kind === 'play').sort((a, b) => a.ts.localeCompare(b.ts))

  const songs = new Map<string, Ranked>()
  const artists = new Map<string, Ranked>()
  const albums = new Map<string, Ranked>()
  const genres = new Map<string, Ranked>()
  const monthCount = new Map<string, number>()
  const monthArtists = new Map<string, Map<string, Ranked>>()
  const monthSongs = new Map<string, Map<string, Ranked>>()
  const days = new Map<string, number>()
  const byHour = new Array<number>(24).fill(0)
  const byWeekday = new Array<number>(7).fill(0)
  const byDevice: Record<string, number> = {}
  let minutes = 0
  let known = 0

  for (const l of plays) {
    const t = l.trackId !== undefined ? byId.get(l.trackId) : undefined
    const dur = t?.duration
    const min = dur && dur > 0 ? (dur * l.pct) / 100 / 60000 : 0
    if (min) { minutes += min; known++ }
    const lp = localParts(l.ts)
    const songKey = `${norm(l.artist)}|${norm(l.title)}`
    const artistName = l.artist || t?.artist || ''
    bump(songs, songKey, () => ({ name: l.title, artist: artistName, plays: 0 }), min)
    if (artistName) bump(artists, norm(artistName), () => ({ name: artistName, plays: 0 }), min)
    const album = l.album || t?.album || ''
    if (album) bump(albums, `${norm(t?.albumArtist || artistName)}|${norm(album)}`, () => ({ name: album, artist: t?.albumArtist || artistName, plays: 0 }), min)
    const genre = l.genre || t?.genre || ''
    if (genre) bump(genres, norm(genre), () => ({ name: genre, plays: 0 }), min)
    monthCount.set(lp.month, (monthCount.get(lp.month) ?? 0) + 1)
    if (!monthArtists.has(lp.month)) { monthArtists.set(lp.month, new Map()); monthSongs.set(lp.month, new Map()) }
    if (artistName) bump(monthArtists.get(lp.month)!, norm(artistName), () => ({ name: artistName, plays: 0 }))
    bump(monthSongs.get(lp.month)!, songKey, () => ({ name: l.title, artist: artistName, plays: 0 }))
    days.set(lp.date, (days.get(lp.date) ?? 0) + 1)
    byHour[lp.hour]++
    byWeekday[lp.weekday]++
    byDevice[l.device] = (byDevice[l.device] ?? 0) + 1
  }

  // Longest run of consecutive listening days, and the single biggest day.
  const dayList = [...days.keys()].sort()
  let best = { days: 0, from: null as string | null, to: null as string | null }
  let runStart = 0
  for (let i = 0; i < dayList.length; i++) {
    if (i > 0 && dayIndex(dayList[i]) - dayIndex(dayList[i - 1]) !== 1) runStart = i
    const len = i - runStart + 1
    if (len > best.days) best = { days: len, from: dayList[runStart], to: dayList[i] }
  }
  let biggestDay: YearInReview['totals']['biggestDay'] = { date: null, plays: 0, firstHour: null, lastHour: null }
  for (const [d, n] of days) if (n > biggestDay.plays || (n === biggestDay.plays && biggestDay.date !== null && d < biggestDay.date)) biggestDay = { date: d, plays: n, firstHour: null, lastHour: null }
  for (const l of plays) {
    const p = localParts(l.ts)
    if (p.date !== biggestDay.date) continue
    if (biggestDay.firstHour === null) biggestDay.firstHour = p.hour
    biggestDay.lastHour = p.hour
  }

  // One song's best 7-day stretch.
  let onRepeat: YearInReview['onRepeat'] = null
  const perSong = new Map<string, Listen[]>()
  for (const l of plays) {
    const k = `${norm(l.artist)}|${norm(l.title)}`
    const arr = perSong.get(k) ?? []
    arr.push(l)
    perSong.set(k, arr)
  }
  for (const list of perSong.values()) {
    let lo = 0
    for (let hi = 0; hi < list.length; hi++) {
      while (Date.parse(list[hi].ts) - Date.parse(list[lo].ts) > 7 * dayMs) lo++
      const n = hi - lo + 1
      if (!onRepeat || n > onRepeat.plays) onRepeat = { artist: list[hi].artist, title: list[hi].title, plays: n, weekOf: localParts(list[lo].ts).date }
    }
  }

  // Discoveries: what came INTO the library through JakeTunes this year.
  const isFound = (t: YirTrack): boolean => FOUND_SOURCES.has(t.source ?? '') && !!t.dateAdded && localParts(t.dateAdded).year === year
  const earliest = new Map<string, YirTrack>()
  const foundByMonth: Record<string, number> = {}
  let foundTotal = 0
  for (const t of input.library) {
    if (!t.dateAdded || !Number.isFinite(Date.parse(t.dateAdded))) continue
    const a = norm(t.albumArtist || t.artist)
    const prev = earliest.get(a)
    if (!prev || t.dateAdded < prev.dateAdded!) earliest.set(a, t)
    if (isFound(t)) {
      const m = localParts(t.dateAdded).month
      foundByMonth[m] = (foundByMonth[m] ?? 0) + 1
      foundTotal++
    }
  }
  const newArtistKeys = new Set([...earliest.entries()].filter(([, t]) => isFound(t)).map(([a]) => a))
  const newArtists = [...newArtistKeys].map((k) => artists.get(k) ?? { name: earliest.get(k)!.albumArtist || earliest.get(k)!.artist || k, plays: 0 })
    .sort((a, b) => b.plays - a.plays)

  // Starred class: found this year and rated 4+.
  const starred = input.library.filter((t) => (t.rating ?? 0) >= 4 && isFound(t))
  const starredTop = starred
    .map((t) => ({ name: t.title || '', artist: t.artist || '', plays: songs.get(`${norm(t.artist)}|${norm(t.title)}`)?.plays ?? 0 }))
    .sort((a, b) => b.plays - a.plays)
    .slice(0, top)

  const concerts = (input.concerts ?? [])
    .filter((c) => c.createdAt && localParts(c.createdAt).year === year)
    .map((c) => ({ ...c, plays: c.mergedTrackId === undefined ? 0 : plays.filter((l) => l.trackId === c.mergedTrackId).length }))
  const mixtapes = (input.mixtapes ?? []).filter((m) => m.createdAt && localParts(m.createdAt).year === year)

  const monthsWithPlays = [...monthCount.keys()].sort()
  const firstMonth = plays.length ? localParts(plays[0].ts).month : null
  const monthsBeforeHistory = firstMonth ? Array.from({ length: Number(firstMonth) - 1 }, (_, i) => String(i + 1).padStart(2, '0')) : []
  const verdicts = plays.length + inYear.filter((l) => l.kind === 'skip').length

  return {
    year,
    coverage: { firstListen: plays[0]?.ts ?? null, lastListen: plays.at(-1)?.ts ?? null, monthsWithPlays, monthsBeforeHistory, playsByDevice: byDevice },
    totals: { plays: plays.length, minutes: Math.round(minutes), minutesKnownFor: known, daysListened: days.size, longestStreak: best, biggestDay },
    honesty: {
      skips: inYear.filter((l) => l.kind === 'skip').length,
      glances: inYear.filter((l) => l.kind === 'glance').length,
      mechanical: inYear.filter((l) => l.kind === 'mechanical').length,
      realSkipRate: verdicts ? Math.round((inYear.filter((l) => l.kind === 'skip').length / verdicts) * 10000) / 10000 : null,
    },
    topSongs: rank(songs, top),
    topArtists: rank(artists, top),
    topAlbums: rank(albums, Math.min(top, 10)),
    topGenres: rank(genres, 10),
    months: monthsWithPlays.map((m) => ({ month: m, plays: monthCount.get(m) ?? 0, topArtist: rank(monthArtists.get(m)!, 1)[0] ?? null, topSong: rank(monthSongs.get(m)!, 1)[0] ?? null })),
    clock: { byHour, byWeekday },
    firstPlay: plays[0] ? { ts: plays[0].ts, artist: plays[0].artist, title: plays[0].title } : null,
    onRepeat,
    discoveries: { newArtists: newArtists.slice(0, top), newArtistCount: newArtists.length, foundByMonth, foundTotal },
    starredClass: { count: starred.length, top: starredTop },
    concerts,
    mixtapes,
  }
}
