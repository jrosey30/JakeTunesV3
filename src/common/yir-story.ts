/**
 * Year in Review story slides (2026-10-12, Jake: "build it"): the cards for
 * the December 17 reveal, written from the facts (year-in-review.ts) and
 * nothing else. Every sentence is a count or a date the facts carry; a card
 * whose fact is missing is left out rather than filled with a guess.
 *
 * Before December 17 the story is "so far"; from the 17th it is the reveal.
 * Pure: the renderer resolves images and playback (YirStory.tsx).
 *
 * ⚠️ TWIN: JakeTunesMobile ios/JakeTunesMobile/YirStory.swift — the phone's story, a line-for-line
 * port (same cards, order, words and Dec 17 gate). Its YirStoryTests compare
 * every card to this file's output for the test fixture; change both together.
 */
import { localParts, YIR_TIME_ZONE, type YearInReview, type Ranked } from './year-in-review.ts'

export type StoryImage =
  | { kind: 'song'; artist: string; title: string }
  | { kind: 'album'; artist: string; album: string }
  | { kind: 'artist'; name: string }
  | { kind: 'concert'; albumKey: string; band: string; show: string }

export type StoryPlay = { kind: 'song'; artist: string; title: string } | { kind: 'album'; artist: string; album: string }

export interface StoryRow { name: string; sub: string; plays: number; image: StoryImage; play?: StoryPlay }

/** One device's share of the plays (the "where the plays happened" card). */
export interface DeviceRow { name: string; plays: number; pct: number }

/** The best-ranked Top 1000 song of one genre bracket; `rank` is its place in the whole 1000. */
export interface ChampionRow { bracket: string; title: string; artist: string; rank: number; image: StoryImage; play: StoryPlay }

/** One picture in a card's visual (a cover or an artist photo); a song's tile plays it. */
export interface Tile { image: StoryImage; play?: StoryPlay; label?: string; hot?: boolean }

/** A card's picture, built from his own covers and photos wherever it can be (Jake 10/29:
 *  "too many words not enough visuals"; "more music and artist visuals and album"). */
export type Viz =
  /** A grid of covers or photos (the cover collage, the keepers, the wall), genre chips optional. */
  | { kind: 'mosaic'; tiles: Tile[]; chips?: string[]; round?: boolean }
  /** One day, hour by hour: each bar topped by that hour's most-played cover. */
  | { kind: 'hours'; bars: Array<{ hour: number; plays: number; tile: Tile | null }> }
  /** Plays by hour of the day and by weekday, the busiest of each lit. */
  | { kind: 'clock'; hours: number[]; weekdays: number[]; hotHour: number; hotDay: number }
  /** A run of days, each shown as that day's most-played cover. */
  | { kind: 'calendar'; days: Array<{ date: string; tile: Tile | null }> }
  /** The Top 1000 as a flow: heats → one-on-ones → genre brackets → finals → the 1,000. */
  | { kind: 'pipeline'; steps: Array<{ value: string; label: string; tiles: Tile[] }> }
  /** Shows he went to: the poster (or the artist's photo), where and when, a few setlist songs. */
  | { kind: 'shows'; items: Array<{ image: StoryImage; artist: string; where: string; songs: Tile[] }> }
  /** Dials: the model when sure vs plays and stars alone. */
  | { kind: 'gauges'; items: Array<{ pct: number; label: string; lead: boolean }> }
  /** The seat map: every seat by rank, colored by its artist (legend index; -1 = anyone else),
   *  the artist of the year's seats lit. */
  | { kind: 'seats'; cells: number[]; legend: Array<{ name: string; seats: number; hot: boolean }> }

export type Slide =
  | { kind: 'cover'; eyebrow: string; year: number; line: string; stats: Array<[string, string]>; tiles: Tile[] }
  | { kind: 'art'; eyebrow: string; big: string; line: string; image: StoryImage; play?: StoryPlay; poster?: boolean; vinyl?: boolean }
  | { kind: 'list'; eyebrow: string; rows: StoryRow[]; firstRank: number; play?: StoryPlay }
  | { kind: 'lanes'; eyebrow: string; big: string; rows: StoryRow[]; line: string }
  | { kind: 'number'; eyebrow: string; big: string; line: string; viz?: Viz; play?: StoryPlay }
  | { kind: 'iceberg'; eyebrow: string; big: string; layers: number[]; line: string }
  | { kind: 'devices'; eyebrow: string; big: string; rows: DeviceRow[]; line: string }
  | { kind: 'champions'; eyebrow: string; big: string; rows: ChampionRow[]; line: string; play?: StoryPlay }
  | { kind: 'end'; eyebrow: string; big: string; line: string; viz?: Viz }

