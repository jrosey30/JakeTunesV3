import { useMemo, useState, useEffect, useRef, useCallback } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { usePlayback } from '../context/PlaybackContext'
import { useAudio, prefetchTrackForPlay, prefetchTrackImmediate } from '../hooks/useAudio'
import { useScrollPersistence } from '../hooks/useScrollPersistence'
import { attachClipToBroadcast, detachClipFromBroadcast } from '../audio/eq'
import { evaluateSmartPlaylist } from '../utils/smartPlaylists'
import { Track } from '../types'
import { SpeakerPlayingIcon } from '../assets/icons/SpeakerIcon'
import ContextMenu, { MenuEntry } from '../components/ContextMenu'
import ConfirmDialog from '../components/ConfirmDialog'
import GetInfoModal from '../components/GetInfoModal'
import StarRating, { ratingMenuEntries } from '../components/StarRating'
import { setNotice } from '../activity'
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
  'top-rated': 'Starred',
  'musicman-picks': 'The Music Man Picks',
  'megan-picks': 'Megan Picks',
  'dj-hands-picks': 'DJ Stephen Hands Picks',
}

interface PicksData {
  name: string
  commentary: string
  trackIds: number[]
  date: string
  /** 4.4.48 schema stamp. Bumped when picks generation changes shape
   *  (e.g. 4.4.48 added main-process variety enforcement). A cached
   *  entry with a mismatched/absent `v` is treated as stale so the
   *  pre-4.4.48 *clustered* localStorage caches get thrown out and
   *  regenerated once — through main, which now de-clusters them. */
  v?: number
}

// Bump this whenever picks output should be considered incompatible
// with what an older build cached. 4.4.48: variety enforcement landed.
const PICKS_SCHEMA_V = 2

// 4.2.18: Picks are weekly now, Friday-to-Friday. Returns the most
// recent Friday at midnight local — same value for any time within the
// same Fri→Thu window, so equality on this value tells us "still in
// the same week's picks." Roll-over fires automatically when the user
// opens picks after Friday 00:00.
function getWeekStartFriday(d: Date): Date {
  const result = new Date(d)
  const day = result.getDay()  // 0=Sun, 1=Mon, ..., 5=Fri, 6=Sat
  const daysSinceFriday = (day - 5 + 7) % 7
  result.setDate(result.getDate() - daysSinceFriday)
  result.setHours(0, 0, 0, 0)
  return result
}

// Pick which persona's picks the current view should use, plus the
// localStorage key to use. One key per persona so MM and Megan picks
// don't overwrite each other.
type PicksKind = 'mm' | 'megan' | 'djhands'
function picksConfigForId(id: string | null): { kind: PicksKind; storageKey: string; apiCall: 'musicmanPicks' | 'meganPicks' | 'djHandsPicks' } | null {
  if (id === 'musicman-picks')   return { kind: 'mm',     storageKey: 'musicman-picks', apiCall: 'musicmanPicks' }
  if (id === 'megan-picks')      return { kind: 'megan',  storageKey: 'megan-picks',    apiCall: 'meganPicks' }
  if (id === 'dj-hands-picks')   return { kind: 'djhands',storageKey: 'dj-hands-picks', apiCall: 'djHandsPicks' }
  return null
}

const MUSICMAN_PICKS_UI_KEY = 'musicmanPicks'

function isSameCalendarDay(isoDate: string): boolean {
  const savedDate = new Date(isoDate)
  if (Number.isNaN(savedDate.getTime())) return false
  const now = new Date()
  return (
    savedDate.getFullYear() === now.getFullYear() &&
    savedDate.getMonth() === now.getMonth() &&
    savedDate.getDate() === now.getDate()
  )
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
  // 4.5: Power-rankings column — only surfaced for the Top 25 playlist
  // (filtered out below for other smart playlists). Shows current rank +
  // last-week rank in parens + a green up / red down / neutral dash
  // arrow. LW data is taken from a weekly-rotated snapshot in ui-state.
  { key: 'rank', label: '#', defaultWidth: 80, minWidth: 60, resizable: false },
  { key: 'title', label: 'Name', defaultWidth: 220, minWidth: 80, resizable: true },
  { key: 'time', label: 'Time', defaultWidth: 50, minWidth: 40, resizable: true },
  { key: 'artist', label: 'Artist', defaultWidth: 160, minWidth: 60, resizable: true },
  { key: 'album', label: 'Album', defaultWidth: 160, minWidth: 60, resizable: true },
  { key: 'genre', label: 'Genre', defaultWidth: 100, minWidth: 50, resizable: true },
  { key: 'year', label: 'Year', defaultWidth: 50, minWidth: 35, resizable: true },
  { key: 'dateAdded', label: 'Date Added', defaultWidth: 100, minWidth: 60, resizable: true },
  { key: 'playCount', label: 'Plays', defaultWidth: 50, minWidth: 35, resizable: true },
  // 4.5: 'rating' column REMOVED — star renders inline next to title.
]

