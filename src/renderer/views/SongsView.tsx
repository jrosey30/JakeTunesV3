import { useCallback, useState, useEffect, useRef } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { usePlayback } from '../context/PlaybackContext'
import { useAudio } from '../hooks/useAudio'
import { useVirtualScroll } from '../hooks/useVirtualScroll'
import { useSortedTracks } from '../hooks/useSortedTracks'
import { SpeakerPlayingIcon } from '../assets/icons/SpeakerIcon'
import ContextMenu, { MenuEntry } from '../components/ContextMenu'
import ConfirmDialog from '../components/ConfirmDialog'
import GetInfoModal from '../components/GetInfoModal'
import type { SortColumn, Track } from '../types'
import '../styles/songs.css'

function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return ''
  const totalSecs = Math.floor(ms / 1000)
  const mins = Math.floor(totalSecs / 60)
  const secs = totalSecs % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

interface ColDef {
  key: SortColumn | 'playing' | 'time'
  label: string
  defaultWidth: number
  minWidth: number
  resizable: boolean
}

function formatDateAdded(d: string): string {
  if (!d) return ''
  // Handle both full ISO timestamps and YYYY-MM-DD
  const datePart = d.length > 10 ? d.substring(0, 10) : d
  const [y, m, day] = datePart.split('-')
  return `${m}-${day}-${y}`
}

