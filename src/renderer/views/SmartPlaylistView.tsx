import { LARRY_VOICE_ID } from '../../common/cohost'
import { useMemo, useState, useEffect, useRef, useCallback } from 'react'
import { audioFromBase64Mpeg } from '../audio/base64-audio'
import { useLibrary } from '../context/LibraryContext'
import { useAudio } from '../hooks/useAudio'
import { attachClipToBroadcast, detachClipFromBroadcast } from '../audio/eq'
import { evaluateSmartPlaylist, SMART_PLAYLIST_TITLES as TITLES } from '../utils/smartPlaylists'
import { smartPlaylistCover } from '../utils/playlistCovers'
import { useListenMoreWeekly } from '../listenMoreWeekly'
import { useTop1000List, useTop1000Movement, useTop1000Ranks } from '../top1000List'
import { compactMovement, isRankedPlaylist, rankMovement, rotateRankSnap, TOP_1000_RANK_COLUMN_WIDTH, weekKeyOf, RANK_SNAPSHOT_KEYS, type RankSnap } from '../../common/rank-movement'
import { useIpodLists, entryColor, renameIpodList, setIpodListHeadline, useIpodListsRole } from '../ipodLists'
import { useTop1000Name, renameTop1000 } from '../top1000Name'
import ListRenameField from '../components/ListRenameField'
import { useIpodPlaylistCover, useIpodPlaylistLook } from '../utils/ipodCovers'
import { IpodAd } from '../components/IpodAd'
import { useTop1000Headline, useTop1000Counts, useTop1000Story, setTop1000Headline } from '../top1000Headline'
import { adCopy, adCounts, adHeadline, adLegal, checkHeadline, countArtists, HEADLINE_MAX } from '../../common/ipod-ad'
import { usePeriodPlaylistCover } from '../utils/periodCovers'
import { IpodColorPicker } from '../components/IpodColorPicker'
import { chooseIpodPhoto, backToIpodDrawing, useIpodPhotoCover } from '../ipodPhotoCovers'
import { photoKeyForPlaylist } from '../../common/ipod-photo-covers'
import { parseIpodListPlaylistId } from '../../common/ipod-list-doc'
import IpodProposalsPanel from '../components/IpodProposalsPanel'
import EventCoverPanel from '../components/EventCoverPanel'
import { useHomeShelves } from '../homeShelves'
import { useRegularLibraryTracks } from '../hooks/useRegularLibraryTracks'
import { useReleaseMonths } from '../releaseMonths'
import { monthPlaylistName, monthTrackIds, parseMonthPlaylistId } from '../../common/release-months'
import { isTop25Rankable } from '../../common/top25-rankable'
import { usePlaysElsewhere, useTracksEverywhere } from '../playsElsewhere'
import { Track, type SmartPlaylistId } from '../types'
import { SpeakerPlayingIcon } from '../assets/icons/SpeakerIcon'
import { canonicalArtist } from '../utils/artistAlias'
import TrackGridView from '../components/TrackGridView'
import CoverFlowView from './CoverFlowView'
import { useViewMode } from '../context/ViewModeContext'
import { setNotice } from '../activity'
import '../styles/musicman.css'
import '../styles/songs.css'
import SongTable, { type SongTableLead } from '../components/SongTable'
import { useListSort } from '../hooks/useListSort'
import { filterSongs, sortSongs } from '../utils/songTableRules'

// Titles: SMART_PLAYLIST_TITLES (utils/smartPlaylists.ts) — one map for this
// page's heading and the back pill's name for it.

