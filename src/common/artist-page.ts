/**
 * The artist page's arithmetic and wording (2026-10-20 rebuild) — the parts
 * that are easy to get subtly wrong and worth a test: the top-songs ranking,
 * the most-played record, the header stats, and how dates and show details
 * read on a poster. Pure; the view (renderer/views/ArtistDetailView.tsx) only
 * lays these out.
 *
 * Plays are passed in as a function so the page counts the way the rest of
 * the app does: this Mac's plays plus the phone's and workmini's
 * (common/plays-elsewhere.ts playsEverywhere).
 */
import { isTop25Rankable } from './top25-rankable.ts'
import type { ReleaseKind } from './release-kind.ts'

export interface PageTrackLike {
  id: number
  title?: string
  album?: string
  duration?: number
  dateAdded?: string
  year?: number | string
  trackNumber?: number | string
  discNumber?: number | string
}

export interface RankedSong<T> { track: T; plays: number; /** 0–1 of the top song's plays */ bar: number }

/**
 * "Your <Artist>": the artist's most-played songs. A song under a minute never
 * takes a slot (Jake: nothing under 1 min in ANY ranking — its plays still
 * count in the totals). Unplayed songs don't rank. Ties: the earlier-added
 * song first, then title, so the order is stable between visits.
 */
export function topSongs<T extends PageTrackLike>(tracks: readonly T[], playsOf: (t: T) => number, n = 5): RankedSong<T>[] {
  const ranked = tracks
    .filter((t) => isTop25Rankable(t))
    .map((t) => ({ track: t, plays: playsOf(t) }))
    .filter((r) => r.plays > 0)
    .sort((a, b) => b.plays - a.plays
      || (Date.parse(a.track.dateAdded || '') || 0) - (Date.parse(b.track.dateAdded || '') || 0)
      || String(a.track.title || '').localeCompare(String(b.track.title || '')))
    .slice(0, n)
  const top = ranked[0]?.plays || 1
  return ranked.map((r) => ({ ...r, bar: r.plays / top }))
}

export interface RecordGroupLike<T> { name: string; year: number | string; tracks: readonly T[] }

/** The release with the most plays everywhere; ties go to the newer one. Null when nothing has been played. */
export function mostPlayedRecord<T extends PageTrackLike, G extends RecordGroupLike<T>>(groups: readonly G[], playsOf: (t: T) => number): { group: G; plays: number } | null {
  let best: { group: G; plays: number } | null = null
  for (const g of groups) {
    const plays = g.tracks.reduce((s, t) => s + playsOf(t), 0)
    if (plays <= 0) continue
    if (!best || plays > best.plays || (plays === best.plays && (Number(g.year) || 0) > (Number(best.group.year) || 0))) best = { group: g, plays }
  }
  return best
}

