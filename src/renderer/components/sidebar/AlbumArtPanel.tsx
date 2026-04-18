import { useState, useEffect, useRef, useCallback } from 'react'
import { usePlayback } from '../../context/PlaybackContext'
import { useLibrary } from '../../context/LibraryContext'
import ContextMenu from '../ContextMenu'

export default function AlbumArtPanel() {
  const { state } = usePlayback()
  const { state: libState, dispatch: libDispatch } = useLibrary()
  const fetchedRef = useRef<Set<string>>(new Set())
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)
  const [dragOver, setDragOver] = useState(false)

  const artist = state.nowPlaying?.artist || ''
  const album = state.nowPlaying?.album || ''
  const artKey = state.nowPlaying
    ? `${artist.toLowerCase().trim()}|||${album.toLowerCase().trim()}`
    : null
  const artHash = artKey ? libState.artworkMap[artKey] : null

  // Auto-fetch artwork when a new track plays and art isn't cached
  useEffect(() => {
    if (!state.nowPlaying || !artKey || artHash) return
    if (fetchedRef.current.has(artKey)) return
    if (!artist || !album) return

    fetchedRef.current.add(artKey)
    window.electronAPI.fetchAlbumArt(artist, album)
      .then((result) => {
        if (result.ok && result.key && result.hash) {
          libDispatch({ type: 'ADD_ARTWORK', key: result.key, hash: result.hash })
        }
      })
      .catch(() => {})
  }, [artKey, artHash, artist, album, state.nowPlaying, libDispatch])

  const handleAddArtwork = useCallback(async () => {
    if (!artist || !album) return
    const file = await window.electronAPI.chooseArtworkFile()
    if (!file.ok || !file.path) return
    const result = await window.electronAPI.setCustomArtwork(artist, album, file.path)
    if (result.ok && result.key && result.hash) {
      libDispatch({ type: 'ADD_ARTWORK', key: result.key, hash: result.hash })
      fetchedRef.current.delete(artKey || '')
    }
  }, [artist, album, artKey, libDispatch])

  const handleRemoveArtwork = useCallback(async () => {
    if (!artist || !album || !artKey) return
    const result = await window.electronAPI.removeArtwork(artist, album)
    if (result.ok && result.key) {
      libDispatch({ type: 'REMOVE_ARTWORK', key: result.key })
      fetchedRef.current.delete(artKey)
    }
  }, [artist, album, artKey, libDispatch])

  const handleRefetch = useCallback(async () => {
    if (!artist || !album) return
    fetchedRef.current.delete(artKey || '')
    const result = await window.electronAPI.fetchAlbumArt(artist, album, true)
    if (result.ok && result.key && result.hash) {
      libDispatch({ type: 'ADD_ARTWORK', key: result.key, hash: result.hash })
    }
  }, [artist, album, artKey, libDispatch])

  // Drag-and-drop image onto the art panel
  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    if (!artist || !album) return

    const files = Array.from(e.dataTransfer.files)
    const imgFile = files.find(f => /\.(jpe?g|png|tiff?|bmp|gif|webp)$/i.test(f.name))
    if (!imgFile) return

    const result = await window.electronAPI.setCustomArtwork(artist, album, imgFile.path)
    if (result.ok && result.key && result.hash) {
      libDispatch({ type: 'ADD_ARTWORK', key: result.key, hash: result.hash })
      fetchedRef.current.delete(artKey || '')
    }
  }, [artist, album, artKey, libDispatch])

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    if (!state.nowPlaying) return
    setCtxMenu({ x: e.clientX, y: e.clientY })
  }, [state.nowPlaying])

  const ctxItems = [
    { label: 'Add Artwork...', onClick: () => { setCtxMenu(null); handleAddArtwork() }, disabled: !artist || !album },
    { label: 'Fetch from Internet', onClick: () => { setCtxMenu(null); handleRefetch() }, disabled: !artist || !album },
    ...(artHash ? [{ label: 'Remove Artwork', onClick: () => { setCtxMenu(null); handleRemoveArtwork() } }] : []),
  ]

  return (
    <div className="album-art-panel">
      <div
        className={`album-art-square${dragOver ? ' album-art-drop-active' : ''}`}
        onContextMenu={handleContextMenu}
        onDragOver={(e) => { e.preventDefault(); if (state.nowPlaying) setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        {artHash ? (
          <img
            src={`album-art://${artHash}.jpg`}
            alt={album}
            className="album-art-image"
            draggable={false}
          />
        ) : state.nowPlaying ? (
          <div className="album-art-placeholder">
            <svg width="40" height="40" viewBox="0 0 40 40" fill="#999">
              <circle cx="20" cy="20" r="18" fill="none" stroke="#999" strokeWidth="1.5" />
              <circle cx="20" cy="20" r="6" fill="none" stroke="#999" strokeWidth="1.5" />
              <circle cx="20" cy="20" r="2" fill="#999" />
            </svg>
          </div>
        ) : (
          <div className="album-art-placeholder">
            <svg width="40" height="40" viewBox="0 0 40 40" fill="#bbb">
              <path d="M14 10v16l4-2v-11l8-3v12l-4 2V14z" />
              <circle cx="14" cy="28" r="4" fill="none" stroke="#bbb" strokeWidth="1.5" />
              <circle cx="26" cy="24" r="4" fill="none" stroke="#bbb" strokeWidth="1.5" />
            </svg>
          </div>
        )}
        {dragOver && (
          <div className="album-art-drop-hint">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="#fff" strokeWidth="2">
              <line x1="10" y1="4" x2="10" y2="16" />
              <line x1="4" y1="10" x2="16" y2="10" />
            </svg>
          </div>
        )}
      </div>
      <div className="album-art-buttons">
        <button
          className="album-art-btn"
          title="New Playlist"
          onClick={() => {
            const name = window.prompt('New playlist name:')
            if (!name || !name.trim()) return
            const playlist = { id: `pl-${Date.now()}`, name: name.trim(), trackIds: [] as number[] }
            libDispatch({ type: 'ADD_PLAYLIST', playlist })
            libDispatch({ type: 'VIEW_PLAYLIST', id: playlist.id })
          }}
        ><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><line x1="7" y1="2" x2="7" y2="12" /><line x1="2" y1="7" x2="12" y2="7" /></svg></button>
        <button
          className="album-art-btn"
          title="Random Playlist"
          disabled={libState.tracks.length === 0}
          onClick={() => {
            const count = Math.min(25, libState.tracks.length)
            const shuffled = [...libState.tracks].sort(() => Math.random() - 0.5)
            const picked = shuffled.slice(0, count)
            const playlist = {
              id: `pl-${Date.now()}`,
              name: `Random Mix – ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
              trackIds: picked.map(t => t.id),
            }
            libDispatch({ type: 'ADD_PLAYLIST', playlist })
            libDispatch({ type: 'VIEW_PLAYLIST', id: playlist.id })
          }}
        ><svg width="20" height="20" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="square" strokeLinejoin="miter"><path d="M5 10V4l6-2v6" /><circle cx="3.5" cy="10" r="1.5" /><circle cx="9.5" cy="8" r="1.5" /></svg></button>
        <button
          className="album-art-btn album-art-btn--dj"
          title="Start DJ Mode"
          onClick={() => window.dispatchEvent(new CustomEvent('toggle-dj-mode'))}
        ><svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10 5v12" strokeWidth="1.8" /><path d="M10 17L6 19M10 17L14 19" /><path d="M8 10h4" /><path d="M9 13h2" /><path d="M10 7L7 17" strokeWidth="1" /><path d="M10 7L13 17" strokeWidth="1" /><path d="M7 4.5a4 4 0 016 0" strokeWidth="1.3" /><path d="M5 2.5a7 7 0 0110 0" strokeWidth="1.2" /><circle cx="10" cy="4.2" r="1" fill="currentColor" stroke="none" /></svg></button>
      </div>

      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={ctxItems}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  )
}