export interface PicksData {
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
export const PICKS_SCHEMA_V = 2

// 4.2.18: Picks are weekly now, Friday-to-Friday. Returns the most
// recent Friday at midnight local — same value for any time within the
// same Fri→Thu window, so equality on this value tells us "still in
// the same week's picks." Roll-over fires automatically when the user
// opens picks after Friday 00:00.
export function getWeekStartFriday(d: Date): Date {
  const result = new Date(d)
  const day = result.getDay()  // 0=Sun, 1=Mon, ..., 5=Fri, 6=Sat
  const daysSinceFriday = (day - 5 + 7) % 7
  result.setDate(result.getDate() - daysSinceFriday)
  result.setHours(0, 0, 0, 0)
  return result
}

// Pick which persona's picks the current view should use, plus the
// localStorage key to use. One key per persona so MM and Larry picks
// don't overwrite each other.
type PicksKind = 'mm' | 'larry' | 'djhands'
function picksConfigForId(id: string | null): { kind: PicksKind; storageKey: string; apiCall: 'musicmanPicks' | 'larryPicks' | 'djHandsPicks' } | null {
  if (id === 'musicman-picks')   return { kind: 'mm',     storageKey: 'musicman-picks', apiCall: 'musicmanPicks' }
  if (id === 'larry-picks')      return { kind: 'larry',  storageKey: 'larry-picks',    apiCall: 'larryPicks' }
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


export default function SmartPlaylistView() {
  const { state: libState, dispatch } = useLibrary()
  // 2026-10-20 — the phone's and workmini's plays count here too. Ranking reads
  // `everywhere`; rows stay the library's own tracks (display only, never saved).
  const elsewhere = usePlaysElsewhere()
  const everywhere = useTracksEverywhere(libState.tracks)
  const { playTrack } = useAudio()
  const { mode: viewMode } = useViewMode()

  const playlistId = libState.activeSmartPlaylist
  const monthYm = playlistId ? parseMonthPlaylistId(playlistId) : null
  // A non-Original iPod's list (2026-11-07): named for the iPod ("iPod EVIL"), homemini's order.
  const ipodLists = useIpodLists()
  const ipodListDevice = playlistId ? parseIpodListPlaylistId(playlistId) : null
  const ipodList = ipodListDevice ? ipodLists.find((l) => l.id === ipodListDevice) ?? null : null
  const [ipodColorAt, setIpodColorAt] = useState<{ x: number; y: number } | null>(null)
  // The Top 1000 and the iPod lists can be renamed (2026-11-09): Rename… in the header and the sidebar.
  const top1000Name = useTop1000Name()
  const ipodListsRole = useIpodListsRole()
  const [renaming, setRenaming] = useState(false)
  const renamable = playlistId === 'top-1000' || ipodList !== null
  // Headline… (2026-11-14): the line at the top of an iPod's page (common/ipod-ad.ts).
  const [editingHeadline, setEditingHeadline] = useState(false)
  const top1000Headline = useTop1000Headline()
  const top1000Counts = useTop1000Counts()
  const top1000Story = useTop1000Story()
  useEffect(() => { setRenaming(false); setEditingHeadline(false) }, [playlistId])
  // Photo covers (2026-11-09): the Top 1000 and every iPod list.
  const photoKey = photoKeyForPlaylist(playlistId)
  const ipodPhoto = useIpodPhotoCover(playlistId)
  const hasPhoto = ipodPhoto !== null
  const title = playlistId === 'top-1000' ? top1000Name : playlistId ? TITLES[playlistId] || (monthYm ? monthPlaylistName(monthYm) : ipodList ? ipodList.name : playlistId) : ''

  // 4.2.18: per-persona weekly picks state. Both Music Man and Larry
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
  const [larryPicks, setLarryPicks]       = useState<PicksData | null>(null)
  const [djHandsPicks, setDjHandsPicks]   = useState<PicksData | null>(null)
  const [picksStateLoaded, setPicksStateLoaded] = useState(false)
  const picks =
    picksConfig?.kind === 'larry'   ? larryPicks :
    picksConfig?.kind === 'djhands' ? djHandsPicks :
    picksConfig?.kind === 'mm'      ? mmPicks :
    null
  const setPicks =
    picksConfig?.kind === 'larry'   ? setLarryPicks :
    picksConfig?.kind === 'djhands' ? setDjHandsPicks :
    setMmPicks

  const [picksLoading, setPicksLoading] = useState(false)
  // Track per-persona "have we already kicked off generation this session"
  // so re-renders don't re-fire the IPC. Reset on persona change. The
  // hydration effect below sets these true for any persona with a
  // fresh-enough cached set, so generation is skipped on mount.
  const mmRequestedRef      = useRef(false)
  const larryRequestedRef   = useRef(false)
  const djHandsRequestedRef = useRef(false)
  const requestedRef =
    picksConfig?.kind === 'larry'   ? larryRequestedRef :
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
      tryHydrate('larry-picks', setLarryPicks, larryRequestedRef)
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
    }).catch(() => { setNotice("Couldn't save the Music Man's picks.", { kind: 'error', durationMs: 4000 }) })
    return () => { cancelled = true }
  }, [mmPicks, picksStateLoaded])
  useEffect(() => {
    if (!picksStateLoaded || !larryPicks) return
    let cancelled = false
    window.electronAPI.loadUiState().then((r) => {
      if (cancelled) return
      const existing = (r.ok && r.state) ? r.state : {}
      window.electronAPI.saveUiState({ ...existing, 'larry-picks': larryPicks })
    }).catch(() => { setNotice("Couldn't save Larry's Picks.", { kind: 'error', durationMs: 4000 }) })
    return () => { cancelled = true }
  }, [larryPicks, picksStateLoaded])
  useEffect(() => {
    if (!picksStateLoaded || !djHandsPicks) return
    let cancelled = false
    window.electronAPI.loadUiState().then((r) => {
      if (cancelled) return
      const existing = (r.ok && r.state) ? r.state : {}
      window.electronAPI.saveUiState({ ...existing, 'dj-hands-picks': djHandsPicks })
    }).catch(() => { setNotice("Couldn't save DJ Stephen Hands Picks.", { kind: 'error', durationMs: 4000 }) })
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
          picksConfig.kind === 'larry'   ? "Larry's Picks" :
          picksConfig.kind === 'djhands' ? "DJ Stephen Hands Picks" :
          "This Week's Picks"
        setPicks({
          name: result.name || fallbackName,
          commentary: result.commentary || '',
          trackIds: result.trackIds,
          date: new Date().toISOString(),
          v: PICKS_SCHEMA_V,
        })
      } else if (!result.ok) {
        setNotice(result.error || "Couldn't load picks.", { kind: 'error' })
      }
      setPicksLoading(false)
    }).catch((err) => {
      setNotice(String(err) || "Couldn't load picks.", { kind: 'error' })
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

  // Listen More Weekly (2026-10-20): homemini's weekly playlist — its song
  // order, resolved against this Mac's library (shared ids).
  const weekly = useListenMoreWeekly()
  // Top 1000 (2026-11-02): the quiz's ranked list from homemini, rank 1 first.
  const top1000 = useTop1000List()
  // …and each song's rank on it, for the '#' column (2026-11-07).
  const top1000Ranks = useTop1000Ranks()
  // Top 1000's weekly arrows come from homemini (published list vs last week's, same rules).
  const top1000Moves = useTop1000Movement()
  // On Repeat (2026-10-28): the Home shelves document's list — the same
  // rows the Home's ON REPEAT row draws (its head), resolved here.
  const regularTracks = useRegularLibraryTracks(libState.tracks)
  const { shelves: onRepeat } = useHomeShelves(libState.tracks, regularTracks)
  // This year's releases by month (2026-10-24): homemini's rows, in release order,
  // resolved against this Mac's library (shared ids).
  const releaseMonths = useReleaseMonths()

  const smartTracks = useMemo(() => {
    if (!playlistId) return []
    // Rank on `everywhere`, hand back the library's own track objects.
    const ownById = everywhere === libState.tracks ? null : new Map(libState.tracks.map(t => [t.id, t]))
    const own = (list: Track[]): Track[] => ownById ? list.map(t => ownById.get(t.id) ?? t) : list
    if (playlistId === 'listen-more-weekly') {
      if (!weekly) return []
      const byId = new Map(libState.tracks.map((t) => [t.id, t]))
      return weekly.trackIds.map((id) => byId.get(id)).filter((t): t is Track => t !== undefined)
    }
    if (playlistId === 'on-repeat') {
      const byId = new Map(libState.tracks.map((t) => [t.id, t]))
      return (onRepeat?.onRepeat ?? []).map((id) => byId.get(id)).filter((t): t is Track => t !== undefined)
    }
    if (monthYm) {
      const byId = new Map(libState.tracks.map((t) => [t.id, t]))
      return monthTrackIds(releaseMonths, monthYm).map((id) => byId.get(id)).filter((t): t is Track => t !== undefined)
    }
    if (ipodListDevice) {
      // A non-Original iPod's list (2026-11-07): homemini's list, newest first, resolved here.
      if (!ipodList) return []
      const byId = new Map(libState.tracks.map((t) => [t.id, t]))
      return ipodList.ids.map((id) => byId.get(id)).filter((t): t is Track => t !== undefined)
    }
    if (playlistId === 'top-1000') {
      // The Top 1000 Quiz's ranking (2026-11-02): homemini's list in rank order, resolved here.
      if (!top1000) return []
      const byId = new Map(libState.tracks.map((t) => [t.id, t]))
      return top1000.map((id) => byId.get(id)).filter((t): t is Track => t !== undefined)
    }

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
      playlistId === 'larry-picks' ||
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
          .filter((x): x is { track: Track; cnt: number } => x.track !== undefined && x.cnt > 0 && isTop25Rankable(x.track))
          .sort((a, b) => b.cnt - a.cnt)
          .slice(0, 25)
          .map(x => x.track)
      }
      // Fallback for the first-launch window where no events have
      // been logged yet (log starts empty post-upgrade and fills as
      // tracks play). Same shape as the old approximation.
      const cutoff = Date.now() - WINDOW_MS
      return own(everywhere
        .filter(t => typeof t.lastPlayedAt === 'number' && t.lastPlayedAt >= cutoff && isTop25Rankable(t))
        .sort((a, b) => (b.playCount || 0) - (a.playCount || 0))
        .slice(0, 25))
    }
    return own(evaluateSmartPlaylist(playlistId, everywhere))
  }, [playlistId, libState.tracks, everywhere, picks, topWindow, windowedCounts, weekly, onRepeat, monthYm, releaseMonths, top1000, ipodListDevice, ipodList])

  // The "This page" search — the song table's filter (utils/songTableRules.ts).
  const filteredTracks = useMemo(() => filterSongs(smartTracks, libState.searchQuery), [smartTracks, libState.searchQuery])

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

  // 4.5: last-week snapshot for the ranked playlists. Rotates weekly: when
  // we detect a new week, promote the in-flight `curr` snapshot to `prev`
  // and capture current ranks as the new `curr`. Display reads `prev` for
  // the "(LW)" value + delta arrow. First-ever load has prev=null → every
  // track shows as NEW; subsequent weeks show real movement. The rule is
  // shared (src/common/rank-movement.ts). Top 25 only since 2026-11-24: the
  // Top 1000's movement is homemini's (top1000Movement), never a local
  // snapshot, which had compared lists made by different rules.
  // Tagged with its playlist, so switching Top 25 ↔ Top 1000 never draws one
  // list's movement on the other for a frame.
  const [rankSnapFor, setRankSnapFor] = useState<{ playlistId: string; snap: RankSnap } | null>(null)
  const rankSnap = rankSnapFor && rankSnapFor.playlistId === playlistId ? rankSnapFor.snap : null
  // Current ranks by song id: Top 25's position in the list (All Time only —
  // week / month are recent-listening lenses, not power-rankings inputs);
  // Top 1000's quiz rank from homemini, every song on the list.
  const currentRanks = useMemo<Record<string, number> | null>(() => {
    if (playlistId !== 'top-25' || topWindow !== 'all' || smartTracks.length === 0) return null
    const r: Record<string, number> = {}
    smartTracks.forEach((t, i) => { r[String(t.id)] = i + 1 })
    return r
  }, [playlistId, topWindow, smartTracks])
  useEffect(() => {
    if (!isRankedPlaylist(playlistId)) return
    if (!currentRanks || Object.keys(currentRanks).length === 0) return
    const key = RANK_SNAPSHOT_KEYS[playlistId]
    const currentWeek = weekKeyOf(Date.now())
    let cancelled = false
    window.electronAPI.loadUiState().then(r => {
      if (cancelled) return
      const existing = (r.ok && r.state) ? (r.state as Record<string, unknown>) : {}
      const { next, changed } = rotateRankSnap(existing[key], currentRanks, currentWeek)
      setRankSnapFor({ playlistId, snap: next })
      // Persist only if anything actually changed; avoid pointless writes.
      if (changed) window.electronAPI.saveUiState({ ...existing, [key]: next })
    })
    return () => { cancelled = true }
  }, [playlistId, currentRanks])

  // --- The list's own order, then the column sort (null = Original Order) ---
  // 4.5: the Starred playlist's own order is starredAt — recent star on top,
  // oldest at the bottom; Recent / Oldest in the header flips it.
  const ownOrder = useMemo(() => {
    if (playlistId !== 'top-rated') return filteredTracks
    return [...filteredTracks].sort((a, b) => {
      const av = a.starredAt || 0
      const bv = b.starredAt || 0
      const cmp = av < bv ? -1 : av > bv ? 1 : 0
      return starredReversed ? cmp : -cmp
    })
  }, [filteredTracks, playlistId, starredReversed])
  // Remembered per smart playlist while the app runs.
  const [sort, setSort] = useListSort(`smart:${playlistId ?? ''}`)
  const sortedTracks = useMemo(() => sortSongs(ownOrder, sort, elsewhere), [ownOrder, sort, elsewhere])

  // The '#' of a ranked list (Top 25, Top 1000): the rank and last week's
  // movement, a column of this page's own in front of the table's. A song's
  // rank is its place in the list's own order, whatever the table is sorted by.
  const ownRank = useMemo(() => new Map(ownOrder.map((t, i) => [t.id, i + 1])), [ownOrder])
  // Memoized: the rows are, and a new lead each render would redraw them all.
  const rankLead = useMemo((): SongTableLead | undefined => {
    // Top 1000 (2026-11-25): a narrow '#' like iTunes — the rank right-aligned
    // in tabular digits, homemini's weekly movement as one small mark beside
    // it, and the speaker in that same place on the playing row (so the table
    // drops its own speaker column).
    if (playlistId === 'top-1000') return {
      label: '#',
      width: TOP_1000_RANK_COLUMN_WIDTH,
      className: 'songs-cell--rank songs-cell--rank-compact',
      headerClassName: 'songs-header-cell--rank-compact',
      showsPlaying: true,
      render: (track, _idx, playing) => {
        const rank = top1000Ranks?.[String(track.id)] ?? ownRank.get(track.id) ?? 0
        const mark = compactMovement(rank, top1000Moves.movement?.[String(track.id)], top1000Moves.comparedTo)
        return (
          // The playing row: the speaker at its own size in place of the number, as an album's
          // track list does (squeezed into the 9 px mark slot it looked wrong, 2026-11-26).
          playing
            ? <span className="rank-playing" role="img" aria-label={`Now playing, number ${rank}`} title={`Number ${rank}`}><SpeakerPlayingIcon /></span>
            : <>
                <span className="rank-mark">
                  {mark && <span className={mark.className} title={mark.title} role="img" aria-label={mark.title}>{mark.glyph}</span>}
                </span>
                <span className="rank-num">{rank}</span>
              </>
        )
      },
    }
    if (!isRankedPlaylist(playlistId)) return undefined
    return {
      label: '#',
      width: 80,
      className: 'songs-cell--rank',
      render: (track) => {
        // Top 25: its position.
        const rank = ownRank.get(track.id) ?? 0
        // LW arrow only on All Time, and only once there is a snapshot (no flash of NEW).
        if (topWindow !== 'all' || !rankSnap) return <span className="rank-num">{rank}</span>
        const { arrow, arrowClass, lwLabel } = rankMovement(rank, rankSnap.prev?.[String(track.id)])
        return (
          <>
            <span className="rank-num">{rank}</span>
            {lwLabel && <span className="rank-lw">{lwLabel}</span>}
            <span className={arrowClass}>{arrow}</span>
          </>
        )
      },
    }
  }, [playlistId, top1000Ranks, top1000Moves, ownRank, topWindow, rankSnap])

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
    const DJ_HANDS_VOICE_ID = 'ApBE43wHy5MiZGz9ihqB'
    const voiceId =
      picksConfig?.kind === 'larry'   ? LARRY_VOICE_ID :
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
        const audio = audioFromBase64Mpeg(tts.audio)
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

  const isPicksView = picksConfig !== null
  const displayName = isPicksView && picks?.name ? picks.name : title
  // Top 1000 and every iPod list wear their own iPod (2026-11-09, utils/ipodCovers.ts).
  const ipodCover = useIpodPlaylistCover(playlistId)
  // The ad's iPod and its numbers (2026-11-14): the whole list, whatever the search box holds.
  // homemini's counts when it sends them (the phone's numbers), else this Mac's own.
  const adLook = useIpodPlaylistLook(playlistId)
  const adFacts = useMemo(() => ({
    ...adCounts({ songs: smartTracks.length, artists: countArtists(smartTracks, canonicalArtist) }, playlistId === 'top-1000' ? top1000Counts : ipodList),
    durationMs: smartTracks.reduce((sum, t) => sum + (t.duration || 0), 0),
  }), [smartTracks, ipodList, top1000Counts, playlistId])
  // A month and the year wear the cover homemini drew (2026-11-13, utils/periodCovers.ts).
  const periodCover = usePeriodPlaylistCover(playlistId)
  const cover = ipodCover ?? periodCover ?? (playlistId ? smartPlaylistCover(playlistId as SmartPlaylistId) : null)
  const loadingLabel =
    picksConfig?.kind === 'larry'   ? 'Larry is picking tracks…' :
    picksConfig?.kind === 'djhands' ? 'DJ Stephen Hands is picking tracks…' :
    'The Music Man is picking tracks…'

  // The iPod ad page (2026-11-14, common/ipod-ad.ts; Jake approved the mock: "Yeah that'll do").
  // The Top 1000 and every iPod list open on the ad: it is the top of the song list's own
  // scroller, so it scrolls away with the songs, and this header (as one bar), the panels and
  // the column header pin under it. List view only: the grid and Cover Flow scroll themselves.
  const adPage = playlistId === 'top-1000' || ipodListDevice !== null
  const showAd = adPage && viewMode === 'list'
  const adKnown = playlistId === 'top-1000' || ipodList !== null
  const adEl = showAd ? (
    <IpodAd
      name={adKnown ? displayName : ''}
      headline={adKnown ? adHeadline({ headline: playlistId === 'top-1000' ? top1000Headline : ipodList?.headline, name: displayName, top1000: playlistId === 'top-1000' }) : ''}
      copy={adKnown ? adCopy(adFacts.songs, adFacts.artists) : ''}
      legal={adKnown ? adLegal({
        name: displayName,
        model: adLook?.model,
        color: adLook?.color,
        songs: adFacts.songs,
        cap: playlistId === 'top-1000' ? 1000 : ipodList?.cap,
        durationMs: adFacts.durationMs,
        lastSyncedAt: ipodList?.lastSyncedAt,
        now: new Date(),
      }) : ''}
      look={adKnown ? adLook : null}
      photo={ipodPhoto}
      story={adKnown ? (playlistId === 'top-1000' ? top1000Story : ipodList?.story) : null}
    />
  ) : null

  const colorPickerEl = ipodColorAt && ipodList ? (
    <IpodColorPicker
      deviceId={ipodList.id}
      ipodName={ipodList.name}
      current={entryColor(ipodList)}
      x={ipodColorAt.x}
      y={ipodColorAt.y}
      onClose={() => setIpodColorAt(null)}
      onSaved={(line) => setNotice(line, { kind: 'info', durationMs: 5000 })}
    />
  ) : null

  const headerEl = (
      <div className={`playlist-view-header${showAd ? ' playlist-view-header--bar' : ''}`}>
        {/* The playlists homemini makes get their own art (Jake 2026-10-20:
            "something noticeable"); the rest keep the plain header. */}
        {cover && !showAd && (
          <div className="playlist-view-cover playlist-view-cover--static">
            <img src={cover} alt="" className="playlist-view-cover-img" />
          </div>
        )}
        <div>
          {editingHeadline && adPage ? (
            <ListRenameField
              variant="header"
              label="Headline"
              initial={(playlistId === 'top-1000' ? top1000Headline : ipodList?.headline) ?? ''}
              others={[]}
              check={(value) => { const c = checkHeadline(value); return c.ok ? { ok: true, name: c.headline ?? '' } : c }}
              hint={`The line at the top of this page, up to ${HEADLINE_MAX} characters. Empty goes back to ${playlistId === 'top-1000' ? 'the usual line' : 'the name'}.`}
              onSave={async (value) => {
                const r = playlistId === 'top-1000' ? await setTop1000Headline(value) : await setIpodListHeadline(ipodList!.id, value)
                if (r.ok && r.homemini === 'later') setNotice('Headline changed.', { kind: 'info', durationMs: 5000 })
                return r.ok ? { ok: true } : r
              }}
              onDone={() => setEditingHeadline(false)}
            />
          ) : renaming && renamable ? (
            <ListRenameField
              variant="header"
              initial={displayName}
              others={playlistId === 'top-1000'
                ? ipodLists.map((l) => l.name)
                : [...ipodLists.filter((l) => l.id !== ipodList?.id).map((l) => l.name), top1000Name]}
              hint={ipodListsRole === 'hub' && (playlistId === 'top-1000' || ipodList?.registered) ? 'Renames the playlist. The iPod keeps its own name.' : null}
              onSave={async (name) => {
                const r = playlistId === 'top-1000' ? await renameTop1000(name) : await renameIpodList(ipodList!.id, name)
                if (r.ok && r.homemini === 'later') setNotice(`Renamed to ${r.name}.`, { kind: 'info', durationMs: 5000 })
                return r.ok ? { ok: true } : r
              }}
              onDone={() => setRenaming(false)}
            />
          ) : (
            <h2 className="playlist-view-name">{displayName}</h2>
          )}
          <div className="playlist-view-meta">
            {isPicksView && picksLoading ? loadingLabel : (
              <>
                {sortedTracks.length} {sortedTracks.length === 1 ? 'song' : 'songs'}, {timeStr}
                {playlistId === 'recently-played' && sortedTracks.length === 0 && ' — play some music.'}
              </>
            )}
          </div>
          {/* "iPod color…" (2026-11-09): an iPod list's cover colour. Not Top 1000 (the Original's).
              "Use a photo…" / "Use the drawing" (2026-11-09): the Top 1000's or an iPod list's photo. */}
          {photoKey && (
            <div className="top25-window-switch">
              {ipodList && (
                <button
                  className="top25-window-btn"
                  onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setIpodColorAt({ x: r.left, y: r.bottom + 4 }) }}
                  title="Color"
                >
                  iPod color…
                </button>
              )}
              <button
                className="top25-window-btn"
                onClick={() => { void chooseIpodPhoto(playlistId!, displayName).then((r) => { if (r.line) setNotice(r.line, { kind: r.ok ? 'info' : 'error', durationMs: 6000 }) }) }}
                title={`A photo for ${displayName}'s cover, here and on the phone`}
              >
                Use a photo…
              </button>
              {hasPhoto && (
                <button
                  className="top25-window-btn"
                  onClick={() => { void backToIpodDrawing(playlistId!, displayName).then((r) => { if (r.line) setNotice(r.line, { kind: r.ok ? 'info' : 'error', durationMs: 6000 }) }) }}
                  title={`${displayName} wears its drawn iPod again`}
                >
                  Use the drawing
                </button>
              )}
            </div>
          )}
          {/* Rename… (2026-11-09): the Top 1000's or an iPod list's name, on every screen. */}
          {renamable && !renaming && !editingHeadline && (
            <div className="top25-window-switch">
              {/* Headline… (2026-11-14): the line at the top of this iPod's page. */}
              {(playlistId === 'top-1000' || ipodList) && (
                <button className="top25-window-btn" onClick={() => setEditingHeadline(true)} title="Change the line at the top of this page">
                  Headline…
                </button>
              )}
              <button className="top25-window-btn" onClick={() => setRenaming(true)} title="Rename this playlist">
                Rename…
              </button>
            </div>
          )}
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
          {playlistId === 'top-rated' && !sort && (
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
                if (picksConfig?.kind === 'larry')   { setLarryPicks(null);  larryRequestedRef.current = false }
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
  )
  const panelsEl = (
    <>
      {/* The brain's picks waiting for Jake's OK (2026-11-09) */}
      {ipodListDevice && <IpodProposalsPanel deviceId={ipodListDevice} ipodName={ipodList?.name ?? title} />}
      {/* An event cover proposed for this month, and "This month's cover is…" (2026-11-13) */}
      <EventCoverPanel playlistId={playlistId} name={displayName} />
      {isPicksView && picks?.commentary && (
        <div className={`playlist-view-commentary playlist-view-commentary--${picksConfig?.kind === 'larry' ? 'larry' : picksConfig?.kind === 'djhands' ? 'djhands' : 'musicman'}`}>
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
    </>
  )
  return (
    <div className="playlist-view">
      {colorPickerEl}
      {!showAd && headerEl}
      {!showAd && panelsEl}
      {/* Brief 026: wrap .songs-header + .songs-body in a .songs-view
          flex column so the CSS that gives them a shared horizontal
          scroll context applies here too. SongsView and PlaylistView
          already had this wrapper; SmartPlaylistView was the outlier
          rendering both as direct children of .playlist-view, which
          left header column labels desynced from row cells under
          horizontal scroll. Same { flex: 1, minHeight: 0 } sizing as
          PlaylistView's existing wrapper at line 533. */}
      {/* V5 facelift: Grid / Cover Flow modes swap only the table below
          the smart-playlist header. */}
      {viewMode === 'grid' ? (
        <div style={{ flex: 1, minHeight: 0 }}>
          <TrackGridView tracks={sortedTracks} emptyNoun="songs" />
        </div>
      ) : viewMode === 'coverflow' ? (
        <div style={{ flex: 1, minHeight: 0 }}>
          <CoverFlowView tracks={sortedTracks} emptyNoun="songs" stateKey={`smart:${playlistId ?? ''}`} />
        </div>
      ) : (
        // The one song table (V7). Up to 10,000 songs on an iPod list: only
        // the rows in view are drawn. On an iPod's page the ad sits above the
        // table and scrolls away; the bar and its panels pin with the header.
        <SongTable
          listKey={`smart:${playlistId ?? ''}`}
          scrollKey={`smart-playlist:${playlistId ?? ''}`}
          tracks={sortedTracks}
          active={libState.currentView === 'smart-playlist'}
          sort={sort}
          onSort={setSort}
          lead={rankLead}
          // A smart list, the Top 1000 and the iPod lists aren't the library:
          // the Delete key does nothing here. Delete from the library stays in
          // the right-click menu, and its question names this list.
          deleteKeyDeletes={false}
          alsoLeaves={displayName}
          className={showAd ? 'songs-view--ipod-ad' : undefined}
          above={showAd ? adEl : undefined}
          pinned={showAd ? <>{headerEl}{panelsEl}</> : undefined}
        />
      )}
    </div>
  )
}
