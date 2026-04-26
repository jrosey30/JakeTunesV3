import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { usePlayback } from '../context/PlaybackContext'
import { useAudio } from '../hooks/useAudio'
import { Track } from '../types'
import ContextMenu, { MenuEntry } from '../components/ContextMenu'
import { useCynthia } from '../context/CynthiaContext'
import { toCynthiaTrack } from '../utils/cynthia'
import ConfirmDialog from '../components/ConfirmDialog'
import UndoToast from '../components/UndoToast'
import GetInfoModal from '../components/GetInfoModal'
import StarRating, { ratingMenuEntries } from '../components/StarRating'
import { SpeakerPlayingIcon } from '../assets/icons/SpeakerIcon'
import '../styles/songs.css'

function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return ''
  const totalSecs = Math.floor(ms / 1000)
  const m = Math.floor(totalSecs / 60)
  const s = totalSecs % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

// Persist sort preferences per playlist across navigation (module-level so survives unmount)
const sortPrefs = new Map<string, { col: string | null; dir: 'asc' | 'desc' }>()

interface ColDef {
  key: string
  label: string
  defaultWidth: number
  minWidth: number
  resizable: boolean
}

const ALL_COLUMN_DEFS: ColDef[] = [
  { key: 'playing', label: '', defaultWidth: 24, minWidth: 24, resizable: false },
  { key: 'title', label: 'Name', defaultWidth: 220, minWidth: 80, resizable: true },
  { key: 'time', label: 'Time', defaultWidth: 50, minWidth: 40, resizable: true },
  { key: 'artist', label: 'Artist', defaultWidth: 160, minWidth: 60, resizable: true },
  { key: 'album', label: 'Album', defaultWidth: 160, minWidth: 60, resizable: true },
  { key: 'genre', label: 'Genre', defaultWidth: 100, minWidth: 50, resizable: true },
  { key: 'year', label: 'Year', defaultWidth: 50, minWidth: 35, resizable: true },
  { key: 'dateAdded', label: 'Date Added', defaultWidth: 100, minWidth: 60, resizable: true },
  { key: 'playCount', label: 'Plays', defaultWidth: 50, minWidth: 35, resizable: true },
  { key: 'rating', label: 'Rating', defaultWidth: 75, minWidth: 55, resizable: true },
]

const ALWAYS_VISIBLE = new Set(['playing', 'title'])

