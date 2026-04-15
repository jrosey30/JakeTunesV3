import { useState, useMemo, useCallback } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { usePlayback } from '../context/PlaybackContext'
import { useAudio } from '../hooks/useAudio'
import { SpeakerPlayingIcon } from '../assets/icons/SpeakerIcon'
import ContextMenu, { MenuEntry } from '../components/ContextMenu'
import ConfirmDialog from '../components/ConfirmDialog'
import GetInfoModal from '../components/GetInfoModal'
import { Track } from '../types'
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

  const genres = useMemo(() => {
    const set = new Set<string>()
    for (const t of lib.tracks) if (t.genre) set.add(t.genre)
    return Array.from(set).sort()
  }, [lib.tracks])

  const filteredByGenre = useMemo(() => {
    if (!selectedGenre) return lib.tracks
    return lib.tracks.filter(t => t.genre === selectedGenre)
  }, [lib.tracks, selectedGenre])

  const artists = useMemo(() => {
    const set = new Set<string>()
    for (const t of filteredByGenre) if (t.artist) set.add(t.artist)
    return Array.from(set).sort()
  }, [filteredByGenre])

  const filteredByArtist = useMemo(() => {
    if (!selectedArtist) return filteredByGenre
    return filteredByGenre.filter(t => t.artist === selectedArtist)
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
      { label: `Play "${track.title}"`, onClick: () => playTrack(track, filteredTracks, idx) },
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
      libDispatch({ type: 'UPDATE_TRACKS', updates })
      for (const u of updates) await window.electronAPI.saveMetadataOverride(u.id, u.field, u.value)
    },
    [libDispatch]
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
      return null
    },
    [libDispatch]
  )

  return (
    <div className="genres-view">
      <div className="genres-browser">
        <div className="genres-column">
          <div className="genres-column-header">Genre</div>
          <div className="genres-column-list">
            <div className={`genres-column-item ${!selectedGenre ? 'genres-column-item--selected' : ''}`} onClick={() => selectGenre(null)}>All ({genres.length})</div>
            {genres.map(g => (
              <div key={g} className={`genres-column-item ${selectedGenre === g ? 'genres-column-item--selected' : ''}`} onClick={() => selectGenre(g)}>{g}</div>
            ))}
          </div>
        </div>
        <div className="genres-column">
          <div className="genres-column-header">Artist</div>
          <div className="genres-column-list">
            <div className={`genres-column-item ${!selectedArtist ? 'genres-column-item--selected' : ''}`} onClick={() => selectArtist(null)}>All ({artists.length})</div>
            {artists.map(a => (
              <div key={a} className={`genres-column-item ${selectedArtist === a ? 'genres-column-item--selected' : ''}`} onClick={() => selectArtist(a)}>{a}</div>
            ))}
          </div>
        </div>
        <div className="genres-column">
          <div className="genres-column-header">Album</div>
          <div className="genres-column-list">
            <div className={`genres-column-item ${!selectedAlbum ? 'genres-column-item--selected' : ''}`} onClick={() => setSelectedAlbum(null)}>All ({albums.length})</div>
            {albums.map(a => (
              <div key={a} className={`genres-column-item ${selectedAlbum === a ? 'genres-column-item--selected' : ''}`} onClick={() => setSelectedAlbum(a)}>{a}</div>
            ))}
          </div>
        </div>
      </div>
      <div className="genres-tracklist">
        {filteredTracks.map((track, i) => {
          const isPlaying = pb.nowPlaying?.id === track.id
          return (
            <div
              key={track.id}
              className={`genres-track-row ${i % 2 ? 'genres-track-row--alt' : ''} ${isPlaying ? 'genres-track-row--playing' : ''}`}
              onDoubleClick={() => playTrack(track, filteredTracks, i)}
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