function StarRating({ value, onChange }: { value: number; onChange: (r: number) => void }) {
  return (
    <span className="star-rating" onMouseLeave={(e) => e.stopPropagation()}>
      {[1, 2, 3, 4, 5].map(star => (
        <span
          key={star}
          className={`star-rating-star ${star <= value ? 'star-rating-star--filled' : ''}`}
          onClick={(e) => {
            e.stopPropagation()
            onChange(star === value ? 0 : star)
          }}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill={star <= value ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="0.8" strokeLinejoin="round">
            <polygon points="5,1 6.2,3.8 9.5,4.1 7.1,6.2 7.9,9.5 5,7.8 2.1,9.5 2.9,6.2 0.5,4.1 3.8,3.8" />
          </svg>
        </span>
      ))}
    </span>
  )
}

const ALL_COLUMN_DEFS: ColDef[] = [
  { key: 'playing', label: '', defaultWidth: 24, minWidth: 24, resizable: false },
  { key: 'title', label: 'Name', defaultWidth: 240, minWidth: 80, resizable: true },
  { key: 'time', label: 'Time', defaultWidth: 50, minWidth: 40, resizable: true },
  { key: 'artist', label: 'Artist', defaultWidth: 180, minWidth: 60, resizable: true },
  { key: 'album', label: 'Album', defaultWidth: 180, minWidth: 60, resizable: true },
  { key: 'genre', label: 'Genre', defaultWidth: 100, minWidth: 50, resizable: true },
  { key: 'year', label: 'Year', defaultWidth: 50, minWidth: 35, resizable: true },
  { key: 'dateAdded', label: 'Date Added', defaultWidth: 100, minWidth: 60, resizable: true },
  { key: 'playCount', label: 'Plays', defaultWidth: 50, minWidth: 35, resizable: true },
  { key: 'rating', label: 'Rating', defaultWidth: 75, minWidth: 55, resizable: true },
]

// Columns that cannot be hidden
const ALWAYS_VISIBLE = new Set(['playing', 'title'])

export default function SongsView() {
  const { state: lib, dispatch: libDispatch } = useLibrary()
  const { state: pb, dispatch: pbDispatch } = usePlayback()
  const { playTrack } = useAudio()

  const [hiddenCols, setHiddenCols] = useState<Set<string>>(() => new Set())
  const [colWidthMap, setColWidthMap] = useState<Record<string, number>>(() =>
    Object.fromEntries(ALL_COLUMN_DEFS.map(c => [c.key, c.defaultWidth]))
  )
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; track: Track; idx: number } | null>(null)
  const [headerCtxMenu, setHeaderCtxMenu] = useState<{ x: number; y: number } | null>(null)
  const [getInfoState, setGetInfoState] = useState<{ tracks: Track[]; index: number } | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<{ ids: number[]; count: number } | null>(null)

  // Filter columns based on visibility
  const visibleCols = ALL_COLUMN_DEFS.filter(c => !hiddenCols.has(c.key))
  const colWidths = visibleCols.map(c => colWidthMap[c.key] ?? c.defaultWidth)

  const sorted = useSortedTracks(lib.tracks, lib.sortColumn, lib.sortDirection, lib.searchQuery)
  const { startIndex, endIndex, totalHeight, offsetY, containerRef, onScroll } = useVirtualScroll(sorted.length, 19)

  const handleSort = useCallback((col: string) => {
    if (col === 'playing' || col === 'time') return
    libDispatch({ type: 'SET_SORT', column: col as SortColumn })
  }, [libDispatch])


  const handleDoubleClick = useCallback((idx: number) => {
    window.getSelection()?.removeAllRanges()
    const track = sorted[idx]
    if (track) playTrack(track, sorted, idx)
  }, [sorted, playTrack])

  const lastClickedIdx = useRef<number>(-1)

  // Reset anchor when search/sort changes the visible list
  useEffect(() => {
    lastClickedIdx.current = -1
    libDispatch({ type: 'SELECT_NONE' })
  }, [lib.searchQuery, lib.sortColumn, lib.sortDirection, libDispatch])

  const handleClick = useCallback((id: number, idx: number, e: React.MouseEvent) => {
    window.getSelection()?.removeAllRanges()
    if (e.shiftKey && lastClickedIdx.current >= 0 && lastClickedIdx.current < sorted.length) {
      // Range select from last clicked to current
      const from = Math.min(lastClickedIdx.current, idx)
      const to = Math.max(lastClickedIdx.current, idx)
      const ids = sorted.slice(from, to + 1).map(t => t.id)
      libDispatch({ type: 'SELECT_RANGE', ids })
    } else {
      libDispatch({ type: 'SELECT_TRACK', id, multi: e.metaKey || e.ctrlKey })
      lastClickedIdx.current = idx
    }
    focusedIdx.current = idx
  }, [libDispatch, sorted])

  const handleContextMenu = useCallback((e: React.MouseEvent, track: Track, idx: number) => {
    e.preventDefault()
    // Select the track if not already selected
    if (!lib.selectedTrackIds.has(track.id)) {
      libDispatch({ type: 'SELECT_TRACK', id: track.id })
    }
    setCtxMenu({ x: e.clientX, y: e.clientY, track, idx })
  }, [lib.selectedTrackIds, libDispatch])

  const getContextMenuItems = useCallback((): MenuEntry[] => {
    if (!ctxMenu) return []
    const { track, idx } = ctxMenu
    // Get all selected tracks, or just the right-clicked one
    const selectedTracks = lib.selectedTrackIds.size > 1
      ? sorted.filter(t => lib.selectedTrackIds.has(t.id))
      : [track]
    const count = selectedTracks.length
    const label = count > 1 ? `${count} Songs` : track.title

    // Collect unique artist+album combos from all selected tracks for batch artwork
    const artPairs = new Map<string, { artist: string; album: string }>()
    for (const t of selectedTracks) {
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
      { label: `Play "${label}"`, onClick: () => playTrack(track, sorted, idx) },
      { separator: true as const },
      { label: `Play Next`, onClick: () => pbDispatch({ type: 'PLAY_NEXT', tracks: selectedTracks }) },
      { label: `Add to Up Next`, onClick: () => pbDispatch({ type: 'ADD_TO_QUEUE', tracks: selectedTracks }) },
      { separator: true as const },
      {
        label: 'Get Info',
        onClick: () => {
          setGetInfoState({
            tracks: selectedTracks,
            index: idx,
          })
        },
      },
      ...artworkItems,
      { separator: true as const },
      {
        label: count > 1 ? `Delete ${count} Songs` : 'Delete Song',
        onClick: () => {
          setDeleteConfirm({ ids: selectedTracks.map(t => t.id), count })
        },
      },
    ]
  }, [ctxMenu, lib.selectedTrackIds, sorted, playTrack, pbDispatch])

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
  }, [colWidths, visibleCols])

  // Save metadata edits from Get Info modal
  const handleGetInfoSave = useCallback(
    async (updates: { id: number; field: string; value: string }[]) => {
      libDispatch({ type: 'UPDATE_TRACKS', updates })
      for (const u of updates) {
        await window.electronAPI.saveMetadataOverride(u.id, u.field, u.value)
      }
    },
    [libDispatch]
  )

  // Fetch artwork for a track (called from Get Info modal)
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

  // Set rating for a track (click stars)
  const handleRatingChange = useCallback((trackId: number, rating: number) => {
    const value = String(rating)
    libDispatch({ type: 'UPDATE_TRACKS', updates: [{ id: trackId, field: 'rating', value }] })
    window.electronAPI.saveMetadataOverride(trackId, 'rating', value)
  }, [libDispatch])

  const gridTemplate = colWidths.map(w => `${w}px`).join(' ')

  const viewRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = viewRef.current
    if (!el) return
    const prevent = (e: Event) => e.preventDefault()
    el.addEventListener('selectstart', prevent)
    return () => el.removeEventListener('selectstart', prevent)
  }, [])

  // Track focused index for keyboard nav (separate from selection for smooth scrolling)
  const focusedIdx = useRef<number>(-1)
  const typeBuffer = useRef('')
  const typeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Scroll a row into view
  const scrollToIdx = useCallback((idx: number) => {
    const el = containerRef.current
    if (!el) return
    const rowH = 19
    const scrollTop = el.scrollTop
    const viewH = el.clientHeight
    const rowTop = idx * rowH
    const rowBottom = rowTop + rowH
    if (rowTop < scrollTop) {
      el.scrollTop = rowTop
    } else if (rowBottom > scrollTop + viewH) {
      el.scrollTop = rowBottom - viewH
    }
  }, [containerRef])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip keyboard nav when Get Info modal is open
      if (document.querySelector('.getinfo-overlay')) return

      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return

      // Delete/Backspace = delete selected tracks
      if ((e.key === 'Delete' || e.key === 'Backspace') && lib.selectedTrackIds.size > 0) {
        e.preventDefault()
        const ids = Array.from(lib.selectedTrackIds)
        setDeleteConfirm({ ids, count: ids.length })
        return
      }

      // Cmd+A = select all
      if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
        e.preventDefault()
        const ids = sorted.map(t => t.id)
        libDispatch({ type: 'SELECT_RANGE', ids })
        return
      }

      // Arrow Up / Arrow Down = move selection
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const dir = e.key === 'ArrowDown' ? 1 : -1
        let next = focusedIdx.current + dir
        if (focusedIdx.current < 0) {
          // Nothing focused yet — start from top or bottom
          next = e.key === 'ArrowDown' ? 0 : sorted.length - 1
        }
        next = Math.max(0, Math.min(sorted.length - 1, next))
        focusedIdx.current = next
        const track = sorted[next]
        if (track) {
          if (e.shiftKey) {
            // Extend selection
            const anchor = lastClickedIdx.current >= 0 ? lastClickedIdx.current : next
            const from = Math.min(anchor, next)
            const to = Math.max(anchor, next)
            const ids = sorted.slice(from, to + 1).map(t => t.id)
            libDispatch({ type: 'SELECT_RANGE', ids })
          } else {
            libDispatch({ type: 'SELECT_TRACK', id: track.id })
            lastClickedIdx.current = next
          }
          scrollToIdx(next)
        }
        return
      }

      // Enter = play selected track
      if (e.key === 'Enter') {
        const idx = focusedIdx.current >= 0 ? focusedIdx.current : -1
        const track = idx >= 0 ? sorted[idx] : null
        if (track) {
          e.preventDefault()
          playTrack(track, sorted, idx)
        }
        return
      }

      // Type-to-search: single printable character jumps to first matching track
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        typeBuffer.current += e.key.toLowerCase()
        if (typeTimer.current) clearTimeout(typeTimer.current)
        typeTimer.current = setTimeout(() => { typeBuffer.current = '' }, 800)
        const query = typeBuffer.current
        const idx = sorted.findIndex(t => (t.title || '').toLowerCase().startsWith(query))
        if (idx >= 0) {
          focusedIdx.current = idx
          lastClickedIdx.current = idx
          libDispatch({ type: 'SELECT_TRACK', id: sorted[idx].id })
          scrollToIdx(idx)
        }
        return
      }
    }
    // Use capture phase to match App.tsx's Space handler and ensure we fire
    // before any intermediate element can consume the event
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [sorted, libDispatch, playTrack, scrollToIdx])

  // Cmd+I → open Get Info for selected tracks
  useEffect(() => {
    const handler = () => {
      if (lib.currentView !== 'songs') return
      if (document.querySelector('.getinfo-overlay')) return
      if (lib.selectedTrackIds.size === 0) return
      const selectedTracks = sorted.filter(t => lib.selectedTrackIds.has(t.id))
      if (selectedTracks.length > 0) {
        const idx = sorted.findIndex(t => t.id === selectedTracks[0].id)
        setGetInfoState({ tracks: selectedTracks, index: idx >= 0 ? idx : 0 })
      }
    }
    window.addEventListener('jaketunes-get-info', handler)
    return () => window.removeEventListener('jaketunes-get-info', handler)
  }, [lib.currentView, lib.selectedTrackIds, sorted])

  // Cmd+L → scroll to now-playing track
  useEffect(() => {
    const handler = () => {
      if (lib.currentView !== 'songs') return
      if (!pb.nowPlaying) return
      const idx = sorted.findIndex(t => t.id === pb.nowPlaying!.id)
      if (idx >= 0) {
        focusedIdx.current = idx
        lastClickedIdx.current = idx
        libDispatch({ type: 'SELECT_TRACK', id: pb.nowPlaying!.id })
        scrollToIdx(idx)
      }
    }
    window.addEventListener('jaketunes-show-now-playing', handler)
    return () => window.removeEventListener('jaketunes-show-now-playing', handler)
  }, [lib.currentView, pb.nowPlaying, sorted, libDispatch, scrollToIdx])

  // Restore column state from saved UI state
  useEffect(() => {
    const handler = (e: Event) => {
      const { colWidthMap: savedWidths, hiddenCols: savedHidden } = (e as CustomEvent).detail
      if (savedWidths && typeof savedWidths === 'object') {
        setColWidthMap(prev => ({ ...prev, ...savedWidths }))
      }
      if (Array.isArray(savedHidden)) {
        setHiddenCols(new Set(savedHidden))
      }
    }
    window.addEventListener('jaketunes-restore-columns', handler)
    return () => window.removeEventListener('jaketunes-restore-columns', handler)
  }, [])

  // Save column state when it changes
  const colSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (colSaveRef.current) clearTimeout(colSaveRef.current)
    colSaveRef.current = setTimeout(() => {
      window.dispatchEvent(new CustomEvent('jaketunes-save-columns', {
        detail: { colWidthMap, hiddenCols: Array.from(hiddenCols) }
      }))
    }, 500)
  }, [colWidthMap, hiddenCols])

  return (
    <div className="songs-view" ref={viewRef}>
      <div
        className="songs-header"
        style={{ gridTemplateColumns: gridTemplate }}
        onContextMenu={(e) => {
          e.preventDefault()
          setHeaderCtxMenu({ x: e.clientX, y: e.clientY })
        }}
      >
        {visibleCols.map((col, i) => (
          <div
            key={col.key}
            className={`songs-header-cell ${lib.sortColumn === col.key ? 'sorted' : ''}`}
            onClick={() => handleSort(col.key)}
          >
            {col.label}
            {lib.sortColumn === col.key && (
              <span className="sort-arrow">{lib.sortDirection === 'asc' ? '▲' : '▼'}</span>
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
      <div className="songs-body" ref={containerRef} onScroll={onScroll}>
        <div style={{ height: totalHeight, position: 'relative' }}>
          <div style={{ position: 'absolute', top: offsetY, left: 0, right: 0 }}>
            {sorted.slice(startIndex, endIndex).map((track, i) => {
              const idx = startIndex + i
              const isPlaying = pb.nowPlaying?.id === track.id
              const isSelected = lib.selectedTrackIds.has(track.id)
              return (
                <div
                  key={track.id}
                  className={`songs-row ${idx % 2 ? 'songs-row--alt' : ''} ${isPlaying ? 'songs-row--playing' : ''} ${isSelected ? 'songs-row--selected' : ''}`}
                  style={{ gridTemplateColumns: gridTemplate }}
                  onClick={(e) => handleClick(track.id, idx, e)}
                  onDoubleClick={() => handleDoubleClick(idx)}
                  onContextMenu={(e) => handleContextMenu(e, track, idx)}
                  draggable
                  onDragStart={(e) => {
                    const selected = lib.selectedTrackIds.has(track.id) && lib.selectedTrackIds.size > 1
                      ? sorted.filter(t => lib.selectedTrackIds.has(t.id))
                      : [track]
                    e.dataTransfer.setData('application/jaketunes-tracks', JSON.stringify(selected.map(t => t.id)))
                    e.dataTransfer.effectAllowed = 'copy'

                    // Custom drag image with count badge
                    const ghost = document.createElement('div')
                    ghost.className = 'drag-ghost'
                    ghost.textContent = selected.length === 1
                      ? track.title
                      : `${selected.length} Songs`
                    document.body.appendChild(ghost)
                    e.dataTransfer.setDragImage(ghost, 0, 10)
                    requestAnimationFrame(() => document.body.removeChild(ghost))
                  }}
                >
                  {visibleCols.map(col => {
                    switch (col.key) {
                      case 'playing':
                        return <div key={col.key} className="songs-cell songs-cell--icon">{isPlaying && <SpeakerPlayingIcon />}</div>
                      case 'title':
                        return <div key={col.key} className="songs-cell songs-cell--title">{track.title || ''}</div>
                      case 'time':
                        return <div key={col.key} className="songs-cell songs-cell--time">{formatDuration(track.duration)}</div>
                      case 'artist':
                        return <div key={col.key} className="songs-cell">{track.artist || ''}</div>
                      case 'album':
                        return <div key={col.key} className="songs-cell">{track.album || ''}</div>
                      case 'genre':
                        return <div key={col.key} className="songs-cell">{track.genre || ''}</div>
                      case 'year':
                        return <div key={col.key} className="songs-cell">{track.year || ''}</div>
                      case 'dateAdded':
                        return <div key={col.key} className="songs-cell">{formatDateAdded(track.dateAdded)}</div>
                      case 'playCount':
                        return <div key={col.key} className="songs-cell">{track.playCount || ''}</div>
                      case 'rating':
                        return <div key={col.key} className="songs-cell songs-cell--rating"><StarRating value={Number(track.rating) || 0} onChange={(r) => handleRatingChange(track.id, r)} /></div>
                      default:
                        return null
                    }
                  })}
                </div>
              )
            })}
          </div>
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
          items={ALL_COLUMN_DEFS
            .filter(c => !ALWAYS_VISIBLE.has(c.key))
            .map(c => ({
              label: c.label,
              checked: !hiddenCols.has(c.key),
              onClick: () => {
                setHiddenCols(prev => {
                  const next = new Set(prev)
                  if (next.has(c.key)) next.delete(c.key)
                  else next.add(c.key)
                  return next
                })
              },
            }))}
          onClose={() => setHeaderCtxMenu(null)}
        />
      )}
      {getInfoState && (
        <GetInfoModal
          tracks={getInfoState.tracks}
          allTracks={sorted}
          initialIndex={getInfoState.index}
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
          onConfirm={() => {
            libDispatch({ type: 'DELETE_TRACKS', ids: deleteConfirm.ids })
            setDeleteConfirm(null)
          }}
          onCancel={() => setDeleteConfirm(null)}
        />
      )}
    </div>
  )
}