/** Earliest dateAdded among the tracks (epoch ms), or null. */
export function earliestAdded(tracks: Iterable<PageTrackLike>): number | null {
  let min = Infinity
  for (const t of tracks) {
    const ms = Date.parse(t.dateAdded || '')
    if (Number.isFinite(ms) && ms > 0 && ms < min) min = ms
  }
  return min === Infinity ? null : min
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Aug 2026" — in local time, like every other date the app shows; non-breaking, so a date never splits across lines. */
export function monthYear(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return ''
  const d = new Date(ms)
  return `${MONTHS[d.getMonth()]}\u00a0${d.getFullYear()}`
}

/** "Aug 9, 2026". */
export function dayMonthYear(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return ''
  const d = new Date(ms)
  return `${MONTHS[d.getMonth()]}\u00a0${d.getDate()},\u00a0${d.getFullYear()}`
}

/** "3:30" from milliseconds — seconds floored, like every song time in the app (SongsView / AlbumDetailView). */
export function clock(ms: number | undefined): string {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

/** "45 min" / "1 hr 12 min" from milliseconds — the album page's own formula (AlbumDetailView formatTotalDuration). */
export function lengthLabel(ms: number): string {
  const totalSecs = Math.floor((Number(ms) || 0) / 1000)
  const hrs = Math.floor(totalSecs / 3600)
  const mins = Math.round((totalSecs % 3600) / 60)
  if (hrs > 0) return `${hrs} hr ${mins} min`
  return `${mins} min`
}

export const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

/** One release's kind as a label on its card ("Album · 2025", "EP · 2023 · 2 plays"). */
export const RELEASE_KIND_SINGULAR: Readonly<Record<ReleaseKind, string>> = {
  album: 'Album', ep: 'EP', single: 'Single', live: 'Live', compilation: 'Compilation',
}

/**
 * The line under an album tile: kind · year, nothing else — "2025",
 * "EP · 2023", "Single · 2024". No play counts (Jake, 10/20: "i also dont
 * need to see the amount of plays next to each album"). Empty when neither is known.
 */
export function albumTileMeta(kindLabel: string, year: number | string | null | undefined): string {
  const y = Number(year) > 0 ? String(year) : ''
  return [kindLabel, y].filter(Boolean).join(' · ')
}

/**
 * "Artist · Brooklyn, New York · Since 2016" — only what the profile grounds.
 * An act that ended shows its span: "Artist · Aberdeen, Washington · 1987–1994".
 */
export function heroEyebrow(origin?: { place?: string; since?: string; until?: string } | null): string {
  const parts = ['Artist']
  if (origin?.place) parts.push(origin.place)
  if (origin?.since && origin?.until) parts.push(origin.since === origin.until ? origin.since : `${origin.since}–${origin.until}`)
  else if (origin?.since) parts.push(`Since ${origin.since}`)
  else if (origin?.until) parts.push(`Until ${origin.until}`)
  return parts.join(' · ')
}

/**
 * Which picture the header shows (⚠️ TWIN: JakeTunesMobile ios ArtistPage
 * `heroSource`, Mobile #501 — same order; one difference, below):
 *  1. 'hero' — a header photo homemini chose. One sourced from the app's own
 *     artist image ('library') counts too: homemini stores one only when the
 *     artist image as it stands puts a face under this header's bottom fade
 *     or outside its window, and the stored file is that image re-framed for
 *     THIS wide header (Mobile backend buildHero/frameHero; QA 10/22: Fat
 *     Dog, Jurassic 5, Guided By Voices, The Chemical Brothers showed faces
 *     under the fade). The phone keeps today's artist image for it, framed
 *     for its own tall header — the wide crop would cut a band to its middle
 *     members there (ArtistPageModel.heroSource).
 *  2. 'cover' — `heroNeedsPhoto`: no photo shows the right line-up (Sublime's
 *     own image is the 2023 band). Never the artist image; the most played
 *     record's cover, else the newest record's.
 *  3. 'artistImage' — today's artist image (the cover only if it has none).
 */
export function headerPhotoChoice(p: { hero?: { source?: string } | null; heroNeedsPhoto?: boolean } | null | undefined): 'hero' | 'cover' | 'artistImage' {
  if (p?.hero) return 'hero'
  if (p?.heroNeedsPhoto) return 'cover'
  return 'artistImage'
}

/**
 * How the header photo meets its window (Jake, 2026-10-22, on the phone: "some
 * of the artist headers cut off band members or a member").
 *
 * The window is `object-fit: cover`: a wide band photo in a window narrower
 * than the photo is cropped at its sides, and the outer members go. The
 * builder frames every header it picks at about 2:1 for a 1440-wide window
 * (878 × 440), so that is right at that width and wrong below it: at the
 * narrowest window (900) the photo's window is 541 × 440 and only 61% of a 2:1
 * photo shows. A TALL group portrait (Camper Van Beethoven: five men in two
 * rows, served 600 × 520 on purpose) is the other way round: cover keeps a
 * 440px slice of it and the slice runs through the foreheads of one row or
 * the chins of the other.
 *
 *   'cover'  — the window is as wide as the photo's proportions, or wider and
 *              the photo is not much taller than it (the crop is only
 *              vertical, and the builder kept every face inside it), or the
 *              act is a person (one face: the crop is what fills the header).
 *   'width'  — a group in a window narrower than its photo: the picture by its
 *              whole width, anchored to the top, dissolving into the ink
 *              below. No member is cropped out; the window's spare height is
 *              the ink the name and stats already sit on.
 *   'height' — a group's tall header photo in a much wider window: the
 *              picture by its whole height, right-aligned (the left of the
 *              window is already ink under the name and the fade), its left
 *              edge dissolving. Every row of faces is shown.
 *
 * `framed` is true for a header photo the profile chose (its builder framed or
 * Jake picked it for this window); the app's own artist image (a generic
 * square portrait) keeps its cover however tall it is.
 *
 * Phone twin: JakeTunesMobile ios/JakeTunesMobile/ArtistHeroFraming.swift. The phone's
 * window is always narrower than a band photo, so it decides by the kind and
 * the picture's shape alone (a person's wide photo fills; anything else shows
 * whole).
 */
export type HeroPhotoFit = 'cover' | 'width' | 'height'

export function heroPhotoFit(
  kind: string | null | undefined,
  box: { width: number; height: number },
  image: { width: number; height: number },
  framed = true,
): HeroPhotoFit {
  if (String(kind || '').trim().toLowerCase() === 'person') return 'cover'
  if (!(box.width > 0) || !(box.height > 0) || !(image.width > 0) || !(image.height > 0)) return 'cover'
  const boxAspect = box.width / box.height
  const imageAspect = image.width / image.height
  // Three percent is rounding, not cropping: a window that is that close to
  // the photo's own proportions stays a full-height cover.
  if (boxAspect < imageAspect * 0.97) return 'width'
  // Cover would keep less than 70% of the picture's height.
  if (framed && imageAspect < boxAspect * 0.7) return 'height'
  return 'cover'
}

/**
 * The name's type size step. Names never truncate (Jake's rule), so a long
 * one steps down instead of running off the band: 84 px for "Geese", smaller
 * for "Godspeed You! Black Emperor".
 */
export function heroNameSize(name: string): 'xl' | 'l' | 'm' | 's' {
  const n = [...String(name || '')].length
  const longestWord = Math.max(0, ...String(name || '').split(/\s+/).map((w) => [...w].length))
  if (n <= 14 && longestWord <= 11) return 'xl'
  if (n <= 24 && longestWord <= 14) return 'l'
  if (n <= 40 && longestWord <= 18) return 'm'
  return 's'
}

const LONG_MONTHS: Record<string, string> = {
  january: 'Jan', february: 'Feb', march: 'Mar', april: 'Apr', may: 'May', june: 'Jun', july: 'Jul',
  august: 'Aug', september: 'Sep', sept: 'Sep', october: 'Oct', november: 'Nov', december: 'Dec',
}

/**
 * A show date as a poster caption prints it: "October 3, 2026" → "Oct 3, 2026";
 * "2023 (exact date not published)" → "2023". Anything else passes through.
 */
export function posterDate(date?: string): string {
  if (!date) return ''
  const bare = date.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim()
  return bare.replace(/\b(january|february|march|april|may|june|july|august|september|sept|october|november|december)\b/gi,
    (m) => LONG_MONTHS[m.toLowerCase()] ?? m)
}

/** The year a poster's footer line can carry: "2023" from "2023 (exact date not published)", "2026" from "Oct 3, 2026". */
export function posterYear(date?: string): string {
  const m = /\b(1[89]\d\d|20\d\d)\b/.exec(date || '')
  return m ? m[1] : ''
}

/**
 * The caption under a live poster: venue on top, then city · date · set.
 * Only grounded details; a show with no venue is captioned by its title. A
 * declared show is a "full set" — or a "studio live set" when its own
 * details say it was taped in a studio (Alive & In Person at The Diamond Mine).
 */
export function liveCaption(c: { title: string; venue?: string; city?: string; date?: string; songs?: number; fullSet?: boolean; studio?: boolean }): { head: string; meta: string } {
  const head = posterVenue(c.venue) || c.title
  const kind = c.fullSet ? (c.studio ? 'studio live set' : 'full set') : ''
  const set = c.songs && c.songs > 0 ? [kind, plural(c.songs, 'song')].filter(Boolean).join(', ') : kind
  const meta = [c.city, posterDate(c.date), set].filter(Boolean).join(' · ')
  return { head, meta }
}

/** The show line on a made poster: "The Diamond Mine · Queens, NY · 2023". */
export function posterShowLine(c: { venue?: string; city?: string; date?: string; year?: number | string }): string {
  const when = posterYear(c.date) || (Number(c.year) > 0 ? String(c.year) : '')
  return [c.venue, c.city, when].filter(Boolean).join(' · ')
}

/**
 * A venue name the way a poster prints it: drops a trailing "Recording
 * Studio(s)" so "The Diamond Mine Recording Studio" sets as "The Diamond
 * Mine". A bare "Studios" is part of the name and stays — "Sony Music
 * Studios" (Nirvana's Unplugged) is not "Sony Music", and "Abbey Road
 * Studios" stays whole.
 */
export function posterVenue(venue?: string): string {
  if (!venue) return ''
  return venue.replace(/\s+recording\s+studios?$/i, '').trim() || venue
}