/** The song or record a card plays when it opens (every card that features a song). */
export function slidePlay(s: Slide): StoryPlay | undefined {
  return 'play' in s ? s.play : undefined
}

/** A declared concert, as the renderer's live-sets store knows it. */
export interface StoryConcert { albumKey: string; band: string; show: string; venue?: string; date?: string; notes?: string; poster?: string }

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const WORDS = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve']

export const n = (v: number): string => v.toLocaleString('en-US')
/** 'YYYY-MM-DD' → 'June 3' (calendar date, no zone math). */
export function dayName(date: string): string {
  const [, m, d] = date.split('-').map(Number)
  return `${MONTHS[m - 1]} ${d}`
}
export function hour12(h: number): string {
  if (h === 0) return 'midnight'
  if (h === 12) return 'noon'
  return `${h % 12} ${h < 12 ? 'AM' : 'PM'}`
}
/** The plays log's device keys, as the card names them. */
export const DEVICE_NAMES: Record<string, string> = { workmini: 'workmini', laptop: 'Laptop', ipod: 'iPods', phone: 'Phone' }
export const deviceName = (key: string): string => DEVICE_NAMES[key] ?? key
/** Whole percent of a total, rounded like Math.round. */
export const pctOf = (v: number, total: number): number => (total > 0 ? Math.round((100 * v) / total) : 0)
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)
const hours = (r: Ranked): number => Math.round((r.minutes ?? 0) / 60)
const argMax = (a: number[]): number => a.reduce((best, v, i) => (v > a[best] ? i : best), 0)

/** The reveal is December 17 (Jake's birthday), local midnight. */
export function isRevealed(year: number, now: Date): boolean {
  return now.getTime() >= new Date(year, 11, 17).getTime()
}

const time = new Intl.DateTimeFormat('en-US', { timeZone: YIR_TIME_ZONE, hour: 'numeric', minute: '2-digit' })

function race(top: Ranked[]): { big: string; line: string } {
  const [a, b, c] = top
  if (!b) return { big: `${a.name}.`, line: `${n(a.plays)} plays and ${hours(a)} hours.` }
  const close = (x: Ranked): boolean => (a.plays - x.plays) / a.plays <= 0.03
  const big = c && close(c) ? 'A three-way photo finish.' : close(b) ? 'A photo finish.' : `${a.name}.`
  if (big === `${a.name}.`) return { big, line: `${n(a.plays)} plays and ${hours(a)} hours, ${n(a.plays - b.plays)} plays clear of ${b.name}.` }
  const field = top.slice(0, c && close(c) ? 3 : 2)
  const byTime = [...field].sort((x, y) => (y.minutes ?? 0) - (x.minutes ?? 0))
  if (byTime[0] === a) return { big, line: `Tiebreak on time: ${a.name}, ${hours(a)} hours to ${hours(byTime[1])}.` }
  return { big, line: `${a.name} on plays, ${byTime[0].name} on time: ${hours(byTime[0])} hours to ${hours(a)}.` }
}

/** Devices by plays, most first, each with its whole-percent share. */
export function deviceRows(byDevice: Record<string, number>): DeviceRow[] {
  const total = Object.values(byDevice).reduce((a, b) => a + b, 0)
  return Object.entries(byDevice)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, v]) => ({ name: deviceName(k), plays: v, pct: pctOf(v, total) }))
}

const fold = (s: string | undefined): string => (s ?? '').trim().toLowerCase()
const pct1 = (v: number, total: number): string => (total > 0 ? ((100 * v) / total).toFixed(1) : '0.0')

/** The seat map: the five biggest artists keep their own color, plus the artist of the year if
 *  it isn't one of them; everyone else is one quiet color. */
function seatsViz(V: NonNullable<YearInReview['top1000']>['variety'], aoty: string | undefined): Viz | undefined {
  const cells = V.seatArtists
  if (!cells?.length) return undefined
  const keep = V.topArtists.map((a, i) => ({ ...a, i })).filter((a, k) => k < 5 || (!!aoty && fold(a.name) === fold(aoty)))
  const at = new Map(keep.map((a, k) => [a.i, k]))
  return {
    kind: 'seats',
    cells: cells.map((c) => at.get(c) ?? -1),
    legend: keep.map((a) => ({ name: a.name, seats: a.seats, hot: !!aoty && fold(a.name) === fold(aoty) })),
  }
}

