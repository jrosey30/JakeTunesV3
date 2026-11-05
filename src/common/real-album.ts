/**
 * Brief 231: which album a song really belongs to, from MusicBrainz.
 *
 * Jake, 2026-11-05: "can girls and boys by blur not be on the album 90's rock albums??? it
 * needs its real album associated with it". A store's first hit for a hit song is a
 * compilation: Qobuz's first 25 hits for Blur's "Girls and Boys" were 25 compilations, and
 * Apple's first row for Ray Charles' "Hit the Road Jack" is a 90-track box. So neither the
 * store nor the row gets to say what the album is when MusicBrainz knows.
 *
 * The real album is the earliest OFFICIAL release-group of primary type Album, with no
 * secondary type (not Compilation, Live, Soundtrack, Remix, DJ-mix), credited to the artist,
 * holding a recording of this title at this length. Nothing is invented when there is none:
 * a single that was never on an album, a soundtrack song and a track nobody has catalogued
 * all answer null, and the caller keeps what it has.
 *
 * Pure, no imports, so its tests and the library audit run it with no network. The asking is
 * the lookup module beside its caller.
 * ⚠️ TWIN: JakeTunesMobile backend/src/util/realAlbum.ts, byte-identical apart from this line.
 */

export interface MbRelease {
  id?: string
  title?: string
  status?: string | null
  date?: string | null
  'artist-credit'?: Array<{ name?: string; artist?: { name?: string } }>
  'track-count'?: number
  'release-group'?: {
    id?: string
    title?: string
    'primary-type'?: string | null
    'secondary-types'?: string[] | null
  }
  media?: Array<{
    position?: number
    format?: string | null
    'track-count'?: number
    track?: Array<{ number?: string; title?: string; length?: number | null }>
  }>
}

export interface MbRecording {
  id?: string
  title?: string
  length?: number | null
  disambiguation?: string | null
  'artist-credit'?: Array<{ name?: string; artist?: { name?: string } }>
  releases?: MbRelease[]
}

export interface RealAlbum {
  album: string
  year?: number
  trackNumber?: number
  trackCount?: number
  discNumber?: number
  /** The song's title as this album prints it. */
  title: string
  /** The album cut's length, in seconds, when MusicBrainz knows it. */
  durationSec?: number
  releaseGroupId: string
  /** Every album this recording is really on, by name: a row naming one of these is fine. */
  realAlbums: string[]
  /** The song was out for years before this album, so it may not be its first home. */
  lateAlbum: boolean
  /** 'high': the clock agrees and the album is where the song first appeared. 'low': no
   *  clock to hold it to, or a late album. */
  confidence: 'high' | 'low'
}

export interface RealAlbumRequest {
  title: string
  artist: string
  /** Other names MusicBrainz knows the artist by. */
  aliases?: string[]
  /** Lengths the song is known to run (a file's, or Apple's); empty = nobody knows. */
  durationsSec?: number[]
  /** Does Jake already own this album? Then the song joins it. */
  owned?: (album: string) => boolean
}

/** How far a recording may stray from the song's length and still be that recording. */
export const REAL_ALBUM_TOLERANCE_SEC = 5
/** A song out this many years before an album is not on its original album: greatest-hits
 *  packages are not always typed as compilations ("Ray Charles' Greatest Hits", 1962). */
const ORIGINAL_ALBUM_YEARS = 3

/** Comparing words: accents and case out, "&" and "'n'" read as "and", punctuation gone. */
export function realAlbumFold(text: string): string {
  return String(text || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s*&\s*/g, ' and ')
    .replace(/\s+['’]?n['’]?\s+/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

/** Labels that say nothing about the recording: they come off a title before comparing. */
const EDITION_LABEL = /\s*[([][^)\]]*\b(?:remaster(?:ed)?|album version|lp version|original version|mono|stereo|explicit|clean|bonus track|deluxe|expanded|anniversary|edition|version originale|single version|feat\.?|ft\.?|featuring|with)\b[^)\]]*[)\]]\s*|\s+[-–—]\s+(?:\d{4}\s+)?(?:digital\s+)?remaster(?:ed)?(?:\s+\d{4})?(?:\s+version)?\s*$/gi
const plainTitle = (title: string): string => title.replace(EDITION_LABEL, ' ').replace(/\s{2,}/g, ' ').trim()

/** Words a title has when it is another recording than the album's cut. */
const VERSION_WORD = /\b(?:live|remix|rmx|acoustic|demo|instrumental|karaoke|radio edit|edit|dub|session|sessions|unplugged|mix)\b/i
/** Disambiguations that name the album's own cut: Neil Young's "original studio mix". */
const OWN_CUT = /\b(?:original|album|lp|studio|mono|stereo)(?:\s+studio)?\s+mix\b/gi
/** Compilations MusicBrainz has typed as plain albums. */
const HITS_PACKAGE = /\b(?:greatest hits|the best of|the very best|the essential|the collection|ultimate collection|definitive collection|hits collection|the singles|singles collection)\b/i