export default function PlaylistView() {
  const { state, dispatch } = useLibrary()
  const { state: pb, dispatch: pbDispatch } = usePlayback()
  const { playTrack } = useAudio()
  const { openCynthia } = useCynthia()
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; track: Track; idx: number } | null>(null)
  const [confirmAction, setConfirmAction] = useState<{ type: 'remove-tracks' | 'delete-playlist' | 'delete-tracks'; trackIds?: number[] } | null>(null)
  const [undoState, setUndoState] = useState<{ trackIds: number[]; atIndex: number; playlistId: string; message: string } | null>(null)
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null)
  const [getInfoState, setGetInfoState] = useState<{ tracks: Track[]; index: number } | null>(null)
  const lastClickedIdx = useRef<number>(-1)
  const [headerCtxMenu, setHeaderCtxMenu] = useState<{ x: number; y: number } | null>(null)

  // Auto-follow now-playing (4.0). Mirror of SongsView pattern; suppressed
  // when user has scrolled in the last 5s.
  const songsBodyRef = useRef<HTMLDivElement | null>(null)
  const lastUserActivityAtRef = useRef<number>(0)
  const isAutoScrollAtRef = useRef<number>(0)
  const FOLLOW_IDLE_MS = 5000
  const handleScroll = useCallback(() => {
    if (Date.now() - isAutoScrollAtRef.current > 200) {
      lastUserActivityAtRef.current = Date.now()
    }
  }, [])

  const playlist = state.playlists.find(p => p.id === state.activePlaylistId)

  // Local sort state — restored from module-level map so it survives navigation
  const [sortCol, setSortCol] = useState<string | null>(() => {
    const saved = state.activePlaylistId ? sortPrefs.get(state.activePlaylistId) : undefined
    return saved?.col ?? null
  })
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(() => {
    const saved = state.activePlaylistId ? sortPrefs.get(state.activePlaylistId) : undefined
    return saved?.dir ?? 'asc'
  })

  // Restore sort prefs when switching playlists (component stays mounted)
  const prevPlaylistId = useRef(state.activePlaylistId)
  useEffect(() => {
    if (state.activePlaylistId !== prevPlaylistId.current) {
      prevPlaylistId.current = state.activePlaylistId
      const saved = state.activePlaylistId ? sortPrefs.get(state.activePlaylistId) : undefined
      setSortCol(saved?.col ?? null)
      setSortDir(saved?.dir ?? 'asc')
    }
  }, [state.activePlaylistId])

  // Persist sort prefs whenever they change
  useEffect(() => {
    if (state.activePlaylistId) sortPrefs.set(state.activePlaylistId, { col: sortCol, dir: sortDir })
  }, [state.activePlaylistId, sortCol, sortDir])

  // Column visibility & width state. Rating column stays visible by
  // default so ratings can be edited inline from any playlist.
  const [hiddenCols, setHiddenCols] = useState<Set<string>>(() => new Set(['dateAdded', 'playCount']))
  const [colWidthMap, setColWidthMap] = useState<Record<string, number>>(() =>
    Object.fromEntries(ALL_COLUMN_DEFS.map(c => [c.key, c.defaultWidth]))
  )

  const visibleCols = ALL_COLUMN_DEFS.filter(c => !hiddenCols.has(c.key))
  const colWidths = visibleCols.map(c => colWidthMap[c.key] ?? c.defaultWidth)
  const gridTemplate = colWidths.map(w => `${w}px`).join(' ')

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editing])

  const trackMap = new Map(state.tracks.map(t => [t.id, t]))
  const allPlaylistTracks = playlist
    ? playlist.trackIds.map(id => trackMap.get(id)).filter((t): t is Track => t !== undefined)
    : []

  // Apply search filter — every word must appear somewhere across all fields
  const tracks = state.searchQuery
    ? (() => {
        const words = state.searchQuery.toLowerCase().split(/\s+/).filter(w => w.length > 0)
        return allPlaylistTracks.filter(t => {
          const haystack = `${t.title || ''} ${t.artist || ''} ${t.album || ''} ${t.genre || ''} ${t.year || ''}`.toLowerCase()
          return words.every(w => haystack.includes(w))
        })
      })()
    : allPlaylistTracks

  // Apply local sort AFTER search filter
  const sortedTracks = useMemo(() => {
    if (!sortCol) return tracks // natural order
    return [...tracks].sort((a, b) => {
      let av: string | number = '', bv: string | number = ''
      switch (sortCol) {
        case 'title': av = a.title || ''; bv = b.title || ''; break
        case 'artist': av = a.artist || ''; bv = b.artist || ''; break
        case 'album': av = a.album || ''; bv = b.album || ''; break
        case 'genre': av = a.genre || ''; bv = b.genre || ''; break
        case 'year': av = a.year || 0; bv = b.year || 0; break
        case 'time': av = a.duration || 0; bv = b.duration || 0; break
        case 'dateAdded': av = a.dateAdded || ''; bv = b.dateAdded || ''; break
        case 'playCount': av = a.playCount || 0; bv = b.playCount || 0; break
        case 'rating': av = a.rating || 0; bv = b.rating || 0; break
        default: return 0
      }
      const aStr = String(av).toLowerCase()
      const bStr = String(bv).toLowerCase()
      const cmp = aStr < bStr ? -1 : aStr > bStr ? 1 : 0
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [tracks, sortCol, sortDir])

  // Sort handler
  const handleSort = useCallback((key: string) => {
    if (key === 'playing') return
    if (sortCol === key) {
      if (sortDir === 'desc') {
        // Third click: go back to natural order
        setSortCol(null)
        setSortDir('asc')
      } else {
        setSortDir('desc')
      }
    } else {
      setSortCol(key)
      setSortDir('asc')
    }
  }, [sortCol, sortDir])

  // Column resize handler
  const handleColResize = useCallback((colKey: string, colIndex: number, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startWidth = colWidths[colIndex]
    const col = visibleCols[colIndex]
    const minW = col.minWidth
    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX
      const newWidth = Math.max(minW, startWidth + delta)
      setColWidthMap(prev => ({ ...prev, [colKey]: newWidth }))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
    }
    document.body.style.cursor = 'col-resize'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [colWidths])

  // Prompt to remove selected tracks from playlist
  const removeSelected = useCallback(() => {
    if (!playlist || selectedIds.size === 0) return
    setConfirmAction({ type: 'remove-tracks', trackIds: Array.from(selectedIds) })
  }, [playlist, selectedIds])

  // Actually remove after confirmation
  const executeRemove = useCallback(() => {
    if (!playlist || !confirmAction) return
    if (confirmAction.type === 'remove-tracks' && confirmAction.trackIds) {
      // Find the position of the first removed track for undo
      const firstRemovedIdx = playlist.trackIds.findIndex(id => confirmAction.trackIds!.includes(id))
      const count = confirmAction.trackIds.length
      dispatch({ type: 'REMOVE_TRACKS_FROM_PLAYLIST', playlistId: playlist.id, trackIds: confirmAction.trackIds })
      setSelectedIds(new Set())
      setUndoState({
        trackIds: confirmAction.trackIds,
        atIndex: firstRemovedIdx >= 0 ? firstRemovedIdx : 0,
        playlistId: playlist.id,
        message: `Removed ${count} song${count !== 1 ? 's' : ''} from "${playlist.name}"`,
      })
    } else if (confirmAction.type === 'delete-tracks' && confirmAction.trackIds) {
      dispatch({ type: 'DELETE_TRACKS', ids: confirmAction.trackIds })
      setSelectedIds(new Set())
    } else if (confirmAction.type === 'delete-playlist') {
      dispatch({ type: 'REMOVE_PLAYLIST', id: playlist.id })
    }
    setConfirmAction(null)
  }, [playlist, confirmAction, dispatch])

  // Keyboard: Delete/Backspace to remove selected tracks
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (confirmAction) return
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.size > 0 && playlist) {
        e.preventDefault()
        removeSelected()
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [selectedIds, playlist, removeSelected, confirmAction])

  // Get Info save handler
  const handleGetInfoSave = useCallback(
    async (updates: { id: number; field: string; value: string }[]) => {
      dispatch({ type: 'UPDATE_TRACKS', updates })
      for (const u of updates) {
        await window.electronAPI.saveMetadataOverride(u.id, u.field, u.value)
      }
    },
    [dispatch]
  )

  // Fetch artwork from Get Info modal
  const handleFetchArt = useCallback(
    async (artist: string, album: string, force?: boolean): Promise<{ key: string; hash: string } | null> => {
      const result = await window.electronAPI.fetchAlbumArt(artist, album, force)
      if (result.ok && result.key && result.hash) {
        dispatch({ type: 'ADD_ARTWORK', key: result.key, hash: result.hash })
        return { key: result.key, hash: result.hash }
      }
      return null
    },
    [dispatch]
  )

  const handleSetCustomArt = useCallback(
    async (artist: string, album: string, imagePath: string): Promise<{ key: string; hash: string } | null> => {
      const result = await window.electronAPI.setCustomArtwork(artist, album, imagePath)
      if (result.ok && result.key && result.hash) {
        dispatch({ type: 'ADD_ARTWORK', key: result.key, hash: result.hash })
        return { key: result.key, hash: result.hash }
      }
      return null
    },
    [dispatch]
  )

  // Listen for Cmd+I (Get Info) when in playlist view
  useEffect(() => {
    if (state.currentView !== 'playlist') return
    const handler = () => {
      if (selectedIds.size > 0) {
        const selectedTracks = sortedTracks.filter(t => selectedIds.has(t.id))
        const idx = sortedTracks.findIndex(t => selectedIds.has(t.id))
        setGetInfoState({ tracks: selectedTracks, index: idx >= 0 ? idx : 0 })
      }
    }
    window.addEventListener('jaketunes-get-info', handler)
    return () => window.removeEventListener('jaketunes-get-info', handler)
  }, [state.currentView, selectedIds, sortedTracks])

  // Auto-follow now-playing on track change (4.0).
  useEffect(() => {
    if (state.currentView !== 'playlist') return
    if (!pb.nowPlaying) return
    if (Date.now() - lastUserActivityAtRef.current < FOLLOW_IDLE_MS) return
    const idx = sortedTracks.findIndex(t => t.id === pb.nowPlaying!.id)
    if (idx < 0) return
    const el = songsBodyRef.current
    if (!el) return
    const rowH = 19
    const rowTop = idx * rowH
    const rowBottom = rowTop + rowH
    const scrollTop = el.scrollTop
    const viewH = el.clientHeight
    if (rowTop < scrollTop || rowBottom > scrollTop + viewH) {
      isAutoScrollAtRef.current = Date.now()
      el.scrollTop = rowTop < scrollTop ? rowTop : rowBottom - viewH
    }
  }, [pb.nowPlaying?.id, state.currentView, sortedTracks])

  if (!playlist) {
    return <div style={{ padding: 24, color: '#999' }}>Playlist not found.</div>
  }

  const totalMs = sortedTracks.reduce((sum, t) => sum + (t.duration || 0), 0)
  const totalMins = Math.floor(totalMs / 60000)
  const hours = Math.floor(totalMins / 60)
  const mins = totalMins % 60
  const timeStr = hours > 0 ? `${hours} hr ${mins} min` : `${mins} min`

  const commitRename = () => {
    const trimmed = editName.trim()
    if (trimmed && trimmed !== playlist.name) {
      dispatch({ type: 'RENAME_PLAYLIST', id: playlist.id, name: trimmed })
    }
    setEditing(false)
  }

  // Reset anchor when search/sort changes the visible list
  useEffect(() => {
    lastClickedIdx.current = -1
    setSelectedIds(new Set())
  }, [state.searchQuery, sortCol, sortDir])

  const handleClick = (track: Track, idx: number, e: React.MouseEvent) => {
    if (e.shiftKey && lastClickedIdx.current >= 0 && lastClickedIdx.current < sortedTracks.length) {
      const from = Math.min(lastClickedIdx.current, idx)
      const to = Math.max(lastClickedIdx.current, idx)
      setSelectedIds(new Set(sortedTracks.slice(from, to + 1).map(t => t.id)))
    } else if (e.metaKey || e.ctrlKey) {
      setSelectedIds(prev => {
        const next = new Set(prev)
        if (next.has(track.id)) next.delete(track.id)
        else next.add(track.id)
        return next
      })
      lastClickedIdx.current = idx
    } else {
      setSelectedIds(new Set([track.id]))
      lastClickedIdx.current = idx
    }
  }

  const handleContextMenu = (e: React.MouseEvent, track: Track, idx: number) => {
    e.preventDefault()
    if (!selectedIds.has(track.id)) {
      setSelectedIds(new Set([track.id]))
    }
    setCtxMenu({ x: e.clientX, y: e.clientY, track, idx })
  }

  const getContextMenuItems = (): MenuEntry[] => {
    if (!ctxMenu) return []
    const { track, idx } = ctxMenu
    const selected = selectedIds.size > 1
      ? sortedTracks.filter(t => selectedIds.has(t.id))
      : [track]
    const count = selected.length
    const label = count > 1 ? `${count} Songs` : track.title

    // Collect unique artist+album combos from all selected tracks for batch artwork
    const artPairs = new Map<string, { artist: string; album: string }>()
    for (const t of selected) {
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
              dispatch({ type: 'ADD_ARTWORK', key: result.key, hash: result.hash })
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
              dispatch({ type: 'ADD_ARTWORK', key: result.key, hash: result.hash })
            }
          }
        },
      },
    ] : []

    return [
      { label: `Play "${label}"`, onClick: () => playTrack(track, sortedTracks, idx) },
      { separator: true as const },
      { label: `Play Next`, onClick: () => pbDispatch({ type: 'PLAY_NEXT', tracks: selected }) },
      { label: `Add to Up Next`, onClick: () => pbDispatch({ type: 'ADD_TO_QUEUE', tracks: selected }) },
      ...ratingMenuEntries(selected, dispatch),
      { separator: true as const },
      {
        label: `Get Info`,
        onClick: () => setGetInfoState({ tracks: selected, index: idx }),
      },
      ...artworkItems,
      { separator: true as const },
      {
        label: 'Cynthia!!',
        onClick: () => {
          if (!ctxMenu) return
          openCynthia({
            x: ctxMenu.x, y: ctxMenu.y,
            scope: {
              type: 'tracks',
              label: count > 1 ? `${count} tracks` : track.title,
              tracks: selected.map(toCynthiaTrack),
            },
          })
        },
      },
      { separator: true as const },
      {
        label: `Remove from Playlist`,
        onClick: () => {
          setConfirmAction({ type: 'remove-tracks', trackIds: selected.map(t => t.id) })
        },
      },
      { separator: true as const },
      {
        label: count > 1 ? `Delete ${count} Songs` : 'Delete Song',
        onClick: () => {
          setConfirmAction({ type: 'delete-tracks', trackIds: selected.map(t => t.id) })
        },
      },
    ]
  }

  // Drag reorder is only enabled when in natural order (no sort, no search)
  const canDragReorder = !state.searchQuery && !sortCol

  return (
    <div className="playlist-view">
      <div className="playlist-view-header">
        <div>
          {editing ? (
            <input
              ref={inputRef}
              className="playlist-view-name-input"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename()
                if (e.key === 'Escape') setEditing(false)
              }}
            />
          ) : (
            <h2
              className="playlist-view-name playlist-view-name--editable"
              onDoubleClick={() => { setEditName(playlist.name); setEditing(true) }}
              title="Double-click to rename"
            >
              {playlist.name}
            </h2>
          )}
          <div className="playlist-view-meta">{sortedTracks.length} {sortedTracks.length === 1 ? 'song' : 'songs'}, {timeStr}</div>
        </div>
        <div className="playlist-view-actions">
          <button
            className="playlist-view-play"
            onClick={() => {
              if (sortedTracks.length > 0) playTrack(sortedTracks[0], sortedTracks, 0)
            }}
          >
            Play All
          </button>
          <button
            className="playlist-view-delete"
            onClick={() => setConfirmAction({ type: 'delete-playlist' })}
          >
            Delete
          </button>
        </div>
      </div>
      {playlist.commentary && (
        <div className="playlist-view-commentary">{playlist.commentary}</div>
      )}
      <div className="songs-view" style={{ flex: 1, minHeight: 0 }}>
        <div
          className="songs-header"
          style={{ gridTemplateColumns: gridTemplate }}
          onContextMenu={(e) => { e.preventDefault(); setHeaderCtxMenu({ x: e.clientX, y: e.clientY }) }}
        >
          {visibleCols.map((col, i) => (
            <div
              key={col.key}
              className={`songs-header-cell ${sortCol === col.key ? 'sorted' : ''}`}
              onClick={() => handleSort(col.key)}
            >
              {col.label}
              {sortCol === col.key && (
                <span className="sort-arrow">{sortDir === 'asc' ? '▲' : '▼'}</span>
              )}
              {col.resizable && (
                <div
                  className="col-resize-handle"
                  onMouseDown={(e) => handleColResize(col.key, i, e)}
                />
              )}
            </div>
          ))}
        </div>
        <div className="songs-body" ref={songsBodyRef} onScroll={handleScroll}>
          {sortedTracks.map((track, i) => {
            const isPlaying = pb.nowPlaying?.id === track.id
            const isSelected = selectedIds.has(track.id)
            return (
              <div
                key={track.id}
                className={`songs-row ${i % 2 ? 'songs-row--alt' : ''} ${isPlaying ? 'songs-row--playing' : ''} ${isSelected ? 'songs-row--selected' : ''} ${dragOverIdx === i ? 'playlist-view-track--dragover' : ''}`}
                style={{ gridTemplateColumns: gridTemplate }}
                onClick={(e) => handleClick(track, i, e)}
                onDoubleClick={() => playTrack(track, sortedTracks, i)}
                onContextMenu={(e) => handleContextMenu(e, track, i)}
                draggable
                onDragStart={(e) => {
                  // Always allow dragging tracks to other playlists
                  const selected = selectedIds.has(track.id) && selectedIds.size > 1
                    ? sortedTracks.filter(t => selectedIds.has(t.id))
                    : [track]
                  e.dataTransfer.setData('application/jaketunes-tracks', JSON.stringify(selected.map(t => t.id)))
                  // Also allow internal playlist reorder when in natural order
                  if (canDragReorder) {
                    e.dataTransfer.setData('application/jaketunes-playlist-reorder', String(i))
                  }
                  e.dataTransfer.effectAllowed = canDragReorder ? 'copyMove' : 'copy'
                }}
                onDragOver={(e) => {
                  if (!e.dataTransfer.types.includes('application/jaketunes-playlist-reorder')) return
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  setDragOverIdx(i)
                }}
                onDragLeave={() => setDragOverIdx(null)}
                onDrop={(e) => {
                  e.preventDefault()
                  setDragOverIdx(null)
                  const fromStr = e.dataTransfer.getData('application/jaketunes-playlist-reorder')
                  if (!fromStr) return
                  const from = parseInt(fromStr, 10)
                  if (from === i || isNaN(from)) return
                  const newIds = [...playlist.trackIds]
                  const [moved] = newIds.splice(from, 1)
                  newIds.splice(from < i ? i - 1 : i, 0, moved)
                  dispatch({ type: 'REORDER_PLAYLIST', playlistId: playlist.id, trackIds: newIds })
                }}
              >
                {visibleCols.map(col => {
                  switch (col.key) {
                    case 'playing':
                      return <div key={col.key} className="songs-cell songs-cell--icon">{isPlaying && <SpeakerPlayingIcon />}</div>
                    case 'title':
                      return <div key={col.key} className="songs-cell songs-cell--title">{track.title}</div>
                    case 'time':
                      return <div key={col.key} className="songs-cell songs-cell--time">{formatDuration(track.duration)}</div>
                    case 'artist':
                      return <div key={col.key} className="songs-cell">{track.artist}</div>
                    case 'album':
                      return <div key={col.key} className="songs-cell">{track.album}</div>
                    case 'genre':
                      return <div key={col.key} className="songs-cell">{track.genre}</div>
                    case 'year':
                      return <div key={col.key} className="songs-cell">{track.year || ''}</div>
                    case 'dateAdded': {
                      const da = track.dateAdded || ''
                      const dp = da.length > 10 ? da.substring(0, 10) : da
                      const [y, mo, dy] = dp.split('-')
                      return <div key={col.key} className="songs-cell songs-cell--time">{dp ? `${mo}-${dy}-${y}` : ''}</div>
                    }
                    case 'playCount':
                      return <div key={col.key} className="songs-cell songs-cell--time">{track.playCount || ''}</div>
                    case 'rating':
                      return (
                        <div key={col.key} className="songs-cell songs-cell--rating">
                          <StarRating
                            value={Number(track.rating) || 0}
                            onChange={(r) => {
                              const value = String(r)
                              dispatch({ type: 'UPDATE_TRACKS', updates: [{ id: track.id, field: 'rating', value }] })
                              window.electronAPI.saveMetadataOverride(track.id, 'rating', value)
                            }}
                          />
                        </div>
                      )
                    default:
                      return null
                  }
                })}
              </div>
            )
          })}
        </div>
      </div>
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={getContextMenuItems()}
          onClose={() => setCtxMenu(null)}
        />
      )}
      {headerCtxMenu && (
        <ContextMenu
          x={headerCtxMenu.x}
          y={headerCtxMenu.y}
          items={[
            {
              label: 'Playlist Order',
              checked: sortCol === null,
              onClick: () => { setSortCol(null); setSortDir('asc') },
            },
            { separator: true as const },
            ...ALL_COLUMN_DEFS
              .filter(c => !ALWAYS_VISIBLE.has(c.key))
              .map(c => ({
                label: c.label,
                checked: !hiddenCols.has(c.key),
                onClick: () => {
                  setHiddenCols(prev => {
                    const next = new Set(prev)
                    if (next.has(c.key)) {
                      next.delete(c.key) // was hidden → show
                    } else {
                      next.add(c.key) // was visible → hide
                      // If hiding the column we're sorting by, reset to playlist order
                      if (sortCol === c.key) { setSortCol(null); setSortDir('asc') }
                    }
                    return next
                  })
                },
              })),
          ]}
          onClose={() => setHeaderCtxMenu(null)}
        />
      )}
      {confirmAction && confirmAction.type === 'remove-tracks' && (
        <ConfirmDialog
          message={`Remove ${confirmAction.trackIds!.length === 1 ? '1 song' : `${confirmAction.trackIds!.length} songs`} from "${playlist.name}"?`}
          detail="The songs will remain in your library."
          confirmLabel="Remove"
          onConfirm={executeRemove}
          onCancel={() => setConfirmAction(null)}
        />
      )}
      {confirmAction && confirmAction.type === 'delete-tracks' && (
        <ConfirmDialog
          message={confirmAction.trackIds!.length === 1
            ? 'Are you sure you want to delete this song from your library?'
            : `Are you sure you want to delete ${confirmAction.trackIds!.length} songs from your library?`}
          detail="This will remove them from all playlists. This cannot be undone."
          confirmLabel="Delete"
          onConfirm={executeRemove}
          onCancel={() => setConfirmAction(null)}
        />
      )}
      {confirmAction && confirmAction.type === 'delete-playlist' && (
        <ConfirmDialog
          message={`Delete the playlist "${playlist.name}"?`}
          detail={`This playlist has ${sortedTracks.length} song${sortedTracks.length !== 1 ? 's' : ''}. The songs will remain in your library.`}
          confirmLabel="Delete"
          onConfirm={executeRemove}
          onCancel={() => setConfirmAction(null)}
        />
      )}
      {undoState && (
        <UndoToast
          message={undoState.message}
          onUndo={() => {
            dispatch({
              type: 'RESTORE_TRACKS_TO_PLAYLIST',
              playlistId: undoState.playlistId,
              trackIds: undoState.trackIds,
              atIndex: undoState.atIndex,
            })
          }}
          onDismiss={() => setUndoState(null)}
        />
      )}
      {getInfoState && (
        <GetInfoModal
          tracks={getInfoState.tracks}
          allTracks={state.tracks}
          initialIndex={state.tracks.findIndex(t => t.id === getInfoState.tracks[0]?.id)}
          artworkMap={state.artworkMap}
          onClose={() => setGetInfoState(null)}
          onSave={handleGetInfoSave}
          onFetchArt={handleFetchArt}
          onSetCustomArt={handleSetCustomArt}
        />
      )}
    </div>
  )
}
