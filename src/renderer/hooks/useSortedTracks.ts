import { useMemo } from 'react'
import { Track, SortColumn, SortDirection } from '../types'
import { filterSongs, sortSongs } from '../utils/songTableRules'
import type { ElsewhereOverlay } from '../../common/plays-elsewhere'

/**
 * A list filtered by the "This page" search and sorted by one column — the
 * rules are the song table's (utils/songTableRules.ts filterSongs / sortSongs).
 * `sortColumn` null = the list's own order ("Original Order").
 */
export function useSortedTracks(
  tracks: Track[],
  sortColumn: SortColumn | null,
  sortDirection: SortDirection,
  searchQuery: string,
  /** 2026-10-20 — Plays sorts by the count everywhere (phone + workmini too). */
  elsewhere?: ElsewhereOverlay,
): Track[] {
  return useMemo(() => {
    const filtered = filterSongs(tracks, searchQuery)
    return sortColumn ? sortSongs(filtered, { column: sortColumn, direction: sortDirection }, elsewhere) : filtered
  }, [tracks, sortColumn, sortDirection, searchQuery, elsewhere])
}
