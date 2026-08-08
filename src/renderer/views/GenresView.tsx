import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { usePlayback } from '../context/PlaybackContext'
import { useAudio } from '../hooks/useAudio'
import { useRegularLibraryTracks } from '../hooks/useRegularLibraryTracks'
import { useScrollPersistence } from '../hooks/useScrollPersistence'
import { SpeakerPlayingIcon } from '../assets/icons/SpeakerIcon'
import ContextMenu, { MenuEntry } from '../components/ContextMenu'
import ConfirmDialog from '../components/ConfirmDialog'
import GetInfoModal from '../components/GetInfoModal'
import { clearArtworkNegativeCache } from '../utils/artworkLookup'
import EmptyState from '../components/EmptyState'
import { Track } from '../types'
import { setNotice } from '../activity'
import { albumKeyOf } from '../utils/albumKey'
import '../styles/genres.css'

export default function GenresView() {
  const { state: lib, dispatch: libDispatch } = useLibrary()
  const { state: pb, dispatch: pbDispatch } = usePlayback()
  const { playTrack } = useAudio()
  const [selectedGenre, setSelectedGenre] = useState<string | null>(null)
  const [selectedArtist, setSelectedArtist] = useState<string | null>(null)
  const [selectedAlbum, setSelectedAlbum] = useState<string | null>(null)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; track: Track; idx: number } | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<{ ids: number[]; count: number } | null>(null)
  const [getInfoState, setGetInfoState] = useState<{ tracks: Track[]; index: number } | null>(null)

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
    return Array.from(set).sort()
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
    return Array.from(set).sort()
  }, [filteredByArtist])

  const filteredTracks = useMemo(() => {
    if (!selectedAlbum) return filteredByArtist
    return filteredByArtist.filter(t => t.album === selectedAlbum)
  }, [filteredByArtist, selectedAlbum])

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

  const handleContextMenu = useCallback((e: React.MouseEvent, track: Track, idx: number) => {
    e.preventDefault()
    setCtxMenu({ x: e.clientX, y: e.clientY, track, idx })
  }, [])

  const getContextMenuItems = useCallback((): MenuEntry[] => {
    if (!ctxMenu) return []
    const { track, idx } = ctxMenu
    const artworkItems: MenuEntry[] = track.artist && track.album ? [
      { separator: true as const },
      {
        label: 'Add Artwork…',
        onClick: async () => {
          const file = await window.electronAPI.chooseArtworkFile()
          if (!file.ok || !file.path) return
          const result = await window.electronAPI.setCustomArtwork(track.artist, track.album, file.path)
          if (result.ok && result.key && result.hash) {
            libDispatch({ type: 'ADD_ARTWORK', key: result.key, hash: result.hash })
          } else {
            // 4.4.12: surface failure (usually sips conversion).
            setNotice(result.error ? `Couldn't save artwork: ${result.error}` : "Couldn't save artwork.", { kind: 'error' })
          }
        },
      },
      {
        label: 'Fetch Artwork from Internet',
        onClick: async () => {
          const result = await window.electronAPI.fetchAlbumArt(track.artist, track.album, true)
          if (result.ok && result.key && result.hash) {
            libDispatch({ type: 'ADD_ARTWORK', key: result.key, hash: result.hash })
          }
        },
      },
    ] : []
    return [
      { label: `Play "${track.title}"`, onClick: () => playTrack(track, filteredTracks, idx, undefined, true) },
      { separator: true as const },
      { label: 'Play Next', onClick: () => pbDispatch({ type: 'PLAY_NEXT', tracks: [track] }) },
      { label: 'Add to Up Next', onClick: () => pbDispatch({ type: 'ADD_TO_QUEUE', tracks: [track] }) },
      { separator: true as const },
      { label: 'Get Info', onClick: () => setGetInfoState({ tracks: [track], index: idx }) },
      ...artworkItems,
      { separator: true as const },
      { label: 'Delete Song', onClick: () => setDeleteConfirm({ ids: [track.id], count: 1 }) },
    ]
  }, [ctxMenu, playTrack, filteredTracks, pbDispatch, libDispatch])

  const handleGetInfoSave = useCallback(
    async (updates: { id: number; field: string; value: string }[]) => {
      // 4.5.0-67 — save-first ordering, see SongsView for full rationale.
      const oldArtAlbumById = new Map<number, { artist: string; album: string }>()
      for (const u of updates) {
        if (oldArtAlbumById.has(u.id)) continue
        const t = lib.tracks.find(tr => tr.id === u.id)
        if (t) oldArtAlbumById.set(u.id, { artist: t.artist || '', album: t.album || '' })
      }
      for (const u of updates) await window.electronAPI.saveMetadataOverride(u.id, u.field, u.value)
      if (updates.some(u => u.field === 'artist' || u.field === 'album')) {
        const newArtAlbumById = new Map<number, { artist: string; album: string }>()
        for (const [id, old] of oldArtAlbumById) newArtAlbumById.set(id, { ...old })
        for (const u of updates) {
          const cur = newArtAlbumById.get(u.id)
          if (!cur) continue
          if (u.field === 'artist') cur.artist = u.value
          else if (u.field === 'album') cur.album = u.value
        }
        for (const v of newArtAlbumById.values()) clearArtworkNegativeCache(v.artist, v.album)
      }
      libDispatch({ type: 'UPDATE_TRACKS', updates })
    },
    [libDispatch, lib.tracks]
  )

  const handleFetchArt = useCallback(
    async (artist: string, album: string, force?: boolean): Promise<{ key: string; hash: string } | null> => {
      const result = await window.electronAPI.fetchAlbumArt(artist, album, force)
      if (result.ok && result.key && result.hash) {
        libDispatch({ type: 'ADD_ARTWORK', key: result.key, hash: result.hash })
        return { key: result.key, hash: result.hash }
      }
      return null
    },
    [libDispatch]
  )

  const handleSetCustomArt = useCallback(
    async (artist: string, album: string, imagePath: string): Promise<{ key: string; hash: string } | null> => {
      const result = await window.electronAPI.setCustomArtwork(artist, album, imagePath)
      if (result.ok && result.key && result.hash) {
        libDispatch({ type: 'ADD_ARTWORK', key: result.key, hash: result.hash })
        return { key: result.key, hash: result.hash }
      }
      // 4.4.12: surface failure (usually sips conversion) so the user
      // doesn't think the art stuck just because the Get Info preview
      // still shows it from localArtHash.
      setNotice(result.error ? `Couldn't save artwork: ${result.error}` : "Couldn't save artwork.", { kind: 'error' })
      return null
    },
    [libDispatch]
  )

  // Auto-follow now-playing (4.0). When the playing track changes and
  // the user has been idle for >5s, drill the genre/artist/album columns
  // into the track's location and scroll its row into view. Same idle-
  // gate pattern as SongsView.
  const viewRootRef = useRef<HTMLDivElement>(null)
  const genreListRef = useRef<HTMLDivElement>(null)
  const artistListRef = useRef<HTMLDivElement>(null)
  const albumListRef = useRef<HTMLDivElement>(null)
  const tracklistRef = useRef<HTMLDivElement>(null)
  useScrollPersistence('genres-col-genre', genreListRef)
  useScrollPersistence('genres-col-artist', artistListRef)
  useScrollPersistence('genres-col-album', albumListRef)
  useScrollPersistence('genres-tracklist', tracklistRef)
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
    requestAnimationFrame(() => {
      const root = tracklistRef.current
      if (!root) return
      const row = root.querySelector(`[data-track-id="${t.id}"]`) as HTMLElement | null
      if (row) row.scrollIntoView({ block: 'nearest', behavior: 'auto' })
    })
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
      <div className="genres-tracklist" ref={tracklistRef}>
        {filteredTracks.length === 0 && (
          <EmptyState
            query={lib.searchQuery}
            noun={selectedGenre ? `${selectedGenre} tracks` : 'tracks'}
          />
        )}
        {filteredTracks.map((track, i) => {
          const isPlaying = pb.nowPlaying?.id === track.id
          return (
            <div
              key={track.id}
              data-track-id={track.id}
              className={`genres-track-row ${i % 2 ? 'genres-track-row--alt' : ''} ${isPlaying ? 'genres-track-row--playing' : ''}`}
              onDoubleClick={() => playTrack(track, filteredTracks, i, undefined, true)}
              onContextMenu={(e) => handleContextMenu(e, track, i)}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('application/jaketunes-tracks', JSON.stringify([track.id]))
                e.dataTransfer.effectAllowed = 'copy'
              }}
            >
              <span className="genres-track-icon">{isPlaying && <SpeakerPlayingIcon />}</span>
              <span className="genres-track-title">{track.title}</span>
              <span className="genres-track-artist">{track.artist}</span>
              <span className="genres-track-album">{track.album}</span>
            </div>
          )
        })}
      </div>
      {ctxMenu && (
        <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={getContextMenuItems()} onClose={() => setCtxMenu(null)} />
      )}
      {getInfoState && (
        <GetInfoModal
          tracks={getInfoState.tracks}
          allTracks={lib.tracks}
          initialIndex={lib.tracks.findIndex(t => t.id === getInfoState.tracks[0]?.id)}
          artworkMap={lib.artworkMap}
          onClose={() => setGetInfoState(null)}
          onSave={handleGetInfoSave}
          onFetchArt={handleFetchArt}
          onSetCustomArt={handleSetCustomArt}
        />
      )}
      {deleteConfirm && (
        <ConfirmDialog
          message="Are you sure you want to delete this song from your library?"
          detail="This will remove them from all playlists. This cannot be undone."
          confirmLabel="Delete"
          onConfirm={() => { libDispatch({ type: 'DELETE_TRACKS', ids: deleteConfirm.ids }); setDeleteConfirm(null) }}
          onCancel={() => setDeleteConfirm(null)}
        />
      )}
    </div>
  )
}