/** Tiles with the most faces first: one per artist in order, then the rest (so a Geese-heavy
 *  list still shows the range). */
export function varied(tiles: Tile[], k: number): Tile[] {
  const who = (t: Tile): string => (t.image.kind === 'song' || t.image.kind === 'album' ? t.image.artist : t.image.kind === 'artist' ? t.image.name : '').trim().toLowerCase()
  const seen = new Set<string>(), first: Tile[] = [], rest: Tile[] = []
  for (const t of tiles) (seen.has(who(t)) ? rest : (seen.add(who(t)), first)).push(t)
  return [...first, ...rest].slice(0, k)
}

const song = (artist: string, title: string): { image: StoryImage; play: StoryPlay } =>
  ({ image: { kind: 'song', artist, title }, play: { kind: 'song', artist, title } })
const songTile = (artist: string, title: string, label?: string): Tile => ({ ...song(artist, title), ...(label ? { label } : {}) })
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** The days from `from` to `to` inclusive ('YYYY-MM-DD', calendar arithmetic only). */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = []
  for (let t = Date.parse(`${from}T12:00:00Z`); t <= Date.parse(`${to}T12:00:00Z`); t += 86400000) out.push(new Date(t).toISOString().slice(0, 10))
  return out
}

/** The Top 1000 chapter's cards (Jake 10/29: "show off that this algorithm I made works and
 *  works elite"). Every number is homemini's measurement (top1000Review.ts); a card whose
 *  numbers are missing is left out. */
function top1000Cards(y: YearInReview): Slide[] {
  const c = y.top1000
  if (!c || c.proof.answers <= 0) return []
  const P = c.proof, V = c.variety
  const wall = V.wall ?? []
  const wallTiles = (from: number, k: number): Tile[] => wall.slice(from, from + k).map((w) => songTile(w.artist, w.title))
  const champs = V.bracketChampions.slice(0, 5)
  const one = V.numberOne ? song(V.numberOne.artist, V.numberOne.title).play : undefined
  const out: Slide[] = []
  out.push({
    kind: 'number', eyebrow: 'The Top 1000', big: 'An algorithm you built.',
    line: P.pool ? `A tournament over ${n(P.pool)} of your songs.` : 'A tournament over your whole library.',
    viz: { kind: 'pipeline', steps: [
      { value: n(P.heats), label: 'heats', tiles: wallTiles(20, 3) },
      { value: n(P.duels), label: 'one-on-ones', tiles: wallTiles(10, 2) },
      { value: n(V.bracketsTotal), label: 'genre brackets', tiles: champs.slice(2, 4).map((ch) => songTile(ch.artist, ch.title, ch.bracket)) },
      { value: 'Finals', label: 'champions duel', tiles: champs.slice(0, 2).map((ch) => songTile(ch.artist, ch.title, ch.bracket)) },
      { value: n(V.seats || 1000), label: 'seats', tiles: wallTiles(0, 1) },
    ] },
    play: one,
  })
  if (P.headToHead.n > 0) {
    const h2h = pctOf(P.headToHead.called, P.headToHead.n)
    const sure = P.sureCalls.n > 0 ? pctOf(P.sureCalls.called, P.sureCalls.n) : null
    const taste = P.tasteAlone.n > 0 ? pctOf(P.tasteAlone.called, P.tasteAlone.n) : null
    const items = [{ pct: sure ?? h2h, label: sure !== null ? 'When it was sure' : 'Called in advance', lead: true }]
    if (taste !== null) items.push({ pct: taste, label: 'Plays and stars alone', lead: false })
    out.push({
      kind: 'number', eyebrow: 'Does it work?',
      big: sure !== null ? `${sure}% right when it was sure.` : `${h2h}% called in advance.`,
      line: taste !== null ? `Plays and stars alone: ${taste}%.` : `${n(P.answers)} answers, every one called first.`,
      viz: { kind: 'gauges', items },
    })
  }
  if (V.seats > 0 && V.topArtists.length > 0) {
    const leader = V.topArtists[0]
    const aoty = y.topArtists[0]?.name
    const mine = aoty ? V.topArtists.find((a) => fold(a.name) === fold(aoty)) : undefined
    const line = mine && fold(mine.name) !== fold(leader.name)
      ? `${mine.name}: ${n(mine.seats)} seats. ${leader.name}: ${n(leader.seats)}. No monopoly.`
      : `Most seats: ${leader.name}, ${n(leader.seats)}.`
    out.push({
      kind: 'number', eyebrow: 'Who holds a seat', big: `${n(V.artists)} artists made the cut.`, line,
      viz: seatsViz(V, mine?.name) ?? (wall.length ? { kind: 'mosaic', tiles: wallTiles(0, 48) } : undefined),
    })
  }
  if (champs.length >= 2) {
    const k = WORDS[champs.length] ?? n(champs.length)
    out.push({
      kind: 'champions', eyebrow: 'Number one, everywhere', big: `${k} genres, ${k.toLowerCase()} number ones.`,
      rows: champs.map((ch) => ({ bracket: ch.bracket, title: ch.title, artist: ch.artist, rank: ch.rank, ...song(ch.artist, ch.title) })),
      line: V.numberOne ? `#1 overall: ${V.numberOne.title}, ${V.numberOne.artist}.` : '',
      play: song(champs[0].artist, champs[0].title).play,
    })
  }
  out.push({
    kind: 'number', eyebrow: 'Why it matters', big: 'Earned, not placed.',
    line: `${Math.round(c.sure * 100)}% sure. Nobody paid for a seat.`,
    viz: wall.length ? { kind: 'mosaic', tiles: wallTiles(0, 48) } : undefined,
    play: wall[0] ? song(wall[0].artist, wall[0].title).play : undefined,
  })
  return out
}

