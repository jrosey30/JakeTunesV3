import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { usePlayback } from '../context/PlaybackContext'
import { useAudio } from '../hooks/useAudio'
import { SpeakerPlayingIcon } from '../assets/icons/SpeakerIcon'
import ContextMenu, { MenuEntry } from '../components/ContextMenu'
import ConfirmDialog from '../components/ConfirmDialog'
import GetInfoModal from '../components/GetInfoModal'
import { Track } from '../types'
import '../styles/albums.css'

interface Album {
  name: string
  artist: string
  artists: string[]   // all unique artist variants for art lookup
  year: string | number
  tracks: Track[]
}

export default function AlbumsView() {
  const { state: lib, dispatch: libDispatch } = useLibrary()
  const { state: pb, dispatch: pbDispatch } = usePlayback()
  const { playTrack } = useAudio()
  const [selected, setSelected] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; track: Track; tracks: Track[]; idx: number } | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<{ ids: number[]; count: number } | null>(null)
  const [getInfoState, setGetInfoState] = useState<{ tracks: Track[]; index: number } | null>(null)
  const [selectedTrackIds, setSelectedTrackIds] = useState<Set<number>>(new Set())
  const lastClickedTrackIdx = useRef<number>(-1)

  const albums = useMemo((): Album[] => {
    const map = new Map<string, Album>()
    for (const t of lib.tracks) {
      // Use albumArtist when available, fall back to track artist
      const groupArtist = (t.albumArtist || t.artist || 'Unknown Artist').toLowerCase().trim()
      const albumKey = (t.album || 'Unknown').toLowerCase().trim()
      const key = `${groupArtist}|||${albumKey}`
      if (!map.has(key)) {
        map.set(key, {
          name: t.album || 'Unknown Album',
          artist: t.albumArtist || t.artist || 'Unknown Artist',
          artists: [],
          year: t.year || '',
          tracks: [],
        })
      }
      const album = map.get(key)!
      album.tracks.push(t)
      // Collect all unique artist variants for artwork lookup
      const a = (t.artist || '').trim()
      if (a && !album.artists.includes(a)) album.artists.push(a)
      if (t.albumArtist) {
        const aa = t.albumArtist.trim()
        if (aa && !album.artists.includes(aa)) album.artists.push(aa)
      }
      // Keep year from first track that has one
      if (!album.year && t.year) album.year = t.year
    }
    // Sort tracks within each album by disc then track number
    for (const album of map.values()) {
      album.tracks.sort((a, b) => {
        const da = Number(a.discNumber) || 1, db = Number(b.discNumber) || 1
        if (da !== db) return da - db
        const ta = Number(a.trackNumber) || 0, tb = Number(b.trackNumber) || 0
        return ta - tb
      })
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name))
  }, [lib.tracks])

  // Apply the page-local search filter on top of the computed albums.
  // Matches album name, artist, or any track title — so typing a song
  // title finds the album it lives on even if you don't remember the
  // album name.
  const filteredAlbums = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return albums
    return albums.filter(a => {
      if (a.name.toLowerCase().includes(q)) return true
      if (a.artist.toLowerCase().includes(q)) return true
      if (a.artists.some(art => art.toLowerCase().includes(q))) return true
      if (a.tracks.some(t => (t.title || '').toLowerCase().includes(q))) return true
      return false
    })
  }, [albums, search])

  // Helper: find artwork hash trying all artist variants for an album
  const findArtHash = (album: Album): string | undefined => {
    const albumKey = album.name.toLowerCase().trim()
    for (const artist of album.artists) {
      const artKey = `${artist.toLowerCase().trim()}|||${albumKey}`
      if (lib.artworkMap[artKey]) return lib.artworkMap[artKey]
    }
    // Fallback: try display artist
    const fallbackKey = `${album.artist.toLowerCase().trim()}|||${albumKey}`
    return lib.artworkMap[fallbackKey]
  }

  const handleContextMenu = useCallback((e: React.MouseEvent, track: Track, tracks: Track[], idx: number) => {
    e.preventDefault()
    setCtxMenu({ x: e.clientX, y: e.clientY, track, tracks, idx })
  }, [])

  const handleTrackClick = useCallback((track: Track, idx: number, albumTracks: Track[], e: React.MouseEvent) => {
    if (e.shiftKey && lastClickedTrackIdx.current >= 0 && lastClickedTrackIdx.current < albumTracks.length) {
      const from = Math.min(lastClickedTrackIdx.current, idx)
      const to = Math.max(lastClickedTrackIdx.current, idx)
      setSelectedTrackIds(new Set(albumTracks.slice(from, to + 1).map(t => t.id)))
    } else if (e.metaKey || e.ctrlKey) {
      setSelectedTrackIds(prev => {
        const next = new Set(prev)
        if (next.has(track.id)) next.delete(track.id)
        else next.add(track.id)
        return next
      })
      lastClickedTrackIdx.current = idx
    } else {
      setSelectedTrackIds(new Set([track.id]))
      lastClickedTrackIdx.current = idx
    }
  }, [])

  // Reset track selection when switching albums
  useEffect(() => {
    setSelectedTrackIds(new Set())
    lastClickedTrackIdx.current = -1
  }, [selected])

  const getContextMenuItems = useCallback((): MenuEntry[] => {
    if (!ctxMenu) return []
    const { track, tracks, idx } = ctxMenu
    const sel = selectedTrackIds.size > 1
      ? tracks.filter(t => selectedTrackIds.has(t.id))
      : [track]
    const count = sel.length
    const label = count > 1 ? `${count} Songs` : track.title

    // Batch artwork for all unique artist+album combos
    const artPairs = new Map<string, { artist: string; album: string }>()
    for (const t of sel) {
      if (t.artist && t.album) {
        const k = `${t.artist.toLowerCase().trim()}|||${t.album.toLowerCase().trim()}`
        if (!artPairs.has(k)) artPairs.set(k, { artist: t.artist, album: t.album })
      }
    }

    const artworkItems: MenuEntry[] = artPairs.size > 0 ? [
      { separator: true as const },
      {
        label: 'Add Artwork…',
        onClick: async () => {
          const file = await window.electronAPI.chooseArtworkFile()
          if (!file.ok || !file.path) return
          for (const { artist, album } of artPairs.values()) {
            const result = await window.electronAPI.setCustomArtwork(artist, album, file.path)
            if (result.ok && result.key && result.hash) {
              libDispatch({ type: 'ADD_ARTWORK', key: result.key, hash: result.hash })
            }
          }
        },
      },
      {
        label: 'Fetch Artwork from Internet',
        onClick: async () => {
          for (const { artist, album } of artPairs.values()) {
            const result = await window.electronAPI.fetchAlbumArt(artist, album, true)
            if (result.ok && result.key && result.hash) {
              libDispatch({ type: 'ADD_ARTWORK', key: result.key, hash: result.hash })
            }
          }
        },
      },
    ] : []

    return [
      { label: `Play "${label}"`, onClick: () => playTrack(track, tracks, idx) },
      { separator: true as const },
      { label: 'Play Next', onClick: () => pbDispatch({ type: 'PLAY_NEXT', tracks: sel }) },
      { label: 'Add to Up Next', onClick: () => pbDispatch({ type: 'ADD_TO_QUEUE', tracks: sel }) },
      { separator: true as const },
      { label: 'Get Info', onClick: () => setGetInfoState({ tracks: sel, index: idx }) },
      ...artworkItems,
      { separator: true as const },
      { label: count > 1 ? `Delete ${count} Songs` : 'Delete Song', onClick: () => setDeleteConfirm({ ids: sel.map(t => t.id), count }) },
    ]
  }, [ctxMenu, selectedTrackIds, playTrack, pbDispatch, libDispatch])

  const handleGetInfoSave = useCallback(
    async (updates: { id: number; field: string; value: string }[]) => {
      libDispatch({ type: 'UPDATE_TRACKS', updates })
      for (const u of updates) {
        await window.electronAPI.saveMetadataOverride(u.id, u.field, u.value)
      }
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

  // Track columns per row so we can insert the detail panel after the last album in the row
  const gridRef = useRef<HTMLDivElement>(null)
  const [colsPerRow, setColsPerRow] = useState(6)

  useEffect(() => {
    const grid = gridRef.current
    if (!grid) return
    const measure = () => {
      const style = getComputedStyle(grid)
      const cols = style.gridTemplateColumns.split(' ').length
      setColsPerRow(cols || 1)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(grid)
    return () => observer.disconnect()
  }, [])

  // Find the selected album's index
  const selectedIdx = selected
    ? filteredAlbums.findIndex(a => `${a.artist.toLowerCase().trim()}|||${a.name.toLowerCase().trim()}` === selected)
    : -1
  // The detail should appear after the last album in the selected album's row
  const detailAfterIdx = selectedIdx >= 0
    ? Math.min(Math.floor(selectedIdx / colsPerRow) * colsPerRow + colsPerRow - 1, filteredAlbums.length - 1)
    : -1
  const selectedAlbum = selectedIdx >= 0 ? filteredAlbums[selectedIdx] : null

  return (
    <div className="albums-view">
      <div className="view-search-bar">
        <input
          className="view-search-input"
          type="search"
          placeholder={`Search ${albums.length} albums...`}
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        {search && (
          <span className="view-search-count">
            {filteredAlbums.length} match{filteredAlbums.length !== 1 ? 'es' : ''}
          </span>
        )}
      </div>
      <div className="albums-grid" ref={gridRef}>
        {filteredAlbums.map((album, albumIdx) => {
          const key = `${album.artist.toLowerCase().trim()}|||${album.name.toLowerCase().trim()}`
          const artHash = findArtHash(album)
          const isSelected = selected === key
          // Show detail after the last album in this row
          const showDetailHere = albumIdx === detailAfterIdx && selectedAlbum
          return (
            <React.Fragment key={key}>
              <div
                className={`album-card ${isSelected ? 'album-card--selected' : ''}`}
                onClick={() => setSelected(isSelected ? null : key)}
              >
                <div className="album-card-art">
                  {artHash ? (
                    <img src={`album-art://${artHash}.jpg`} alt={album.name} className="album-card-img" />
                  ) : (
                    <svg width="32" height="32" viewBox="0 0 32 32" fill="#bbb">
                      <circle cx="16" cy="16" r="14" fill="none" stroke="#bbb" strokeWidth="1" />
                      <circle cx="16" cy="16" r="5" fill="none" stroke="#bbb" strokeWidth="1" />
                      <circle cx="16" cy="16" r="1.5" fill="#bbb" />
                    </svg>
                  )}
                </div>
                <div className="album-card-title">{album.name}</div>
                <div className="album-card-artist">{album.artist}</div>
              </div>
              {showDetailHere && (() => {
                const detailArtHash = findArtHash(selectedAlbum)
                return (
                  <div className="album-detail album-detail--inline">
                    <div className="album-detail-header">
                      <div className="album-detail-art">
                        {detailArtHash ? (
                          <img src={`album-art://${detailArtHash}.jpg`} alt={selectedAlbum.name} className="album-detail-img" />
                        ) : (
                          <svg width="48" height="48" viewBox="0 0 48 48" fill="#999">
                            <circle cx="24" cy="24" r="20" fill="none" stroke="#999" strokeWidth="1.5" />
                            <circle cx="24" cy="24" r="7" fill="none" stroke="#999" strokeWidth="1.5" />
                            <circle cx="24" cy="24" r="2" fill="#999" />
                          </svg>
                        )}
                      </div>
                      <div>
                        <div className="album-detail-title">{selectedAlbum.name}</div>
                        <div className="album-detail-artist">{selectedAlbum.artist}</div>
                        <div className="album-detail-meta">{selectedAlbum.tracks.length} tracks{selectedAlbum.year ? ` · ${selectedAlbum.year}` : ''}</div>
                      </div>
                    </div>
                    <div className="album-detail-tracks">
                      {(() => {
                        const discNums = new Set(selectedAlbum.tracks.map(t => Number(t.discNumber) || 1))
                        const isMultiDisc = discNums.size > 1
                        let lastDisc = -1
                        let rowIdx = 0
                        return selectedAlbum.tracks.map((track, i) => {
                          const disc = Number(track.discNumber) || 1
                          const showDiscHeader = isMultiDisc && disc !== lastDisc
                          lastDisc = disc
                          const currentRowIdx = rowIdx++
                          const isPlaying = pb.nowPlaying?.id === track.id
                          const isTrackSelected = selectedTrackIds.has(track.id)
                          return (
                            <React.Fragment key={track.id}>
                              {showDiscHeader && (
                                <div className="album-detail-disc-header">
                                  Disc {disc}
                                </div>
                              )}
                              <div
                                className={`album-detail-row ${isPlaying ? 'album-detail-row--playing' : ''} ${isTrackSelected ? 'album-detail-row--selected' : ''} ${currentRowIdx % 2 ? 'album-detail-row--alt' : ''}`}
                                onClick={(e) => handleTrackClick(track, i, selectedAlbum.tracks, e)}
                                onDoubleClick={() => playTrack(track, selectedAlbum.tracks, i)}
                                onContextMenu={(e) => {
                                  if (!selectedTrackIds.has(track.id)) {
                                    setSelectedTrackIds(new Set([track.id]))
                                    lastClickedTrackIdx.current = i
                                  }
                                  handleContextMenu(e, track, selectedAlbum.tracks, i)
                                }}
                                draggable
                                onDragStart={(e) => {
                                  const sel = selectedTrackIds.size > 1 && selectedTrackIds.has(track.id)
                                    ? selectedAlbum.tracks.filter(t => selectedTrackIds.has(t.id))
                                    : [track]
                                  e.dataTransfer.setData('application/jaketunes-tracks', JSON.stringify(sel.map(t => t.id)))
                                  e.dataTransfer.effectAllowed = 'copy'
                                }}
                              >
                                <span className="album-detail-icon">{isPlaying ? <SpeakerPlayingIcon /> : <span className="album-detail-num">{track.trackNumber || i + 1}</span>}</span>
                                <span className="album-detail-track-title">{track.title}</span>
                              </div>
                            </React.Fragment>
                          )
                        })
                      })()}
                    </div>
                  </div>
                )
              })()}
            </React.Fragment>
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
          message={deleteConfirm.count === 1
            ? 'Are you sure you want to delete this song from your library?'
            : `Are you sure you want to delete ${deleteConfirm.count} songs from your library?`}
          detail="This will remove them from all playlists. This cannot be undone."
          confirmLabel="Delete"
          onConfirm={() => { libDispatch({ type: 'DELETE_TRACKS', ids: deleteConfirm.ids }); setDeleteConfirm(null) }}
          onCancel={() => setDeleteConfirm(null)}
        />
      )}
    </div>
  )
}
