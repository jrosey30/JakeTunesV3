/** Minimal fields needed to order tracks on an album page. */
export interface AlbumTrackSortable {
  discNumber?: number | string
  trackNumber?: number | string
  title?: string
}

/**
 * Standard album track order: disc, then track number, then title.
 * Missing disc defaults to 1 (iTunes / ID3 convention) — NOT 0, which
 * would float orphan-tagged tracks ahead of everything on disc 1.
 */
export function compareAlbumTracks(a: AlbumTrackSortable, b: AlbumTrackSortable): number {
  const da = Number(a.discNumber) || 1
  const db = Number(b.discNumber) || 1
  if (da !== db) return da - db
  const ta = Number(a.trackNumber) || 0
  const tb = Number(b.trackNumber) || 0
  if (ta !== tb) return ta - tb
  return (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' })
}

export function sortAlbumTracks<T extends AlbumTrackSortable>(tracks: readonly T[]): T[] {
  return tracks.slice().sort(compareAlbumTracks)
}
