/**
 * The Record Shop's search, grouped (Brief 256, Phase 3 of the rework).
 *
 * Typing "Pink Floyd" shows the artist first, then the albums, then the
 * songs. Albums come from Apple's album search, not from whichever songs
 * happened to match. Every result says whether Jake already has it ("In your
 * library") or has it jotted ("On your list"), and the library's own matches
 * sit above the catalogue.
 *
 * Pure: the fetching is main/shop-search.ts, the screens DownloadView and its
 * artist and album pages. node --test covers everything here.
 */
import { nameKey, withinEditDistance, typoBudget } from './fold-text.ts'
import { explicitWins } from './explicit.ts'
import { JUNK_ARTIST_NAME } from './junk-artist.ts'

// ── Shapes ─────────────────────────────────────────────────────────────

export interface ShopArtist {
  artistId: number
  name: string
  genre?: string
}

export interface ShopAlbum {
  collectionId: number
  name: string
  artist: string
  artistId?: number
  artworkUrl?: string
  /** Apple's releaseDate, as given ("1973-03-01T08:00:00Z"); sorts the artist page. */
  releaseDate?: string
  releaseYear?: number
  trackCount?: number
  genre?: string
  explicitness?: string
}

export type ShopReleaseKind = 'ALBUM' | 'EP' | 'SINGLE'

/** `shop-search`'s answer. `S` is the song row (main's ItunesSuggestion). */
export interface ShopSearchAnswer<S> {
  ok: boolean
  songs: S[]
  artists: ShopArtist[]
  albums: ShopAlbum[]
  /** The song search's own answer (Apple, or Deezer standing in). False: the screen falls back to Qobuz's song search. */
  songsOk: boolean
  /** False when Apple's album search didn't answer: the screen then builds albums from the songs, as before. */
  albumsOk: boolean
}

/** `shop-artist-releases`' answer. */
export interface ShopArtistAnswer {
  ok: boolean
  artist?: ShopArtist
  releases: ArtistReleases
}

// ── Names ──────────────────────────────────────────────────────────────

/**
 * What kind of release this is. Apple's name suffix says it ("Sundowning - EP",
 * "Bags - Single"); with no suffix, one track is a single and anything else an
 * album. Moved here from DownloadView (it re-exports it).
 *
 * Brief 256: a short record with no suffix is an ALBUM, no longer an EP. The
 * old 2-6-tracks rule filed Meddle (6), Animals (5) and Wish You Were Here (5)
 * under EPs on Pink Floyd's artist page; Apple stamps its EPs " - EP".
 */
export function releaseKind(name: string, trackCount?: number): ShopReleaseKind {
  if (/\s[-–—]\s*EP$/i.test(name)) return 'EP'
  if (/\s[-–—]\s*Single$/i.test(name)) return 'SINGLE'
  if (trackCount === 1) return 'SINGLE'
  return 'ALBUM'
}

/** Apple's " - Single" / " - EP" off a title, for display.
 *  ⚠️ TWIN: src/main/streamrip-match.ts searchTitle (same suffix). */
export function displayAlbumTitle(name: string): string {
  return name.replace(/\s[-–—]\s*(EP|Single)$/i, '').trim() || name
}

