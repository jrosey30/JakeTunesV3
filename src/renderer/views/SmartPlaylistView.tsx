import { useMemo, useState, useEffect, useRef, useCallback } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { usePlayback } from '../context/PlaybackContext'
import { useAudio } from '../hooks/useAudio'
import { Track } from '../types'
import { SpeakerPlayingIcon } from '../assets/icons/SpeakerIcon'
import ContextMenu, { MenuEntry } from '../components/ContextMenu'
import ConfirmDialog from '../components/ConfirmDialog'
import GetInfoModal from '../components/GetInfoModal'
import StarRating, { ratingMenuEntries } from '../components/StarRating'
import '../styles/musicman.css'
import '../styles/songs.css'

// Persist sort preferences per smart playlist across navigation
const smartSortPrefs = new Map<string, { col: string | null; dir: 'asc' | 'desc' }>()

function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return ''
  const totalSecs = Math.floor(ms / 1000)
  const m = Math.floor(totalSecs / 60)
  const s = totalSecs % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

const TITLES: Record<string, string> = {
  'recently-added': 'Recently Added',
  'recently-played': 'Recently Played',
  'top-25': 'Top 25 Most Played',
  'top-rated': 'My Top Rated',
  'musicman-picks': 'The Music Man Picks',
}

interface PicksData {
  name: string
  commentary: string
  trackIds: number[]
  date: string
}

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

