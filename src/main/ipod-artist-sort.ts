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
