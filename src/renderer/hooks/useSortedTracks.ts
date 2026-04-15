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
      const words = searchQuery.toLowerCase().split(/\s+/).filter(w => w.length > 0)
      filtered = tracks.filter((t) => {
        // Combine all searchable fields into one string
        const haystack = `${t.title || ''} ${t.artist || ''} ${t.album || ''} ${t.genre || ''} ${t.year || ''}`.toLowerCase()
        // Every word the user typed must appear somewhere in the combined fields
        return words.every(w => haystack.includes(w))
      })
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
