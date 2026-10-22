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

export type Slide =
  | { kind: 'cover'; eyebrow: string; year: number; line: string; stats: Array<[string, string]>; note?: string }
  | { kind: 'art'; eyebrow: string; big: string; line: string; image: StoryImage; play?: StoryPlay; poster?: boolean }
  | { kind: 'list'; eyebrow: string; rows: StoryRow[]; firstRank: number }
  | { kind: 'lanes'; eyebrow: string; big: string; rows: StoryRow[]; line: string }
  | { kind: 'number'; eyebrow: string; big: string; line: string }
  | { kind: 'iceberg'; eyebrow: string; big: string; layers: number[]; line: string }
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

export function buildStory(y: YearInReview, opts: { now: Date; concerts?: StoryConcert[] }): Slide[] {
  const revealed = isRevealed(y.year, opts.now)
  const T = y.totals
  const slides: Slide[] = []

  const startedLate = y.coverage.monthsBeforeHistory.length > 0 && y.coverage.firstListen
  slides.push({
    kind: 'cover', eyebrow: 'JakeTunes · Year in Review', year: y.year,
    line: revealed ? 'Your year in music.' : 'So far.',
    stats: [[n(T.plays), 'songs played'], [n(Math.round(T.minutes / 60)), 'hours of music'], [n(T.daysListened), 'days with music']],
    note: startedLate ? `Since ${dayName(localParts(y.coverage.firstListen!).date)}, the day JakeTunes started keeping score.` : undefined,
  })

  if (y.firstPlay) {
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
      kind: 'art', eyebrow: 'Record of the year', big: album.name, line: `${album.artist ?? ''} · ${n(album.plays)} plays`,
      image: { kind: 'album', artist: album.artist ?? '', album: album.name },
      play: { kind: 'album', artist: album.artist ?? '', album: album.name },
    })
  }

  const bd = T.biggestDay
  if (bd.date && bd.firstHour !== null && bd.lastHour !== null) {
    slides.push({ kind: 'number', eyebrow: 'The day it never stopped', big: dayName(bd.date), line: `${n(bd.plays)} songs, from ${hour12(bd.firstHour)} to ${hour12(bd.lastHour)}.` })
  }

  // Busiest hour and busiest weekday are measured separately, so the card
  // says them separately (never "noon on Thursdays" as if it were one peak).
  if (T.plays > 0) {
    const h = argMax(y.clock.byHour), d = argMax(y.clock.byWeekday)
    slides.push({ kind: 'number', eyebrow: 'When you listen', big: `${cap(hour12(h))}. ${WEEKDAYS[d]}s.`, line: 'Your busiest hour of the day, and your busiest day of the week.' })
  }

  const st = T.longestStreak
  if (st.days >= 2 && st.from && st.to) {
    slides.push({ kind: 'number', eyebrow: 'Longest streak', big: `${n(st.days)} days`, line: `${dayName(st.from)} to ${dayName(st.to)} without a day off.` })
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
      line: disc.newArtists.length >= 3 ? 'Your three most played of them.' : 'Your most played of them.',
      rows: disc.newArtists.slice(0, 3).map((a) => ({ name: a.name, sub: `${n(a.plays)} plays`, plays: a.plays, image: { kind: 'artist', name: a.name } })),
    })
  }
  if (y.starredClass.count > 0) {
    slides.push({ kind: 'number', eyebrow: 'The keepers', big: n(y.starredClass.count), line: `new find${y.starredClass.count === 1 ? '' : 's'} got your star.` })
  }
  if (y.honesty.realSkipRate !== null) {
    slides.push({ kind: 'number', eyebrow: 'Honest numbers', big: `${n(y.honesty.skips)} real skips`, line: `${(y.honesty.realSkipRate * 100).toFixed(1)}% of what you started. Glances and button-mashing don't count.` })
  }

  slides.push(revealed
    ? { kind: 'end', eyebrow: 'Happy birthday', big: `That was ${y.year}.`, line: 'Every number here is a count of real plays.' }
    : { kind: 'end', eyebrow: 'December 17', big: `The rest of ${y.year} is still being written.`, line: 'The final cut drops on your birthday.' })
  return slides
}
