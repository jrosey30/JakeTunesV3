/**
 * iPod-native artist sort — Music > Artists A–Z on the Mini.
 *
 * Activity sync used to write tracks (and therefore the mhia album list)
 * in picker/score order. The Mini's Artists menu follows that first-seen
 * order, so a 500-song set looked shuffled instead of A–Z.
 *
 * Sort is case-insensitive, ignores a leading "The "/"A "/"An ", strips
 * leading punctuation, and prefers an explicit sortArtist when present.
 *
 * ⚠️ TWIN: src/renderer/utils/artistSort.ts artistSortName / compareNames
 * ⚠️ TWIN: core/db_reader.py ipod_artist_sort_key / ipod_artist_sort_label
 *
 * The iTunesDB type-52 sort tables use this strip too, then the firmware
 * fold (ipodMenuSortText below; twin of db_reader.py menu_sort_text).
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function ipodArtistSortKey(artist: string, sortArtist?: string | null): string {
  const raw = (sortArtist && String(sortArtist).trim()) ? String(sortArtist) : String(artist || '')
  return artistSortName(raw)
}

/** Same algorithm as renderer artistSortName — keep the twins in lockstep. */
export function artistSortName(name: string): string {
  let s = (name || '').trim().toLowerCase()
  let prev = ''
  while (s && s !== prev) {
    prev = s
    s = s.replace(/^[\p{P}\p{S}\s]+/u, '')
    s = s.replace(/^(?:the|a|an)\s+/, '')
    s = s.trim()
  }
  return s || (name || '').trim().toLowerCase()
}

/** Display sort-artist written to iTunesDB mhod 22 ("Beatles" for "The Beatles"). */
export function ipodArtistSortLabel(artist: string, sortArtist?: string | null): string {
  if (sortArtist && String(sortArtist).trim()) return String(sortArtist).trim()
  const raw = String(artist || '').trim()
  if (!raw) return ''
  let s = raw
  let prev = ''
  while (s && s !== prev) {
    prev = s
    s = s.replace(/^[\p{P}\p{S}\s]+/u, '')
    s = s.replace(/^(?:[Tt][Hh][Ee]|[Aa][Nn]|[Aa])\s+/, '')
    s = s.trim()
  }
  return s || raw
}

export function compareIpodArtistNames(a: string, b: string, aSort?: string | null, bSort?: string | null): number {
  return ipodArtistSortKey(a, aSort).localeCompare(ipodArtistSortKey(b, bSort), undefined, {
    numeric: true,
    sensitivity: 'base',
  })
}

