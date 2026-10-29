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
 *
 * ⚠️ TWIN (shape): JakeTunesMobile ios/JakeTunesMobile/YearInReview.swift YirFacts — the phone decodes
 * the same nightly file (GET /api/year-in-review/:year). A field rename or
 * removal here breaks the phone; additions are safe.
 */
import type { Listen } from './listening-history.ts'
import { isTop25Rankable } from './top25-rankable.ts'
import { layerOf } from './genre-iceberg.ts'

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

/** A show he went to (JakeTunesMobile concerts, yir/concerts-attended.json — Mobile #648). */
export interface YirAttendedInput {
  artist?: string
  headliners?: string[] | string
  venue?: string
  neighbourhood?: string
  borough?: string
  date?: string
  setlist?: { songs?: Array<{ name?: string; encore?: boolean; cover?: boolean }> } | null
}

/** A show in the facts: who, where, when, and the first songs of its setlist. */
export interface YirShow { artist: string; venue: string; place: string; date: string; songs: string[] }

export interface YirInput {
  year: number
  listens: readonly Listen[]
  library: readonly YirTrack[]
  concerts?: readonly YirConcert[]
  mixtapes?: readonly YirMixtape[]
  attended?: readonly YirAttendedInput[]
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
    biggestDay: {
      date: string | null; plays: number; firstHour: number | null; lastHour: number | null
      /** That day's plays per local hour, and each hour's most-played song (the hour strip). */
      byHour?: number[]
      topByHour?: Array<{ artist: string; title: string } | null>
      /** That day's most-played song. */
      top?: { artist: string; title: string } | null
    }
  }
  /** Every day with music (local 'YYYY-MM-DD'): its plays and its most-played song (the
   *  streak's calendar of covers). */
  calendar?: Record<string, { plays: number; artist: string; title: string }>
  honesty: { skips: number; glances: number; mechanical: number; realSkipRate: number | null }
  topSongs: Ranked[]
  /** The song of the year's own best 7-day stretch ("seven of them in one
   *  week in July" comes from here, never from a guess). */
  songOfTheYearBestWeek: { plays: number; weekOf: string } | null
  topArtists: Ranked[]
  topAlbums: Ranked[]
  topGenres: Ranked[]
  months: Array<{ month: string; plays: number; topArtist: Ranked | null; topSong: Ranked | null }>
  clock: { byHour: number[]; byWeekday: number[] }
  /** Plays by genre-iceberg layer (genre-iceberg.ts layerOf, the song's
   *  current tag): [tip, just below, below, deep water, abyss]. offBerg =
   *  plays of genres not on the berg (Soundtrack, Comedy) or untagged. */
  depth: { layers: number[]; offBerg: number }
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
  /** Found through JakeTunes this year AND starred. */
  starredClass: { count: number; top: Ranked[] }
  concerts: Array<YirConcert & { plays: number }>
  mixtapes: YirMixtape[]
  /** How wide the year ran (Jake 10/29: "how do we show more variety?"): different artists and
   *  genres played, and the day that covered the most genres (ties: more artists, then earlier). */
  range: {
    artists: number
    genres: number
    widestDay: { date: string; genres: number; artists: number; plays: number } | null
  }
  /** The iPods (Jake 10/29: "it should brag that it does count the ipod"): plays recorded
   *  offline on any iPod and carried home on sync, the different songs, and the most played. The
   *  history does not say which iPod a play came from, so this is all of them together. */
  ipod?: { plays: number; songs: number; top: Ranked[] }
  /** Every show he went to this year, oldest first (absent until the attended file exists). */
  attended?: YirShow[]
  /** The Top 1000 chapter. NOT built here: homemini's backend measures it next to the quiz
   *  model it grades (JakeTunesMobile backend/src/util/top1000Review.ts) and folds it into
   *  these facts as it serves them (GET /api/year-in-review/:year). Absent in the nightly
   *  file and its NAS copy; the story and the page leave the chapter out without it. */
  top1000?: Top1000Review
}

/** Calls the model made before seeing the answer, and how many his answer agreed with. */
export interface Top1000Tally { n: number; called: number }

/**
 * The Top 1000 chapter as homemini serves it.
 * ⚠️ TWIN (shape): JakeTunesMobile backend/src/util/top1000Review.ts (Top1000Proof,
 * Top1000Variety) + routes/top1000.ts Top1000Chapter; ios/JakeTunesMobile/YearInReview.swift.
 */
