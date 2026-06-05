/**
 * 4.5: Universal-search index. In-memory fuzzy search over the
 * library — tracks, albums, artists, playlists — feeding the slide-
 * out panel under the top-right search pill. Built once at library
 * load + per playlist mutation; filtered per keystroke in ~5-15ms
 * even on 6000+ track libraries.
 *
 * Design notes:
 *  - Diacritic folding so "beyonce" matches "Beyoncé", "celine" matches
 *    "Céline Dion". Also lowercases + strips ASCII punctuation so
 *    "Don't Stop" matches "dont stop".
 *  - Field-weighted scorer: title hits outrank artist hits outrank
 *    album hits. Prefix match outranks substring; exact match outranks
 *    prefix. Token-anywhere match (e.g. "machine" matches "Time Machine")
 *    is a baseline.
 *  - Sectioned results: tracks/albums/artists/playlists. Each section
 *    capped at 8 visible rows; "see all" routes to per-type view.
 *  - Albums + artists are derived from tracks on index build, not
 *    stored separately. One pass through tracks during build, no
 *    per-keystroke aggregation.
 */

import type { Track, Playlist } from '../types'
import { albumKeyOf } from './albumKey'

// ── Normalization ───────────────────────────────────────────────────
/**
 * Lowercases + folds diacritics + strips ASCII punctuation. Returns
 * the canonical form used for both index storage and query matching.
 * "Beyoncé — Crazy in Love (feat. JAY-Z)" → "beyonce crazy in love feat jayz"
 */
