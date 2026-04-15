import { useMemo } from 'react'
import { Track, SortColumn, SortDirection } from '../types'

export function useSortedTracks(
  tracks: Track[],
  sortColumn: SortColumn,
  sortDirection: SortDirection,
  searchQuery: string
): Track[] {
  return useMemo(() => {
    let filtered = tracks
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      filtered = tracks.filter((t) =>
        t.title?.toLowerCase().includes(q) ||
        t.artist?.toLowerCase().includes(q) ||
        t.album?.toLowerCase().includes(q) ||
        t.genre?.toLowerCase().includes(q)
      )
    }

    return [...filtered].sort((a, b) => {
      const av = (a[sortColumn] ?? '') as string | number
      const bv = (b[sortColumn] ?? '') as string | number
      const aStr = String(av).toLowerCase()
      const bStr = String(bv).toLowerCase()
      const cmp = aStr < bStr ? -1 : aStr > bStr ? 1 : 0
      return sortDirection === 'asc' ? cmp : -cmp
    })
  }, [tracks, sortColumn, sortDirection, searchQuery])
}
