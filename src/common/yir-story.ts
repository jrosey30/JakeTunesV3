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

/** The best-ranked Top 1000 song of one genre bracket. */
export interface ChampionRow { bracket: string; title: string; artist: string; rank: number; image: StoryImage; play: StoryPlay }

export type Slide =
  | { kind: 'cover'; eyebrow: string; year: number; line: string; stats: Array<[string, string]>; note?: string }
  | { kind: 'art'; eyebrow: string; big: string; line: string; image: StoryImage; play?: StoryPlay; poster?: boolean }
  | { kind: 'list'; eyebrow: string; rows: StoryRow[]; firstRank: number }
  | { kind: 'lanes'; eyebrow: string; big: string; rows: StoryRow[]; line: string }
  | { kind: 'number'; eyebrow: string; big: string; line: string }
  | { kind: 'iceberg'; eyebrow: string; big: string; layers: number[]; line: string }
  | { kind: 'devices'; eyebrow: string; big: string; rows: DeviceRow[]; line: string }
  | { kind: 'stats'; eyebrow: string; big: string; stats: Array<[string, string]>; line: string }
  | { kind: 'champions'; eyebrow: string; big: string; rows: ChampionRow[]; line: string }
  | { kind: 'end'; eyebrow: string; big: string; line: string }

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

/** The Top 1000 chapter's cards (Jake 10/29: "show off that this algorithm I made works and
 *  works elite"). Every number is homemini's measurement (top1000Review.ts); a card whose
 *  numbers are missing is left out. */
function top1000Cards(y: YearInReview): Slide[] {
  const c = y.top1000
  if (!c || c.proof.answers <= 0) return []
  const P = c.proof, V = c.variety
  const out: Slide[] = []
  out.push({
    kind: 'number', eyebrow: 'The Top 1000', big: 'An algorithm you built.',
    line: `A tournament over ${P.pool ? `${n(P.pool)} of your songs` : 'your whole library'}: heats, one-on-one duels, genre brackets, then finals between the champions. A brain learns from your plays, stars and skips, plus how famous each song is, and guesses your answer before you give it.`,
  })
  if (P.headToHead.n > 0) {
    const h2h = pctOf(P.headToHead.called, P.headToHead.n)
    const sure = P.sureCalls.n > 0 ? pctOf(P.sureCalls.called, P.sureCalls.n) : null
    const taste = P.tasteAlone.n > 0 ? pctOf(P.tasteAlone.called, P.tasteAlone.n) : null
    out.push({
      kind: 'stats', eyebrow: 'Does it work?',
      big: sure !== null ? `${sure}% right when it was sure.` : `${h2h}% called in advance.`,
      stats: [[n(P.answers), 'answers you gave'], [n(P.songsJudged), 'songs judged'], [`${h2h}%`, 'one-on-ones called before you answered']],
      line: [
        taste !== null ? `Plays and stars alone would call ${taste}% of them.` : '',
        P.overruled > 0 ? `You overruled it ${n(P.overruled)} times. It took notes.` : '',
      ].filter(Boolean).join(' '),
    })
  }
  if (V.seats > 0 && V.topArtists.length > 0) {
    const leader = V.topArtists[0]
    const aoty = y.topArtists[0]?.name
    const mine = aoty ? V.topArtists.find((a) => fold(a.name) === fold(aoty)) : undefined
    const span = V.oldest && V.newest && V.oldest.year !== V.newest.year ? `${V.oldest.year}–${V.newest.year}` : ''
    const stats: Array<[string, string]> = [[`${V.brackets} of ${V.bracketsTotal}`, 'genre brackets with a seat']]
    if (span) stats.push([span, 'oldest seat to newest'])
    if (V.decades.length > 1) stats.push([n(V.decades.length), 'decades'])
    let line: string
    if (mine && fold(mine.name) !== fold(leader.name)) line = `Artist of the year ${mine.name}? ${n(mine.seats)} seats, ${pct1(mine.seats, V.seats)}% of the ${n(V.seats)}. ${leader.name}? ${n(leader.seats)}. Love isn't a monopoly.`
    else if (mine) line = `Most seats: ${leader.name}, ${n(leader.seats)} of the ${n(V.seats)}.${V.topArtists[1] ? ` Then ${V.topArtists[1].name}, ${n(V.topArtists[1].seats)}.` : ''}`
    else line = `Most seats: ${leader.name}, ${n(leader.seats)} of the ${n(V.seats)}. Nobody else comes close to a monopoly.`
    out.push({ kind: 'stats', eyebrow: 'Who holds a seat', big: `${n(V.artists)} artists made the cut.`, stats, line })
  }
  const champs = V.bracketChampions.slice(0, 5)
  if (champs.length >= 2) {
    const k = WORDS[champs.length] ?? n(champs.length)
    out.push({
      kind: 'champions', eyebrow: 'Number one, everywhere', big: `${k} genres, ${k.toLowerCase()} number ones.`,
      rows: champs.map((ch) => ({
        bracket: ch.bracket, title: ch.title, artist: ch.artist, rank: ch.rank,
        image: { kind: 'song', artist: ch.artist, title: ch.title }, play: { kind: 'song', artist: ch.artist, title: ch.title },
      })),
      line: V.numberOne ? `And number one of all ${n(V.seats)}: ${V.numberOne.title}, ${V.numberOne.artist}.` : '',
    })
  }
  out.push({
    kind: 'number', eyebrow: 'Why it matters', big: 'Earned, not placed.',
    line: `Every seat was won answer by answer, and nobody paid for one. Today it is ${Math.round(c.sure * 100)}% sure of all ${n(V.seats || 1000)}, and they help pick what rides on your Original iPod.`,
  })
  return out
}