/** The title without its brackets or a trailing " - …": "Wish You Were Here (2011 Remaster)" → "Wish You Were Here". */
export function baseAlbumTitle(name: string): string {
  return displayAlbumTitle(name)
    .replace(/[([{][^()[\]{}]*[)\]}]/g, '')
    .replace(/\s+[-–—]\s+[^-–—]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim() || name
}

const key = (s: string): string => nameKey(s, '')

/**
 * Words in a bracket or a trailing " - …" that make another record of the same
 * title: "Tommy (Live)" is not "Tommy", "Bags (Remix)" is not "Bags". A
 * remaster, a deluxe, a year or a dated remix ("2018 Remix") is the same record.
 */
const VARIANT_WORD = /\b(live|demos?|remix(?:es|ed)?|acoustic|instrumentals?|unplugged|karaoke|a ?cappella|acapella|rehearsals?|outtakes?|sessions?|in concert)\b/g

/** The variant words a title carries in its brackets or trailing " - …", sorted ("" for none). */
export function albumVariantTag(name: string): string {
  const shown = displayAlbumTitle(name)
  const parts = [...shown.matchAll(/[([{]([^()[\]{}]*)[)\]}]/g)].map((m) => m[1])
  const dash = shown.match(/\s+[-–—]\s+([^-–—]+)$/)
  if (dash) parts.push(dash[1])
  const words = new Set<string>()
  for (const p of parts) {
    // "Animals (2018 Remix)" is the record mixed again, as a remaster is: a year beside "remix" is the same record.
    const dated = /\b(19|20)\d\d\b/.test(p)
    for (const m of nameKey(p).matchAll(VARIANT_WORD)) if (!(dated && m[1].startsWith('remix'))) words.add(m[1].replace(/\s+/g, ''))
  }
  return [...words].sort().join('+')
}

/** The plain-title key: the title without its brackets, plus its variant words, so "Tommy" never matches "Tommy (Live)". */
const baseKey = (name: string): string => `~${key(baseAlbumTitle(name))}#${albumVariantTag(name)}`
const spaced = (s: string): string => nameKey(s)
const stripThe = (s: string): string => s.replace(/^the /, '')

// ── Relevance ──────────────────────────────────────────────────────────

/**
 * exact > prefix > token start > substring > all tokens > a near spelling.
 * ⚠️ TWIN: src/renderer/utils/searchIndex.ts scoreField (moved here from
 * DownloadView, which imports it).
 */
export function scoreField(field: string, query: string, qTokens: string[]): number {
  if (!field || !query) return 0
  if (field === query) return 100 + Math.min(20, query.length)
  if (field.startsWith(query)) return 70 + Math.min(20, query.length)
  if ((' ' + field).includes(' ' + query)) return 50
  if (field.includes(query)) return 30
  if (qTokens.length > 1 && qTokens.every((qt) => field.includes(qt))) return 20
  // Typo tier, last: Apple corrects "radiohed" to Radiohead, and the correction must not be discarded.
  const fTokens = field.split(' ').filter(Boolean)
  if (qTokens.length && fTokens.length) {
    const near = qTokens.every((qt) => fTokens.some((ft) => withinEditDistance(qt, ft, typoBudget(qt.length))))
    if (near) return 14
  }
  return 0
}

/** A title + artist against the query, each alone and joined ("when you die mgmt"). */
export function scoreResult(q: string, qTokens: string[], title: string, artist: string): number {
  const t = scoreField(spaced(title), q, qTokens)
  const aRaw = spaced(artist)
  const a = Math.max(scoreField(aRaw, q, qTokens), scoreField(stripThe(aRaw), q, qTokens))
  const combo = Math.max(
    scoreField(`${spaced(title)} ${aRaw}`, q, qTokens),
    scoreField(`${aRaw} ${spaced(title)}`, q, qTokens),
  )
  return Math.max(t * 1.0 + a * 1.15, combo * 1.2)
}

/** The query as the scorers read it. */
export function queryTokens(query: string): { q: string; tokens: string[] } {
  const q = spaced(query)
  return { q, tokens: q ? q.split(' ') : [] }
}

/** True when the artist's name IS what was typed ("pink floyd", "the beatles" for "beatles"). */
export function isArtistQuery(query: string, name: string): boolean {
  const q = spaced(query), n = spaced(name)
  return !!q && !!n && (q === n || stripThe(q) === stripThe(n))
}

// ── Apple's rows ───────────────────────────────────────────────────────

const yearOf = (raw: unknown): number | undefined => {
  if (typeof raw !== 'string') return undefined
  const m = /^(\d{4})/.exec(raw)
  if (!m) return undefined
  const y = Number(m[1])
  return y >= 1900 && y <= 2100 ? y : undefined
}

/** Artist rows of an iTunes search answer. */
export function appleArtistRows(results: ReadonlyArray<Record<string, unknown>> | undefined): ShopArtist[] {
  return (results || [])
    .filter((r) => (r.wrapperType === 'artist' || r.artistType === 'Artist') && typeof r.artistId === 'number' && typeof r.artistName === 'string')
    .map((r) => ({ artistId: Number(r.artistId), name: String(r.artistName), genre: typeof r.primaryGenreName === 'string' ? r.primaryGenreName : undefined }))
    .filter((a) => a.name && !JUNK_ARTIST_NAME.test(a.name))
}

/** Album rows of an iTunes search or lookup answer. */
export function appleAlbumRows(results: ReadonlyArray<Record<string, unknown>> | undefined): ShopAlbum[] {
  return (results || [])
    .filter((r) => r.wrapperType === 'collection' && typeof r.collectionId === 'number' && typeof r.collectionName === 'string')
    .map((r) => ({
      collectionId: Number(r.collectionId),
      name: String(r.collectionName),
      artist: String(r.artistName ?? ''),
      artistId: typeof r.artistId === 'number' ? r.artistId : undefined,
      artworkUrl: typeof r.artworkUrl100 === 'string' ? r.artworkUrl100.replace('100x100', '200x200') : undefined,
      releaseDate: typeof r.releaseDate === 'string' ? r.releaseDate : undefined,
      releaseYear: yearOf(r.releaseDate),
      trackCount: typeof r.trackCount === 'number' ? r.trackCount : undefined,
      genre: typeof r.primaryGenreName === 'string' ? r.primaryGenreName : undefined,
      explicitness: typeof r.collectionExplicitness === 'string' ? r.collectionExplicitness : undefined,
    }))
    .filter((a) => a.name && a.artist && !JUNK_ARTIST_NAME.test(a.artist) && !JUNK_ARTIST_NAME.test(a.name))
}

/**
 * One row per record: Apple lists the censored and the uncensored editions
 * under the same artist and title, and the explicit one keeps the row
 * (explicitWins: only 'cleaned' ever loses). A deluxe or a remaster has its
 * own name and stays its own row. First seen keeps its place.
 */
export function collapseCleanTwins(albums: readonly ShopAlbum[]): ShopAlbum[] {
  const at = new Map<string, number>()
  const out: ShopAlbum[] = []
  for (const a of albums) {
    const k = `${key(a.artist)}|${key(a.name)}`
    const i = at.get(k)
    if (i === undefined) { at.set(k, out.length); out.push(a); continue }
    if (explicitWins(out[i].explicitness, a.explicitness)) out[i] = { ...a, artworkUrl: a.artworkUrl ?? out[i].artworkUrl }
  }
  return out
}

// ── The grouped answer ─────────────────────────────────────────────────

export const MAX_SHOP_ARTISTS = 4
export const MAX_SHOP_ALBUMS = 30

export interface RankedShop {
  artists: ShopArtist[]
  albums: ShopAlbum[]
}

const KIND_NUDGE: Record<ShopReleaseKind, number> = { ALBUM: 3, EP: 1, SINGLE: 0 }

/**
 * Artists, then albums (songs are ranked by the song search, as before).
 *
 * - An artist whose name is what was typed comes first; the rest by how well
 *   their name matches, Apple's order breaking ties. Nothing that doesn't match.
 * - Albums by how well title + artist match. When the first artist is the
 *   query itself, that artist's own records come first (Pink Floyd's albums,
 *   not a tribute that says "Pink Floyd" in its title), and among equals an
 *   album before an EP before a single, then Apple's order.
 */
export function rankShop(query: string, artists: readonly ShopArtist[], albums: readonly ShopAlbum[]): RankedShop {
  const { q, tokens } = queryTokens(query)
  if (!q) return { artists: [], albums: [] }
  const seenArtist = new Set<number>()
  const scoredArtists = artists
    .filter((a) => { if (seenArtist.has(a.artistId)) return false; seenArtist.add(a.artistId); return true })
    .map((a, i) => ({ a, i, s: isArtistQuery(query, a.name) ? 1000 : Math.max(scoreField(spaced(a.name), q, tokens), scoreField(stripThe(spaced(a.name)), q, tokens)) }))
    .filter((x) => x.s > 0)
    .sort((x, y) => (y.s - x.s) || (x.i - y.i))
  const rankedArtists = scoredArtists.slice(0, MAX_SHOP_ARTISTS).map((x) => x.a)
  const named = scoredArtists[0]?.s === 1000 ? scoredArtists[0].a : null

  const rankedAlbums = collapseCleanTwins(albums)
    .map((a, i) => {
      let s = scoreResult(q, tokens, displayAlbumTitle(a.name), a.artist)
      const own = !!named && (a.artistId === named.artistId || (a.artistId === undefined && key(a.artist) === key(named.name)))
      if (own) s += 500
      if (s > 0) s += KIND_NUDGE[releaseKind(a.name, a.trackCount)]
      return { a, i, s }
    })
    .filter((x) => x.s > 0)
    .sort((x, y) => (y.s - x.s) || (x.i - y.i))
    .slice(0, MAX_SHOP_ALBUMS)
    .map((x) => x.a)
  return { artists: rankedArtists, albums: rankedAlbums }
}

/** An artist's picture: the cover of their first album in the answer (Apple gives artists none). */
export function artistArtwork(artist: ShopArtist, albums: readonly ShopAlbum[]): string | undefined {
  return albums.find((a) => a.artworkUrl && (a.artistId === artist.artistId || key(a.artist) === key(artist.name)))?.artworkUrl
}

// ── The artist page ────────────────────────────────────────────────────

export interface ArtistReleases {
  albums: ShopAlbum[]
  eps: ShopAlbum[]
  singles: ShopAlbum[]
}

/**
 * An artist's own releases from Apple's album lookup, grouped Albums, EPs,
 * Singles, each newest first (Apple's order breaking ties). Only records the
 * artist is the main credit on (their guest spots are other people's
 * records), one row per record (the explicit edition wins its clean twin).
 */
export function artistReleases(rows: readonly ShopAlbum[], artist: { artistId: number; name: string }): ArtistReleases {
  const own = rows.filter((a) => a.artistId === artist.artistId || (a.artistId === undefined && key(a.artist) === key(artist.name)))
  const ordered = collapseCleanTwins(own)
    .map((a, i) => ({ a, i }))
    .sort((x, y) => (String(y.a.releaseDate ?? y.a.releaseYear ?? '')).localeCompare(String(x.a.releaseDate ?? x.a.releaseYear ?? '')) || (x.i - y.i))
    .map((x) => x.a)
  const out: ArtistReleases = { albums: [], eps: [], singles: [] }
  for (const a of ordered) {
    const k = releaseKind(a.name, a.trackCount)
    if (k === 'ALBUM') out.albums.push(a)
    else if (k === 'EP') out.eps.push(a)
    else out.singles.push(a)
  }
  return out
}

// ── In your library / On your list ─────────────────────────────────────

export interface LibraryMarks {
  /** title|artist → true */
  songs: Set<string>
  /** album|artist (full name and base title) → songs Jake has from it */
  albums: Map<string, number>
  artists: Set<string>
}

/** The library, keyed the way results are marked. ⚠️ TWIN: DownloadView libIndex (same keys). */
export function libraryMarks(tracks: ReadonlyArray<{ title?: string; artist?: string; album?: string; albumArtist?: string }>): LibraryMarks {
  const songs = new Set<string>()
  const albums = new Map<string, number>()
  const artists = new Set<string>()
  const bump = (k: string) => albums.set(k, (albums.get(k) ?? 0) + 1)
  for (const t of tracks) {
    const a = key(t.artist || '')
    if (a) artists.add(a)
    const aa = key(t.albumArtist || '')
    if (aa) artists.add(aa)
    if (t.title) songs.add(`${key(t.title)}|${a}`)
    if (t.album) {
      const full = `${key(t.album)}|${a}`
      const base = `${baseKey(t.album)}|${a}`
      bump(full)
      bump(base)
      if (aa && aa !== a) { bump(`${key(t.album)}|${aa}`); bump(`${baseKey(t.album)}|${aa}`) }
    }
  }
  return { songs, albums, artists }
}

export type OwnedAlbum = { state: 'all' | 'some'; have: number } | null

/**
 * How much of a record Jake has. The exact name first, then the plain title
 * (his "Wish You Were Here" is Apple's "Wish You Were Here (2011 Remaster)").
 * All of it when he has at least as many songs as the record holds (or the
 * size is unknown); some when fewer.
 */
export function ownedAlbum(m: LibraryMarks, artist: string, name: string, trackCount?: number): OwnedAlbum {
  const a = key(artist)
  const have = m.albums.get(`${key(displayAlbumTitle(name))}|${a}`) ?? m.albums.get(`${key(name)}|${a}`) ?? m.albums.get(`${baseKey(name)}|${a}`) ?? 0
  if (have <= 0) return null
  return { state: !trackCount || have >= trackCount ? 'all' : 'some', have }
}

export const ownsSong = (m: LibraryMarks, artist: string, title: string): boolean => m.songs.has(`${key(title)}|${key(artist)}`)
export const ownsArtist = (m: LibraryMarks, name: string): boolean => m.artists.has(key(name))

export interface ListMarks { songs: Set<string>; albums: Set<string>; artists: Set<string> }

/**
 * What is jotted on the Listen List and not yet had: songs by title + artist,
 * albums by title (and plain title) + artist, artists by name. A row already
 * fulfilled (`owned`) isn't "on your list" any more.
 */
export function listMarks(recs: ReadonlyArray<{ kind?: string; song?: string; artist?: string; album?: string; owned?: boolean }>): ListMarks {
  const out: ListMarks = { songs: new Set(), albums: new Set(), artists: new Set() }
  for (const r of recs) {
    if (r.owned) continue
    if (r.kind === 'concert' || r.kind === 'playlist') continue
    const a = key(r.artist || '')
    if (!a) continue
    const song = (r.song || '').trim()
    const album = (r.album || '').trim()
    if (r.kind === 'artist') { out.artists.add(a); continue }
    if (song && r.kind !== 'album') { out.songs.add(`${key(song)}|${a}`); continue }
    if (album) { out.albums.add(`${key(album)}|${a}`); out.albums.add(`${baseKey(album)}|${a}`); continue }
    if (!song && !album) out.artists.add(a)
  }
  return out
}

export const listedSong = (m: ListMarks, artist: string, title: string): boolean => m.songs.has(`${key(title)}|${key(artist)}`)
export const listedAlbum = (m: ListMarks, artist: string, name: string): boolean => {
  const a = key(artist)
  return m.albums.has(`${key(displayAlbumTitle(name))}|${a}`) || m.albums.has(`${baseKey(name)}|${a}`)
}
export const listedArtist = (m: ListMarks, name: string): boolean => m.artists.has(key(name))

/** The mark a result wears: library first (it is the stronger fact), then the list. */
export function markLine(o: { owned?: OwnedAlbum | boolean; listed?: boolean }): string | null {
  const own = o.owned
  if (own === true) return 'In your library'
  if (own && typeof own === 'object') return own.state === 'all' ? 'In your library' : `${own.have} song${own.have === 1 ? '' : 's'} in your library`
  if (o.listed) return 'On your list'
  return null
}

// ── The library above the catalogue ────────────────────────────────────

/** Library hits strong enough to sit above the shop: a whole word or better (searchIndex scores ≥ 45). */
export const LIBRARY_HIT_MIN = 45
export const LIBRARY_HITS_MAX = 6

/**
 * Jake's own matches, artists first, then albums, then songs, each only when it
 * matched on a whole word or better, at most LIBRARY_HITS_MAX in all. Pure over
 * the library search's sections (renderer/utils/searchIndex.ts search).
 */
export function pickLibraryHits<A, B, C>(sections: { artists: Array<{ row: A; score: number }>; albums: Array<{ row: B; score: number }>; tracks: Array<{ row: C; score: number }> }, o: { min?: number; max?: number } = {}): Array<{ kind: 'artist'; row: A } | { kind: 'album'; row: B } | { kind: 'song'; row: C }> {
  const min = o.min ?? LIBRARY_HIT_MIN
  const max = o.max ?? LIBRARY_HITS_MAX
  const out: Array<{ kind: 'artist'; row: A } | { kind: 'album'; row: B } | { kind: 'song'; row: C }> = []
  for (const x of sections.artists.slice(0, 2)) if (x.score >= min) out.push({ kind: 'artist', row: x.row })
  for (const x of sections.albums.slice(0, 3)) if (x.score >= min) out.push({ kind: 'album', row: x.row })
  for (const x of sections.tracks.slice(0, 3)) if (x.score >= min) out.push({ kind: 'song', row: x.row })
  return out.slice(0, max)
}