const ALWAYS_VISIBLE = new Set(['playing', 'title'])

export default function SmartPlaylistView() {
  const { state: libState, dispatch } = useLibrary()
  const { state: pbState, dispatch: pbDispatch } = usePlayback()
  const { playTrack } = useAudio()

  const playlistId = libState.activeSmartPlaylist
  const title = playlistId ? TITLES[playlistId] || playlistId : ''

  // 4.2.18: per-persona weekly picks state. Both Music Man and Megan
  // get their own 25-track rotation that resets every Friday at 00:00.
  // Cache is keyed per persona so flipping between the two doesn't
  // invalidate or overwrite either set.
  const picksConfig = picksConfigForId(playlistId)

  // Per-persona picks state. Persisted via main's ui-state IPC, not
  // renderer localStorage (CLAUDE.md ban; localStorage is unreliable in
  // Electron). All three personas hydrate from a single ui-state read
  // in the load effect below. Initialized to null; the load effect
  // populates them async, and the save effects are gated on
  // picksStateLoaded so they can't fire before hydration and clobber
  // persisted state with null defaults.
  const [mmPicks, setMmPicks]             = useState<PicksData | null>(null)
  const [meganPicks, setMeganPicks]       = useState<PicksData | null>(null)
  const [djHandsPicks, setDjHandsPicks]   = useState<PicksData | null>(null)
  const [picksStateLoaded, setPicksStateLoaded] = useState(false)
  const picks =
    picksConfig?.kind === 'megan'   ? meganPicks :
    picksConfig?.kind === 'djhands' ? djHandsPicks :
    picksConfig?.kind === 'mm'      ? mmPicks :
    null
  const setPicks =
    picksConfig?.kind === 'megan'   ? setMeganPicks :
    picksConfig?.kind === 'djhands' ? setDjHandsPicks :
    setMmPicks

  const [picksLoading, setPicksLoading] = useState(false)
  // Track per-persona "have we already kicked off generation this session"
  // so re-renders don't re-fire the IPC. Reset on persona change. The
  // hydration effect below sets these true for any persona with a
  // fresh-enough cached set, so generation is skipped on mount.
  const mmRequestedRef      = useRef(false)
  const meganRequestedRef   = useRef(false)
  const djHandsRequestedRef = useRef(false)
  const requestedRef =
    picksConfig?.kind === 'megan'   ? meganRequestedRef :
    picksConfig?.kind === 'djhands' ? djHandsRequestedRef :
    mmRequestedRef
  // 4.4.48: set true by the Regenerate button so the next generation
  // pass tells main to bypass its weekly cache (a true fresh pull).
  const forcePicksRef = useRef(false)

  // Hydrate all three persona picks from ui-state on mount. One IPC read,
  // three persona slots. Per-persona staleness check is the same weekly
  // Friday-to-Friday window plus the 4.4.48 schema-version stamp the file
  // already uses.
  useEffect(() => {
    let cancelled = false
    window.electronAPI.loadUiState().then((r) => {
      if (cancelled || !r.ok || !r.state) return
      const state = r.state as Record<string, unknown>
      const tryHydrate = (
        key: string,
        setter: (p: PicksData) => void,
        reqRef: React.MutableRefObject<boolean>,
      ) => {
        const raw = state[key]
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
        const saved = raw as PicksData
        if (saved.v !== PICKS_SCHEMA_V) return
        if (
          typeof saved.name !== 'string' ||
          typeof saved.commentary !== 'string' ||
          !Array.isArray(saved.trackIds) ||
          typeof saved.date !== 'string'
        ) return
        if (!saved.trackIds.every((id) => typeof id === 'number')) return
        const savedWeek = getWeekStartFriday(new Date(saved.date)).getTime()
        const currentWeek = getWeekStartFriday(new Date()).getTime()
        if (savedWeek !== currentWeek) return
        setter(saved)
        reqRef.current = true
      }
      tryHydrate('musicman-picks', setMmPicks, mmRequestedRef)
      tryHydrate('megan-picks', setMeganPicks, meganRequestedRef)
      tryHydrate('dj-hands-picks', setDjHandsPicks, djHandsRequestedRef)
    }).catch(() => {
      // Non-fatal — picks regenerate for this session.
    }).finally(() => {
      if (!cancelled) setPicksStateLoaded(true)
    })
    return () => { cancelled = true }
  }, [])

  // Persist each persona's picks to ui-state when they change. Each save
  // effect is gated by picksStateLoaded so the save can't fire before
  // hydration completes and clobber persisted state with null defaults.
  useEffect(() => {
    if (!picksStateLoaded || !mmPicks) return
    let cancelled = false
    window.electronAPI.loadUiState().then((r) => {
      if (cancelled) return
      const existing = (r.ok && r.state) ? r.state : {}
      window.electronAPI.saveUiState({ ...existing, 'musicman-picks': mmPicks })
    }).catch(() => {})
    return () => { cancelled = true }
  }, [mmPicks, picksStateLoaded])
  useEffect(() => {
    if (!picksStateLoaded || !meganPicks) return
    let cancelled = false
    window.electronAPI.loadUiState().then((r) => {
      if (cancelled) return
      const existing = (r.ok && r.state) ? r.state : {}
      window.electronAPI.saveUiState({ ...existing, 'megan-picks': meganPicks })
    }).catch(() => {})
    return () => { cancelled = true }
  }, [meganPicks, picksStateLoaded])
  useEffect(() => {
    if (!picksStateLoaded || !djHandsPicks) return
    let cancelled = false
    window.electronAPI.loadUiState().then((r) => {
      if (cancelled) return
      const existing = (r.ok && r.state) ? r.state : {}
      window.electronAPI.saveUiState({ ...existing, 'dj-hands-picks': djHandsPicks })
    }).catch(() => {})
    return () => { cancelled = true }
  }, [djHandsPicks, picksStateLoaded])

  // Generate this persona's picks if we don't have a fresh cached set.
  useEffect(() => {
    if (!picksStateLoaded) return
    if (!picksConfig || libState.tracks.length === 0) return
    if (picks || requestedRef.current) return

    requestedRef.current = true
    setPicksLoading(true)
    const compactTracks = libState.tracks.map(t => ({
      id: t.id, title: t.title, artist: t.artist,
      album: t.album, genre: t.genre, year: t.year
    }))
    // 4.4.48: consume the force flag set by the Regenerate button. main
    // bypasses its weekly cache when force is true; otherwise it returns
    // this week's cached set (no Claude call) — that's the "stop
    // resetting" fix on the renderer side.
    const force = forcePicksRef.current
    forcePicksRef.current = false
    const apiCall = window.electronAPI[picksConfig.apiCall]
    apiCall(compactTracks, force).then((result) => {
      if (result.ok && result.trackIds) {
        const fallbackName =
          picksConfig.kind === 'megan'   ? "Megan's Picks" :
          picksConfig.kind === 'djhands' ? "DJ Stephen Hands Picks" :
          "This Week's Picks"
        setPicks({
          name: result.name || fallbackName,
          commentary: result.commentary || '',
          trackIds: result.trackIds,
          date: new Date().toISOString(),
          v: PICKS_SCHEMA_V,
        })
      }
      setPicksLoading(false)
    }).catch(() => {
      setPicksLoading(false)
    })
  // picksConfig + setPicks + requestedRef are all derived from playlistId, so
  // playlistId in the dep list is sufficient — adding the others would re-run
  // on every render since they're freshly computed each pass.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playlistId, libState.tracks, picks, picksStateLoaded])

  // 4.5: Top 25 windowing. Declared here (BEFORE smartTracks) because
  // smartTracks's memo reads topWindow to apply the date filter. The
  // load/save effects + segmented control are further down.
  type TopWindow = 'all' | 'month' | 'week'
  const [topWindow, setTopWindow] = useState<TopWindow>('all')
  // 4.5.0-82 — true windowed play counts from the per-play event log.
  // Fetched whenever the user picks Week or Month on Top 25; replaces
  // the old "rank by lifetime playCount" approximation. Empty for All
  // Time (which already uses track.playCount correctly).
  const [windowedCounts, setWindowedCounts] = useState<Record<string, number>>({})
  useEffect(() => {
    if (playlistId !== 'top-25' || topWindow === 'all') {
      setWindowedCounts({})
      return
    }
    const ms = topWindow === 'week' ? 7 * 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000
    let cancelled = false
    window.electronAPI.getWindowedPlayCounts?.(ms).then(r => {
      if (!cancelled && r?.ok) setWindowedCounts(r.counts || {})
    }).catch(() => { /* keep last value */ })
    return () => { cancelled = true }
  }, [playlistId, topWindow])
  // 4.5: Starred playlist default sort. true = oldest first (reversed),
  // false = recent first (default). Toggled by a button in the playlist
  // header, only visible on the Starred view. Only applies when the
  // user hasn't picked an explicit sort column.
  const [starredReversed, setStarredReversed] = useState(false)

  const smartTracks = useMemo(() => {
    if (!playlistId) return []

    // 4.4.46: the four built-in smart playlists are now evaluated by
    // the SHARED `evaluateSmartPlaylist` (src/renderer/utils/smartPlaylists.ts)
    // — the exact same function the iPod-sync path uses. Before this,
    // this view and the sync path had divergent copies (different
    // counts; Recently Played wasn't synced at all). One definition,
    // two consumers — they can't drift again.
    //
    // Recently Played is now `Track.lastPlayedAt`-backed (persistent,
    // survives restarts, syncs to the iPod) rather than the old
    // in-memory `pbState.recentlyPlayed` session list.
    if (
      playlistId === 'musicman-picks' ||
      playlistId === 'megan-picks' ||
      playlistId === 'dj-hands-picks'
    ) {
      // AI picks need the async-fetched `picks` payload — not part of
      // the shared evaluator (which is pure over the library).
      if (!picks) return []
      const trackMap = new Map(libState.tracks.map(t => [t.id, t]))
      return picks.trackIds
        .map(id => trackMap.get(id))
        .filter((t): t is Track => t !== undefined)
    }
    // 4.5.0-82 — TRUE windowed Top 25. Pre-fix this filtered by
    // lastPlayedAt-in-window but RANKED by lifetime playCount — so a
    // track played 500 times two years ago and once last week
    // dominated "Last Week" with 500. Now ranks by play events within
    // the window from the per-play log (main: get-windowed-play-counts).
    // Falls back to the old approximation only when the windowedCounts
    // map is empty (first launch before any plays have been logged
    // post-upgrade — the log is forward-only). Tracks not in the log
    // for the window get filtered out entirely; tracks WITH events get
    // ranked by their actual in-window count.
    if (playlistId === 'top-25' && topWindow !== 'all') {
      const WINDOW_MS = topWindow === 'week' ? 7 * 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000
      const trackById = new Map(libState.tracks.map(t => [t.id, t]))
      const haveAnyEvents = Object.keys(windowedCounts).length > 0
      if (haveAnyEvents) {
        return Object.entries(windowedCounts)
          .map(([id, cnt]) => ({ track: trackById.get(Number(id)), cnt }))
          .filter((x): x is { track: Track; cnt: number } => x.track !== undefined && x.cnt > 0)
          .sort((a, b) => b.cnt - a.cnt)
          .slice(0, 25)
          .map(x => x.track)
      }
      // Fallback for the first-launch window where no events have
      // been logged yet (log starts empty post-upgrade and fills as
      // tracks play). Same shape as the old approximation.
      const cutoff = Date.now() - WINDOW_MS
      return libState.tracks
        .filter(t => typeof t.lastPlayedAt === 'number' && t.lastPlayedAt >= cutoff)
        .sort((a, b) => (b.playCount || 0) - (a.playCount || 0))
        .slice(0, 25)
    }
    return evaluateSmartPlaylist(playlistId, libState.tracks)
  }, [playlistId, libState.tracks, picks, topWindow, windowedCounts])

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
  // Default hidden set varies by playlist — Recently Added obviously
  // wants dateAdded visible; Top 25 wants playCount visible; etc.
  // Rating stays visible everywhere so ratings can be edited from any
  // smart playlist.
  const defaultHidden = useMemo(() => {
    switch (playlistId) {
      case 'recently-added':  return new Set(['playCount'])             // show dateAdded
      case 'recently-played': return new Set(['dateAdded', 'playCount']) // recency-driven; both noisy
      case 'top-25':          return new Set(['dateAdded'])              // playCount drives the list, keep it visible
      case 'top-rated':       return new Set(['dateAdded', 'playCount']) // Starred is binary; counts add noise
      default:                return new Set(['dateAdded', 'playCount']) // picks views — meta-light
    }
  }, [playlistId])
  const [hiddenCols, setHiddenCols] = useState<Set<string>>(defaultHidden)
  // When the user switches between smart playlists, reset hiddenCols
  // to that playlist's defaults — otherwise carrying over the previous
  // playlist's hide-set means each view doesn't get the right columns.
  useEffect(() => { setHiddenCols(defaultHidden) }, [defaultHidden])
  const [headerCtxMenu, setHeaderCtxMenu] = useState<{ x: number; y: number } | null>(null)

  // 4.5: Top 25 windowing — see the topWindow state declared above
  // smartTracks. The load/save effects + segmented control live here
  // (below smartTracks) so the initial render uses the persisted value.
  useEffect(() => {
    if (playlistId !== 'top-25') return
    let cancelled = false
    window.electronAPI.loadUiState().then(r => {
      if (cancelled || !r.ok || !r.state) return
      const w = (r.state as Record<string, unknown>).topWindow
      if (w === 'all' || w === 'month' || w === 'week') setTopWindow(w)
    })
    return () => { cancelled = true }
  }, [playlistId])
  const setTopWindowAndSave = useCallback((w: TopWindow) => {
    setTopWindow(w)
    window.electronAPI.loadUiState().then(r => {
      const existing = (r.ok && r.state) ? (r.state as Record<string, unknown>) : {}
      window.electronAPI.saveUiState({ ...existing, topWindow: w })
    })
  }, [])

  const visibleCols = ALL_COLUMN_DEFS.filter(c => {
    if (hiddenCols.has(c.key)) return false
    // Rank column shows on every Top 25 view; the LW arrow inside it
    // only renders for All Time (week/month don't have a meaningful
    // week-over-week snapshot). Number always present so the user
    // sees positions 1 -> 25.
    if (c.key === 'rank' && playlistId !== 'top-25') return false
    return true
  })

  // 4.5: Top-25 last-week snapshot. Rotates weekly: when we detect a new
  // ISO week, promote the in-flight `curr` snapshot to `prev` and capture
  // current ranks as the new `curr`. Display reads `prev` for the "(LW)"
  // value + delta arrow. First-ever load has prev=null → every track
  // shows as NEW; subsequent weeks show real movement.
  type RankSnap = { weekKey: number; prev: Record<string, number> | null; curr: Record<string, number> }
  const [rankSnap, setRankSnap] = useState<RankSnap | null>(null)
  useEffect(() => {
    if (playlistId !== 'top-25') return
    // Snapshot only the All Time view — week / month variants are
    // recent-listening lenses, not power-rankings inputs.
    if (topWindow !== 'all') return
    if (smartTracks.length === 0) return
    const WEEK_MS = 7 * 24 * 60 * 60 * 1000
    const currentWeek = Math.floor(Date.now() / WEEK_MS)
    const currentRanks: Record<string, number> = {}
    smartTracks.forEach((t, i) => { currentRanks[String(t.id)] = i + 1 })

    let cancelled = false
    window.electronAPI.loadUiState().then(r => {
      if (cancelled) return
      const existing = (r.ok && r.state) ? (r.state as Record<string, unknown>) : {}
      const saved = existing.topRankSnapshot as RankSnap | undefined

      let next: RankSnap
      if (!saved || typeof saved.weekKey !== 'number') {
        // First-ever snapshot — no LW data yet.
        next = { weekKey: currentWeek, prev: null, curr: currentRanks }
      } else if (saved.weekKey === currentWeek) {
        // Same week as the saved snapshot — keep prev as-is, refresh
        // curr to current ranks (plays may have shifted intra-week,
        // but we don't rotate prev until next week).
        next = { weekKey: currentWeek, prev: saved.prev, curr: currentRanks }
      } else {
        // Week rolled over — promote saved.curr to prev, set curr to
        // current. THIS is the moment the user gets fresh LW deltas.
        next = { weekKey: currentWeek, prev: saved.curr, curr: currentRanks }
      }
      setRankSnap(next)
      // Persist only if anything actually changed; avoid pointless writes.
      const isSame = saved && saved.weekKey === next.weekKey
        && JSON.stringify(saved.curr) === JSON.stringify(next.curr)
        && JSON.stringify(saved.prev) === JSON.stringify(next.prev)
      if (!isSame) {
        window.electronAPI.saveUiState({ ...existing, topRankSnapshot: next })
      }
    })
    return () => { cancelled = true }
  }, [playlistId, smartTracks, topWindow])

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

  // 4.5: column-resize sort-suppression. handleColResize stamps
  // lastResizeEndAt on mouseup; handleSort ignores clicks within the
  // suppression window so a resize drag doesn't also re-sort.
  const lastResizeEndAt = useRef<number>(0)
  const handleSort = useCallback((key: string) => {
    if (Date.now() - lastResizeEndAt.current < 300) return
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
    // 4.5: Starred playlist defaults to starredAt sort — recent star
    // on top, oldest at bottom. Reverse toggle in the header flips it.
    // Only applies when user hasn't picked an explicit column header
    // (clicking a column escapes back into the generic sort path).
    if (playlistId === 'top-rated' && !sortCol) {
      return [...filteredTracks].sort((a, b) => {
        const av = a.starredAt || 0
        const bv = b.starredAt || 0
        const cmp = av < bv ? -1 : av > bv ? 1 : 0
        return starredReversed ? cmp : -cmp
      })
    }
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
  }, [filteredTracks, sortCol, sortDir, playlistId, starredReversed])

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
      lastResizeEndAt.current = Date.now()
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

  // Tear down any in-flight commentary speech on unmount so navigating
  // away doesn't leave it playing or leak its source node into the
  // Web-Audio broadcast graph (4.4.6 rattle class). Mirrors the
  // detach → pause → null cleanup the toggle-off branch uses.
  useEffect(() => () => {
    if (audioRef.current) {
      detachClipFromBroadcast(audioRef.current)
      audioRef.current.pause()
      audioRef.current = null
      window.dispatchEvent(new Event('musicman-speaking-end'))
    }
  }, [])

  // Reset saved state when picks change
  useEffect(() => { setPicksSaved(false) }, [picks])

  // Auto-follow now-playing on track change (4.0). Skipped if user
  // scrolled in last 5s.
  useEffect(() => {
    if (libState.currentView !== 'smart-playlist') return
    if (!pbState.nowPlaying) return
    if (Date.now() - lastUserActivityAtRef.current < FOLLOW_IDLE_MS) return
    const idx = sortedTracks.findIndex(t => t.id === pbState.nowPlaying!.id)
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
  }, [pbState.nowPlaying?.id, libState.currentView, sortedTracks])

  const speakCommentary = useCallback(async () => {
    if (!picks?.commentary) return
    if (speaking && audioRef.current) {
      detachClipFromBroadcast(audioRef.current)
      audioRef.current.pause()
      audioRef.current = null
      setSpeaking(false)
      window.dispatchEvent(new Event('musicman-speaking-end'))
      return
    }
    setSpeaking(true)
    // Route each persona's commentary to their voice. MM picks use the
    // default voice (server-side pulls MUSIC_MAN_CORE's voice).
    const MEGAN_VOICE_ID = 'T7eLpgAAhoXHlrNajG8v'
    const DJ_HANDS_VOICE_ID = 'ApBE43wHy5MiZGz9ihqB'
    const voiceId =
      picksConfig?.kind === 'megan'   ? MEGAN_VOICE_ID :
      picksConfig?.kind === 'djhands' ? DJ_HANDS_VOICE_ID :
      undefined
    try {
      const tts = await window.electronAPI.musicmanSpeak(picks.commentary, false, voiceId)
      if (tts.ok && tts.audio) {
        window.dispatchEvent(new Event('musicman-speaking-start'))
        await new Promise<void>(resolve => {
          // The fade handler over in Toolbar fires `musicman-fade-ready`
          // once the volume duck is in place; we then start playback. Wrap
          // the resolver in an EventListener-shaped function so the DOM
          // typings accept it (resolve takes `value`, listeners take `Event`).
          const listener: EventListener = () => resolve()
          window.addEventListener('musicman-fade-ready', listener, { once: true })
          setTimeout(() => resolve(), 2000)
        })
        const audio = new Audio(`data:audio/mpeg;base64,${tts.audio}`)
        attachClipToBroadcast(audio)
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
    } catch {
      // A rejected musicmanSpeak left `speaking` stuck true (dead button)
      // before this guard — clear the flag and undo the speaking state.
      setSpeaking(false)
      window.dispatchEvent(new Event('musicman-speaking-end'))
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

  // Auto-follow now-playing (4.0). Mirrors the SongsView pattern:
  // when the playing track changes and the user has been idle for >5s,
  // scroll the now-playing row into view. Programmatic scrolls don't
  // count as user activity (200ms grace window after our scrollTop write).
  const songsBodyRef = useRef<HTMLDivElement | null>(null)
  // 4.4.13: per-smart-playlist scroll persistence within the session.
  useScrollPersistence(`smart-playlist:${libState.activeSmartPlaylist}`, songsBodyRef)
  const lastUserActivityAtRef = useRef<number>(0)
  const isAutoScrollAtRef = useRef<number>(0)
  const FOLLOW_IDLE_MS = 5000

  const handleScroll = useCallback(() => {
    if (Date.now() - isAutoScrollAtRef.current > 200) {
      lastUserActivityAtRef.current = Date.now()
    }
  }, [])

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
      { label: `Play`, onClick: () => playTrack(track, sortedTracks, idx, undefined, true) },
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
      // 4.4.12: surface failure (usually sips conversion) so the user
      // doesn't think the art stuck just because the Get Info preview
      // still shows it from localArtHash.
      setNotice(result.error ? `Couldn't save artwork: ${result.error}` : "Couldn't save artwork.", { kind: 'error' })
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

  const isPicksView = picksConfig !== null
  const displayName = isPicksView && picks?.name ? picks.name : title
  const loadingLabel =
    picksConfig?.kind === 'megan'   ? 'Megan is picking tracks…' :
    picksConfig?.kind === 'djhands' ? 'DJ Stephen Hands is picking tracks…' :
    'The Music Man is picking tracks…'

  return (
    <div className="playlist-view">
      <div className="playlist-view-header">
        <div>
          <h2 className="playlist-view-name">{displayName}</h2>
          <div className="playlist-view-meta">
            {isPicksView && picksLoading ? loadingLabel : (
              <>
                {sortedTracks.length} {sortedTracks.length === 1 ? 'song' : 'songs'}, {timeStr}
                {playlistId === 'recently-played' && sortedTracks.length === 0 && ' — play some music!'}
              </>
            )}
          </div>
          {/* 4.5: Top 25 window switcher — keeps the sidebar clean
              (one entry) while giving Jake last-week / last-month /
              all-time lenses without a separate playlist per window. */}
          {playlistId === 'top-25' && (
            <div className="top25-window-switch" role="tablist" aria-label="Top 25 window">
              {([
                ['all',   'All Time'],
                ['month', 'Last Month'],
                ['week',  'Last Week'],
              ] as const).map(([w, label]) => (
                <button
                  key={w}
                  role="tab"
                  aria-selected={topWindow === w}
                  className={`top25-window-btn ${topWindow === w ? 'top25-window-btn--active' : ''}`}
                  onClick={() => setTopWindowAndSave(w)}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          {/* 4.5: Starred reverse-order toggle. Default = recent first.
              Click to flip to oldest first. Only renders on the Starred
              playlist and only when the user hasn't picked an explicit
              column sort (which would override anyway). */}
          {playlistId === 'top-rated' && !sortCol && (
            <div className="top25-window-switch" role="group" aria-label="Starred sort order">
              <button
                className={`top25-window-btn ${!starredReversed ? 'top25-window-btn--active' : ''}`}
                onClick={() => setStarredReversed(false)}
                title="Most recently starred at the top"
              >
                Recent
              </button>
              <button
                className={`top25-window-btn ${starredReversed ? 'top25-window-btn--active' : ''}`}
                onClick={() => setStarredReversed(true)}
                title="Oldest starred at the top"
              >
                Oldest
              </button>
            </div>
          )}
        </div>
        <div className="playlist-view-actions">
          {isPicksView && (
            <button
              className="playlist-view-save"
              onClick={() => {
                // 4.4.2: force a fresh pull. Clears the cached picks
                // and the per-persona "have we already requested?"
                // flag so the generation effect re-fires immediately.
                // 4.4.48: also set forcePicksRef so the effect tells
                // main to bypass BOTH the renderer cache AND main's
                // weekly cache — a true fresh rotation, not a re-read.
                forcePicksRef.current = true
                if (picksConfig?.kind === 'mm')      { setMmPicks(null);     mmRequestedRef.current = false }
                if (picksConfig?.kind === 'megan')   { setMeganPicks(null);  meganRequestedRef.current = false }
                if (picksConfig?.kind === 'djhands') { setDjHandsPicks(null);djHandsRequestedRef.current = false }
                setPicksLoading(true)
              }}
              disabled={picksLoading}
              title="Force a fresh rotation now (overrides the weekly cache)"
            >
              {picksLoading ? '…' : '↻ Regenerate'}
            </button>
          )}
          {isPicksView && picks && (
            <button
              className="playlist-view-save"
              onClick={savePicks}
              disabled={picksSaved}
            >
              {picksSaved ? 'Saved' : 'Save'}
            </button>
          )}
          {sortedTracks.length > 0 && (
            <button
              className="playlist-view-play"
              onClick={() => playTrack(sortedTracks[0], sortedTracks, 0, undefined, true)}
            >
              Play All
            </button>
          )}
        </div>
      </div>
      {isPicksView && picks?.commentary && (
        <div className={`playlist-view-commentary playlist-view-commentary--${picksConfig?.kind === 'megan' ? 'megan' : picksConfig?.kind === 'djhands' ? 'djhands' : 'musicman'}`}>
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
      {/* Brief 026: wrap .songs-header + .songs-body in a .songs-view
          flex column so the CSS that gives them a shared horizontal
          scroll context applies here too. SongsView and PlaylistView
          already had this wrapper; SmartPlaylistView was the outlier
          rendering both as direct children of .playlist-view, which
          left header column labels desynced from row cells under
          horizontal scroll. Same { flex: 1, minHeight: 0 } sizing as
          PlaylistView's existing wrapper at line 533. */}
      <div className="songs-view" style={{ flex: 1, minHeight: 0 }}>
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
      <div className="songs-body" ref={songsBodyRef} onScroll={handleScroll}>
        {sortedTracks.map((track, i) => {
          const isPlaying = pbState.nowPlaying?.id === track.id
          const isSelected = selectedIds.has(track.id)
          return (
            <div
              key={`${track.id}-${i}`}
              className={`songs-row ${i % 2 ? 'songs-row--alt' : ''} ${isPlaying ? 'songs-row--playing' : ''} ${isSelected ? 'songs-row--selected' : ''}`}
              style={{ gridTemplateColumns: gridTemplate }}
              onClick={(e) => handleClick(track, i, e)}
              onDoubleClick={() => playTrack(track, sortedTracks, i, undefined, true)}
              onMouseEnter={() => prefetchTrackForPlay(track)}
              onMouseDown={() => prefetchTrackImmediate(track)}
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
                  case 'rank': {
                    const rank = i + 1
                    // LW arrow + delta only on All Time (the snapshot
                    // is keyed to all-time ranks). Week/month views
                    // get the rank number alone — still meaningful as
                    // "position 1 through 25 within this lens."
                    if (topWindow !== 'all') {
                      return (
                        <div key={col.key} className="songs-cell songs-cell--rank">
                          <span className="rank-num">{rank}</span>
                        </div>
                      )
                    }
                    const lwRank = rankSnap?.prev?.[String(track.id)]
                    let arrow = ''
                    let arrowClass = 'rank-arrow rank-arrow--same'
                    let lwLabel = ''
                    if (lwRank === undefined) {
                      arrow = 'NEW'
                      arrowClass = 'rank-arrow rank-arrow--new'
                    } else if (rank < lwRank) {
                      arrow = `▲${lwRank - rank}`
                      arrowClass = 'rank-arrow rank-arrow--up'
                      lwLabel = `(${lwRank})`
                    } else if (rank > lwRank) {
                      arrow = `▼${rank - lwRank}`
                      arrowClass = 'rank-arrow rank-arrow--down'
                      lwLabel = `(${lwRank})`
                    } else {
                      arrow = '—'
                      arrowClass = 'rank-arrow rank-arrow--same'
                      lwLabel = `(${lwRank})`
                    }
                    return (
                      <div key={col.key} className="songs-cell songs-cell--rank">
                        <span className="rank-num">{rank}</span>
                        {lwLabel && <span className="rank-lw">{lwLabel}</span>}
                        <span className={arrowClass}>{arrow}</span>
                      </div>
                    )
                  }
                  case 'title': {
                    const starred = (Number(track.rating) || 0) > 0
                    const toggleStar = (e: React.MouseEvent) => {
                      e.stopPropagation()
                      const value = String(starred ? 0 : 5)
                      dispatch({ type: 'UPDATE_TRACKS', updates: [{ id: track.id, field: 'rating', value }] })
                      window.electronAPI.saveMetadataOverride(track.id, 'rating', value)
                      // 4.5: stamp starredAt on star-ON for recent-first sort.
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
                  case 'year':
                    return <div key={col.key} className="songs-cell">{track.year || ''}</div>
                  case 'dateAdded': {
                    const da = track.dateAdded || ''
                    const dp = da.length > 10 ? da.substring(0, 10) : da
                    const [y, mo, dy] = dp.split('-')
                    return <div key={col.key} className="songs-cell">{dp ? `${mo}-${dy}-${y}` : ''}</div>
                  }
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
      </div> {/* Brief 026: close the wrapping .songs-view div opened above the .songs-header */}
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
