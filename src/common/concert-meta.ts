/**
 * A declared live concert as the app shows it: band, show, and the venue /
 * date its poster carries. Shared by the Live Concerts page (ConcertsView)
 * and the artist page's Live wall, so the two can never disagree on which
 * band a concert belongs to or what its poster says.
 *
 * A "declared concert" is a live-sets.json entry (albumKey → entry) whose
 * merged "Full Set" track is still in the library. Venue and date come only
 * from grounded sources — the entry's own concert.* fields, else the
 * "(Live at VENUE, DATE)" tag the tracks carry, else a date in the show
 * name. Nothing is ever invented.
 *
 * Pure: no imports, no IPC.
 */

export interface ConcertCueLike {
  trackId: number
  title?: string | null
  artist?: string | null
}

export interface ConcertMetaLike {
  venue?: string
  city?: string
  date?: string
  /** A bare artwork-store hash for a real poster, when one was set. */
  poster?: string
  blurb?: string
  facts?: readonly string[]
}

export interface ConcertSetLike {
  mergedTrackId: number
  cues: readonly ConcertCueLike[]
  promotedTrackIds?: readonly number[]
  concert?: ConcertMetaLike | null
}

export interface ConcertTrackLike {
  id: number
  artist?: string | null
  album?: string | null
  year?: number | string | null
}

/**
 * Venue + date for a poster, from grounded sources only: a persisted
 * override first, else the "(Live at|from VENUE, DATE)" suffix on a sample
 * title, else a "Month D…, YYYY" date lifted from the show name.
 */
export function parseConcertMeta(
  showName: string,
  sampleTitle: string,
  override?: { venue?: string; city?: string; date?: string } | null,
): { venue?: string; date?: string } {
  if (override && (override.venue || override.date)) return { venue: override.venue, date: override.date }
  let venue: string | undefined
  let date: string | undefined
  const m = /\(live\s+(?:at|from)\s+([^,]+),\s*(.+?)\)\s*$/i.exec(sampleTitle || '')
  if (m) { venue = m[1].trim(); date = m[2].trim() }
  if (!date) {
    const d = /([A-Z][a-z]+\.?\s+\d[\d\s&,–-]*\d{4})/.exec(showName || '')
    if (d) date = d[1].trim()
  }
  return { venue, date }
}

const MONTHS: Record<string, number> = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11 }

/** "July 17, 18 & 21, 2009" → the FIRST night, as ms; unparseable → +∞ (sorts last). */
export function firstNightMs(date?: string): number {
  if (!date) return Number.POSITIVE_INFINITY
  const y = /(\d{4})/.exec(date)?.[1]
  const mo = /([A-Za-z]+)/.exec(date)?.[1]?.toLowerCase()
  const d = /\b(\d{1,2})\b/.exec(date)?.[1]
  if (!y) return Number.POSITIVE_INFINITY
  const month = mo && MONTHS[mo] != null ? MONTHS[mo] : 0
  return Date.UTC(Number(y), month, d ? Number(d) : 1)
}

export interface DeclaredConcert<E extends ConcertSetLike = ConcertSetLike> {
  albumKey: string
  entry: E
  band: string
  /** The show's name: the source album with any "(Live Set)" tag removed. */
  show: string
  venue?: string
  city?: string
  date?: string
  blurb?: string
  /** concert.poster when set (a bare artwork hash); the caller falls back to the show's cover. */
  poster?: string
  /** First night (ms), +∞ when no date is grounded. */
  when: number
  /** The source track's year, 0 when unknown. */
  year: number
}

/**
 * Every declared concert, in sidecar order. A set whose merged track is no
 * longer in the library is not declared (parity with liveSetFor's
 * self-heal). The band is the first cue's artist, else the source track's.
 */
export function declaredConcerts<E extends ConcertSetLike>(
  sets: Readonly<Record<string, E>>,
  trackById: (id: number) => ConcertTrackLike | undefined,
): DeclaredConcert<E>[] {
  const out: DeclaredConcert<E>[] = []
  for (const [albumKey, entry] of Object.entries(sets)) {
    if (!trackById(entry.mergedTrackId)) continue
    const first = entry.cues[0]
    const src = (first ? trackById(first.trackId) : undefined) ?? trackById(entry.mergedTrackId)
    const band = first?.artist || src?.artist || ''
    const show = src?.album?.replace(/\s*\(Live Set\)\s*$/i, '') || albumKey.split('|||')[1] || 'Live Concert'
    const { venue, date } = parseConcertMeta(show, first?.title || '', entry.concert)
    const year = Number(src?.year) || 0
    out.push({
      albumKey,
      entry,
      band,
      show,
      venue,
      city: entry.concert?.city,
      date,
      blurb: entry.concert?.blurb || entry.concert?.facts?.[0],
      poster: entry.concert?.poster || undefined,
      when: firstNightMs(date),
      year: year > 0 && year < 10000 ? year : 0,
    })
  }
  return out
}

/**
 * Every track a declared concert owns — the merged show and every
 * constituent, promoted or not. A promoted song is a normal song again in
 * the library, but on a page of releases it belongs to its show: one show,
 * one tile.
 */
export function concertTrackIds(
  sets: Readonly<Record<string, ConcertSetLike>>,
  hasTrack: (id: number) => boolean,
): Set<number> {
  const ids = new Set<number>()
  for (const entry of Object.values(sets)) {
    if (!hasTrack(entry.mergedTrackId)) continue   // stale set: its songs are an ordinary album again
    ids.add(entry.mergedTrackId)
    for (const c of entry.cues) ids.add(c.trackId)
  }
  return ids
}
