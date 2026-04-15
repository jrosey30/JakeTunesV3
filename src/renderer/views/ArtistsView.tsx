import { useState, useMemo, useCallback } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { usePlayback } from '../context/PlaybackContext'
import { useAudio } from '../hooks/useAudio'
import { SpeakerPlayingIcon } from '../assets/icons/SpeakerIcon'
import ContextMenu, { MenuEntry } from '../components/ContextMenu'
import ConfirmDialog from '../components/ConfirmDialog'
import GetInfoModal from '../components/GetInfoModal'
import { Track } from '../types'
import '../styles/artists.css'

interface ArtistGroup {
  name: string
  tracks: Track[]
  albums: { name: string; tracks: Track[] }[]
}

const AVATAR_COLORS = ['#c0392b', '#8e44ad', '#2980b9', '#27ae60', '#f39c12', '#d35400', '#1abc9c', '#7f8c8d']

function hashColor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length]
}

function initials(name: string): string {
  return name.split(/\s+/).map(w => w[0] || '').join('').toUpperCase().slice(0, 2)
}

export default function ArtistsView() {
  const { state: lib, dispatch: libDispatch } = useLibrary()
  const { state: pb, dispatch: pbDispatch } = usePlayback()
  const { playTrack } = useAudio()
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [expandedAlbums, setExpandedAlbums] = useState<Set<string>>(new Set())
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; track: Track; tracks: Track[]; idx: number } | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<{ ids: number[]; count: number } | null>(null)
  const [getInfoState, setGetInfoState] = useState<{ tracks: Track[]; index: number } | null>(null)

  const artists = useMemo((): ArtistGroup[] => {
    const map = new Map<string, Track[]>()
    for (const t of lib.tracks) {
      const name = t.artist || 'Unknown Artist'
      if (!map.has(name)) map.set(name, [])
      map.get(name)!.push(t)
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, tracks]) => {
        const albumMap = new Map<string, Track[]>()
        for (const t of tracks) {
          const aName = t.album || 'Unknown Album'
          if (!albumMap.has(aName)) albumMap.set(aName, [])
          albumMap.get(aName)!.push(t)
        }
        return {
          name,
          tracks,
          albums: Array.from(albumMap.entries()).map(([n, t]) => ({ name: n, tracks: t }))
        }
      })
  }, [lib.tracks])

  const toggleArtist = useCallback((name: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }, [])

  const toggleAlbum = useCallback((key: string) => {
    setExpandedAlbums(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const handleContextMenu = useCallback((e: React.MouseEvent, track: Track, tracks: Track[], idx: number) => {
    e.preventDefault()
    setCtxMenu({ x: e.clientX, y: e.clientY, track, tracks, idx })
  }, [])

  const getContextMenuItems = useCallback((): MenuEntry[] => {
    if (!ctxMenu) return []
    const { track, tracks, idx } = ctxMenu
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
      { label: `Play "${track.title}"`, onClick: () => playTrack(track, tracks, idx) },
      { separator: true as const },
      { label: 'Play Next', onClick: () => pbDispatch({ type: 'PLAY_NEXT', tracks: [track] }) },
      { label: 'Add to Up Next', onClick: () => pbDispatch({ type: 'ADD_TO_QUEUE', tracks: [track] }) },
      { separator: true as const },
      { label: 'Get Info', onClick: () => setGetInfoState({ tracks: [track], index: idx }) },
      ...artworkItems,
      { separator: true as const },
      { label: 'Delete Song', onClick: () => setDeleteConfirm({ ids: [track.id], count: 1 }) },
    ]
  }, [ctxMenu, playTrack, pbDispatch, libDispatch])

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
    <div className="artists-view">
      {artists.map((artist) => (
        <div key={artist.name} className="artist-group">
          <div className="artist-row" onClick={() => toggleArtist(artist.name)}>
            <div className="artist-avatar" style={{ background: hashColor(artist.name) }}>
              {initials(artist.name)}
            </div>
            <span className="artist-name">{artist.name}</span>
            <span className="artist-count">{artist.tracks.length} songs</span>
            <svg className={`artist-chevron ${expanded.has(artist.name) ? 'open' : ''}`} width="10" height="10" viewBox="0 0 10 10" fill="#999">
              <path d="M3 1l5 4-5 4z" />
            </svg>
          </div>

          {expanded.has(artist.name) && (
            <div className="artist-albums-grid">
              {artist.albums.map((album) => {
                const albumKey = `${artist.name}::${album.name}`
                return (
                  <div key={albumKey} className="artist-album-card">
                    <div className="artist-album-art" onClick={() => toggleAlbum(albumKey)}>
                      <div className="artist-album-placeholder">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="#bbb">
                          <circle cx="12" cy="12" r="10" fill="none" stroke="#bbb" strokeWidth="1" />
                          <circle cx="12" cy="12" r="3" fill="none" stroke="#bbb" strokeWidth="1" />
                        </svg>
                      </div>
                    </div>
                    <div className="artist-album-title">{album.name}</div>
                    <div className="artist-album-count">{album.tracks.length} tracks</div>
                    {expandedAlbums.has(albumKey) && (
                      <div className="artist-album-tracklist">
                        {album.tracks.map((track) => {
                          const isPlaying = pb.nowPlaying?.id === track.id
                          return (
                            <div
                              key={track.id}
                              className={`artist-track-row ${isPlaying ? 'artist-track-row--playing' : ''}`}
                              onDoubleClick={() => playTrack(track, album.tracks, album.tracks.indexOf(track))}
                              onContextMenu={(e) => handleContextMenu(e, track, album.tracks, album.tracks.indexOf(track))}
                              draggable
                              onDragStart={(e) => {
                                e.dataTransfer.setData('application/jaketunes-tracks', JSON.stringify([track.id]))
                                e.dataTransfer.effectAllowed = 'copy'
                              }}
                            >
                              <span className="artist-track-icon">{isPlaying && <SpeakerPlayingIcon />}</span>
                              <span className="artist-track-title">{track.title}</span>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      ))}
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