export function buildStory(y: YearInReview, opts: { now: Date; concerts?: StoryConcert[] }): Slide[] {
  const revealed = isRevealed(y.year, opts.now)
  const T = y.totals
  const slides: Slide[] = []

  const startedLate = y.coverage.monthsBeforeHistory.length > 0 && y.coverage.firstListen
  const since = startedLate ? `, since ${dayName(localParts(y.coverage.firstListen!).date)}` : ''
  slides.push({
    kind: 'cover', eyebrow: 'JakeTunes · Year in Review', year: y.year,
    line: revealed ? `Your year${since}. None of it rented.` : `So far${since}. None of it rented.`,
    stats: [[n(T.plays), 'songs played'], [n(Math.round(T.minutes / 60)), 'hours of music'], [n(T.daysListened), 'days with music']],
    tiles: y.topAlbums.slice(0, 8).map((a) => ({ image: { kind: 'album', artist: a.artist ?? '', album: a.name }, play: { kind: 'album', artist: a.artist ?? '', album: a.name } })),
  })

  // Where it started: only when the log reaches back to the start of the year (Jake 10/22).
  if (y.firstPlay && !startedLate) {
    const p = localParts(y.firstPlay.ts)
    slides.push({
      kind: 'art', eyebrow: 'Where it started', big: y.firstPlay.title,
      line: `${y.firstPlay.artist} · ${WEEKDAYS[p.weekday]}, ${dayName(p.date)} at ${time.format(new Date(y.firstPlay.ts))}`,
      ...song(y.firstPlay.artist, y.firstPlay.title),
    })
  }

  const soty = y.topSongs[0]
  if (soty) {
    const wk = y.songOfTheYearBestWeek
    const week = wk && wk.plays >= 3 ? ` ${WORDS[wk.plays] ?? n(wk.plays)} in one ${MONTHS[Number(wk.weekOf.slice(5, 7)) - 1]} week.` : ''
    slides.push({ kind: 'art', eyebrow: 'Your song of the year', big: soty.name, line: `${soty.artist} · ${n(soty.plays)} plays.${week}`, ...song(soty.artist ?? '', soty.name) })
  }
  if (y.topSongs.length > 1) {
    const rows = y.topSongs.slice(1, 5).map((s) => ({ name: s.name, sub: s.artist ?? '', plays: s.plays, ...song(s.artist ?? '', s.name) }))
    slides.push({ kind: 'list', eyebrow: `The rest of the top ${Math.min(5, y.topSongs.length)}`, firstRank: 2, rows, play: rows[0].play })
  }

  if (y.topArtists[0]) {
    const top = y.topArtists.slice(0, 3)
    const { big, line } = race(top)
    slides.push({
      kind: 'lanes', eyebrow: 'Your artist of the year', big, line,
      rows: top.map((a) => ({ name: a.name, sub: `${n(a.plays)} plays · ${hours(a)} hours`, plays: a.plays, image: { kind: 'artist', name: a.name } })),
    })
  }

  const album = y.topAlbums[0]
  if (album) {
    slides.push({
      kind: 'art', eyebrow: 'Record of the year', big: album.name, line: `${album.artist ?? ''} · ${n(album.plays)} plays. Yours to keep.`,
      image: { kind: 'album', artist: album.artist ?? '', album: album.name },
      play: { kind: 'album', artist: album.artist ?? '', album: album.name }, vinyl: true,
    })
  }

  // Where the plays happened: his own machines, one library (out of the skips — the skips are gone).
  const devices = deviceRows(y.coverage.playsByDevice ?? {})
  if (devices.length >= 2) {
    const k = devices.length
    const ipod = devices.find((d) => d.name === DEVICE_NAMES.ipod)
    slides.push({
      kind: 'devices', eyebrow: 'Where the plays happened', big: `${WORDS[k] ?? n(k)} devices. One library you own.`, rows: devices,
      line: ipod ? `iPods: ${n(ipod.plays)} play${ipod.plays === 1 ? '' : 's'}. No signal. No subscription.` : `${devices[0].name} played ${devices[0].pct}%.`,
    })
  }

  const bd = T.biggestDay
  if (bd.date && bd.firstHour !== null && bd.lastHour !== null) {
    const bars = (bd.byHour ?? []).map((plays, hour) => {
      const t = bd.topByHour?.[hour]
      return { hour, plays, tile: t ? songTile(t.artist, t.title) : null }
    })
    slides.push({
      kind: 'number', eyebrow: 'The day it never stopped', big: dayName(bd.date),
      line: `${n(bd.plays)} songs, ${hour12(bd.firstHour)} to ${hour12(bd.lastHour)}. Zero ads.`,
      viz: bars.length === 24 ? { kind: 'hours', bars } : undefined,
      play: bd.top ? song(bd.top.artist, bd.top.title).play : undefined,
    })
  }

  // Busiest hour and busiest weekday are measured separately, so the card says them separately.
  if (T.plays > 0) {
    const h = argMax(y.clock.byHour), d = argMax(y.clock.byWeekday)
    slides.push({
      kind: 'number', eyebrow: 'When you listen', big: `${cap(hour12(h))}. ${WEEKDAYS[d]}s.`, line: 'Your hour. Your day.',
      viz: { kind: 'clock', hours: y.clock.byHour, weekdays: y.clock.byWeekday, hotHour: h, hotDay: d },
    })
  }

  const st = T.longestStreak
  if (st.days >= 2 && st.from && st.to) {
    const days = daysBetween(st.from, st.to).map((date) => {
      const c = y.calendar?.[date]
      return { date, tile: c?.title ? songTile(c.artist, c.title) : null }
    })
    // The streak's song: the one that topped the most of its days.
    const count = new Map<string, { t: Tile; n: number }>()
    for (const d of days) if (d.tile?.play?.kind === 'song') { const k = `${d.tile.play.artist}|${d.tile.play.title}`; const e = count.get(k) ?? { t: d.tile, n: 0 }; e.n++; count.set(k, e) }
    const best = [...count.values()].sort((a, b) => b.n - a.n)[0]
    const [, fm, fd] = st.from.split('-').map(Number), [, tm, td] = st.to.split('-').map(Number)
    slides.push({
      kind: 'number', eyebrow: 'Longest streak', big: `${n(st.days)} days straight.`,
      line: `${MONTH_SHORT[fm - 1]} ${fd} – ${MONTH_SHORT[tm - 1]} ${td}. No reminder needed.`,
      viz: y.calendar ? { kind: 'calendar', days } : undefined,
      play: best?.t.play,
    })
  }

  const layers = y.depth?.layers
  const onBerg = layers ? layers.reduce((s, v) => s + v, 0) : 0
  if (layers && onBerg > 0) {
    const below = Math.round((100 * (layers[2] + layers[3] + layers[4])) / onBerg)
    const deep = Math.round((100 * (layers[3] + layers[4])) / onBerg)
    slides.push({
      kind: 'iceberg', eyebrow: 'How deep you went', big: below >= 40 && below < 50 ? 'Almost half went deep.' : `${below}% went deep.`, layers,
      line: `${below}% from Below or deeper. ${deep}% from the deep.`,
    })
  }

  // Range (Jake 10/29: "how do we show more variety?"): what the year covered, and its widest day.
  const R = y.range
  if (R && R.artists > 0 && R.genres > 0) {
    const wd = R.widestDay
    slides.push({
      kind: 'number', eyebrow: 'Range', big: `${n(R.artists)} artists. ${n(R.genres)} genres.`,
      line: wd ? `Widest day: ${dayName(wd.date)}, ${n(wd.genres)} genres. Zero paid placements.` : 'Zero paid placements.',
      viz: { kind: 'mosaic', round: true, tiles: y.topArtists.slice(0, 12).map((a) => ({ image: { kind: 'artist', name: a.name } })), chips: y.topGenres.slice(0, 6).map((g) => g.name) },
    })
  }

  // Live: every show he went to this year (the concerts tracker's attended list, Mobile #648),
  // poster when he made one, else the artist's photo, with a few songs of the setlist. Before that
  // list exists: the shows he declared with a recording, poster first, as before.
  const shows = y.attended ?? []
  if (shows.length) {
    // His recording of that show, when there is one: same band, same year, same month.
    const poster = (artist: string, date: string): StoryConcert | undefined => (opts.concerts ?? []).find((c) =>
      fold(c.band) === fold(artist) && !!c.date && c.date.includes(String(y.year)) && c.date.includes(MONTHS[Number(date.slice(5, 7)) - 1] ?? '-'))
    const items = shows.slice(-6).reverse().map((sh) => {
      const p = poster(sh.artist, sh.date)
      const [, m, d] = sh.date.split('-').map(Number)
      return {
        image: p ? { kind: 'concert' as const, albumKey: p.albumKey, band: p.band, show: p.show } : { kind: 'artist' as const, name: sh.artist },
        artist: sh.artist,
        where: [sh.venue, m && d ? `${MONTH_SHORT[m - 1]} ${d}` : ''].filter(Boolean).join(' · '),
        songs: sh.songs.slice(0, 3).map((t) => songTile(sh.artist, t)),
      }
    })
    const lastShow = shows[shows.length - 1]
    slides.push({
      kind: 'number', eyebrow: `Live in ${y.year}`,
      big: shows.length === 1 ? `${lastShow.artist}. You were there.` : `${WORDS[shows.length] ?? n(shows.length)} shows. You were there.`,
      line: shows.length === 1 ? `${lastShow.venue}, ${dayName(lastShow.date)}.` : `Last: ${lastShow.artist}, ${dayName(lastShow.date)}.`,
      viz: { kind: 'shows', items },
      play: items.flatMap((it) => it.songs)[0]?.play,
    })
  } else {
    const live = (opts.concerts ?? []).filter((c) => c.date?.includes(String(y.year)))
    for (const c of live.slice(0, 2)) {
      slides.push({
        kind: 'art', eyebrow: `Live in ${y.year}`, big: c.venue ? `${c.band} at ${c.venue}.` : `${c.band}.`, poster: true,
        line: [c.date ? `${c.date}.` : '', c.notes ? `“${c.notes.trim()}”` : ''].filter(Boolean).join(' '),
        image: { kind: 'concert', albumKey: c.albumKey, band: c.band, show: c.show },
      })
    }
  }

  const disc = y.discoveries
  if (disc.newArtists.length > 0) {
    slides.push({
      kind: 'lanes', eyebrow: 'Artists you found this year', big: `${n(disc.newArtistCount)} new artist${disc.newArtistCount === 1 ? '' : 's'}.`,
      line: 'Found by you, not fed to you.',
      rows: disc.newArtists.slice(0, 3).map((a) => ({ name: a.name, sub: `${n(a.plays)} plays`, plays: a.plays, image: { kind: 'artist', name: a.name } })),
    })
  }
  if (y.starredClass.count > 0) {
    const tiles = varied(y.starredClass.top.map((s) => songTile(s.artist ?? '', s.name)), 12)
    slides.push({
      kind: 'number', eyebrow: 'The keepers', big: `${n(y.starredClass.count)} starred find${y.starredClass.count === 1 ? '' : 's'}.`,
      line: 'No expiring license can take them back.',
      viz: tiles.length ? { kind: 'mosaic', tiles } : undefined,
      play: tiles[0]?.play,
    })
  }

  slides.push(...top1000Cards(y))

  const finale: Viz | undefined = y.topSongs.length ? { kind: 'mosaic', tiles: varied(y.topSongs.map((s) => songTile(s.artist ?? '', s.name)), 16) } : undefined
  slides.push(revealed
    ? { kind: 'end', eyebrow: 'Happy birthday', big: `That was ${y.year}.`, line: 'Real plays. Music you own.', viz: finale }
    : { kind: 'end', eyebrow: 'December 17', big: `The rest of ${y.year} is still being written.`, line: 'The final cut drops on your birthday.', viz: finale })
  return slides
}
