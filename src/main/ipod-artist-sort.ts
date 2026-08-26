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
 * Do NOT use this fold for iTunesDB type-52 sort tables — those must
 * match firmware collation (_fold in db_reader.py) or Songs drops rows.
 */

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
 * Does NOT strip a leading "The " — Mini 1.4.1 discards out-of-order
 * type-52 rows (Tiësto / Entrañas / The-prefixed titles vanish from Songs).
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

/** Music > Songs write / type-52 key 7 order (firmware fold of sortTitle || title). */
export function orderTracksForIpodTitleIndex<T extends {
  title?: unknown
  sortTitle?: unknown
  artist?: unknown
  album?: unknown
  trackNumber?: unknown
}>(tracks: T[]): T[] {
  return [...tracks].sort((a, b) => {
    const c = ipodFirmwareFold(optionalSortText(a.title, a.sortTitle)).localeCompare(
      ipodFirmwareFold(optionalSortText(b.title, b.sortTitle)),
      undefined,
      { numeric: true, sensitivity: 'base' },
    )
    if (c !== 0) return c
    const art = ipodFirmwareFold(String(a.artist || '')).localeCompare(
      ipodFirmwareFold(String(b.artist || '')),
      undefined,
      { numeric: true, sensitivity: 'base' },
    )
    if (art !== 0) return art
    const alb = ipodFirmwareFold(String(a.album || '')).localeCompare(
      ipodFirmwareFold(String(b.album || '')),
      undefined,
      { numeric: true, sensitivity: 'base' },
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

/** Unique genres in Music > Genres A–Z (firmware fold — type-52 key 5).
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