export interface Top1000Review {
  builtAt: string
  /** the model's confidence in today's 1000, 0–1 */
  sure: number
  proof: {
    /** songs in the running */
    pool?: number
    answers: number
    decisions: number
    songsJudged: number
    heats: number
    duels: number
    calls: Top1000Tally
    headToHead: Top1000Tally
    sureCalls: Top1000Tally
    heatCalls: Top1000Tally & { chance: number }
    tasteAlone: Top1000Tally
    overruled: number
    rechecks: { n: number; same: number }
    firstAnswer: string | null
    lastAnswer: string | null
  }
  variety: {
    seats: number
    artists: number
    topArtists: Array<{ name: string; seats: number }>
    brackets: number
    bracketsTotal: number
    genres: number
    decades: Array<{ decade: string; seats: number }>
    oldest: { title: string; artist: string; year: number } | null
    newest: { title: string; artist: string; year: number } | null
    numberOne: { title: string; artist: string } | null
    /** The top seats in rank order (the cover wall). */
    wall?: Array<{ title: string; artist: string }>
    /** Every seat by rank, as its artist's index in topArtists (-1 = anyone else): the seat map. */
    seatArtists?: number[]
    bracketChampions: Array<{ bracket: string; seats: number; title: string; artist: string; rank: number }>
  }
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

/** The most-played entry of a count map (first seen wins a tie: Map keeps insertion order). */
function topOf<T extends { n: number }>(m: Map<string, T> | undefined): T | null {
  let best: T | null = null
  for (const v of m?.values() ?? []) if (!best || v.n > best.n) best = v
  return best
}

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
  const depthLayers = [0, 0, 0, 0, 0]
  let offBerg = 0
  const byWeekday = new Array<number>(7).fill(0)
  const byDevice: Record<string, number> = {}
  const daySongs = new Map<string, Map<string, { artist: string; title: string; n: number }>>()
  const ipodSongs = new Map<string, Ranked>()
  let ipodPlays = 0
  const dayArtists = new Map<string, Set<string>>()
  const dayGenres = new Map<string, Set<string>>()
  const rangeGenres = new Set<string>()
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
    // The play counts everywhere; a song under a minute just can't hold a
    // ranked slot (Jake's Top 25 rule, applied to every ranking 10/11).
    const rankable = isTop25Rankable({ duration: dur })
    if (rankable) bump(songs, songKey, () => ({ name: l.title, artist: artistName, plays: 0 }), min)
    if (l.device === 'ipod') {
      ipodPlays++
      if (rankable) bump(ipodSongs, songKey, () => ({ name: l.title, artist: artistName, plays: 0 }))
    }
    if (artistName) bump(artists, norm(artistName), () => ({ name: artistName, plays: 0 }), min)
    const album = l.album || t?.album || ''
    if (album) bump(albums, `${norm(t?.albumArtist || artistName)}|${norm(album)}`, () => ({ name: album, artist: t?.albumArtist || artistName, plays: 0 }), min)
    const genre = l.genre || t?.genre || ''
    if (genre) bump(genres, norm(genre), () => ({ name: genre, plays: 0 }), min)
    // The berg is drawn from each song's CURRENT tag (Jake 10/11: "against
    // what each song is currently marked as"), so depth reads that first;
    // the logged genre is the play-time tag, often a retired broad one.
    const layer = layerOf(t?.genre || genre)
    if (layer === null) offBerg++
    else depthLayers[layer]++
    monthCount.set(lp.month, (monthCount.get(lp.month) ?? 0) + 1)
    if (!monthArtists.has(lp.month)) { monthArtists.set(lp.month, new Map()); monthSongs.set(lp.month, new Map()) }
    if (artistName) bump(monthArtists.get(lp.month)!, norm(artistName), () => ({ name: artistName, plays: 0 }))
    if (rankable) bump(monthSongs.get(lp.month)!, songKey, () => ({ name: l.title, artist: artistName, plays: 0 }))
    days.set(lp.date, (days.get(lp.date) ?? 0) + 1)
    if (rankable) {
      const m = daySongs.get(lp.date) ?? new Map<string, { artist: string; title: string; n: number }>()
      const e = m.get(songKey) ?? { artist: artistName, title: l.title, n: 0 }
      e.n++
      m.set(songKey, e)
      daySongs.set(lp.date, m)
    }
    if (artistName) { const set = dayArtists.get(lp.date) ?? new Set<string>(); set.add(norm(artistName)); dayArtists.set(lp.date, set) }
    // Range counts the song's CURRENT tag, as the berg does (the logged one is often a retired broad tag).
    const tag = t?.genre || genre
    if (tag) { rangeGenres.add(norm(tag)); const set = dayGenres.get(lp.date) ?? new Set<string>(); set.add(norm(tag)); dayGenres.set(lp.date, set) }
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
  const bdHours = new Array<number>(24).fill(0)
  const bdHourSongs = Array.from({ length: 24 }, () => new Map<string, { artist: string; title: string; n: number }>())
  for (const l of plays) {
    const p = localParts(l.ts)
    if (p.date !== biggestDay.date) continue
    if (biggestDay.firstHour === null) biggestDay.firstHour = p.hour
    biggestDay.lastHour = p.hour
    bdHours[p.hour]++
    const t = l.trackId !== undefined ? byId.get(l.trackId) : undefined
    if (!isTop25Rankable({ duration: t?.duration })) continue
    const k = `${norm(l.artist)}|${norm(l.title)}`
    const e = bdHourSongs[p.hour].get(k) ?? { artist: l.artist || t?.artist || '', title: l.title, n: 0 }
    e.n++
    bdHourSongs[p.hour].set(k, e)
  }
  if (biggestDay.date) {
    biggestDay.byHour = bdHours
    biggestDay.topByHour = bdHourSongs.map((m) => { const b = topOf(m); return b ? { artist: b.artist, title: b.title } : null })
    const d = topOf(daySongs.get(biggestDay.date))
    biggestDay.top = d ? { artist: d.artist, title: d.title } : null
  }

