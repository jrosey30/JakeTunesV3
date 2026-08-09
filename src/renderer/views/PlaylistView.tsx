import { useState, useRef, useEffect, useCallback, useMemo, useSyncExternalStore } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { usePlayback } from '../context/PlaybackContext'
import { useAudio, prefetchTrackForPlay, prefetchTrackImmediate } from '../hooks/useAudio'
import { useScrollPersistence } from '../hooks/useScrollPersistence'
import { Track } from '../types'
import ContextMenu, { MenuEntry } from '../components/ContextMenu'
import { getDeckState, layOnDeck } from '../mixtapes'
import MixArtwork from '../components/MixArtwork'
import {
  subscribePlaylistCovers, getPlaylistCovers, ensurePlaylistCoversLoaded,
  playlistCoverSrc, pickPlaylistCover, clearPlaylistCover,
} from '../playlistCovers'
import { downloadMenuEntries, subscribeDownloads, downloadsVersion, isDownloaded, isDownloading } from '../utils/downloadStore'
import { formatAppDate } from '../utils/formatDate'
import { canonicalArtist } from '../utils/artistAlias'
import { albumKeyOf } from '../utils/albumKey'
import { suggestForPlaylist, suggestFromVibeHits } from '../utils/playlistSuggest'
import { useRegularLibraryTracks } from '../hooks/useRegularLibraryTracks'
import AlbumArtImage from '../components/AlbumArtImage'
import { buildNormalizedArtworkIndex, lookupArtwork } from '../utils/artworkLookup'
import { useCynthia } from '../context/CynthiaContext'
import { toCynthiaTrack } from '../utils/cynthia'
import ConfirmDialog from '../components/ConfirmDialog'
import UndoToast from '../components/UndoToast'
import GetInfoModal from '../components/GetInfoModal'
import StarRating, { ratingMenuEntries } from '../components/StarRating'
import SortArrowIcon from '../components/SortArrowIcon'
import TrackGridView from '../components/TrackGridView'
import CoverFlowView from './CoverFlowView'
import { useViewMode } from '../context/ViewModeContext'
import { SpeakerPlayingIcon } from '../assets/icons/SpeakerIcon'
import { setNotice } from '../activity'
import { songsGridTemplate, songsGridTemplateFixed } from '../utils/songsGridTemplate'
import '../styles/songs.css'
import { addToPlaylistEntry } from '../utils/playlistMenu'

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
  { key: 'channelMode', label: 'Channels', defaultWidth: 70, minWidth: 50, resizable: true },
  // 4.5: 'rating' column REMOVED — star renders inline next to title.
]

const ALWAYS_VISIBLE = new Set(['playing', 'title'])