export function buildStory(y: YearInReview, opts: { now: Date; concerts?: StoryConcert[] }): Slide[] {
  const revealed = isRevealed(y.year, opts.now)
  const T = y.totals
  const slides: Slide[] = []

  const startedLate = y.coverage.monthsBeforeHistory.length > 0 && y.coverage.firstListen
  slides.push({
    kind: 'cover', eyebrow: 'JakeTunes · Year in Review', year: y.year,
    line: revealed ? 'Your year in music. None of it rented.' : 'So far. None of it rented.',
    stats: [[n(T.plays), 'songs played'], [n(Math.round(T.minutes / 60)), 'hours of music'], [n(T.daysListened), 'days with music']],
    note: startedLate ? `Since ${dayName(localParts(y.coverage.firstListen!).date)}, the day JakeTunes started keeping score.` : undefined,
  })

  // Where it started: only when the log reaches back to the start of the
  // year. When JakeTunes began keeping score mid-year (startedLate), the
  // first logged play is just the first thing the log caught, not where the
  // year started (Jake 10/22: "Illegal being on the year in review makes no
  // sense to me"). firstPlay stays in the facts; it is honest data.
  if (y.firstPlay && !startedLate) {
    const p = localParts(y.firstPlay.ts)
    slides.push({
      kind: 'art', eyebrow: 'Where it started', big: y.firstPlay.title,
      line: `${y.firstPlay.artist} · ${WEEKDAYS[p.weekday]}, ${dayName(p.date)} at ${time.format(new Date(y.firstPlay.ts))}`,
      image: { kind: 'song', artist: y.firstPlay.artist, title: y.firstPlay.title },
      play: { kind: 'song', artist: y.firstPlay.artist, title: y.firstPlay.title },
    })
  }

  const soty = y.topSongs[0]
  if (soty) {
    const wk = y.songOfTheYearBestWeek
    const week = wk && wk.plays >= 3 ? ` ${WORDS[wk.plays] ?? n(wk.plays)} of them in one week in ${MONTHS[Number(wk.weekOf.slice(5, 7)) - 1]}.` : ''
    slides.push({
      kind: 'art', eyebrow: 'Your song of the year', big: soty.name,
      line: `${soty.artist} · ${n(soty.plays)} times.${week}`,
      image: { kind: 'song', artist: soty.artist ?? '', title: soty.name },
      play: { kind: 'song', artist: soty.artist ?? '', title: soty.name },
    })
  }
  if (y.topSongs.length > 1) {
    slides.push({
      kind: 'list', eyebrow: `The rest of the top ${Math.min(5, y.topSongs.length)}`, firstRank: 2,
      rows: y.topSongs.slice(1, 5).map((s) => ({
        name: s.name, sub: s.artist ?? '', plays: s.plays,
        image: { kind: 'song', artist: s.artist ?? '', title: s.name }, play: { kind: 'song', artist: s.artist ?? '', title: s.name },
      })),
    })
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
      play: { kind: 'album', artist: album.artist ?? '', album: album.name },
    })
  }

  // Where the plays happened: his own machines, one library (Jake 10/29: keep the split, out
  // of the skips — the skips are gone).
  const devices = deviceRows(y.coverage.playsByDevice ?? {})
  if (devices.length >= 2) {
    const k = devices.length
    const ipod = devices.find((d) => d.name === DEVICE_NAMES.ipod)
    slides.push({
      kind: 'devices', eyebrow: 'Where the plays happened', big: `${WORDS[k] ?? n(k)} devices. One library you own.`, rows: devices,
      line: `${devices[0].name} played ${devices[0].pct}% of it.${ipod ? ` The iPods logged ${n(ipod.plays)} play${ipod.plays === 1 ? '' : 's'} with no signal and no subscription.` : ''}`,
    })
  }

  const bd = T.biggestDay
  if (bd.date && bd.firstHour !== null && bd.lastHour !== null) {
    slides.push({ kind: 'number', eyebrow: 'The day it never stopped', big: dayName(bd.date), line: `${n(bd.plays)} songs, from ${hour12(bd.firstHour)} to ${hour12(bd.lastHour)}. Zero ad breaks.` })
  }

  // Busiest hour and busiest weekday are measured separately, so the card
  // says them separately (never "noon on Thursdays" as if it were one peak).
  if (T.plays > 0) {
    const h = argMax(y.clock.byHour), d = argMax(y.clock.byWeekday)
    slides.push({ kind: 'number', eyebrow: 'When you listen', big: `${cap(hour12(h))}. ${WEEKDAYS[d]}s.`, line: 'Your busiest hour of the day, and your busiest day of the week.' })
  }

  const st = T.longestStreak
  if (st.days >= 2 && st.from && st.to) {
    slides.push({ kind: 'number', eyebrow: 'Longest streak', big: `${n(st.days)} days`, line: `${dayName(st.from)} to ${dayName(st.to)} without a day off. Nobody had to send you a reminder.` })
  }

  const layers = y.depth?.layers
  const onBerg = layers ? layers.reduce((s, v) => s + v, 0) : 0
  if (layers && onBerg > 0) {
    const below = Math.round((100 * (layers[2] + layers[3] + layers[4])) / onBerg)
    const deep = Math.round((100 * (layers[3] + layers[4])) / onBerg)
    slides.push({
      kind: 'iceberg', eyebrow: 'How deep you went', big: below >= 40 && below < 50 ? 'Almost half went deep.' : `${below}% went deep.`, layers,
      line: `${below}% of your plays came from genres at "Below" or deeper on your genre iceberg. ${deep}% from deep water and the abyss.`,
    })
  }

  // Range (Jake 10/29: "how do we show more variety?"): what the year covered, and its widest day.
  const R = y.range
  if (R && R.artists > 0 && R.genres > 0) {
    const wd = R.widestDay
    slides.push({
      kind: 'number', eyebrow: 'Range', big: `${n(R.artists)} artists. ${n(R.genres)} genres.`,
      line: wd ? `Your widest day was ${dayName(wd.date)}: ${n(wd.artists)} artists across ${n(wd.genres)} genres. No label paid to be on it.` : 'No label paid to be on any of it.',
    })
  }

  // Shows that happened this year (the concert's own date), poster first.
  const live = (opts.concerts ?? []).filter((c) => c.date?.includes(String(y.year)))
  for (const c of live.slice(0, 2)) {
    slides.push({
      kind: 'art', eyebrow: `Live in ${y.year}`, big: c.venue ? `${c.band} at ${c.venue}.` : `${c.band}.`, poster: true,
      line: [c.date ? `${c.date}.` : '', c.notes ? `“${c.notes.trim()}”` : ''].filter(Boolean).join(' '),
      image: { kind: 'concert', albumKey: c.albumKey, band: c.band, show: c.show },
    })
  }

  const disc = y.discoveries
  if (disc.newArtists.length > 0) {
    slides.push({
      kind: 'lanes', eyebrow: 'Artists you found this year', big: `${n(disc.newArtistCount)} new artist${disc.newArtistCount === 1 ? '' : 's'}.`,
      line: `${disc.newArtists.length >= 3 ? 'Your three most played of them.' : 'Your most played of them.'} Found by you, not fed to you.`,
      rows: disc.newArtists.slice(0, 3).map((a) => ({ name: a.name, sub: `${n(a.plays)} plays`, plays: a.plays, image: { kind: 'artist', name: a.name } })),
    })
  }
  if (y.starredClass.count > 0) {
    slides.push({ kind: 'number', eyebrow: 'The keepers', big: n(y.starredClass.count), line: `new find${y.starredClass.count === 1 ? '' : 's'} got your star, and no expiring license can take ${y.starredClass.count === 1 ? 'it' : 'them'} back.` })
  }

  slides.push(...top1000Cards(y))

  slides.push(revealed
    ? { kind: 'end', eyebrow: 'Happy birthday', big: `That was ${y.year}.`, line: 'Every number here is a count of real plays, on music you own.' }
    : { kind: 'end', eyebrow: 'December 17', big: `The rest of ${y.year} is still being written.`, line: 'The final cut drops on your birthday.' })
  return slides
}