export function realAlbumQuery(title: string, artist: string): string {
  const quoted = (s: string): string => `"${s.replace(/(["\\])/g, '\\$1')}"`
  const base = plainTitle(title)
  const spellings = [...new Set([base, base.replace(/\s*&\s*/g, ' and '), base.replace(/\s+and\s+/gi, ' & ')])]
  const titles = spellings.map((s) => `recording:${quoted(s)}`).join(' OR ')
  return `(${titles}) AND artist:${quoted(artist)} AND status:official AND primarytype:album`
}

/** MusicBrainz prints typographer's marks. Stores and Jake's library don't: Qobuz is asked
 *  for "Tri-Polar", not "Tri\u2010Polar". */
const storeSpelling = (text: string): string => text
  .replace(/[\u2018\u2019\u02bc]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2010\u2011]/g, '-').replace(/\u2026/g, '...').replace(/\u00a0/g, ' ')

const yearOf = (date: string | null | undefined): number | undefined => {
  const y = Number(String(date ?? '').slice(0, 4))
  return Number.isFinite(y) && y > 0 ? y : undefined
}
const creditNames = (credit: MbRecording['artist-credit']): string[] =>
  (credit ?? []).flatMap((c) => [c.name, c.artist?.name]).filter((n): n is string => !!n)

/** Picks the song's real album out of a recording search. See the head of this file. */
export function pickRealAlbum(recordings: MbRecording[], req: RealAlbumRequest): RealAlbum | null {
  const wantTitle = realAlbumFold(plainTitle(req.title))
  if (!wantTitle || !req.artist.trim()) return null
  // A title that says it is another recording is not an album cut to look for.
  if (VERSION_WORD.test(plainTitle(req.title).match(/[([].*[)\]]|[-–—].*$/)?.[0] ?? '')) return null
  const names = new Set([req.artist, ...(req.aliases ?? [])].map(realAlbumFold).filter(Boolean))
  const isTheArtist = (credit: MbRecording['artist-credit']): boolean => {
    const got = creditNames(credit).map(realAlbumFold)
    return got.some((n) => names.has(n))
  }
  const durations = (req.durationsSec ?? []).filter((d) => d > 0)
  const clockFits = (lengthMs: number | null | undefined): boolean | null => {
    if (!lengthMs || durations.length === 0) return null
    return durations.some((d) => Math.abs(d - lengthMs / 1000) <= REAL_ALBUM_TOLERANCE_SEC)
  }

  interface Seat { rg: string; rgTitle: string; release: MbRelease; date: string; clock: boolean | null; printed: string; lengthMs?: number | null }
  const seats: Seat[] = []
  let earliestAny: number | undefined
  for (const rec of recordings) {
    if (!isTheArtist(rec['artist-credit'])) continue
    if (realAlbumFold(plainTitle(rec.title ?? '')) !== wantTitle) continue
    if (rec.disambiguation && VERSION_WORD.test(rec.disambiguation.replace(OWN_CUT, ''))) continue
    for (const rel of rec.releases ?? []) {
      if (String(rel.status ?? '').toLowerCase() !== 'official') continue
      const track = rel.media?.[0]?.track?.[0]
      const lengthMs = track?.length ?? rec.length
      const clock = clockFits(lengthMs)
      // When the song first came out, as this cut: an early demo of the title doesn't count.
      const y = yearOf(rel.date)
      if (clock !== false && y !== undefined && (earliestAny === undefined || y < earliestAny)) earliestAny = y
      const rg = rel['release-group']
      if (!rg?.id || !rg.title) continue
      if (String(rg['primary-type'] ?? '').toLowerCase() !== 'album') continue
      if ((rg['secondary-types'] ?? []).length > 0) continue
      if (rel['artist-credit'] && !isTheArtist(rel['artist-credit'])) continue
      if (HITS_PACKAGE.test(rg.title)) continue
      seats.push({
        rg: rg.id, rgTitle: storeSpelling(rg.title), release: rel, date: String(rel.date ?? ''),
        clock, printed: storeSpelling(track?.title || rec.title || req.title), lengthMs,
      })
    }
  }
  // A recording the clock rules out is another cut, on any album. Only when the clock
  // can't speak at all does a recording stand without it.
  const fitting = seats.some((s) => s.clock === true) ? seats.filter((s) => s.clock === true) : seats.filter((s) => s.clock === null)
  if (fitting.length === 0) return null

  // By release group: the group's earliest known date.
  const groups = new Map<string, Seat[]>()
  for (const s of fitting) groups.set(s.rg, [...(groups.get(s.rg) ?? []), s])
  const firstDate = (ss: Seat[]): string => ss.map((s) => s.date).filter(Boolean).sort()[0] ?? '9999'
  const ordered = [...groups.values()].sort((a, b) => firstDate(a).localeCompare(firstDate(b)))
  // The album Jake already owns, if this recording is really on it: the song joins it.
  const chosen = ordered.find((ss) => req.owned?.(ss[0]!.rgTitle)) ?? ordered[0]!

  // The plainest edition of that album prints the numbers: the earliest, then the shortest.
  // Not a bonus track that says "(mono)", and a first pressing on vinyl calls track 5 "B1",
  // so an edition that counts from 1 goes ahead of it.
  const trackNo = (s: Seat): number => {
    const n = Number(s.release.media?.[0]?.track?.[0]?.number)
    return Number.isInteger(n) && n > 0 ? n : 0
  }
  const bare = (s: Seat): boolean => plainTitle(s.printed) === s.printed
  const seat = [...chosen].sort((a, b) =>
    Number(bare(b)) - Number(bare(a))
    || Number(trackNo(b) > 0) - Number(trackNo(a) > 0)
    || (a.date || '9999').localeCompare(b.date || '9999')
    || (a.release['track-count'] ?? 9999) - (b.release['track-count'] ?? 9999))[0]!
  const media = seat.release.media?.[0]
  const number = trackNo(seat)
  const year = yearOf(firstDate(chosen))
  const lateAlbum = year !== undefined && earliestAny !== undefined && year - earliestAny >= ORIGINAL_ALBUM_YEARS
  return {
    album: seat.rgTitle,
    ...(year !== undefined ? { year } : {}),
    ...(number > 0 ? { trackNumber: number } : {}),
    ...(media?.['track-count'] ? { trackCount: media['track-count'] } : {}),
    ...(media?.position ? { discNumber: media.position } : {}),
    title: seat.printed,
    ...(seat.lengthMs ? { durationSec: seat.lengthMs / 1000 } : {}),
    releaseGroupId: seat.rg,
    realAlbums: [...new Set(ordered.map((ss) => ss[0]!.rgTitle))],
    lateAlbum,
    confidence: seat.clock === true && !lateAlbum ? 'high' : 'low',
  }
}