  // The widest day: the most genres in one day; more artists, then the earlier day, break ties.
  let widestDay: YearInReview['range']['widestDay'] = null
  for (const d of dayList) {
    const g = dayGenres.get(d)?.size ?? 0, a = dayArtists.get(d)?.size ?? 0
    if (g === 0) continue
    if (!widestDay || g > widestDay.genres || (g === widestDay.genres && a > widestDay.artists)) widestDay = { date: d, genres: g, artists: a, plays: days.get(d) ?? 0 }
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

  const topSongs = rank(songs, top)
  let songOfTheYearBestWeek: YearInReview['songOfTheYearBestWeek'] = null
  const sotyPlays = topSongs[0] ? perSong.get(`${norm(topSongs[0].artist)}|${norm(topSongs[0].name)}`) ?? [] : []
  for (let hi = 0, lo = 0; hi < sotyPlays.length; hi++) {
    while (Date.parse(sotyPlays[hi].ts) - Date.parse(sotyPlays[lo].ts) > 7 * dayMs) lo++
    if (!songOfTheYearBestWeek || hi - lo + 1 > songOfTheYearBestWeek.plays) songOfTheYearBestWeek = { plays: hi - lo + 1, weekOf: localParts(sotyPlays[lo].ts).date }
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

  // Starred class: found this year and starred. JakeTunes' star is binary
  // (StarRating.tsx, 4.5.2): any rating > 0 reads as starred, same as the
  // Starred playlist. Jake 10/12: "you either get a star or you dont".
  const starred = input.library.filter((t) => (t.rating ?? 0) > 0 && isFound(t))
  // "The ones you came back to most" is a ranking, so a song under a minute
  // never takes a slot (Jake 10/11: nothing under 1 minute in ANY ranking).
  // It used to sink to the bottom with 0 plays instead; now it is dropped.
  // The count above is a tally of starred finds, not a ranking, and keeps it.
  const starredTop = starred
    .filter((t) => isTop25Rankable(t))
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
    topSongs,
    songOfTheYearBestWeek,
    topArtists: rank(artists, top),
    topAlbums: rank(albums, Math.min(top, 10)),
    topGenres: rank(genres, 10),
    months: monthsWithPlays.map((m) => ({ month: m, plays: monthCount.get(m) ?? 0, topArtist: rank(monthArtists.get(m)!, 1)[0] ?? null, topSong: rank(monthSongs.get(m)!, 1)[0] ?? null })),
    clock: { byHour, byWeekday },
    depth: { layers: depthLayers, offBerg },
    firstPlay: plays[0] ? { ts: plays[0].ts, artist: plays[0].artist, title: plays[0].title } : null,
    onRepeat,
    discoveries: { newArtists: newArtists.slice(0, top), newArtistCount: newArtists.length, foundByMonth, foundTotal },
    starredClass: { count: starred.length, top: starredTop },
    concerts,
    mixtapes,
    range: { artists: artists.size, genres: rangeGenres.size, widestDay },
    ipod: { plays: ipodPlays, songs: ipodSongs.size, top: rank(ipodSongs, 9) },
    attended: (input.attended ?? [])
      .filter((a) => typeof a.date === 'string' && a.date.startsWith(String(year)))
      .map((a) => ({
        artist: (a.artist || (Array.isArray(a.headliners) ? a.headliners[0] : a.headliners) || '').trim(),
        venue: (a.venue ?? '').trim(),
        place: [a.neighbourhood, a.borough].filter(Boolean).join(', '),
        date: a.date!.slice(0, 10),
        songs: (a.setlist?.songs ?? []).map((x) => (x.name ?? '').trim()).filter(Boolean).slice(0, 5),
      }))
      .filter((a) => a.artist)
      .sort((a, b) => a.date.localeCompare(b.date)),
    calendar: Object.fromEntries(dayList.map((d) => { const b = topOf(daySongs.get(d)); return [d, { plays: days.get(d) ?? 0, artist: b?.artist ?? '', title: b?.title ?? '' }] })),
  }
}
