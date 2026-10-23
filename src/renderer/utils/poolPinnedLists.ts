/**
 * Lists that are ALWAYS in the iPod Pool (Jake, 2026-10-16: "bops,
 * rocksurgence, recently added should always be in the pool updated as i
 * update those lists"). Resolved LIVE from the current library every time —
 * edit Bops and the next sync follows.
 *
 * 2026-10-23 (Jake): the original iPod is "my top 1000 songs", so Recently
 * Added no longer belongs on it. It is replaced by Greenpoint Greatest Hits
 * and every Justification playlist — a SERIES matched by name
 * ("Justification", "Justification II", "JUSTIFICATION IV: A NEW STREAM", …)
 * in series order, so the next one joins without a code change.
 *
 * Priority order matters only when the pinned lists alone overflow your half
 * of a small sync (see src/common/activity-split.ts): earlier lists win.
 * Locked albums (common/pool-locked-albums.ts — Geese's studio albums) go
 * before all of them.
 */
import type { Track, Playlist } from '../types'
import { resolveLockedAlbumIds } from '../../common/pool-locked-albums'

export const ALWAYS_IN_POOL = ['Greenpoint Greatest Hits', 'Justification', 'Bops', 'Rocksurgence'] as const

/** Names in ALWAYS_IN_POOL that stand for every playlist in a numbered series. */
const SERIES = new Set<string>(['Justification'])

const ROMAN: Record<string, number> = { i: 1, v: 5, x: 10, l: 50 }

/** "Justification" → 1, "Justification II" → 2, "JUSTIFICATION IV: A NEW STREAM" → 4. */
export function seriesNumber(name: string, series: string): number | null {
  const m = name.trim().toLowerCase().match(new RegExp(`^${series.toLowerCase()}(?:\\s+([ivxl]+|\\d+))?\\b`))
  if (!m) return null
  const tag = m[1]
  if (!tag) return 1
  if (/^\d+$/.test(tag)) return Number(tag)
  let total = 0
  for (let i = 0; i < tag.length; i++) {
    const cur = ROMAN[tag[i]] ?? 0
    const next = ROMAN[tag[i + 1]] ?? 0
    total += cur < next ? -cur : cur
  }
  return total
}

function seriesPlaylists(playlists: Playlist[], series: string): Playlist[] {
  return playlists
    .map((p) => ({ p, n: seriesNumber(String(p.name || ''), series) }))
    .filter((x): x is { p: Playlist; n: number } => x.n !== null)
    .sort((a, b) => a.n - b.n)
    .map((x) => x.p)
}

export interface PinnedListInfo { name: string; found: boolean; count: number; locked?: true }

export function resolvePinnedPoolIds(
  tracks: Track[],
  playlists: Playlist[],
): { ids: number[]; lists: PinnedListInfo[] } {
  const ids: number[] = []
  const seen = new Set<number>()
  const lists: PinnedListInfo[] = []
  // Locked albums first (Geese: 3D Country + Getting Killed, 2026-10-23) — "locked" wins
  // the pinned half on a small sync. See common/pool-locked-albums.ts.
  const locked = resolveLockedAlbumIds(tracks)
  for (const set of locked.sets) lists.push({ name: set.label, found: set.count > 0, count: set.count, locked: true })
  for (const id of locked.ids) {
    if (seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  const add = (src: Array<number | string>) => {
    for (const raw of src) {
      const id = Number(raw)
      if (!Number.isFinite(id) || seen.has(id)) continue
      seen.add(id)
      ids.push(id)
    }
  }
  for (const name of ALWAYS_IN_POOL) {
    if (SERIES.has(name)) {
      const found = seriesPlaylists(playlists, name)
      if (found.length === 0) lists.push({ name, found: false, count: 0 })
      for (const pl of found) {
        const src = [...(pl.trackIds || [])]
        lists.push({ name: String(pl.name), found: true, count: src.length })
        add(src)
      }
      continue
    }
    const want = name.toLowerCase()
    const pl = playlists.find((p) => String(p.name || '').trim().toLowerCase() === want)
    const src = pl ? [...(pl.trackIds || [])] : null
    lists.push({ name, found: src !== null, count: src?.length ?? 0 })
    add(src || [])
  }
  return { ids, lists }
}
