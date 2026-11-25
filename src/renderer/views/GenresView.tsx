import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { usePlayback } from '../context/PlaybackContext'
import { useRegularLibraryTracks } from '../hooks/useRegularLibraryTracks'
import { useScrollPersistence } from '../hooks/useScrollPersistence'
import EmptyState from '../components/EmptyState'
import SongTable from '../components/SongTable'
import { useListSort } from '../hooks/useListSort'
import { sortSongs } from '../utils/songTableRules'
import { usePlaysElsewhere } from '../playsElsewhere'
import { albumKeyOf } from '../utils/albumKey'
import { compareNames, compareAlbumNames } from '../utils/artistSort'
import '../styles/genres.css'

export default function GenresView() {
  const { state: lib, dispatch: libDispatch } = useLibrary()
  const { state: pb } = usePlayback()
  const elsewhere = usePlaysElsewhere()
  const [selectedGenre, setSelectedGenre] = useState<string | null>(null)
  const [selectedArtist, setSelectedArtist] = useState<string | null>(null)
  const [selectedAlbum, setSelectedAlbum] = useState<string | null>(null)
  // V7 (2026-11-24): the songs below the browser are the one song table
  // (components/SongTable.tsx) — selection, the full song menu, Get Info on
  // the song right-clicked, sorting, the arrow keys and Delete, like every
  // other list. Its Delete deletes from the library, after asking.
  const [sort, setSort] = useListSort('genres')

  // 2026-08-08 (Jake's explicit OK to touch this file, as with the 2026-06-24
  // casing fix): a declared concert's songs are hidden from the regular
  // library everywhere else, but this view counted them — 24 Nassau '80
  // tracks were inventing a whole "Rock, Pop" genre that has no regular
  // songs in it, and inflating Indie Rock (+17) and French House (+14).
  const regularTracks = useRegularLibraryTracks(lib.tracks)

  const genres = useMemo(() => {
    // Case-insensitive grouping (2026-06-24 audit, with Jake's OK to touch this
    // file): "Alternative Indie" and "Alternative indie" are ONE genre, not two.
    // Bucket by lowercase, then label each bucket with its most common casing.
    const byLower = new Map<string, Map<string, number>>()
    for (const t of regularTracks) {
      if (!t.genre) continue
      const lower = t.genre.toLowerCase()
      let casings = byLower.get(lower)
      if (!casings) { casings = new Map(); byLower.set(lower, casings) }
      casings.set(t.genre, (casings.get(t.genre) ?? 0) + 1)
    }
    const labels: string[] = []
    for (const casings of byLower.values()) {
      let best = '', bestN = -1
      for (const [casing, n] of casings) if (n > bestN) { best = casing; bestN = n }
      labels.push(best)
    }
    return labels.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  }, [regularTracks])

  const filteredByGenre = useMemo(() => {
    if (!selectedGenre) return regularTracks
    // Case-insensitive so a bucket matches every casing variant of the genre.
    const sel = selectedGenre.toLowerCase()
    return regularTracks.filter(t => (t.genre || '').toLowerCase() === sel)
  }, [regularTracks, selectedGenre])

  const artists = useMemo(() => {
    const set = new Set<string>()
    for (const t of filteredByGenre) if (t.artist) set.add(t.artist)
    return Array.from(set).sort(compareNames)
  }, [filteredByGenre])

  const filteredByArtist = useMemo(() => {
    if (!selectedArtist) return filteredByGenre
    // Brief 031 Phase 4c: filter by contributingArtists so a collab
    // track appears under every contributing artist's drill-down,
    // not just whichever name happens to be in track.artist.
    // Fallback to [t.artist] for legacy tracks lacking the field.
    return filteredByGenre.filter(t =>
      (t.contributingArtists ?? [t.artist]).includes(selectedArtist)
    )
  }, [filteredByGenre, selectedArtist])

  const albums = useMemo(() => {
    const set = new Set<string>()
    for (const t of filteredByArtist) if (t.album) set.add(t.album)
    return Array.from(set).sort(compareAlbumNames)
  }, [filteredByArtist])

  const filteredTracks = useMemo(() => {
    if (!selectedAlbum) return filteredByArtist
    return filteredByArtist.filter(t => t.album === selectedAlbum)
  }, [filteredByArtist, selectedAlbum])

  const sortedTracks = useMemo(() => sortSongs(filteredTracks, sort, elsewhere), [filteredTracks, sort, elsewhere])

  const selectGenre = useCallback((g: string | null) => {
    setSelectedGenre(g)
    setSelectedArtist(null)
    setSelectedAlbum(null)
  }, [])

  const selectArtist = useCallback((a: string | null) => {
    setSelectedArtist(a)
    setSelectedAlbum(null)
  }, [])

  const openAlbumInGenre = useCallback((albumName: string) => {
    const first = filteredByArtist.find(t => t.album === albumName)
    if (first) libDispatch({ type: 'VIEW_ALBUM_DETAIL', albumKey: albumKeyOf(first) })
  }, [filteredByArtist, libDispatch])

  const viewRootRef = useRef<HTMLDivElement>(null)
  const genreListRef = useRef<HTMLDivElement>(null)
  const artistListRef = useRef<HTMLDivElement>(null)
  const albumListRef = useRef<HTMLDivElement>(null)
  useScrollPersistence('genres-col-genre', genreListRef)
  useScrollPersistence('genres-col-artist', artistListRef)
  useScrollPersistence('genres-col-album', albumListRef)
  const lastUserActivityAtRef = useRef<number>(0)
  const isAutoScrollAtRef = useRef<number>(0)
  const FOLLOW_IDLE_MS = 5000
  const noteUserActivity = useCallback(() => {
    if (Date.now() - isAutoScrollAtRef.current > 200) {
      lastUserActivityAtRef.current = Date.now()
    }
  }, [])

  useEffect(() => {
    if (lib.currentView !== 'genres') return
    if (!pb.nowPlaying) return
    if (Date.now() - lastUserActivityAtRef.current < FOLLOW_IDLE_MS) return
    const t = pb.nowPlaying
    const targetGenre = t.genre || null
    const targetArtist = t.artist || null
    const targetAlbum = t.album || null
    if (!targetGenre) return
    isAutoScrollAtRef.current = Date.now()
    setSelectedGenre(targetGenre)
    setSelectedArtist(targetArtist)
    setSelectedAlbum(targetAlbum)
  }, [pb.nowPlaying?.id, lib.currentView])

  return (
    <div
      className="genres-view"
      ref={viewRootRef}
      onClickCapture={noteUserActivity}
      onWheelCapture={noteUserActivity}
      onScrollCapture={noteUserActivity}
      onKeyDownCapture={noteUserActivity}
    >
      <div className="genres-browser">
        <div className="genres-column">
          <div className="genres-column-header">Genre</div>
          <div className="genres-column-list" ref={genreListRef}>
            <div className={`genres-column-item ${!selectedGenre ? 'genres-column-item--selected' : ''}`} onClick={() => selectGenre(null)}>All ({genres.length})</div>
            {genres.map(g => (
              <div key={g} className={`genres-column-item ${selectedGenre?.toLowerCase() === g.toLowerCase() ? 'genres-column-item--selected' : ''}`} onClick={() => selectGenre(g)}>{g}</div>
            ))}
          </div>
        </div>
        <div className="genres-column">
          <div className="genres-column-header">Artist</div>
          <div className="genres-column-list" ref={artistListRef}>
            <div className={`genres-column-item ${!selectedArtist ? 'genres-column-item--selected' : ''}`} onClick={() => selectArtist(null)}>All ({artists.length})</div>
            {artists.map(a => (
              <div key={a} className={`genres-column-item ${selectedArtist === a ? 'genres-column-item--selected' : ''}`} onClick={() => selectArtist(a)}>{a}</div>
            ))}
          </div>
        </div>
        <div className="genres-column">
          <div className="genres-column-header">Album</div>
          <div className="genres-column-list" ref={albumListRef}>
            <div className={`genres-column-item ${!selectedAlbum ? 'genres-column-item--selected' : ''}`} onClick={() => setSelectedAlbum(null)}>All ({albums.length})</div>
            {albums.map(a => (
              <div
                key={a}
                className={`genres-column-item ${selectedAlbum === a ? 'genres-column-item--selected' : ''}`}
                onClick={() => setSelectedAlbum(a)}
                onDoubleClick={() => openAlbumInGenre(a)}
                title="Double-click to open album page"
              >
                {a}
              </div>
            ))}
          </div>
        </div>
      </div>
      <SongTable
        listKey={`genres:${selectedGenre ?? ''}|${selectedArtist ?? ''}|${selectedAlbum ?? ''}`}
        scrollKey="genres-tracklist"
        className="genres-tracklist"
        tracks={sortedTracks}
        active={lib.currentView === 'genres'}
        sort={sort}
        onSort={setSort}
        empty={<EmptyState query={lib.searchQuery} noun={selectedGenre ? `${selectedGenre} songs` : 'songs'} />}
      />
    </div>
  )
}