export function normalize(s: string | null | undefined): string {
  if (!s) return ''
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')     // strip combining diacritics
    .replace(/['''‛`]/g, '')              // strip straight + smart apostrophes (don't / don't → dont)
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')        // ASCII punct + non-letter → space
    .replace(/\s+/g, ' ')
    .trim()
}

/** Cheap token split — splits on whitespace after normalize. */
function tokens(s: string): string[] {
  const n = normalize(s)
  return n ? n.split(' ') : []
}

// ── Index types ─────────────────────────────────────────────────────
export interface TrackRow {
  kind: 'track'
  id: number
  title: string
  artist: string
  album: string
  // Pre-normalized fields for matching, computed at build time.
  nTitle: string
  nArtist: string
  nAlbum: string
}

export interface AlbumRow {
  kind: 'album'
  /** Canonical key — "artistFolded|||albumFolded". Matches the format
   *  HomeView + AlbumsView use so click-through navigation aligns. */
  key: string
  album: string
  artist: string
  trackCount: number
  nAlbum: string
  nArtist: string
}

export interface ArtistRow {
  kind: 'artist'
  name: string
  trackCount: number
  nName: string
}

export interface PlaylistRow {
  kind: 'playlist'
  id: string
  name: string
  trackCount: number
  nName: string
}

export type SearchRow = TrackRow | AlbumRow | ArtistRow | PlaylistRow

export interface SearchIndex {
  tracks: TrackRow[]
  albums: AlbumRow[]
  artists: ArtistRow[]
  playlists: PlaylistRow[]
}

// ── Build ──────────────────────────────────────────────────────────
export function buildIndex(tracks: Track[], playlists: Playlist[]): SearchIndex {
  const trackRows: TrackRow[] = []
  const albumMap = new Map<string, AlbumRow>()
  const artistMap = new Map<string, ArtistRow>()

  for (const t of tracks) {
    const nTitle = normalize(t.title)
    const nArtist = normalize(t.artist)
    const nAlbum = normalize(t.album)
    trackRows.push({
      kind: 'track',
      id: t.id,
      title: t.title || '',
      artist: t.artist || '',
      album: t.album || '',
      nTitle, nArtist, nAlbum,
    })

    // 4.5.0-73 — album key MUST match the one AlbumsView uses to
    // group + match its `selected` state. Use the shared albumKeyOf
    // helper. Pre-fix the search index built normalized keys
    // (punctuation stripped, artist only — no albumArtist fallback);
    // AlbumsView built unnormalized keys with `albumArtist || artist`.
    // Click-through landed in AlbumsView with a `pendingAlbumKey` that
    // matched nothing in its `albums` Map → no selection → user lost
    // on the full grid.
    const albumKey = albumKeyOf(t)
    if (t.album) {
      const existing = albumMap.get(albumKey)
      if (existing) existing.trackCount++
      else albumMap.set(albumKey, {
        kind: 'album',
        key: albumKey,
        album: t.album || '',
        // Display the albumArtist when present (e.g. compilations show
        // "Various Artists" not the first track's individual artist).
        artist: t.albumArtist || t.artist || '',
        trackCount: 1,
        nAlbum, nArtist,
      })
    }

    // Aggregate artist by normalized name
    if (t.artist) {
      const existing = artistMap.get(nArtist)
      if (existing) existing.trackCount++
      else artistMap.set(nArtist, {
        kind: 'artist',
        name: t.artist || '',
        trackCount: 1,
        nName: nArtist,
      })
    }
  }

  const playlistRows: PlaylistRow[] = playlists.map(p => ({
    kind: 'playlist',
    id: p.id,
    name: p.name || '',
    trackCount: p.trackIds?.length || 0,
    nName: normalize(p.name),
  }))

  return {
    tracks: trackRows,
    albums: [...albumMap.values()],
    artists: [...artistMap.values()],
    playlists: playlistRows,
  }
}

// ── Score + match ──────────────────────────────────────────────────
/**
 * Scores a normalized field value against the normalized query.
 * Higher = better match. 0 = no match.
 * Weighting tiers:
 *   - exact match:     100 + length-bonus
 *   - prefix match:    70 + length-bonus
 *   - token-start:     50  (query starts a word in the field)
 *   - substring:       30
 *   - all-tokens-hit:  20  (every query token appears somewhere)
 */
function scoreField(field: string, query: string, qTokens: string[]): number {
  if (!field || !query) return 0
  if (field === query) return 100 + Math.min(20, query.length)
  if (field.startsWith(query)) return 70 + Math.min(20, query.length)
  // Token-start: query appears at the start of any word in the field.
  // Cheap to check via " " + field including a " " + query prefix.
  if ((' ' + field).includes(' ' + query)) return 50
  if (field.includes(query)) return 30
  // Last resort: every query token appears somewhere in the field
  // (handles word-reorder queries like "love crazy" → "crazy in love").
  if (qTokens.length > 1 && qTokens.every(qt => field.includes(qt))) return 20
  return 0
}

export interface RankedRow { row: SearchRow; score: number }
export interface SearchResults {
  tracks: RankedRow[]
  albums: RankedRow[]
  artists: RankedRow[]
  playlists: RankedRow[]
  /** Single best hit across all sections, for the "top hit" hero row. */
  topHit: RankedRow | null
}

/**
 * Field weights — title hits outrank artist hits outrank album hits,
 * so searching "kind" surfaces a TRACK titled "kind" above an album
 * by an artist whose surname contains "kind". Tunable per taste.
 */
const W_TITLE  = 1.0
const W_ARTIST = 0.9
const W_ALBUM  = 0.8
const W_GENRE  = 0.4
const W_PLAYS  = 0.3  // playlist name match

export function search(idx: SearchIndex, rawQuery: string, opts?: { perSectionCap?: number }): SearchResults {
  const q = normalize(rawQuery)
  if (!q) return { tracks: [], albums: [], artists: [], playlists: [], topHit: null }
  const qTokens = q.split(' ')
  const cap = opts?.perSectionCap ?? 8

  const trackHits: RankedRow[] = []
  for (const t of idx.tracks) {
    const sTitle  = scoreField(t.nTitle,  q, qTokens) * W_TITLE
    const sArtist = scoreField(t.nArtist, q, qTokens) * W_ARTIST
    const sAlbum  = scoreField(t.nAlbum,  q, qTokens) * W_ALBUM
    const score = sTitle + sArtist + sAlbum
    if (score > 0) trackHits.push({ row: t, score })
  }
  trackHits.sort((a, b) => b.score - a.score)

  const albumHits: RankedRow[] = []
  for (const a of idx.albums) {
    const sAlbum  = scoreField(a.nAlbum,  q, qTokens) * W_ALBUM
    const sArtist = scoreField(a.nArtist, q, qTokens) * W_ARTIST * 0.5
    const score = sAlbum + sArtist
    if (score > 0) albumHits.push({ row: a, score })
  }
  albumHits.sort((a, b) => b.score - a.score)

  const artistHits: RankedRow[] = []
  for (const a of idx.artists) {
    const score = scoreField(a.nName, q, qTokens) * W_ARTIST
    if (score > 0) artistHits.push({ row: a, score })
  }
  artistHits.sort((a, b) => b.score - a.score)

  const playlistHits: RankedRow[] = []
  for (const p of idx.playlists) {
    const score = scoreField(p.nName, q, qTokens) * W_PLAYS
    if (score > 0) playlistHits.push({ row: p, score })
  }
  playlistHits.sort((a, b) => b.score - a.score)

  // Suppress unused-var warning for genre weight; reserved for a
  // future genre section if we ever add it.
  void W_GENRE

  // Top hit: highest absolute score across all sections.
  const candidates = [
    trackHits[0],
    albumHits[0],
    artistHits[0],
    playlistHits[0],
  ].filter((r): r is RankedRow => !!r)
  candidates.sort((a, b) => b.score - a.score)
  const topHit = candidates[0] || null

  return {
    tracks: trackHits.slice(0, cap),
    albums: albumHits.slice(0, cap),
    artists: artistHits.slice(0, cap),
    playlists: playlistHits.slice(0, cap),
    topHit,
  }
}
