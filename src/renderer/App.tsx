import { useEffect, useState, useCallback, useRef } from 'react'
import type { Track } from './types'
import { LibraryProvider, useLibrary } from './context/LibraryContext'
import { PlaybackProvider, usePlayback } from './context/PlaybackContext'
import { useAudio } from './hooks/useAudio'
import Toolbar from './components/playback/Toolbar'
import Sidebar from './components/sidebar/Sidebar'
import MainContent from './components/MainContent'
import QueuePanel from './components/playback/QueuePanel'
import StatusBar from './components/chrome/StatusBar'
import './styles/variables.css'
import './styles/reset.css'
import './styles/app.css'
import './styles/toolbar.css'
import './styles/sidebar.css'

function AppInner() {
  const { state: libState, dispatch } = useLibrary()
  const { togglePlayPause, nextTrack, prevTrack, setVolume } = useAudio()
  const { state: pbState } = usePlayback()
  const [sidebarWidth, setSidebarWidth] = useState(170)
  const [showQueue, setShowQueue] = useState(false)
  const [uiReady, setUiReady] = useState(false)

  useEffect(() => {
    Promise.all([
      window.electronAPI.loadTracks(),
      window.electronAPI.loadMetadataOverrides(),
      window.electronAPI.loadPlaylists(),
      window.electronAPI.loadUiState(),
    ]).then(([dbResult, overridesResult, playlistsResult, uiResult]) => {
      const tracks = dbResult.tracks || []
      const ipodPlaylists = dbResult.playlists || []

      // Apply saved metadata overrides.
      //
      // v2 entries carry a fingerprint ("title|artist|duration_ms") that
      // matches the track they were saved against. If the fingerprint no
      // longer matches the track at that ID, skip it — IDs shift when
      // the iTunesDB track set changes, and stale overrides were the
      // root cause of the hybrid-row metadata bug.
      //
      // v1 entries (no fingerprint, fields at top level) have no way to
      // be validated, so we ignore them rather than risk mis-applying.
      let appliedCount = 0, skippedStale = 0, skippedLegacy = 0
      if (overridesResult.ok && overridesResult.overrides) {
        const ov = overridesResult.overrides as Record<string, unknown>
        for (const t of tracks) {
          const entry = ov[String(t.id)] as { fp?: string; fields?: Record<string, string> } | undefined
          if (!entry || typeof entry !== 'object') continue
          if (!('fields' in entry) || !entry.fields) {
            skippedLegacy++
            continue
          }
          const fp = `${(t.title || '').toLowerCase().trim()}|${(t.artist || '').toLowerCase().trim()}|${t.duration || 0}`
          if (entry.fp !== fp) {
            skippedStale++
            continue
          }
          for (const [field, value] of Object.entries(entry.fields)) {
            (t as Record<string, unknown>)[field] = value
          }
          appliedCount++
        }
        if (skippedStale || skippedLegacy) {
          console.warn(`metadata overrides: applied ${appliedCount}, skipped ${skippedStale} stale and ${skippedLegacy} legacy entries`)
        }
      }
      dispatch({ type: 'SET_TRACKS', tracks })

      // Merge iPod playlists with user-saved playlists (only on first load)
      const savedPlaylists: import('./types').Playlist[] =
        (playlistsResult.ok && playlistsResult.playlists) ? playlistsResult.playlists : []
      if (ipodPlaylists.length > 0) {
        const savedNames = new Set(savedPlaylists.map(p => p.name))
        const merged = [...savedPlaylists]
        for (const ip of ipodPlaylists) {
          if (!savedNames.has(ip.name)) {
            merged.push({
              id: `ipod-${ip.name.toLowerCase().replace(/\s+/g, '-')}`,
              name: ip.name,
              trackIds: ip.trackIds,
            })
          }
        }
        dispatch({ type: 'LOAD_PLAYLISTS', playlists: merged })
      } else {
        dispatch({ type: 'LOAD_PLAYLISTS', playlists: savedPlaylists })
      }
      // Restore UI state
      if (uiResult.ok && uiResult.state) {
        const ui = uiResult.state
        if (typeof ui.sidebarWidth === 'number') setSidebarWidth(ui.sidebarWidth)
        if (typeof ui.currentView === 'string') {
          dispatch({ type: 'SET_VIEW', view: ui.currentView as import('./types').ViewName })
        }
        if (typeof ui.activePlaylistId === 'string') {
          dispatch({ type: 'VIEW_PLAYLIST', id: ui.activePlaylistId })
        }
        if (typeof ui.activeSmartPlaylist === 'string') {
          dispatch({ type: 'VIEW_SMART_PLAYLIST', id: ui.activeSmartPlaylist as import('./types').SmartPlaylistId })
        }
        if (typeof ui.sortColumn === 'string') {
          // Restore sort state — dispatch twice if needed to match saved direction
          dispatch({ type: 'SET_SORT', column: ui.sortColumn as import('./types').SortColumn })
          if (ui.sortDirection === 'desc') {
            dispatch({ type: 'SET_SORT', column: ui.sortColumn as import('./types').SortColumn })
          }
        }
        // Column state is restored via custom event so SongsView can pick it up
        if (ui.colWidthMap || ui.hiddenCols) {
          window.dispatchEvent(new CustomEvent('jaketunes-restore-columns', {
            detail: { colWidthMap: ui.colWidthMap, hiddenCols: ui.hiddenCols }
          }))
        }
      }
      setUiReady(true)
      // Load artwork map, then auto-fetch any missing album art in background
      if (typeof window.electronAPI.loadArtworkMap === 'function') {
        window.electronAPI.loadArtworkMap().then(async (r) => {
          if (!r?.ok) return
          const map = r.map || {}
          dispatch({ type: 'SET_ARTWORK_MAP', map })

          // Collect all unique artist+album pairs from the library
          const albums = new Map<string, { artist: string; album: string }>()
          for (const t of tracks) {
            if (t.artist && t.album) {
              const k = `${t.artist.toLowerCase().trim()}|||${t.album.toLowerCase().trim()}`
              if (!albums.has(k)) albums.set(k, { artist: t.artist, album: t.album })
            }
          }

          // Find which albums are missing artwork
          const missing: { artist: string; album: string }[] = []
          for (const [k, v] of albums) {
            if (!map[k]) missing.push(v)
          }

          if (missing.length === 0) return

          // Fetch missing artwork in background, one at a time to avoid hammering the API
          for (const { artist, album } of missing) {
            try {
              const result = await window.electronAPI.fetchAlbumArt(artist, album)
              if (result.ok && result.key && result.hash) {
                dispatch({ type: 'ADD_ARTWORK', key: result.key, hash: result.hash })
              }
            } catch { /* ignore individual failures */ }
          }
        }).catch(() => {})
      }
      // Build library summary for Music Man
      const artists: Record<string, number> = {}
      const genres: Record<string, number> = {}
      for (const t of tracks) {
        if (t.artist) artists[t.artist] = (artists[t.artist] || 0) + 1
        if (t.genre) genres[t.genre] = (genres[t.genre] || 0) + 1
      }
      const topArtists = Object.entries(artists).sort((a, b) => b[1] - a[1]).slice(0, 50).map(([name, count]) => `${name} (${count})`).join(', ')
      const topGenres = Object.entries(genres).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([name, count]) => `${name} (${count})`).join(', ')
      const ctx = `${tracks.length} total tracks.\nTop artists: ${topArtists}\nTop genres: ${topGenres}`
      window.electronAPI.setLibraryContext(ctx)
    }).catch((err) => {
      console.error('Failed to load tracks:', err)
    })
  }, [dispatch])

  // Persist playlists whenever they change
  const playlistsLoaded = useRef(false)
  useEffect(() => {
    if (!playlistsLoaded.current) {
      if (libState.playlists.length > 0 || libState.tracks.length > 0) playlistsLoaded.current = true
      return
    }
    window.electronAPI.savePlaylists(libState.playlists)
  }, [libState.playlists])

  // Persist library (tracks + playlists) whenever tracks change (debounced)
  const libraryLoaded = useRef(false)
  const librarySaveRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!libraryLoaded.current) {
      if (libState.tracks.length > 0) libraryLoaded.current = true
      return
    }
    if (librarySaveRef.current) clearTimeout(librarySaveRef.current)
    librarySaveRef.current = setTimeout(() => {
      window.electronAPI.saveLibrary(libState.tracks, libState.playlists)
    }, 1000)
  }, [libState.tracks, libState.playlists])

  // Save UI state on changes (debounced)
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!uiReady) return
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current)
    saveTimeoutRef.current = setTimeout(() => {
      const uiState: Record<string, unknown> = {
        sidebarWidth,
        currentView: libState.currentView,
        activePlaylistId: libState.activePlaylistId,
        activeSmartPlaylist: libState.activeSmartPlaylist,
        sortColumn: libState.sortColumn,
        sortDirection: libState.sortDirection,
      }
      window.electronAPI.saveUiState(uiState)
    }, 500)
  }, [uiReady, sidebarWidth, libState.currentView, libState.activePlaylistId, libState.activeSmartPlaylist, libState.sortColumn, libState.sortDirection])

  // Expose saveUiState for SongsView to piggyback column state
  useEffect(() => {
    const handler = (e: Event) => {
      const { colWidthMap, hiddenCols } = (e as CustomEvent).detail
      // Merge column state into next save
      window.electronAPI.loadUiState().then(r => {
        const existing = (r.ok && r.state) ? r.state : {}
        window.electronAPI.saveUiState({ ...existing, colWidthMap, hiddenCols })
      })
    }
    window.addEventListener('jaketunes-save-columns', handler)
    return () => window.removeEventListener('jaketunes-save-columns', handler)
  }, [])

  // Global CD-rip progress listener. Lives at the App level so it survives
  // when the user navigates away from the CD Import view mid-rip — the
  // main process keeps ripping regardless, and tracks continue to appear
  // in the library one by one as each finishes. ADD_IMPORTED_TRACKS
  // dedupes by id, so the final batched return from ripCdTracks is a
  // no-op if we've already streamed everything in here.
  useEffect(() => {
    const cleanup = window.electronAPI.onCdRipProgress((progress) => {
      if (progress.track) {
        dispatch({ type: 'ADD_IMPORTED_TRACKS', tracks: [progress.track as import('./types').Track] })
      }
    })
    return cleanup
  }, [dispatch])

  useEffect(() => {
    const cleanup = window.electronAPI.onMenuAction((action: string) => {
      switch (action) {
        case 'play-pause': togglePlayPause(); break
        case 'next-track': nextTrack(); break
        case 'prev-track': prevTrack(); break
        case 'volume-up': setVolume(Math.min(1, pbState.volume + 0.1)); break
        case 'volume-down': setVolume(Math.max(0, pbState.volume - 0.1)); break
        case 'get-info': window.dispatchEvent(new Event('jaketunes-get-info')); break
        case 'show-now-playing': window.dispatchEvent(new Event('jaketunes-show-now-playing')); break
        case 'view-songs': dispatch({ type: 'SET_VIEW', view: 'songs' }); break
        case 'view-artists': dispatch({ type: 'SET_VIEW', view: 'artists' }); break
        case 'view-albums': dispatch({ type: 'SET_VIEW', view: 'albums' }); break
        case 'view-genres': dispatch({ type: 'SET_VIEW', view: 'genres' }); break
      }
    })
    return cleanup
  }, [togglePlayPause, nextTrack, prevTrack, setVolume])

  // Global keyboard shortcuts
  const toggleRef = useRef(togglePlayPause)
  toggleRef.current = togglePlayPause
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable

      // Space = play/pause (unless typing in an input)
      if (e.code === 'Space' && !isInput) {
        e.preventDefault()
        e.stopPropagation()
        toggleRef.current()
        return
      }

      // Cmd+I = Get Info (dispatched as custom event, SongsView/PlaylistView handles it)
      if ((e.metaKey || e.ctrlKey) && e.key === 'i' && !e.shiftKey) {
        // Don't intercept if Alt is held (DevTools toggle is Alt+Cmd+I)
        if (e.altKey) return
        e.preventDefault()
        window.dispatchEvent(new Event('jaketunes-get-info'))
        return
      }

      // Cmd+L = scroll to now-playing track
      if ((e.metaKey || e.ctrlKey) && e.key === 'l') {
        e.preventDefault()
        window.dispatchEvent(new Event('jaketunes-show-now-playing'))
        return
      }
    }
    // Use capture phase to beat scrollable div's default behavior
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [])

  const handleSidebarDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const onMove = (ev: MouseEvent) => {
      const w = Math.max(120, Math.min(350, ev.clientX))
      setSidebarWidth(w)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
    }
    document.body.style.cursor = 'col-resize'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  // ── Drag-and-drop file import ──
  const [importing, setImporting] = useState(false)
  const [dropActive, setDropActive] = useState(false)

  const nextIdRef = useRef(0)
  useEffect(() => {
    if (libState.tracks.length > 0) {
      const maxId = Math.max(0, ...libState.tracks.map(t => t.id))
      if (maxId >= nextIdRef.current) nextIdRef.current = maxId + 1
    }
  }, [libState.tracks])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDropActive(false)

    const files = Array.from(e.dataTransfer.files)
    // Pass ALL paths (files + folders) — backend resolves folders recursively
    const droppedPaths = files.map(f => f.path).filter(Boolean)

    if (droppedPaths.length === 0) return

    setImporting(true)
    const nextId = nextIdRef.current
    try {
      const result = await window.electronAPI.importTracks(droppedPaths, nextId)
      if (result.ok && result.tracks.length > 0) {
        const newTracks = result.tracks as Track[]
        // Advance the counter past all imported IDs to prevent collisions
        nextIdRef.current = Math.max(nextIdRef.current, ...newTracks.map(t => t.id)) + 1
        dispatch({ type: 'ADD_IMPORTED_TRACKS', tracks: newTracks })
      }
    } catch (err) {
      console.error('Import failed:', err)
    }
    setImporting(false)
  }, [dispatch])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer.types.includes('Files')) {
      setDropActive(true)
    }
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) {
      setDropActive(false)
    }
  }, [])

  if (!uiReady) {
    return (
      <div className="app-splash">
        <div className="app-splash-inner">
          <img src={new URL('./assets/musicman-avatar.png', import.meta.url).href} className="app-splash-icon" alt="" />
          <div className="app-splash-title">JakeTunes</div>
          <div className="app-splash-sub">Loading library...</div>
        </div>
      </div>
    )
  }

  return (
    <div
      className="app-shell"
      style={{ gridTemplateColumns: `${sidebarWidth}px 1fr` } as React.CSSProperties}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
    >
      <div className="titlebar">JakeTunes</div>
      <div className="toolbar-area">
        <Toolbar onToggleQueue={() => setShowQueue(q => !q)} onOpenQueue={() => setShowQueue(true)} showQueue={showQueue} />
      </div>
      <div className="sidebar-area" style={{ width: sidebarWidth }}>
        <Sidebar />
        <div className="sidebar-resize-handle" onMouseDown={handleSidebarDrag} />
      </div>
      <div className="content-area" style={{ position: 'relative' }}>
        <MainContent />
        {showQueue && <QueuePanel onClose={() => setShowQueue(false)} />}
      </div>
      <div className="statusbar-area">
        <StatusBar />
      </div>
      {dropActive && (
        <div className="app-drop-overlay">
          <div className="app-drop-message">Drop to import</div>
        </div>
      )}
      {importing && (
        <div className="app-drop-overlay app-drop-overlay--importing">
          <div className="app-drop-message">Importing...</div>
        </div>
      )}
    </div>
  )
}

export default function App() {
  return (
    <LibraryProvider>
      <PlaybackProvider>
        <AppInner />
      </PlaybackProvider>
    </LibraryProvider>
  )
}
