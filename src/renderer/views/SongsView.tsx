import { useCallback, useState, useEffect, useRef, useSyncExternalStore } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { usePlayback } from '../context/PlaybackContext'
import { useAudio, prefetchTrackForPlay, prefetchTrackImmediate } from '../hooks/useAudio'
import { useVirtualScroll } from '../hooks/useVirtualScroll'
import { useScrollPersistence, getSavedScrollTop } from '../hooks/useScrollPersistence'
import { useSortedTracks } from '../hooks/useSortedTracks'
import { getSnapshot as recentlyAddedSnapshot, isRecentlyAdded, subscribe as subscribeRecentlyAdded } from '../state/recentlyAdded'
import { SpeakerPlayingIcon } from '../assets/icons/SpeakerIcon'
import ContextMenu, { MenuEntry } from '../components/ContextMenu'
import ConfirmDialog from '../components/ConfirmDialog'
import GetInfoModal from '../components/GetInfoModal'
import { ratingMenuEntries } from '../components/StarRating'
import { useCynthia } from '../context/CynthiaContext'
import { toCynthiaTrack } from '../utils/cynthia'
import { clearArtworkNegativeCache } from '../utils/artworkLookup'
import type { SortColumn, Track } from '../types'
import { setNotice } from '../activity'
import EmptyState from '../components/EmptyState'
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

