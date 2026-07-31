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
        const haystack = `${t.title || ''} ${t.artist || ''} ${t.album || ''} ${t.genre || ''} ${t.subgenre || ''} ${t.year || ''}`.toLowerCase()
        // Every word the user typed must appear somewhere in the combined fields
        return words.every(w => haystack.includes(w))
      })
    }

    // 2026-07-31: every column used to compare as a lowercased STRING, so
    // numeric ones sorted lexically — 100 landed before 72. Year and Plays were
    // quietly wrong the same way. Numbers now compare as numbers.
    //
    // Camelot gets its own rule: it's a wheel, so 1A 1B 2A 2B … is the useful
    // order (harmonic neighbours adjacent). Text sort gives 1A 10A 11A 12A 2A,
    // which is worse than useless to mix from.
    const camelot = (v: unknown): [number, string] => {
      const m = /^(\d{1,2})([AB])$/i.exec(String(v ?? '').trim())
      return m ? [Number(m[1]), m[2].toUpperCase()] : [999, 'Z']
    }
    return [...filtered].sort((a, b) => {
      const av = a[sortColumn] as unknown
      const bv = b[sortColumn] as unknown
      let cmp: number
      if (sortColumn === 'camelotKey') {
        const [an, al] = camelot(av)
        const [bn, bl] = camelot(bv)
        cmp = an !== bn ? an - bn : (al < bl ? -1 : al > bl ? 1 : 0)
      } else {
        const anum = Number(av)
        const bnum = Number(bv)
        const bothNumeric = av != null && bv != null && av !== '' && bv !== ''
          && Number.isFinite(anum) && Number.isFinite(bnum)
        if (bothNumeric) {
          cmp = anum - bnum
        } else {
          const aStr = String(av ?? '').toLowerCase()
          const bStr = String(bv ?? '').toLowerCase()
          cmp = aStr < bStr ? -1 : aStr > bStr ? 1 : 0
        }
      }
      return sortDirection === 'asc' ? cmp : -cmp
    })
  }, [tracks, sortColumn, sortDirection, searchQuery])
}