export default function SmartPlaylistView() {
  const { state: libState, dispatch } = useLibrary()
  const { state: pbState, dispatch: pbDispatch } = usePlayback()
  const { playTrack } = useAudio()

  const playlistId = libState.activeSmartPlaylist
  const title = playlistId ? TITLES[playlistId] || playlistId : ''

  // Music Man Picks state — persists until midnight via UI state
  // Resets at 12:00 AM each day. If the app was closed before midnight,
  // picks regenerate on next launch after midnight has passed.
  const [picks, setPicks] = useState<PicksData | null>(() => {
    try {
      const raw = localStorage.getItem('musicman-picks')
      if (raw) {
        const saved = JSON.parse(raw) as PicksData
        const savedDate = new Date(saved.date)
        const now = new Date()
        // Same calendar day = keep picks. Different day = regenerate.
        const sameDay =
          savedDate.getFullYear() === now.getFullYear() &&
          savedDate.getMonth() === now.getMonth() &&
          savedDate.getDate() === now.getDate()
        if (sameDay) return saved
      }
    } catch { /* ignore */ }
    return null
  })
  const [picksLoading, setPicksLoading] = useState(false)
  const picksRequested = useRef(!!picks)

  // Save picks to localStorage when they change
  useEffect(() => {
    if (picks) localStorage.setItem('musicman-picks', JSON.stringify(picks))
  }, [picks])

  // Generate Music Man Picks — only when no valid cached picks exist
  useEffect(() => {
    if (playlistId !== 'musicman-picks' || libState.tracks.length === 0) return
    if (picks || picksRequested.current) return

    picksRequested.current = true
    setPicksLoading(true)
    const compactTracks = libState.tracks.map(t => ({
      id: t.id, title: t.title, artist: t.artist,
      album: t.album, genre: t.genre, year: t.year
    }))
    window.electronAPI.musicmanPicks(compactTracks).then(result => {
      if (result.ok && result.trackIds) {
        setPicks({
          name: result.name || "Today's Picks",
          commentary: result.commentary || '',
          trackIds: result.trackIds,
          date: new Date().toISOString(),
        })
      }
      setPicksLoading(false)
    }).catch(() => {
      setPicksLoading(false)
    })
  }, [playlistId, libState.tracks, picks])

  const smartTracks = useMemo(() => {
    if (!playlistId) return []

    switch (playlistId) {
      case 'recently-added': {
        return [...libState.tracks]
          .filter(t => t.dateAdded)
          .sort((a, b) => (b.dateAdded || '').localeCompare(a.dateAdded || ''))
          .slice(0, 50)
      }
      case 'recently-played': {
        const trackMap = new Map(libState.tracks.map(t => [t.id, t]))
        return pbState.recentlyPlayed
          .map(id => trackMap.get(id))
          .filter((t): t is Track => t !== undefined)
      }
      case 'top-25': {
        return [...libState.tracks]
          .filter(t => t.playCount > 0)
          .sort((a, b) => b.playCount - a.playCount)
          .slice(0, 25)
      }
      case 'top-rated': {
        // Use actual ratings if available, fall back to play count + recency
        const rated = [...libState.tracks].filter(t => t.rating > 0)
        if (rated.length > 0) {
          return rated
            .sort((a, b) => b.rating - a.rating || b.playCount - a.playCount)
            .slice(0, 50)
        }
        return [...libState.tracks]
          .filter(t => t.playCount > 0)
          .sort((a, b) => {
            const scoreA = a.playCount * 2 + (a.dateAdded ? new Date(a.dateAdded).getTime() / 1e12 : 0)
            const scoreB = b.playCount * 2 + (b.dateAdded ? new Date(b.dateAdded).getTime() / 1e12 : 0)
            return scoreB - scoreA
          })
          .slice(0, 50)
      }
      case 'musicman-picks': {
        if (!picks) return []
        const trackMap = new Map(libState.tracks.map(t => [t.id, t]))
        return picks.trackIds
          .map(id => trackMap.get(id))
          .filter((t): t is Track => t !== undefined)
      }
      default:
        return []
    }
  }, [playlistId, libState.tracks, pbState.recentlyPlayed, picks])

  // Apply search filter — every word must appear somewhere across all fields
  const filteredTracks = useMemo(() => {
    if (!libState.searchQuery) return smartTracks
    const words = libState.searchQuery.toLowerCase().split(/\s+/).filter(w => w.length > 0)
    return smartTracks.filter(t => {
      const haystack = `${t.title || ''} ${t.artist || ''} ${t.album || ''} ${t.genre || ''} ${t.year || ''}`.toLowerCase()
      return words.every(w => haystack.includes(w))
    })
  }, [smartTracks, libState.searchQuery])

  // --- Column visibility ---
  // Rating stays visible so ratings can be edited from any smart
  // playlist (Recently Added, Top 25, The Music Man Picks…).
  const [hiddenCols, setHiddenCols] = useState<Set<string>>(() => new Set(['dateAdded', 'playCount']))
  const [headerCtxMenu, setHeaderCtxMenu] = useState<{ x: number; y: number } | null>(null)

  const visibleCols = ALL_COLUMN_DEFS.filter(c => !hiddenCols.has(c.key))

  // --- Local sort state — restored from module-level map so it survives navigation ---
  const [sortCol, setSortCol] = useState<string | null>(() => {
    const saved = playlistId ? smartSortPrefs.get(playlistId) : undefined
    return saved?.col ?? null
  })
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(() => {
    const saved = playlistId ? smartSortPrefs.get(playlistId) : undefined
    return saved?.dir ?? 'asc'
  })

  // Restore sort prefs when switching smart playlists
  const prevSmartId = useRef(playlistId)
  useEffect(() => {
    if (playlistId !== prevSmartId.current) {
      prevSmartId.current = playlistId
      const saved = playlistId ? smartSortPrefs.get(playlistId) : undefined
      setSortCol(saved?.col ?? null)
      setSortDir(saved?.dir ?? 'asc')
    }
  }, [playlistId])

  // Persist sort prefs whenever they change
  useEffect(() => {
    if (playlistId) smartSortPrefs.set(playlistId, { col: sortCol, dir: sortDir })
  }, [playlistId, sortCol, sortDir])

  const handleSort = useCallback((key: string) => {
    if (key === 'playing') return
    if (sortCol === key) {
      if (sortDir === 'desc') {
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

  // --- Sorted tracks ---
  const sortedTracks = useMemo(() => {
    if (!sortCol) return filteredTracks
    return [...filteredTracks].sort((a, b) => {
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
  }, [filteredTracks, sortCol, sortDir])

  // --- Column resize ---
  const [colWidthMap, setColWidthMap] = useState<Record<string, number>>({})

  const colWidths = visibleCols.map(c => colWidthMap[c.key] ?? c.defaultWidth)
  const gridTemplate = colWidths.map(w => `${w}px`).join(' ')

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

  // --- Summary stats ---
  const totalMs = sortedTracks.reduce((sum, t) => sum + (t.duration || 0), 0)
  const totalMins = Math.floor(totalMs / 60000)
  const hours = Math.floor(totalMins / 60)
  const mins = totalMins % 60
  const timeStr = hours > 0 ? `${hours} hr ${mins} min` : `${mins} min`

  // --- Picks save / speak state ---
  const [picksSaved, setPicksSaved] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  // Reset saved state when picks change
  useEffect(() => { setPicksSaved(false) }, [picks])

  const speakCommentary = useCallback(async () => {
    if (!picks?.commentary) return
    if (speaking && audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
      setSpeaking(false)
      window.dispatchEvent(new Event('musicman-speaking-end'))
      return
    }
    setSpeaking(true)
    const tts = await window.electronAPI.musicmanSpeak(picks.commentary)
    if (tts.ok && tts.audio) {
      window.dispatchEvent(new Event('musicman-speaking-start'))
      await new Promise<void>(resolve => {
        window.addEventListener('musicman-fade-ready', resolve, { once: true })
        setTimeout(resolve, 2000)
      })
      const audio = new Audio(`data:audio/mpeg;base64,${tts.audio}`)
      audioRef.current = audio
      audio.onended = () => {
        setSpeaking(false)
        window.dispatchEvent(new Event('musicman-speaking-end'))
      }
      audio.play().catch(() => {
        setSpeaking(false)
        window.dispatchEvent(new Event('musicman-speaking-end'))
      })
    } else {
      setSpeaking(false)
    }
  }, [picks, speaking])

  const savePicks = useCallback(() => {
    if (!picks || picksSaved) return
    dispatch({
      type: 'ADD_PLAYLIST',
      playlist: {
        id: `mm-picks-${Date.now()}`,
        name: picks.name,
        trackIds: picks.trackIds,
        commentary: picks.commentary,
      }
    })
    setPicksSaved(true)
  }, [picks, picksSaved, dispatch])

  // --- Selection, context menu, Get Info ---
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; track: Track; idx: number } | null>(null)
  const [getInfoState, setGetInfoState] = useState<{ tracks: Track[]; index: number } | null>(null)
  const lastClickedIdx = useRef<number>(-1)

  // Reset anchor when search/sort changes the visible list
  useEffect(() => {
    lastClickedIdx.current = -1
    setSelectedIds(new Set())
  }, [libState.searchQuery, sortCol, sortDir])

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
    if (!selectedIds.has(track.id)) setSelectedIds(new Set([track.id]))
    setCtxMenu({ x: e.clientX, y: e.clientY, track, idx })
  }

  const [deleteConfirm, setDeleteConfirm] = useState<{ ids: number[]; count: number } | null>(null)

  const getContextMenuItems = (): MenuEntry[] => {
    if (!ctxMenu) return []
    const { track, idx } = ctxMenu
    const selected = selectedIds.size > 1 ? sortedTracks.filter(t => selectedIds.has(t.id)) : [track]
    const count = selected.length

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
      { label: `Play`, onClick: () => playTrack(track, sortedTracks, idx) },
      { separator: true as const },
      { label: `Play Next`, onClick: () => pbDispatch({ type: 'PLAY_NEXT', tracks: selected }) },
      { label: `Add to Up Next`, onClick: () => pbDispatch({ type: 'ADD_TO_QUEUE', tracks: selected }) },
      ...ratingMenuEntries(selected, dispatch),
      { separator: true as const },
      { label: `Get Info`, onClick: () => setGetInfoState({ tracks: selected, index: idx }) },
      ...artworkItems,
      { separator: true as const },
      {
        label: count > 1 ? `Delete ${count} Songs` : 'Delete Song',
        onClick: () => setDeleteConfirm({ ids: selected.map(t => t.id), count }),
      },
    ]
  }

  const handleGetInfoSave = useCallback(
    async (updates: { id: number; field: string; value: string }[]) => {
      dispatch({ type: 'UPDATE_TRACKS', updates })
      for (const u of updates) {
        await window.electronAPI.saveMetadataOverride(u.id, u.field, u.value)
      }
    },
    [dispatch]
  )

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

  // Cmd+I for Get Info
  useEffect(() => {
    if (libState.currentView !== 'smart-playlist') return
    const handler = () => {
      if (selectedIds.size > 0) {
        const sel = sortedTracks.filter(t => selectedIds.has(t.id))
        const idx = sortedTracks.findIndex(t => selectedIds.has(t.id))
        setGetInfoState({ tracks: sel, index: idx >= 0 ? idx : 0 })
      }
    }
    window.addEventListener('jaketunes-get-info', handler)
    return () => window.removeEventListener('jaketunes-get-info', handler)
  }, [libState.currentView, selectedIds, sortedTracks])

  const displayName = playlistId === 'musicman-picks' && picks?.name ? picks.name : title

  return (
    <div className="playlist-view">
      <div className="playlist-view-header">
        <div>
          <h2 className="playlist-view-name">{displayName}</h2>
          <div className="playlist-view-meta">
            {playlistId === 'musicman-picks' && picksLoading ? (
              'The Music Man is picking tracks...'
            ) : (
              <>
                {sortedTracks.length} {sortedTracks.length === 1 ? 'song' : 'songs'}, {timeStr}
                {playlistId === 'recently-played' && sortedTracks.length === 0 && ' — play some music!'}
              </>
            )}
          </div>
        </div>
        {sortedTracks.length > 0 && (
          <div className="playlist-view-actions">
            {playlistId === 'musicman-picks' && picks && (
              <button
                className="playlist-view-save"
                onClick={savePicks}
                disabled={picksSaved}
              >
                {picksSaved ? 'Saved' : 'Save'}
              </button>
            )}
            <button
              className="playlist-view-play"
              onClick={() => playTrack(sortedTracks[0], sortedTracks, 0)}
            >
              Play All
            </button>
          </div>
        )}
      </div>
      {playlistId === 'musicman-picks' && picks?.commentary && (
        <div className="playlist-view-commentary playlist-view-commentary--musicman">
          {picks.commentary}{' '}
          <button
            className={`musicman-commentary-play ${speaking ? 'musicman-commentary-play--active' : ''}`}
            onClick={speakCommentary}
            title={speaking ? 'Stop' : 'Listen'}
          >
            {speaking ? '\u25A0' : '\u25B6'}
          </button>
        </div>
      )}
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
              <span className="sort-arrow">{sortDir === 'asc' ? '\u25B2' : '\u25BC'}</span>
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
      <div className="songs-body">
        {sortedTracks.map((track, i) => {
          const isPlaying = pbState.nowPlaying?.id === track.id
          const isSelected = selectedIds.has(track.id)
          return (
            <div
              key={`${track.id}-${i}`}
              className={`songs-row ${i % 2 ? 'songs-row--alt' : ''} ${isPlaying ? 'songs-row--playing' : ''} ${isSelected ? 'songs-row--selected' : ''}`}
              style={{ gridTemplateColumns: gridTemplate }}
              onClick={(e) => handleClick(track, i, e)}
              onDoubleClick={() => playTrack(track, sortedTracks, i)}
              onContextMenu={(e) => handleContextMenu(e, track, i)}
              draggable
              onDragStart={(e) => {
                const selected = selectedIds.has(track.id) && selectedIds.size > 1
                  ? sortedTracks.filter(t => selectedIds.has(t.id))
                  : [track]
                e.dataTransfer.setData('application/jaketunes-tracks', JSON.stringify(selected.map(t => t.id)))
                e.dataTransfer.effectAllowed = 'copy'
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
                    return <div key={col.key} className="songs-cell">{dp ? `${mo}-${dy}-${y}` : ''}</div>
                  }
                  case 'playCount':
                    return <div key={col.key} className="songs-cell">{track.playCount || ''}</div>
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
              label: 'Default Order',
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
                      next.delete(c.key)
                    } else {
                      next.add(c.key)
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
      {getInfoState && (
        <GetInfoModal
          tracks={getInfoState.tracks}
          allTracks={libState.tracks}
          initialIndex={libState.tracks.findIndex(t => t.id === getInfoState.tracks[0]?.id)}
          artworkMap={libState.artworkMap}
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
            dispatch({ type: 'DELETE_TRACKS', ids: deleteConfirm.ids })
            setDeleteConfirm(null)
          }}
          onCancel={() => setDeleteConfirm(null)}
        />
      )}
    </div>
  )
}