// 4.5.2: was an inline 5-star widget that shadowed the shared
// components/StarRating. Replaced with a single-star toggle matching
// the shared component. Click toggles 0 <-> 5 (the stored value stays
// on the 0..5 scale; any > 0 reads as starred so legacy ratings show
// up). Kept inline rather than importing because SongsView is on the
// hot path and the shared component lives in src/renderer/components.
function StarRating({ value, onChange }: { value: number; onChange: (r: number) => void }) {
  const filled = value > 0
  return (
    <span className="star-rating" onMouseLeave={(e) => e.stopPropagation()}>
      <span
        className={`star-rating-star ${filled ? 'star-rating-star--filled' : ''}`}
        onClick={(e) => {
          e.stopPropagation()
          onChange(filled ? 0 : 5)
        }}
        title={filled ? 'Unstar' : 'Star'}
      >
        <svg width="11" height="11" viewBox="0 0 10 10" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="0.8" strokeLinejoin="round">
          <polygon points="5,1 6.2,3.8 9.5,4.1 7.1,6.2 7.9,9.5 5,7.8 2.1,9.5 2.9,6.2 0.5,4.1 3.8,3.8" />
        </svg>
      </span>
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
  // 4.5: 'rating' column REMOVED — the star now renders inline next to
  // the song title (hover-reveal when unstarred, always-visible when
  // starred). Right-click Star/Unstar still works via ratingMenuEntries.
  // If a persisted user columnOrder references 'rating', the visibleCols
  // filter quietly drops it because no def matches the key.
]

// Columns that cannot be hidden
const ALWAYS_VISIBLE = new Set(['playing', 'title'])

// Idle window before the library re-follows the playing track. Any
// library action (scroll, click, sort, keyboard nav) resets this clock;
// only after this long with NO activity does the now-playing track snap
// to the top. Deliberately long so browsing is never yanked away.
const FOLLOW_IDLE_MS = 15000
// Fixed row height (px) — matches the value passed to useVirtualScroll.
const ROW_HEIGHT = 19

export default function SongsView() {
  const { state: lib, dispatch: libDispatch } = useLibrary()
  const { state: pb, dispatch: pbDispatch } = usePlayback()
  const { playTrack } = useAudio()
  const { openCynthia } = useCynthia()
  // Subscribe to the Bandcamp recently-added store so the row class
  // re-renders when a new import lands or its 10s TTL expires.
  useSyncExternalStore(subscribeRecentlyAdded, recentlyAddedSnapshot)

  const [hiddenCols, setHiddenCols] = useState<Set<string>>(() => new Set())
  const [colWidthMap, setColWidthMap] = useState<Record<string, number>>(() =>
    Object.fromEntries(ALL_COLUMN_DEFS.map(c => [c.key, c.defaultWidth]))
  )
  // 4.5.3: user-rearrangeable column order. Default is the natural
  // ALL_COLUMN_DEFS order; drag a header onto another to reorder.
  // Persists with the rest of the column state. Defensive about new
  // columns added in future versions — those get appended at the end
  // rather than being lost from the saved order.
  const [columnOrder, setColumnOrder] = useState<string[]>(() => ALL_COLUMN_DEFS.map(c => c.key))
  const [dragOverKey, setDragOverKey] = useState<string | null>(null)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; track: Track; idx: number } | null>(null)
  const [headerCtxMenu, setHeaderCtxMenu] = useState<{ x: number; y: number } | null>(null)
  const [getInfoState, setGetInfoState] = useState<{ tracks: Track[]; index: number } | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<{ ids: number[]; count: number } | null>(null)

  // Filter columns based on visibility, ordered per user's columnOrder.
  // Any column NOT in columnOrder (e.g. a brand-new column added in a
  // future version that landed after the user's last save) gets
  // appended at the end so nothing silently disappears.
  const byKey = ALL_COLUMN_DEFS.reduce<Record<string, ColDef>>((m, c) => { m[c.key] = c; return m }, {})
  const orderedCols: ColDef[] = []
  const seen = new Set<string>()
  for (const k of columnOrder) {
    const c = byKey[k]
    if (c && !seen.has(k)) { orderedCols.push(c); seen.add(k) }
  }
  for (const c of ALL_COLUMN_DEFS) {
    if (!seen.has(c.key)) orderedCols.push(c)
  }
  const visibleCols = orderedCols.filter(c => !hiddenCols.has(c.key))
  const colWidths = visibleCols.map(c => colWidthMap[c.key] ?? c.defaultWidth)

  const sorted = useSortedTracks(lib.tracks, lib.sortColumn, lib.sortDirection, lib.searchQuery)
  // 4.4.22: seed useVirtualScroll's internal scrollTop from the persisted
  // value so the FIRST render computes startIndex/endIndex correctly.
  // Pair with useScrollPersistence(key, containerRef) which then keeps
  // both DOM scrollTop and the cache in sync.
  const { startIndex, endIndex, totalHeight, offsetY, containerRef, onScroll } = useVirtualScroll(
    sorted.length, 19, 10, getSavedScrollTop('songs'),
  )
  useScrollPersistence('songs', containerRef)
  // 4.4.27: removed useElasticOverscroll — let macOS provide the
  // native bounce instead of a JS approximation.

  // 4.5: column-resize sort-suppression. The resize handle lives inside
  // the header cell; user mousedown on the handle, drags, releases —
  // the click event still fires on the parent header and triggered an
  // unwanted re-sort. lastResizeEndAt is updated on resize mouseup;
  // handleSort ignores clicks that land inside the suppression window.
  const lastResizeEndAt = useRef<number>(0)
  const handleSort = useCallback((col: string) => {
    if (Date.now() - lastResizeEndAt.current < 300) return
    if (col === 'playing' || col === 'time') return
    libDispatch({ type: 'SET_SORT', column: col as SortColumn })
  }, [libDispatch])


  const handleDoubleClick = useCallback((idx: number) => {
    window.getSelection()?.removeAllRanges()
    const track = sorted[idx]
    if (track) playTrack(track, sorted, idx, undefined, true)
  }, [sorted, playTrack])

  const lastClickedIdx = useRef<number>(-1)
  const selectedIdsRef = useRef(lib.selectedTrackIds)
  selectedIdsRef.current = lib.selectedTrackIds

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
          let failed = 0
          let lastErr = ''
          for (const { artist, album } of artPairs.values()) {
            const result = await window.electronAPI.setCustomArtwork(artist, album, file.path)
            if (result.ok && result.key && result.hash) {
              libDispatch({ type: 'ADD_ARTWORK', key: result.key, hash: result.hash })
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
              libDispatch({ type: 'ADD_ARTWORK', key: result.key, hash: result.hash })
            }
          }
        },
      },
    ] : []

    // Artist Radio: filter library by this song's artist, dispatch to
    // Toolbar so it shuffles + starts Radio Mode focused on that artist.
    // Toolbar listens on 'jaketunes-start-artist-radio'.
    //
    // Brief 031 Phase 4c: match by contributingArtists overlap. For a
    // sole-artist source track ("Lou Reed") this reduces to the
    // previous behavior — any track contributing to "Lou Reed" gets
    // included. For a collab source track ("JAY-Z & Linkin Park"
    // with contributingArtists ["JAY-Z", "Linkin Park"]), Artist
    // Radio expands to every track involving either canonical
    // contributor — better UX than matching only the literal
    // "JAY-Z & Linkin Park" string (which would have returned just
    // the same 6 collab tracks). Case-insensitive match preserves
    // the prior tolerance for casing differences.
    //
    // trackArtist stays as the displayed menu-label string (the
    // right-clicked track's `artist` field is what the user sees,
    // so that's what reads naturally in "Start X Radio").
    const trackArtist = (track.artist || '').trim()
    const sourceContribs = (
      track.contributingArtists && track.contributingArtists.length > 0
        ? track.contributingArtists
        : [trackArtist]
    )
      .map(s => (s || '').trim().toLowerCase())
      .filter(s => s.length > 0)
    const artistTracks = sourceContribs.length
      ? lib.tracks.filter(t => {
          const candidates = (t.contributingArtists && t.contributingArtists.length > 0
            ? t.contributingArtists
            : [(t.artist || '').trim()]
          )
            .map(s => (s || '').trim().toLowerCase())
            .filter(s => s.length > 0)
          return candidates.some(c => sourceContribs.includes(c))
        })
      : []

    return [
      { label: `Play "${label}"`, onClick: () => playTrack(track, sorted, idx, undefined, true) },
      { separator: true as const },
      { label: `Play Next`, onClick: () => pbDispatch({ type: 'PLAY_NEXT', tracks: selectedTracks }) },
      { label: `Add to Up Next`, onClick: () => pbDispatch({ type: 'ADD_TO_QUEUE', tracks: selectedTracks }) },
      ...(trackArtist && artistTracks.length > 0 ? [
        { separator: true as const },
        {
          label: `Start ${trackArtist} Radio`,
          onClick: () => {
            window.dispatchEvent(new CustomEvent('jaketunes-start-artist-radio', {
              detail: { tracks: artistTracks, label: trackArtist },
            }))
          },
        },
      ] : []),
      ...ratingMenuEntries(selectedTracks, libDispatch),
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
        label: 'Cynthia!!',
        onClick: () => {
          openCynthia({
            x: ctxMenu.x, y: ctxMenu.y,
            scope: {
              type: 'tracks',
              label: count > 1 ? `${count} tracks` : track.title,
              tracks: selectedTracks.map(toCynthiaTrack),
            },
          })
        },
      },
      { separator: true as const },
      {
        label: count > 1 ? `Delete ${count} Songs` : 'Delete Song',
        onClick: () => {
          setDeleteConfirm({ ids: selectedTracks.map(t => t.id), count })
        },
      },
    ]
  }, [ctxMenu, lib.selectedTrackIds, sorted, playTrack, pbDispatch, libDispatch, openCynthia])

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
      // 4.5: stamp the suppression window so the click event that
      // bubbles to the header right after this mouseup doesn't fire
      // a re-sort. handleSort checks against this timestamp.
      lastResizeEndAt.current = Date.now()
    }
    document.body.style.cursor = 'col-resize'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [colWidths, visibleCols])

  // Save metadata edits from Get Info modal.
  // 4.4.5: we now snapshot each track's PRE-EDIT fingerprint and pass
  // it with every override save. The fingerprint is title|artist|
  // duration computed from the track AS IT WAS BEFORE the user's
  // edits — so on the next library re-parse, the load-time validator
  // can confirm the override still applies to the correct track.
  // Without this snapshot, the post-edit dispatch flips the track's
  // in-memory state, the next save would compute a different
  // fingerprint, and the safeguard logic in main would treat
  // consecutive saves as different identities.
  const handleGetInfoSave = useCallback(
    async (updates: { id: number; field: string; value: string }[]) => {
      // 4.5.0-67 — save-first ordering for artwork-affecting edits.
      // OLD order: dispatch UPDATE_TRACKS → re-render with new key →
      // requestArtworkResolution(newKey) fires → main's migration hasn't
      // run yet → returns null → renderer caches 60s negative → album
      // tile stays blank until that cache expires even after main
      // completes the migration.
      // NEW order: snapshot old (artist, album), await all saves
      // (migration runs inside save-metadata-override), derive new
      // (artist, album), explicitly clear the negative cache for those
      // keys, THEN dispatch UPDATE_TRACKS. The re-render now triggers
      // a fresh resolveArtwork IPC that finds the migrated entry.
      const fpById = new Map<number, string>()
      const oldArtAlbumById = new Map<number, { artist: string; album: string }>()
      for (const u of updates) {
        if (fpById.has(u.id)) continue
        const t = lib.tracks.find(tr => tr.id === u.id)
        if (!t) continue
        fpById.set(u.id, `${(t.title || '').toLowerCase().trim()}|${(t.artist || '').toLowerCase().trim()}|${t.duration || 0}`)
        oldArtAlbumById.set(u.id, { artist: t.artist || '', album: t.album || '' })
      }
      for (const u of updates) {
        await window.electronAPI.saveMetadataOverride(u.id, u.field, u.value, fpById.get(u.id))
      }
      const touchesArtwork = updates.some(u => u.field === 'artist' || u.field === 'album')
      if (touchesArtwork) {
        const newArtAlbumById = new Map<number, { artist: string; album: string }>()
        for (const [id, old] of oldArtAlbumById) newArtAlbumById.set(id, { ...old })
        for (const u of updates) {
          const cur = newArtAlbumById.get(u.id)
          if (!cur) continue
          if (u.field === 'artist') cur.artist = u.value
          else if (u.field === 'album') cur.album = u.value
        }
        for (const v of newArtAlbumById.values()) {
          clearArtworkNegativeCache(v.artist, v.album)
        }
      }
      libDispatch({ type: 'UPDATE_TRACKS', updates })
    },
    [libDispatch, lib.tracks]
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
      // 4.4.12: surface failure (usually sips conversion) so the user
      // doesn't think the art stuck just because the Get Info preview
      // still shows it from localArtHash.
      setNotice(result.error ? `Couldn't save artwork: ${result.error}` : "Couldn't save artwork.", { kind: 'error' })
      return null
    },
    [libDispatch]
  )

  // Set rating for a track (click stars)
  // 4.5: when starring (rating > 0), also stamp starredAt = now so the
  // Starred smart playlist can sort recent-first. Unstar leaves the
  // timestamp alone — irrelevant since the track drops out of the
  // playlist anyway, and re-starring later will overwrite it.
  const handleRatingChange = useCallback((trackId: number, rating: number) => {
    const value = String(rating)
    libDispatch({ type: 'UPDATE_TRACKS', updates: [{ id: trackId, field: 'rating', value }] })
    window.electronAPI.saveMetadataOverride(trackId, 'rating', value)
    if (rating > 0) {
      const stampValue = String(Date.now())
      libDispatch({ type: 'UPDATE_TRACKS', updates: [{ id: trackId, field: 'starredAt', value: stampValue }] })
      window.electronAPI.saveMetadataOverride(trackId, 'starredAt', stampValue)
    }
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

  // Scroll a row just into view (nearest edge). Used by keyboard nav.
  const scrollToIdx = useCallback((idx: number) => {
    const el = containerRef.current
    if (!el) return
    const scrollTop = el.scrollTop
    const viewH = el.clientHeight
    const rowTop = idx * ROW_HEIGHT
    const rowBottom = rowTop + ROW_HEIGHT
    if (rowTop < scrollTop) {
      el.scrollTop = rowTop
    } else if (rowBottom > scrollTop + viewH) {
      el.scrollTop = rowBottom - viewH
    }
  }, [containerRef])

  // Scroll a row to the TOP of the viewport. Used by the idle auto-follow
  // so the now-playing track lands at the top of the list (browser clamps
  // at the scroll max, so a track near the end sits as high as it can).
  const scrollIdxToTop = useCallback((idx: number) => {
    const el = containerRef.current
    if (!el) return
    el.scrollTop = idx * ROW_HEIGHT
  }, [containerRef])

  // Auto-follow now-playing. The list re-centers the playing track at the
  // TOP, but ONLY after the user has been idle in the library for
  // FOLLOW_IDLE_MS. ANY library action (scroll, click, sort, keyboard
  // nav) calls markActivity, which resets the idle clock AND restarts the
  // countdown — so browsing is never yanked away mid-scroll. Two triggers
  // keep the playing track on top while idle:
  //   1. an idle timer — re-centers FOLLOW_IDLE_MS after you stop, even if
  //      the track never changed; and
  //   2. a track-change effect — follows shuffle/next while still idle.
  // Programmatic auto-scrolls set isAutoScrollAtRef so the resulting
  // scroll event isn't mistaken for user activity.
  const lastUserActivityAtRef = useRef<number>(0)
  const isAutoScrollAtRef = useRef<number>(0)
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Refs mirror the latest values so the idle timer's (stale) setTimeout
  // closure always reads current state when it eventually fires.
  const sortedRef = useRef(sorted)
  sortedRef.current = sorted
  const nowPlayingIdRef = useRef(pb.nowPlaying?.id)
  nowPlayingIdRef.current = pb.nowPlaying?.id
  const currentViewRef = useRef(lib.currentView)
  currentViewRef.current = lib.currentView

  const followNowPlayingTop = useCallback(() => {
    if (currentViewRef.current !== 'songs') return
    const id = nowPlayingIdRef.current
    if (id == null) return
    const idx = sortedRef.current.findIndex(t => t.id === id)
    if (idx < 0) return
    isAutoScrollAtRef.current = Date.now()
    scrollIdxToTop(idx)
  }, [scrollIdxToTop])

  const markActivity = useCallback(() => {
    lastUserActivityAtRef.current = Date.now()
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
    idleTimerRef.current = setTimeout(followNowPlayingTop, FOLLOW_IDLE_MS)
  }, [followNowPlayingTop])

  const handleScroll = useCallback((_e: React.UIEvent<HTMLDivElement>) => {
    onScroll()
    // Skip activity update if this scroll was triggered by our own
    // auto-follow (within 200ms of the programmatic scrollTop write).
    if (Date.now() - isAutoScrollAtRef.current > 200) {
      markActivity()
    }
  }, [onScroll, markActivity])

  // Start the idle countdown when the view mounts; clear it on unmount so
  // a pending snap never fires into a dead component.
  useEffect(() => {
    markActivity()
    return () => { if (idleTimerRef.current) clearTimeout(idleTimerRef.current) }
  }, [markActivity])

  // Track-change follow: when the playing track changes while the user is
  // still idle (>= FOLLOW_IDLE_MS), keep the new track pinned to the top.
  useEffect(() => {
    if (lib.currentView !== 'songs') return
    if (!pb.nowPlaying) return
    if (Date.now() - lastUserActivityAtRef.current < FOLLOW_IDLE_MS) return
    const idx = sorted.findIndex(t => t.id === pb.nowPlaying!.id)
    if (idx < 0) return
    isAutoScrollAtRef.current = Date.now()
    scrollIdxToTop(idx)
  }, [pb.nowPlaying?.id, lib.currentView, sorted, scrollIdxToTop])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip keyboard nav when Get Info modal is open
      if (document.querySelector('.getinfo-overlay')) return

      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return

      // Keyboard interaction is library activity — reset the idle clock.
      markActivity()

      // Delete/Backspace = delete selected tracks
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIdsRef.current.size > 0) {
        e.preventDefault()
        const ids = Array.from(selectedIdsRef.current)
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
          playTrack(track, sorted, idx, undefined, true)
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
  }, [sorted, libDispatch, playTrack, scrollToIdx, markActivity])

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
      const { colWidthMap: savedWidths, hiddenCols: savedHidden, columnOrder: savedOrder } = (e as CustomEvent).detail
      if (savedWidths && typeof savedWidths === 'object') {
        setColWidthMap(prev => ({ ...prev, ...savedWidths }))
      }
      if (Array.isArray(savedHidden)) {
        setHiddenCols(new Set(savedHidden))
      }
      if (Array.isArray(savedOrder) && savedOrder.length > 0) {
        setColumnOrder(savedOrder.filter((k: unknown): k is string => typeof k === 'string'))
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
        detail: { colWidthMap, hiddenCols: Array.from(hiddenCols), columnOrder }
      }))
    }, 500)
  }, [colWidthMap, hiddenCols, columnOrder])

  // 4.5.3: drag-to-reorder headers. Standard convention: drop AFTER
  // target when dragging rightward, BEFORE target when dragging left.
  // dragOverKey gives the destination cell a visual hint while the
  // user hovers (see .songs-header-cell--drag-over in songs.css).
  const handleHeaderDragStart = useCallback((e: React.DragEvent, key: string) => {
    e.dataTransfer.setData('text/plain', key)
    e.dataTransfer.effectAllowed = 'move'
  }, [])
  const handleHeaderDragOver = useCallback((e: React.DragEvent, key: string) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (dragOverKey !== key) setDragOverKey(key)
  }, [dragOverKey])
  const handleHeaderDragLeave = useCallback(() => { setDragOverKey(null) }, [])
  const handleHeaderDrop = useCallback((e: React.DragEvent, targetKey: string) => {
    e.preventDefault()
    setDragOverKey(null)
    const sourceKey = e.dataTransfer.getData('text/plain')
    if (!sourceKey || sourceKey === targetKey) return
    setColumnOrder(prev => {
      const next = [...prev]
      const sourceIdx = next.indexOf(sourceKey)
      const targetIdx = next.indexOf(targetKey)
      if (sourceIdx < 0 || targetIdx < 0) return prev
      next.splice(sourceIdx, 1)
      const newTargetIdx = next.indexOf(targetKey)
      next.splice(newTargetIdx + (sourceIdx < targetIdx ? 1 : 0), 0, sourceKey)
      return next
    })
  }, [])

  return (
    <div className="songs-view" ref={viewRef} onPointerDownCapture={markActivity}>
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
            className={`songs-header-cell songs-header-cell--${col.key} ${lib.sortColumn === col.key ? 'sorted' : ''} ${dragOverKey === col.key ? 'songs-header-cell--drag-over' : ''}`}
            onClick={() => handleSort(col.key)}
            draggable
            onDragStart={(e) => handleHeaderDragStart(e, col.key)}
            onDragOver={(e) => handleHeaderDragOver(e, col.key)}
            onDragLeave={handleHeaderDragLeave}
            onDrop={(e) => handleHeaderDrop(e, col.key)}
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
      <div className="songs-body" ref={containerRef} onScroll={handleScroll}>
        {sorted.length === 0 && (
          <EmptyState query={lib.searchQuery} noun="tracks" />
        )}
        <div style={{ height: totalHeight, position: 'relative' }}>
          <div style={{ position: 'absolute', top: offsetY, left: 0, right: 0 }}>
            {sorted.slice(startIndex, endIndex).map((track, i) => {
              const idx = startIndex + i
              const isPlaying = pb.nowPlaying?.id === track.id
              const isSelected = lib.selectedTrackIds.has(track.id)
              const isRecent = isRecentlyAdded(track.id)
              return (
                <div
                  key={track.id}
                  className={`songs-row ${idx % 2 ? 'songs-row--alt' : ''} ${isPlaying ? 'songs-row--playing' : ''} ${isSelected ? 'songs-row--selected' : ''} ${isRecent ? 'songs-row--recently-added' : ''}`}
                  style={{ gridTemplateColumns: gridTemplate }}
                  onClick={(e) => handleClick(track.id, idx, e)}
                  onDoubleClick={() => handleDoubleClick(idx)}
                  onMouseEnter={() => prefetchTrackForPlay(track)}
                  onMouseDown={() => prefetchTrackImmediate(track)}
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
                      case 'title': {
                        const starred = (Number(track.rating) || 0) > 0
                        return (
                          <div key={col.key} className="songs-cell songs-cell--title">
                            {track.audioMissing && (
                              <span
                                className="songs-cell-missing-badge"
                                title="JakeTunes can't find this track's audio file. The library entry is preserved — re-import the file to restore playback."
                                aria-label="Audio file missing"
                              >!</span>
                            )}
                            <span className="title-row-text">{track.title || ''}</span>
                            {/* 4.5: inline star to the RIGHT of the title.
                                Hover-reveal when unstarred, always visible
                                when starred. Click stops propagation so
                                it doesn't trigger row select. */}
                            <button
                              className={`title-row-star ${starred ? 'title-row-star--filled' : ''}`}
                              onClick={(e) => { e.stopPropagation(); handleRatingChange(track.id, starred ? 0 : 5) }}
                              onDoubleClick={(e) => e.stopPropagation()}
                              title={starred ? 'Unstar' : 'Star'}
                              aria-label={starred ? 'Unstar' : 'Star'}
                            >
                              <svg width="10" height="10" viewBox="0 0 10 10" fill={starred ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="0.8" strokeLinejoin="round">
                                <polygon points="5,1 6.2,3.8 9.5,4.1 7.1,6.2 7.9,9.5 5,7.8 2.1,9.5 2.9,6.2 0.5,4.1 3.8,3.8" />
                              </svg>
                            </button>
                          </div>
                        )
                      }
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