export default function PlaylistView() {
  const { state, dispatch } = useLibrary()
  const { state: pb, dispatch: pbDispatch } = usePlayback()
  const { playTrack } = useAudio()
  const { openCynthia } = useCynthia()
  const { mode: viewMode } = useViewMode()
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
  // 4.4.13: per-playlist scroll persistence. Switching A→B→A restores A's
  // scroll position from where the user left it.
  useScrollPersistence(`playlist:${state.activePlaylistId}`, songsBodyRef)
  const lastUserActivityAtRef = useRef<number>(0)
  const isAutoScrollAtRef = useRef<number>(0)
  const FOLLOW_IDLE_MS = 5000
  const handleScroll = useCallback(() => {
    if (Date.now() - isAutoScrollAtRef.current > 200) {
      lastUserActivityAtRef.current = Date.now()
    }
  }, [])

  const playlist = state.playlists.find(p => p.id === state.activePlaylistId)

  // Custom playlist cover (2026-08-09). State lives in playlistCovers.ts —
  // a module store, because LibraryContext is do-not-touch.
  useSyncExternalStore(subscribePlaylistCovers, getPlaylistCovers)
  useEffect(() => { ensurePlaylistCoversLoaded() }, [])
  const [coverBusy, setCoverBusy] = useState(false)
  const [coverNote, setCoverNote] = useState('')
  const customCover = playlistCoverSrc(playlist?.id ?? '')
  const chooseCover = async (): Promise<void> => {
    if (!playlist || coverBusy) return
    setCoverBusy(true)
    const err = await pickPlaylistCover(playlist.id)
    setCoverBusy(false)
    if (err) { setCoverNote(err); setTimeout(() => setCoverNote(''), 8000) }
  }
  const dropCover = async (): Promise<void> => {
    if (!playlist || coverBusy) return
    setCoverBusy(true)
    await clearPlaylistCover(playlist.id)
    setCoverBusy(false)
  }

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
  const [hiddenCols, setHiddenCols] = useState<Set<string>>(() => new Set(['dateAdded', 'playCount', 'channelMode']))
  // Re-render when download pins/progress change so the title-cell disc tracks
  // state (store is app-init'd in App.tsx; inert on all-local machines).
  useSyncExternalStore(subscribeDownloads, downloadsVersion)
  const [colWidthMap, setColWidthMap] = useState<Record<string, number>>(() =>
    Object.fromEntries(ALL_COLUMN_DEFS.map(c => [c.key, c.defaultWidth]))
  )

  const visibleCols = ALL_COLUMN_DEFS.filter(c => !hiddenCols.has(c.key))
  const colWidths = visibleCols.map(c => colWidthMap[c.key] ?? c.defaultWidth)
  const gridTemplate = songsGridTemplate(visibleCols, colWidths)
  const gridTemplateFixed = songsGridTemplateFixed(colWidths)

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editing])

  // 2026-08-08 — suggestions must draw from the REGULAR library. A declared
  // concert's constituent songs are hidden everywhere else, but the strip was
  // reading raw state.tracks, so a Dead setlist cue turned up as a standalone
  // suggestion (Jake: "this track is apart of a live set why is it a seperate
  // thing"). The playlist's OWN tracks still resolve from the full map — a
  // tape or playlist that legitimately holds a concert track keeps working.
  const suggestPool = useRegularLibraryTracks(state.tracks)

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
  // 4.5: brain-driven suggestions strip — the tracks most similar to this
  // playlist's actual songs (vibe match), filtered for fresh artists + no
  // same-album repeats. Replaces the old artist/genre string-match that just
  // surfaced more songs by the artists already on the playlist.
  const [suggestRotate, setSuggestRotate] = useState(0)
  const [vibeHits, setVibeHits] = useState<Array<{ trackId: number; score: number; cluster: number }>>([])
  const [vibeClusterSeeds, setVibeClusterSeeds] = useState<number[]>([])
  // Taste-ledger loop: learned per-playlist blend weights + the diag map
  // (each shown candidate's blend components) that verdict events carry.
  const [tasteWeights, setTasteWeights] = useState<Record<string, { vibe?: number; genre?: number; taste?: number }>>({})
  const suggestDiag = useRef(new Map<number, { vn: number; g: number; b: number; ta: number }>())
  useEffect(() => {
    void window.electronAPI.getTasteWeights?.().then((r) => {
      const pl = (r?.weights as { playlists?: Record<string, { vibe?: number; genre?: number; taste?: number }> })?.playlists
      if (pl) setTasteWeights(pl)
    })
  }, [])
  const ledger = (events: Array<{ surface: string; verdict: string; key?: Record<string, unknown>; ctx?: Record<string, unknown> }>) => {
    void window.electronAPI.tasteLedgerAppend?.(events)
  }
  useEffect(() => { setSuggestRotate(0) }, [state.activePlaylistId])
  // Re-fetch whenever the playlist's MEMBERSHIP changes — adding a song (the +,
  // or manually), removing one, or swapping one for another all re-center the
  // suggestions. Keyed on the full trackIds content: NOT the search-filtered
  // `tracks` (suggestions are for the whole playlist), and NOT just length (a
  // same-size swap must still recompute). ↻ then re-pages this pool locally.
  const plMembershipKey = (playlist?.trackIds ?? []).join(',')
  useEffect(() => {
    let cancelled = false
    const ids = playlist?.trackIds ?? []
    if (ids.length === 0) { setVibeHits([]); return }
    window.electronAPI.playlistSimilar(ids, 5)
      .then(r => {
        if (cancelled) return
        setVibeHits(r.ok ? r.hits : [])
        setVibeClusterSeeds(r.ok ? (r.clusterSeeds ?? []) : [])
      })
      .catch(() => { if (!cancelled) { setVibeHits([]); setVibeClusterSeeds([]) } })
    return () => { cancelled = true }
  }, [state.activePlaylistId, plMembershipKey])
  const suggestions = useMemo(
    () => {
      suggestDiag.current = new Map()
      return vibeHits.length
        ? suggestFromVibeHits(allPlaylistTracks, suggestPool, vibeHits, 5, suggestRotate, vibeClusterSeeds,
            (playlist ? tasteWeights[playlist.id] : undefined) ?? {}, suggestDiag.current)
        : suggestForPlaylist(allPlaylistTracks, suggestPool, 5, suggestRotate)
    },
    [allPlaylistTracks, suggestPool, vibeHits, vibeClusterSeeds, suggestRotate, tasteWeights, playlist],
  )
  const suggestArtIndex = useMemo(() => buildNormalizedArtworkIndex(state.artworkMap), [state.artworkMap])

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
        case 'channelMode': av = a.channelMode || ''; bv = b.channelMode || ''; break
        default: return 0
      }
      const aStr = String(av).toLowerCase()
      const bStr = String(bv).toLowerCase()
      const cmp = aStr < bStr ? -1 : aStr > bStr ? 1 : 0
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [tracks, sortCol, sortDir])

  // Sort handler
  // 4.5: suppress sort if a column resize just ended — the implicit
  // click bubbling up from the resize handle was triggering unwanted
  // re-sorts on every drag-to-resize.
  const lastResizeEndAt = useRef<number>(0)
  const handleSort = useCallback((key: string) => {
    if (Date.now() - lastResizeEndAt.current < 300) return
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
      lastResizeEndAt.current = Date.now()
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
      if (playlist.id.startsWith('mm-')) {
        void window.electronAPI.tasteLedgerAppend?.([{
          surface: 'mm-playlist', verdict: 'reject',
          key: { playlistId: playlist.id },
          ctx: { name: playlist.name },
        }])
      }
    }
    setConfirmAction(null)
  }, [playlist, confirmAction, dispatch])

  // Keyboard: Delete/Backspace to remove selected tracks; ⌘A selects every
  // visible track (parity with SongsView).
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (confirmAction) return
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if ((e.metaKey || e.ctrlKey) && e.key === 'a' && sortedTracks.length > 0) {
        e.preventDefault()
        setSelectedIds(new Set(sortedTracks.map(t => t.id)))
        return
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.size > 0 && playlist) {
        e.preventDefault()
        removeSelected()
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [selectedIds, playlist, removeSelected, confirmAction, sortedTracks])

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
      // 4.4.12: surface failure (usually sips conversion) so the user
      // doesn't think the art stuck just because the Get Info preview
      // still shows it from localArtHash.
      setNotice(result.error ? `Couldn't save artwork: ${result.error}` : "Couldn't save artwork.", { kind: 'error' })
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
    // V5 facelift: 18px rows (matches --row-height + SongsView's ROW_HEIGHT).
    const rowH = 18
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
          let failed = 0
          let lastErr = ''
          for (const { artist, album } of artPairs.values()) {
            const result = await window.electronAPI.setCustomArtwork(artist, album, file.path)
            if (result.ok && result.key && result.hash) {
              dispatch({ type: 'ADD_ARTWORK', key: result.key, hash: result.hash })
            } else {
              failed += 1
              lastErr = result.error || ''
            }
          }
          // 4.4.12: surface failures so the user knows the save didn't stick.
          if (failed > 0) {
            setNotice(
              failed === 1
                ? (lastErr ? `Couldn't save artwork: ${lastErr}` : "Couldn't save artwork.")
                : `Couldn't save artwork for ${failed} albums.`,
              { kind: 'error' }
            )
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
      { label: `Play "${label}"`, onClick: () => playTrack(track, sortedTracks, idx, undefined, true) },
      { separator: true as const },
      { label: `Play Next`, onClick: () => pbDispatch({ type: 'PLAY_NEXT', tracks: selected }) },
      { label: `Add to Up Next`, onClick: () => pbDispatch({ type: 'ADD_TO_QUEUE', tracks: selected }) },
      addToPlaylistEntry(selected, state.playlists, (pid, ids) => dispatch({ type: 'ADD_TRACKS_TO_PLAYLIST', playlistId: pid, trackIds: ids })),
      ...(getDeckState() ? [
        {
          label: `Lay on the tape (${selected.length} song${selected.length === 1 ? '' : 's'})`,
          onClick: () => {
            void layOnDeck(selected.map(t => t.id), (id) => selected.find(t => t.id === id)?.duration || undefined)
              .then(async (msg) => { const a = await import('../activity'); a.setNotice(msg) })
          },
        },
      ] : []),
      { separator: true as const },
      { label: 'Go to Artist', onClick: () => dispatch({ type: 'VIEW_ARTIST_DETAIL', artistName: canonicalArtist(track.albumArtist || track.artist || '') }) },
      { label: 'Go to Album', onClick: () => dispatch({ type: 'VIEW_ALBUM_DETAIL', albumKey: albumKeyOf(track) }) },
      ...ratingMenuEntries(selected, dispatch),
      { separator: true as const },
      {
        label: `Get Info`,
        onClick: () => setGetInfoState({ tracks: selected, index: idx }),
      },
      ...artworkItems,
      ...downloadMenuEntries(selected),
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
        label: count > 1 ? `Remove ${count} from Playlist` : `Remove from Playlist`,
        onClick: () => {
          setConfirmAction({ type: 'remove-tracks', trackIds: selected.map(t => t.id) })
        },
      },
      // 4.4.10: removed "Delete Song" from the playlist context menu —
      // sat right next to "Remove from Playlist" and made it trivial
      // to accidentally nuke a song from the whole library when the
      // user just wanted to take it out of THIS playlist. iTunes
      // precedent: playlist context menus only offer "Remove from
      // Playlist." Library deletion still works from the Songs view.
    ]
  }

  // Drag reorder is only enabled when in natural order (no sort, no search)
  const canDragReorder = !state.searchQuery && !sortCol

  return (
    <div className="playlist-view">
      <div className="playlist-view-header">
        {/* Cover — Jake, 2026-08-09: "playlists on desktop need covers....like
            it is on mobile (first 4 songs' album covers or i can upload a
            custom cover)". The default is MixArtwork, which already builds
            the 2x2 of the first four unique album covers using the same rule
            iOS uses, so parity is structural rather than re-implemented.
            Click to choose your own; right-click a custom one to drop back
            to the mosaic. */}
        <button
          type="button"
          className="playlist-view-cover"
          title={customCover ? 'Click to replace this cover · right-click to go back to the album mosaic' : 'Click to choose a cover'}
          onClick={() => { void chooseCover() }}
          onContextMenu={(e) => { e.preventDefault(); if (customCover) void dropCover() }}
        >
          {customCover
            ? <img src={customCover} alt="" className="playlist-view-cover-img" />
            : <MixArtwork tracks={sortedTracks} alt={playlist.name} priority />}
          <span className="playlist-view-cover-hint">{coverBusy ? '…' : 'Cover'}</span>
        </button>
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
          {coverNote && <div className="playlist-view-meta">{coverNote}</div>}
        </div>
        <div className="playlist-view-actions">
          <button
            className="playlist-view-play"
            onClick={() => {
              if (sortedTracks.length > 0) playTrack(sortedTracks[0], sortedTracks, 0, undefined, true)
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

      {suggestions.length > 0 && (
        <div className="pl-suggest">
          <div className="pl-suggest-head">
            <span className="pl-suggest-title">Suggested for this playlist</span>
            <button
              className="pl-suggest-refresh"
              onClick={() => {
                if (playlist) {
                  ledger(suggestions.map((sg) => ({
                    surface: 'strip', verdict: 'pass',
                    key: { trackId: sg.id, playlistId: playlist.id },
                    ctx: suggestDiag.current.get(sg.id) ?? {},
                  })))
                }
                setSuggestRotate(r => r + 1)
              }}
              title="Show different suggestions"
              aria-label="More suggestions"
            >↻</button>
          </div>
          <div className="pl-suggest-row">
            {suggestions.map(s => {
              const hash = lookupArtwork(state.artworkMap, suggestArtIndex, s.albumArtist || s.artist, s.album)
              return (
                <div key={s.id} className="pl-suggest-chip" title={`${s.title} — ${s.artist}`}>
                  <div className="pl-suggest-art">
                    {hash ? <AlbumArtImage hash={hash} alt="" /> : <span className="pl-suggest-ph">♪</span>}
                  </div>
                  <div className="pl-suggest-meta">
                    <div className="pl-suggest-song">{s.title}</div>
                    <div className="pl-suggest-artist">{s.artist}</div>
                  </div>
                  <button
                    className="pl-suggest-add"
                    onClick={() => {
                      if (!playlist) return
                      dispatch({ type: 'ADD_TRACKS_TO_PLAYLIST', playlistId: playlist.id, trackIds: [s.id] })
                      ledger([{ surface: 'strip', verdict: 'accept', key: { trackId: s.id, playlistId: playlist.id }, ctx: suggestDiag.current.get(s.id) ?? {} }])
                    }}
                    title={`Add "${s.title}" to this playlist`}
                    aria-label={`Add ${s.title}`}
                  >＋</button>
                </div>
              )
            })}
          </div>
        </div>
      )}
      {playlist.commentary && (
        <div className="playlist-view-commentary">{playlist.commentary}</div>
      )}
      {/* V5 facelift: Grid / Cover Flow modes swap only the table below
          the playlist header. */}
      {viewMode === 'grid' ? (
        <div style={{ flex: 1, minHeight: 0 }}>
          <TrackGridView tracks={sortedTracks} emptyNoun="tracks" />
        </div>
      ) : viewMode === 'coverflow' ? (
        <div style={{ flex: 1, minHeight: 0 }}>
          <CoverFlowView tracks={sortedTracks} emptyNoun="tracks" stateKey={`playlist:${playlist.id}`} />
        </div>
      ) : (
      <div className="songs-view" style={{ flex: 1, minHeight: 0 }} ref={songsBodyRef} onScroll={handleScroll}>
        <div
          className="songs-header"
          style={{ gridTemplateColumns: gridTemplate }}
          onContextMenu={(e) => { e.preventDefault(); setHeaderCtxMenu({ x: e.clientX, y: e.clientY }) }}
        >
          {visibleCols.map((col, i) => (
            <div
              key={col.key}
              className={`songs-header-cell songs-header-cell--${col.key} ${sortCol === col.key ? 'sorted' : ''}`}
              onClick={() => handleSort(col.key)}
            >
              {col.label}
              {sortCol === col.key && (
                <span className="sort-arrow"><SortArrowIcon direction={sortDir} /></span>
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
          {/* Fixed-px width anchor: owns .songs-view scrollWidth so rows
              (contain:inline-size) can't inflate past the header. */}
          <div className="songs-body-width-sizer" style={{ gridTemplateColumns: gridTemplateFixed }} aria-hidden="true" />
          {sortedTracks.map((track, i) => {
            const isPlaying = pb.nowPlaying?.id === track.id
            const isSelected = selectedIds.has(track.id)
            return (
              <div
                key={track.id}
                className={`songs-row ${i % 2 ? 'songs-row--alt' : ''} ${isPlaying ? 'songs-row--playing' : ''} ${isSelected ? 'songs-row--selected' : ''} ${dragOverIdx === i ? 'playlist-view-track--dragover' : ''}`}
                style={{ gridTemplateColumns: gridTemplate }}
                onClick={(e) => handleClick(track, i, e)}
                onDoubleClick={() => playTrack(track, sortedTracks, i, undefined, true)}
                onMouseEnter={() => prefetchTrackForPlay(track)}
                onMouseDown={() => prefetchTrackImmediate(track)}
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
                    case 'title': {
                      const starred = (Number(track.rating) || 0) > 0
                      const toggleStar = (e: React.MouseEvent) => {
                        e.stopPropagation()
                        const value = String(starred ? 0 : 5)
                        dispatch({ type: 'UPDATE_TRACKS', updates: [{ id: track.id, field: 'rating', value }] })
                        window.electronAPI.saveMetadataOverride(track.id, 'rating', value)
                        // 4.5: stamp starredAt on star-ON for the Starred
                        // playlist's recent-first default sort.
                        if (!starred) {
                          const stamp = String(Date.now())
                          dispatch({ type: 'UPDATE_TRACKS', updates: [{ id: track.id, field: 'starredAt', value: stamp }] })
                          window.electronAPI.saveMetadataOverride(track.id, 'starredAt', stamp)
                        }
                      }
                      return (
                        <div key={col.key} className="songs-cell songs-cell--title">
                          <span className="title-row-text">{track.title}</span>
                          <button
                            className={`title-row-star ${starred ? 'title-row-star--filled' : ''}`}
                            onClick={toggleStar}
                            onDoubleClick={(e) => e.stopPropagation()}
                            title={starred ? 'Unstar' : 'Star'}
                            aria-label={starred ? 'Unstar' : 'Star'}
                          >
                            <svg width="10" height="10" viewBox="0 0 10 10" fill={starred ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="0.8" strokeLinejoin="round">
                              <polygon points="5,1 6.2,3.8 9.5,4.1 7.1,6.2 7.9,9.5 5,7.8 2.1,9.5 2.9,6.2 0.5,4.1 3.8,3.8" />
                            </svg>
                          </button>
                          {(isDownloaded(track.path) || isDownloading(track.path)) && (
                            <span
                              className={isDownloading(track.path) ? 'title-row-dl title-row-dl--loading' : 'title-row-dl'}
                              title={isDownloading(track.path) ? 'Downloading…' : 'Downloaded for offline — plays instantly'}
                              aria-label={isDownloading(track.path) ? 'Downloading' : 'Downloaded'}
                            >
                              <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
                                <circle cx="8" cy="8" r="7" fill="currentColor" />
                                <path className="dl-arrow" d="M8 4.8v6M5.4 8.2 8 10.8l2.6-2.6" />
                              </svg>
                            </span>
                          )}
                        </div>
                      )
                    }
                    case 'time':
                      return <div key={col.key} className="songs-cell songs-cell--time">{formatDuration(track.duration)}</div>
                    case 'artist':
                      return <div key={col.key} className="songs-cell">{track.artist}</div>
                    case 'album':
                      return <div key={col.key} className="songs-cell">{track.album}</div>
                    case 'genre':
                      return <div key={col.key} className="songs-cell">{track.genre}</div>
                    case 'channelMode':
                      return <div key={col.key} className="songs-cell">{track.channelMode === 'mono' ? 'Mono' : track.channelMode === 'stereo' ? 'Stereo' : ''}</div>
                    case 'year':
                      return <div key={col.key} className="songs-cell">{track.year || ''}</div>
                    case 'dateAdded':
                      return <div key={col.key} className="songs-cell songs-cell--time">{formatAppDate(track.dateAdded)}</div>
                    case 'playCount':
                      return <div key={col.key} className="songs-cell songs-cell--plays">{track.playCount || ''}</div>
                    default:
                      return null
                  }
                })}
              </div>
            )
          })}
        </div>
      </div>
      )}
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
