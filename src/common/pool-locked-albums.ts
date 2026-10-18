/**
 * Albums LOCKED into the iPod Pool (Jake, 2026-10-18: "all geese studio
 * discography is to be locked in the pool"). Like the always-in lists
 * (renderer/utils/poolPinnedLists.ts), they are resolved live from the
 * library at every sync — they are not pool drops, so the 1,000 roll-off
 * can never push them out — and they come FIRST in the pinned order, ahead
 * of Recently Added / Bops / Rocksurgence.
 *
 * Geese studio albums = MusicBrainz release groups typed Album with no
 * secondary type (artist e0c97a4d-c392-41a9-a374-57af3e3eeab3, checked
 * 2026-10-18). Not included: 4D Country (EP), Alive & In Person and the
 * Getting Killed Again live sets, singles. A new studio album gets added
 * here.
 *
 * Album titles match EXACTLY (folded) — "Getting Killed Again (Live …)"
 * must not ride along with "Getting Killed".
 *
 * Pure — node --test loads it.
 */
import { nameKey } from './fold-text.ts'

export interface LockedAlbumSet {
  /** Shown on the pool page and the Activity sheet. */
  label: string
  artist: string
  /** In release order — the order they sit in the pinned half. */
  albums: string[]
}

export const LOCKED_IN_POOL: LockedAlbumSet[] = [
  { label: 'Geese studio albums', artist: 'Geese', albums: ['A Beautiful Memory', 'Projector', '3D Country', 'Getting Killed'] },
]

export interface LockedTrackLike {
  id: number | string
  artist?: string
  albumArtist?: string
  album?: string
  discNumber?: number | string
  trackNumber?: number | string
}

export interface LockedSetInfo { label: string; count: number; albumsFound: number; albumsWanted: number }

export function resolveLockedAlbumIds(
  tracks: readonly LockedTrackLike[],
  sets: readonly LockedAlbumSet[] = LOCKED_IN_POOL,
): { ids: number[]; sets: LockedSetInfo[] } {
  const ids: number[] = []
  const seen = new Set<number>()
  const info: LockedSetInfo[] = []
  for (const set of sets) {
    const artistKey = nameKey(set.artist)
    const albumRank = new Map(set.albums.map((a, i) => [nameKey(a), i]))
    const hits = tracks
      .filter((t) => nameKey(t.artist || '') === artistKey || nameKey(t.albumArtist || '') === artistKey)
      .map((t) => ({ t, rank: albumRank.get(nameKey(t.album || '')) }))
      .filter((x): x is { t: LockedTrackLike; rank: number } => x.rank !== undefined)
      .sort((a, b) => a.rank - b.rank
        || (Number(a.t.discNumber) || 0) - (Number(b.t.discNumber) || 0)
        || (Number(a.t.trackNumber) || 0) - (Number(b.t.trackNumber) || 0))
    const before = ids.length
    for (const { t } of hits) {
      const id = Number(t.id)
      if (!Number.isFinite(id) || seen.has(id)) continue
      seen.add(id)
      ids.push(id)
    }
    info.push({
      label: set.label,
      count: ids.length - before,
      albumsFound: new Set(hits.map((h) => h.rank)).size,
      albumsWanted: set.albums.length,
    })
  }
  return { ids, sets: info }
}