function numField(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export function orderTracksForIpodArtistIndex<T extends {
  artist?: unknown
  sortArtist?: unknown
  album?: unknown
  discNumber?: unknown
  trackNumber?: unknown
  title?: unknown
}>(tracks: T[]): T[] {
  return [...tracks].sort((a, b) => {
    const c = compareIpodArtistNames(
      String(a.artist || ''),
      String(b.artist || ''),
      a.sortArtist == null ? null : String(a.sortArtist),
      b.sortArtist == null ? null : String(b.sortArtist),
    )
    if (c !== 0) return c
    const alb = artistSortName(String(a.album || '')).localeCompare(
      artistSortName(String(b.album || '')),
      undefined,
      { numeric: true, sensitivity: 'base' },
    )
    if (alb !== 0) return alb
    const disc = numField(a.discNumber) - numField(b.discNumber)
    if (disc !== 0) return disc
    const tn = numField(a.trackNumber) - numField(b.trackNumber)
    if (tn !== 0) return tn
    return String(a.title || '').localeCompare(String(b.title || ''), undefined, {
      numeric: true,
      sensitivity: 'base',
    })
  })
}

export function stampIpodSortArtist<T extends { artist?: unknown; sortArtist?: unknown }>(track: T): T {
  const existing = String(track.sortArtist || '').trim()
  if (existing) return track
  const label = ipodArtistSortLabel(String(track.artist || ''))
  if (!label) return track
  track.sortArtist = label
  return track
}

/**
 * Firmware collation for iTunesDB type-52 tables.
 *
 * ⚠️ TWIN: core/db_reader.py _fold
 *
 * NFKD-strip combining marks, normalize typographic quotes/dashes, casefold.
 * Accents MUST fold: Mini 1.4.1 discarded out-of-order type-52 rows
 * (Tiësto / Entrañas vanished from Songs, 2026-07-21). This fold keeps a
 * leading "The "; ipodMenuSortText strips it first.
 */
export function ipodFirmwareFold(s: string): string {
  return String(s || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u00A0/g, ' ')
    .toLocaleLowerCase('en')
}

function optionalSortText(display: unknown, sortValue?: unknown): string {
  const stamped = String(sortValue || '').trim()
  if (stamped) return stamped
  return String(display || '')
}

/**
 * Kill switch (2026-11-07): when this file exists the type-52 tables and
 * this module sort exactly as before — "The Strokes" under T.
 * ⚠️ TWIN: core/db_reader.py IPOD_SORT_KEEP_THE_FILE / ipod_sort_keeps_the.
 * Both halves read the same file, so they cannot split.
 */
export const IPOD_SORT_KEEP_THE_FILE = join('.config', 'jaketunes', 'ipod-sort-keep-the')

export function ipodSortKeepsThe(): boolean {
  try {
    return existsSync(join(homedir(), IPOD_SORT_KEEP_THE_FILE))
  } catch {
    return false
  }
}

/**
 * Music-menu sort text for one component (title / album / artist).
 * ⚠️ TWIN: core/db_reader.py menu_sort_text (and the kill-switch branch of
 * _sort_indices). Explicit sort field when present, else the display text;
 * leading punctuation and The/A/An dropped (artistSortName), then the
 * firmware fold. With keepThe, the old rule: fold of sortTitle/sortAlbum ||
 * display, and the artist ignores sortArtist.
 */
export function ipodMenuSortText(
  display: unknown,
  sortValue: unknown,
  keepThe: boolean,
  field: 'title' | 'album' | 'artist' = 'title',
): string {
  if (keepThe) {
    return ipodFirmwareFold(field === 'artist' ? String(display || '') : optionalSortText(display, sortValue))
  }
  return ipodFirmwareFold(ipodArtistSortKey(String(display || ''), sortValue == null ? null : String(sortValue)))
}

/** Music > Songs write / type-52 key 3 order (ipodMenuSortText of sortTitle || title). */
export function orderTracksForIpodTitleIndex<T extends {
  title?: unknown
  sortTitle?: unknown
  artist?: unknown
  sortArtist?: unknown
  album?: unknown
  sortAlbum?: unknown
  trackNumber?: unknown
}>(tracks: T[], keepThe: boolean = ipodSortKeepsThe()): T[] {
  const cmp = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
  return [...tracks].sort((a, b) => {
    const c = cmp(ipodMenuSortText(a.title, a.sortTitle, keepThe, 'title'), ipodMenuSortText(b.title, b.sortTitle, keepThe, 'title'))
    if (c !== 0) return c
    const art = cmp(ipodMenuSortText(a.artist, a.sortArtist, keepThe, 'artist'), ipodMenuSortText(b.artist, b.sortArtist, keepThe, 'artist'))
    if (art !== 0) return art
    // Under the kill switch the old tiebreak read the display album.
    const alb = cmp(
      ipodMenuSortText(a.album, keepThe ? undefined : a.sortAlbum, keepThe, 'album'),
      ipodMenuSortText(b.album, keepThe ? undefined : b.sortAlbum, keepThe, 'album'),
    )
    if (alb !== 0) return alb
    return numField(a.trackNumber) - numField(b.trackNumber)
  })
}

/** Unique albums in Music > Albums A–Z (article-strip / sortAlbum — mhia, not type-52).
 *  ⚠️ TWIN: core/db_reader.py album_tuples_for_itunesdb
 */
export function orderAlbumsForIpodIndex<T extends {
  album?: unknown
  sortAlbum?: unknown
  artist?: unknown
  albumArtist?: unknown
}>(tracks: T[]): Array<{ artist: string; albumArtist: string; album: string }> {
  const seen = new Set<string>()
  const rows: Array<{ artist: string; albumArtist: string; album: string; sortAlbum?: string }> = []
  for (const t of tracks) {
    const album = String(t.album || '').trim()
    if (!album) continue
    const artist = String(t.artist || '').trim()
    const albumArtist = String(t.albumArtist || t.artist || '').trim()
    const key = `${albumArtist.toLowerCase()}\0${album.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    const sortAlbum = String(t.sortAlbum || '').trim()
    rows.push({ artist, albumArtist, album, sortAlbum: sortAlbum || undefined })
  }
  rows.sort((a, b) => {
    const c = compareIpodArtistNames(a.album, b.album, a.sortAlbum, b.sortAlbum)
    if (c !== 0) return c
    return compareIpodArtistNames(a.artist, b.artist)
  })
  return rows.map(({ artist, albumArtist, album }) => ({ artist, albumArtist, album }))
}

/** Unique genres in Music > Genres A–Z (firmware fold — type-52 key 7).
 *  ⚠️ TWIN: core/db_reader.py unique_genre_names_az
 */
export function uniqueGenresAz<T extends { genre?: unknown }>(tracks: T[]): string[] {
  const seen = new Set<string>()
  const names: string[] = []
  for (const t of tracks) {
    const g = String(t.genre || '').trim()
    if (!g) continue
    const k = g.toLocaleLowerCase('en')
    if (seen.has(k)) continue
    seen.add(k)
    names.push(g)
  }
  names.sort((a, b) => ipodFirmwareFold(a).localeCompare(ipodFirmwareFold(b), undefined, {
    numeric: true,
    sensitivity: 'base',
  }))
  return names
}
