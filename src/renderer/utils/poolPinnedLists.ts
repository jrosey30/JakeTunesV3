/**
 * Lists that are ALWAYS in the iPod Pool (Jake, 2026-10-16: "bops,
 * rocksurgence, recently added should always be in the pool updated as i
 * update those lists"). Resolved LIVE from the current library every time —
 * edit Bops and the next sync follows; Recently Added is the app's own smart
 * list (evaluateSmartPlaylist — the same rule the sidebar shows and the iPod
 * syncs), never the stale iPod-imported playlist that shares its name.
 *
 * Priority order matters only when the pinned lists alone overflow your half
 * of a small sync (see src/common/activity-split.ts): earlier lists win.
 * Locked albums (common/pool-locked-albums.ts — Geese's studio albums) go
 * before all of them.
 */
import type { Track, Playlist } from '../types'
import { evaluateSmartPlaylist } from './smartPlaylists'
import { resolveLockedAlbumIds } from '../../common/pool-locked-albums'

export const ALWAYS_IN_POOL = ['Recently Added', 'Bops', 'Rocksurgence'] as const

export interface PinnedListInfo { name: string; found: boolean; count: number; locked?: true }

export function resolvePinnedPoolIds(
  tracks: Track[],
  playlists: Playlist[],
): { ids: number[]; lists: PinnedListInfo[] } {
  const ids: number[] = []
  const seen = new Set<number>()
  const lists: PinnedListInfo[] = []
  // Locked albums first (Geese studio albums, 2026-10-18) — "locked" wins
  // the pinned half on a small sync. See common/pool-locked-albums.ts.
  const locked = resolveLockedAlbumIds(tracks)
  for (const set of locked.sets) lists.push({ name: set.label, found: set.count > 0, count: set.count, locked: true })
  for (const id of locked.ids) {
    if (seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  for (const name of ALWAYS_IN_POOL) {
    let src: Array<number | string> | null
    if (name === 'Recently Added') {
      src = evaluateSmartPlaylist('recently-added', tracks).map((t) => t.id)
    } else {
      const want = name.toLowerCase()
      const pl = playlists.find((p) => String(p.name || '').trim().toLowerCase() === want)
      src = pl ? [...(pl.trackIds || [])] : null
    }
    lists.push({ name, found: src !== null, count: src?.length ?? 0 })
    for (const raw of src || []) {
      const id = Number(raw)
      if (!Number.isFinite(id) || seen.has(id)) continue
      seen.add(id)
      ids.push(id)
    }
  }
  return { ids, lists }
}