/**
 * The album a download should look for. The row's own album stands when MusicBrainz has
 * nothing certain to say, when it is one of the song's real albums (a re-recording, a deluxe
 * name), or when its name says it is another recording: a row on "Live at Leeds" asked for
 * that. A row on a compilation or a single takes the real album; a row on nothing takes
 * what MusicBrainz has, certain or not, since looking for it costs nothing. An album years
 * later than the song is never looked for: that is a package no one has typed as one.
 */
export function albumToLookFor(rowAlbum: string, real: RealAlbum | null, albumAddsRecording: (album: string) => boolean): string {
  const row = rowAlbum.trim()
  if (!real || real.lateAlbum) return row
  if (!row) return real.album
  if (albumAddsRecording(row) || real.confidence !== 'high') return row
  const key = (a: string): string => realAlbumFold(plainTitle(a.replace(/\s+[-–—]\s*(?:EP|Single)\s*$/i, '')))
  if (real.realAlbums.some((a) => key(a) === key(row))) return row
  return real.album
}

export interface MbRecordingPage { count?: number; recordings?: MbRecording[] }

const RECORDINGS_PER_PAGE = 100
const MAX_PAGES = 3

/**
 * Every recording a search has, up to three pages. A hit song has hundreds of recordings, one
 * per compilation, in no useful order: page one of Dobie Gray's "Drift Away" has only the 2004
 * re-recording, and the 1973 album is on page two. A page that fails fails the whole answer,
 * since a half-read list would call a later album the first.
 */
export async function allRecordings(page: (offset: number, limit: number) => Promise<MbRecordingPage>): Promise<MbRecording[]> {
  const all: MbRecording[] = []
  for (let n = 0; n < MAX_PAGES; n++) {
    const body = await page(n * RECORDINGS_PER_PAGE, RECORDINGS_PER_PAGE)
    const got = body.recordings ?? []
    all.push(...got)
    if (got.length < RECORDINGS_PER_PAGE || all.length >= (body.count ?? 0)) break
  }
  return all
}

interface OwnedRow { artist?: string; albumArtist?: string; album?: string }

const sameArtist = (t: OwnedRow, key: string): boolean => realAlbumFold(t.artist ?? '') === key || realAlbumFold(t.albumArtist ?? '') === key
const albumKey = (album: string): string => realAlbumFold(album.replace(/\s*[([][^)\]]*[)\]]\s*$/, ''))

/** Does Jake own this album by this artist? Then a song of it joins it. */
export function ownedAlbumTest(tracks: readonly OwnedRow[], artist: string): (album: string) => boolean {
  const key = realAlbumFold(artist)
  const albums = new Set(tracks.filter((t) => t.album && sameArtist(t, key)).map((t) => albumKey(t.album!)))
  return (album) => albums.has(albumKey(album))
}

/** The album as Jake's library spells it, and who it files it under. */
export function ownedAlbumSpelling(tracks: readonly OwnedRow[], artist: string, album: string): { album: string; albumArtist: string } | null {
  const key = realAlbumFold(artist)
  const want = albumKey(album)
  const mine = tracks.find((t) => t.album && sameArtist(t, key) && albumKey(t.album) === want)
  return mine?.album ? { album: mine.album, albumArtist: mine.albumArtist || mine.artist || artist } : null
}
