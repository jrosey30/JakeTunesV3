import { useCallback, useEffect } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { useSortedTracks } from '../hooks/useSortedTracks'
import { usePlaysElsewhere } from '../playsElsewhere'
import { useRegularLibraryTracks } from '../hooks/useRegularLibraryTracks'
import { initDownloads } from '../utils/downloadStore'
import TrackGridView from '../components/TrackGridView'
import CoverFlowView from './CoverFlowView'
import { useViewMode } from '../context/ViewModeContext'
import SongTable from '../components/SongTable'
import EmptyState from '../components/EmptyState'
import type { SongSort } from '../utils/songTableRules'
import '../styles/songs.css'

/**
 * The library's songs. The list itself is the one song table every page uses
 * (components/SongTable.tsx, V7): its columns, sorting, keys, menu, delete and
 * drag. What is Songs' own: the whole library (declared concerts aside), the
 * sort kept in LibraryContext and saved across launches by App.tsx, Delete
 * deleting from the library, ⌘L, and the list following the playing song to
 * the top after 15 s without a touch.
 */
export default function SongsView() {
  const { state: lib, dispatch: libDispatch } = useLibrary()
  const { mode: viewMode } = useViewMode()
  useEffect(() => { void initDownloads() }, [])

  // Declared full concerts (merged track + un-promoted constituents) don't
  // appear in the Songs list — they live in the Full Live Concerts section.
  const regularTracks = useRegularLibraryTracks(lib.tracks)
  const elsewhere = usePlaysElsewhere()
  const sorted = useSortedTracks(regularTracks, lib.sortColumn, lib.sortDirection, lib.searchQuery, elsewhere)
  const sort: SongSort | null = lib.sortColumn ? { column: lib.sortColumn, direction: lib.sortDirection } : null
  const onSort = useCallback((next: SongSort | null) => libDispatch({ type: 'SET_SORT_STATE', sort: next }), [libDispatch])

  // V5 facelift: Grid / Cover Flow modes over THIS view's sorted/filtered tracks.
  if (viewMode === 'grid') return <TrackGridView tracks={sorted} emptyNoun="songs" />
  if (viewMode === 'coverflow') return <CoverFlowView tracks={sorted} emptyNoun="songs" stateKey="songs" />

  return (
    <SongTable
      listKey="songs"
      scrollKey="songs"
      tracks={sorted}
      active={lib.currentView === 'songs'}
      sort={sort}
      onSort={onSort}
      follow="top"
      answersShowNowPlaying
      empty={<EmptyState query={lib.searchQuery} noun="songs" />}
    />
  )
}
