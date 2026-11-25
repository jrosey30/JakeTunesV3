/**
 * The one song table (V7, 2026-11-24). Every page that lists songs draws its
 * songs with this: Songs, a playlist, a smart playlist (Top 1000 and the iPod
 * lists included), an album, Genres, one of an iPod's playlists. Each page
 * keeps its own look ABOVE the table (the jewel case, the iPod ad, the Top
 * 1000's ranks in the lead column, a playlist's cover); the table itself is
 * the same everywhere:
 *
 *   columns     one layout, saved and shared by every page (useColumnLayout):
 *               right-click the header to show or hide one, drag a header to
 *               move it, drag its edge to size it
 *   sorting     click a header: ascending, descending, then back to the
 *               list's own order ("Original Order") — Time included
 *   keys        ↑/↓ (⇧ extends), Return plays, Space stays play/pause,
 *               type-to-find (useTrackListKeys), ⌘A, Delete, ⌘I, ⌘F
 *   the menu    utils/libraryMenus.ts songMenuEntries, one order everywhere,
 *               plus the page's own (Remove from Playlist …)
 *   Delete      takes the songs out of the list you're in, with Undo, where
 *               the page lets you (onRemove); otherwise deletes from the
 *               library after asking (DeleteSongsDialog)
 *   drag        the selection to a playlist / the queue ("12 Songs"), and in
 *               the list's own order, several rows at once to reorder
 *   playing     double-click or Return plays the row in this list's order
 *   long lists  only the rows in view are drawn (useRowWindow), so a
 *               10,000-song list costs a screenful
 *
 * Selection is the library's (LibraryContext selectedTrackIds), as Songs and
 * the album page always had it, so New Mixtape from the selection sees it
 * from any list.
 *
 * The rules are pure and tested: utils/songTableRules.ts,
 * src/main/__tests__/song-table.test.ts.
 */
import {
  memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore,
  type ReactNode,
} from 'react'
import { useLibrary } from '../context/LibraryContext'
import { addKeyLayer } from '../keyboard'
import { usePlayback } from '../context/PlaybackContext'
import { useCynthia } from '../context/CynthiaContext'
import { useAudio, prefetchTrackForPlay, prefetchTrackImmediate } from '../hooks/useAudio'
import { useScrollPersistence } from '../hooks/useScrollPersistence'
import { useTrackListKeys } from '../hooks/useTrackListKeys'
import { useColumnLayout } from '../hooks/useColumnLayout'
import { useRowWindow } from '../hooks/useRowWindow'
import { useFindState } from '../hooks/useFindState'
import { useGetInfoHandlers } from '../hooks/useGetInfoHandlers'
import { usePlaysElsewhere } from '../playsElsewhere'
import { lastPlayedEverywhere, playsEverywhere } from '../../common/plays-elsewhere'
import { getInfoTarget, type GetInfoTarget } from '../../common/get-info-target'
import { formatDuration } from '../../common/format-duration'
import { getSnapshot as recentlyAddedSnapshot, isRecentlyAdded, subscribe as subscribeRecentlyAdded } from '../state/recentlyAdded'
import { subscribeDownloads, downloadsVersion, isDownloaded, isDownloading } from '../utils/downloadStore'
import { formatAppDateTime } from '../utils/formatDate'
import { songsGridTemplate, songsGridTemplateFixed } from '../utils/songsGridTemplate'
import { TRACK_DRAG_TYPE } from '../utils/trackDrag'
import { songMenuEntries } from '../utils/libraryMenus'
import { hasPendingShowNowPlaying, takePendingShowNowPlaying } from '../nowPlayingNav'
import {
  ALWAYS_VISIBLE, ORIGINAL_ORDER, dragLabel, nextSort, withoutPlayingColumn, type SongColumn, type SongSort,
} from '../utils/songTableRules'
import { SpeakerPlayingIcon } from '../assets/icons/SpeakerIcon'
import ContextMenu, { type MenuEntry } from './ContextMenu'
import DeleteSongsDialog from './DeleteSongsDialog'
import GetInfoModal from './GetInfoModal'
import UndoToast from './UndoToast'
import FindBar from './FindBar'
import ScrollTopButton from './ScrollTopButton'
import SortArrowIcon from './SortArrowIcon'
import { TitleStar, type StarDispatch } from './StarRating'
import type { SortColumn, Track } from '../types'
import '../styles/songs.css'

/** Row height — the CSS --row-height token (variables.css). Both move together. */
const ROW_HEIGHT = 18
/** The rows' own reorder payload (ids, in list order). */
const ROWS_DRAG_TYPE = 'application/jaketunes-list-rows'
/** Songs: the list waits this long without a touch before it follows the playing song. */
const FOLLOW_IDLE_TOP_MS = 15000
/** Other lists: a new song is brought into view if the list sat still this long. */
const FOLLOW_IDLE_NEAREST_MS = 5000

export interface SongTableLead {
  label: string
  width: number
  /** The cell. `idx` is the row's place in the list as shown. */
  render: (track: Track, idx: number, playing: boolean) => ReactNode
  className?: string
  /** The header cell's own class (a right-aligned '#'). */
  headerClassName?: string
  /** The lead shows the speaker on the playing row itself, so the table
   *  drops its own speaker column (no empty column beside the '#'). */
  showsPlaying?: boolean
}

export interface SongTableRemoval {
  /** The Undo toast's line. */
  message: string
  undo: () => void
}

export interface SongTableProps {
  /** This list's id: the keyboard cursor and selection start over when it changes. */
  listKey: string
  /** The rows, in the order shown (the page filters and sorts). */
  tracks: Track[]
  /** This list is the page on screen, in list mode: its keys answer. */
  active: boolean
  sort: SongSort | null
  onSort: (next: SongSort | null) => void
  /** A first column the page draws: the album's track numbers, the Top 1000's ranks. */
  lead?: SongTableLead
  /** A page's own short set of columns, instead of the shared layout (the
   *  album page: #, Name, Artist, Plays, Time — the jewel-case layout's rule). */
  columns?: readonly string[]
  /** Take songs out of THIS list (Delete, and "Remove from …" in the menu).
   *  Returns the Undo, or null when nothing came out. */
  onRemove?: (songs: Track[]) => SongTableRemoval | null
  /** The menu's "Remove from …" wording. */
  removeLabel?: (count: number) => string
  /** No onRemove: the Delete key deletes from the library, asked first. Only
   *  on library pages (Songs, an album, Genres); false on a smart playlist,
   *  the Top 1000 and the iPod lists, where Delete does nothing. */
  deleteKeyDeletes?: boolean
  /** "Delete Song" (from the library, asked first) in the right-click menu. */
  libraryDeleteInMenu?: boolean
  /** What else the songs leave, said in the delete question ("punkPod"). */
  alsoLeaves?: string
  /** The page's own menu entries for the songs right-clicked. */
  menuExtras?: (songs: Track[], track: Track) => MenuEntry[]
  /** Drag rows to reorder: only offered in the list's own order. `beforeId`
   *  null = the end. */
  onReorder?: (ids: number[], beforeId: number | null) => void
  /** Songs dragged in from elsewhere. */
  onDropSongs?: (ids: number[], beforeId: number | null) => void
  /** Play from row `idx` (default: this list, from there). */
  playFrom?: (idx: number) => void
  /** 'own': the table is its own scroller. 'page': the page scrolls it. */
  scroll?: 'own' | 'page'
  /** Scroll memory key (own scroller). */
  scrollKey?: string
  className?: string
  /** Inside the scroller, above the header — scrolls away (the iPod ad). */
  above?: ReactNode
  /** Pinned with the column header (the iPod page's bar). */
  pinned?: ReactNode
  /** What an empty list says. */
  empty?: ReactNode
  /** How the list follows the playing song: Songs pins it to the top after a
   *  long idle; the others bring it into view. */
  follow?: 'top' | 'nearest'
  /** ⌘L (show the playing song) lands here — Songs. */
  answersShowNowPlaying?: boolean
}

interface RowProps {
  track: Track
  idx: number
  isPlaying: boolean
  isSelected: boolean
  isRecent: boolean
  isFindHit: boolean
  isDropTarget: boolean
  gridTemplate: string
  visibleCols: SongColumn[]
  lead?: SongTableLead
  starDispatch: StarDispatch
  downloaded: boolean
  downloading: boolean
  onClick: (idx: number, e: React.MouseEvent) => void
  onDoubleClick: (idx: number) => void
  onContextMenu: (e: React.MouseEvent, idx: number) => void
  onDragStart: (e: React.DragEvent, idx: number) => void
  onDragOver: (e: React.DragEvent, idx: number) => void
  onDrop: (e: React.DragEvent, idx: number) => void
}

const bpmBand = (b: number): string => (b === 0 ? '' : b < 88 ? 'a' : b < 100 ? 'b' : b < 112 ? 'c' : b < 122 ? 'd' : b < 134 ? 'e' : 'f')

// Memoized: a scroll that doesn't change THIS row's props skips it. Every
// handler is stable (refs in the table), so the shallow compare holds.
const SongRow = memo(function SongRow(p: RowProps) {
  const { track, idx, isPlaying } = p
  const elsewhere = usePlaysElsewhere()
  return (
    <div
      className={`songs-row ${idx % 2 ? 'songs-row--alt' : ''} ${isPlaying ? 'songs-row--playing' : ''} ${p.isSelected ? 'songs-row--selected' : ''} ${p.isRecent ? 'songs-row--recently-added' : ''} ${p.isFindHit ? 'songs-row--find' : ''} ${p.isDropTarget ? 'songs-row--drop-before' : ''}`}
      style={{ gridTemplateColumns: p.gridTemplate }}
      data-row-idx={idx}
      data-track-id={track.id}
      role="row"
      aria-selected={p.isSelected}
      onClick={(e) => p.onClick(idx, e)}
      onDoubleClick={() => p.onDoubleClick(idx)}
      onMouseEnter={() => prefetchTrackForPlay(track)}
      onMouseDown={() => prefetchTrackImmediate(track)}
      onContextMenu={(e) => p.onContextMenu(e, idx)}
      draggable
      onDragStart={(e) => p.onDragStart(e, idx)}
      onDragOver={(e) => p.onDragOver(e, idx)}
      onDrop={(e) => p.onDrop(e, idx)}
    >
      {p.lead && <div className={`songs-cell songs-cell--lead ${p.lead.className ?? ''}`}>{p.lead.render(track, idx, isPlaying)}</div>}
      {p.visibleCols.map((col) => {
        switch (col.key) {
          case 'playing':
            return <div key={col.key} className="songs-cell songs-cell--icon">{isPlaying && <SpeakerPlayingIcon />}</div>
          case 'title':
            return (
              <div key={col.key} className="songs-cell songs-cell--title">
                {track.audioMissing && (
                  <span
                    className="songs-cell-missing-badge"
                    title="JakeTunes can't find this song's audio file. The library entry is kept — re-import the file to play it again."
                    aria-label="Audio file missing"
                  >!</span>
                )}
                <span className="title-row-text">{track.title || ''}</span>
                <TitleStar track={track} dispatch={p.starDispatch} />
                {(p.downloaded || p.downloading) && (
                  <span
                    className={p.downloading ? 'title-row-dl title-row-dl--loading' : 'title-row-dl'}
                    title={p.downloading ? 'Downloading…' : 'Downloaded for offline — plays instantly'}
                    aria-label={p.downloading ? 'Downloading' : 'Downloaded'}
                  >
                    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
                      <circle cx="8" cy="8" r="7" fill="currentColor" />
                      <path className="dl-arrow" d="M8 4.8v6M5.4 8.2 8 10.8l2.6-2.6" />
                    </svg>
                  </span>
                )}
              </div>
            )
          case 'time':
            return <div key={col.key} className="songs-cell songs-cell--time">{formatDuration(track.duration)}</div>
          case 'artist':
            return <div key={col.key} className="songs-cell">{track.artist || ''}</div>
          case 'album':
            return <div key={col.key} className="songs-cell">{track.album || ''}</div>
          case 'genre':
            return <div key={col.key} className="songs-cell">{track.genre || ''}</div>
          case 'origin':
            return <div key={col.key} className="songs-cell">{track.origin || ''}</div>
          case 'subgenre':
            return <div key={col.key} className="songs-cell" title={track.subgenrePath || ''}>{track.subgenre || ''}</div>
          case 'year':
            return <div key={col.key} className="songs-cell">{track.year || ''}</div>
          case 'dateAdded':
            return <div key={col.key} className="songs-cell">{formatAppDateTime(track.dateAdded)}</div>
          case 'lastPlayedAt':
            return <div key={col.key} className="songs-cell">{formatAppDateTime(lastPlayedEverywhere(track, elsewhere))}</div>
          case 'playCount':
            return <div key={col.key} className="songs-cell songs-cell--plays">{playsEverywhere(track, elsewhere) || ''}</div>
          case 'channelMode':
            return <div key={col.key} className="songs-cell">{track.channelMode === 'mono' ? 'Mono' : track.channelMode === 'stereo' ? 'Stereo' : ''}</div>
          case 'bpm': {
            // Warm = fast: the cell is tinted by tempo band, the digits stay dark.
            const b = Number(track.bpm) || 0
            const band = bpmBand(b)
            return <div key={col.key} className={`songs-cell songs-cell--num${band ? ` bpm-${band}` : ''}`}>{b ? Math.round(b) : ''}</div>
          }
          case 'camelotKey': {
            // Colour follows the Camelot WHEEL, so harmonic neighbours look related.
            const m = /^(\d{1,2})([AB])$/i.exec(String(track.camelotKey || '').trim())
            const cls = m ? ` cam-${m[1]} cam-${m[2].toUpperCase()}` : ''
            return <div key={col.key} className={`songs-cell songs-cell--num${cls}`} title={track.keyRoot ? `${track.keyRoot} ${track.keyMode || ''}`.trim() : ''}>{track.camelotKey || ''}</div>
          }
          default:
            return null
        }
      })}
    </div>
  )
})

export default function SongTable(props: SongTableProps): JSX.Element {
  const {
    listKey, tracks, active, sort, onSort, lead, columns: fixedColumns, onRemove, removeLabel,
    deleteKeyDeletes = true, libraryDeleteInMenu = true, alsoLeaves, menuExtras, onReorder, onDropSongs, playFrom,
    scroll = 'own', scrollKey, className, above, pinned, empty, follow = 'nearest', answersShowNowPlaying,
  } = props
  const { state: lib, dispatch: libDispatch } = useLibrary()
  const { state: pb, dispatch: pbDispatch } = usePlayback()
  const { playTrack } = useAudio()
  const { openCynthia } = useCynthia()
  useSyncExternalStore(subscribeRecentlyAdded, recentlyAddedSnapshot)
  useSyncExternalStore(subscribeDownloads, downloadsVersion)
  const columns = useColumnLayout(fixedColumns)
  const { onSave: onGetInfoSave, onFetchArt, onSetCustomArt } = useGetInfoHandlers()

  const ownScrollerRef = useRef<HTMLDivElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const headRef = useRef<HTMLDivElement | null>(null)
  useScrollPersistence(scrollKey ?? `song-table:${listKey}`, ownScrollerRef)
  const { start: winStart, end: winEnd, scroller, bodyTop } = useRowWindow(tracks.length, ROW_HEIGHT, bodyRef, scroll === 'own' ? ownScrollerRef : undefined)

  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; idx: number } | null>(null)
  const [headerMenu, setHeaderMenu] = useState<{ x: number; y: number } | null>(null)
  const [getInfo, setGetInfo] = useState<GetInfoTarget<Track> | null>(null)
  const [deleteIds, setDeleteIds] = useState<number[] | null>(null)
  const [undo, setUndo] = useState<(SongTableRemoval & { key: number }) | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)
  const [dragOverKey, setDragOverKey] = useState<string | null>(null)

  // Everything a stable handler reads, read at the moment it runs.
  const live = useRef({ tracks, lib, pb, sort, onSort, onRemove, onReorder, onDropSongs, playFrom, playTrack })
  live.current = { tracks, lib, pb, sort, onSort, onRemove, onReorder, onDropSongs, playFrom, playTrack }

  // ── Selection: the library's; a new list (or a new order) starts clean ──
  const lastClickedIdx = useRef(-1)
  const focusedIdx = useRef(-1)
  const sortKey = sort ? `${sort.column}:${sort.direction}` : 'own'
  useEffect(() => {
    lastClickedIdx.current = -1
    focusedIdx.current = -1
    libDispatch({ type: 'SELECT_NONE' })
  }, [listKey, sortKey, lib.searchQuery, libDispatch])

  const selectedSongs = useCallback((): Track[] => {
    const sel = live.current.lib.selectedTrackIds
    return live.current.tracks.filter((t) => sel.has(t.id))
  }, [])

  // ── Play ──
  const play = useCallback((idx: number) => {
    const { tracks: list, playFrom: from, playTrack: pt } = live.current
    if (!list[idx]) return
    if (from) from(idx)
    else pt(list[idx], list, idx, undefined, true)
  }, [])

  // ── Now-playing follow ──
  const lastActivityAt = useRef(0)
  const ourScrollAt = useRef(0)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stickyHeight = useCallback((): number => headRef.current?.offsetHeight ?? 0, [])
  const scrollToIdx = useCallback((idx: number, where: 'nearest' | 'top' | 'center') => {
    const sc = scroller()
    if (!sc || idx < 0) return
    const top = bodyTop() + idx * ROW_HEIGHT
    const head = stickyHeight()
    ourScrollAt.current = Date.now()
    if (where === 'top') sc.scrollTop = top - head
    else if (where === 'center') sc.scrollTop = Math.max(0, top - head - (sc.clientHeight - head) / 2 + ROW_HEIGHT / 2)
    else if (top < sc.scrollTop + head) sc.scrollTop = top - head
    else if (top + ROW_HEIGHT > sc.scrollTop + sc.clientHeight) sc.scrollTop = top + ROW_HEIGHT - sc.clientHeight
  }, [scroller, bodyTop, stickyHeight])

  const followPlaying = useCallback((where: 'top' | 'nearest') => {
    const id = live.current.pb.nowPlaying?.id
    if (id == null) return
    const idx = live.current.tracks.findIndex((t) => t.id === id)
    if (idx >= 0) scrollToIdx(idx, where)
  }, [scrollToIdx])

  const activeRef = useRef(active)
  activeRef.current = active
  const markActivity = useCallback(() => {
    lastActivityAt.current = Date.now()
    if (follow !== 'top') return
    if (idleTimer.current) clearTimeout(idleTimer.current)
    idleTimer.current = setTimeout(() => { if (activeRef.current) followPlaying('top') }, FOLLOW_IDLE_TOP_MS)
  }, [follow, followPlaying])
  useEffect(() => {
    markActivity()
    return () => { if (idleTimer.current) clearTimeout(idleTimer.current) }
  }, [markActivity])
  useEffect(() => {
    const sc = scroller()
    if (!sc) return
    const onScroll = (): void => { if (Date.now() - ourScrollAt.current > 200) markActivity() }
    sc.addEventListener('scroll', onScroll, { passive: true })
    return () => sc.removeEventListener('scroll', onScroll)
  }, [scroller, markActivity])
  // A click anywhere in the app is activity (picking a genre above the list
  // included): the list only moves on its own while Jake isn't using the app.
  useEffect(() => {
    if (!active) return
    document.addEventListener('pointerdown', markActivity, true)
    return () => document.removeEventListener('pointerdown', markActivity, true)
  }, [active, markActivity])
  // A new song, or another list in this page: follow, if idle.
  useEffect(() => {
    if (!active || !pb.nowPlaying) return
    const idle = follow === 'top' ? FOLLOW_IDLE_TOP_MS : FOLLOW_IDLE_NEAREST_MS
    if (Date.now() - lastActivityAt.current < idle) return
    followPlaying(follow)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pb.nowPlaying?.id, active, listKey])

  // ⌘L: show the playing song (Songs).
  useEffect(() => {
    if (!answersShowNowPlaying || !active) return
    const handler = (): void => {
      const id = live.current.pb.nowPlaying?.id
      if (id == null) return
      const idx = live.current.tracks.findIndex((t) => t.id === id)
      if (idx < 0) return
      focusedIdx.current = idx
      lastClickedIdx.current = idx
      libDispatch({ type: 'SELECT_TRACK', id })
      scrollToIdx(idx, 'nearest')
    }
    window.addEventListener('jaketunes-show-now-playing', handler)
    // ⌘L pressed on another page: App switched here and left a flag. Acted on a
    // beat after mount, so it lands after the scroll position is restored.
    const t = hasPendingShowNowPlaying()
      ? window.setTimeout(() => { if (takePendingShowNowPlaying()) handler() }, 60)
      : undefined
    return () => {
      window.removeEventListener('jaketunes-show-now-playing', handler)
      if (t !== undefined) window.clearTimeout(t)
    }
  }, [answersShowNowPlaying, active, libDispatch, scrollToIdx])

  // ── Clicks ──
  const onRowClick = useCallback((idx: number, e: React.MouseEvent) => {
    window.getSelection()?.removeAllRanges()
    const list = live.current.tracks
    const track = list[idx]
    if (!track) return
    if (e.shiftKey && lastClickedIdx.current >= 0 && lastClickedIdx.current < list.length) {
      const from = Math.min(lastClickedIdx.current, idx)
      const to = Math.max(lastClickedIdx.current, idx)
      libDispatch({ type: 'SELECT_RANGE', ids: list.slice(from, to + 1).map((t) => t.id) })
    } else {
      libDispatch({ type: 'SELECT_TRACK', id: track.id, multi: e.metaKey || e.ctrlKey })
      lastClickedIdx.current = idx
    }
    focusedIdx.current = idx
  }, [libDispatch])

  const onRowDoubleClick = useCallback((idx: number) => {
    window.getSelection()?.removeAllRanges()
    play(idx)
  }, [play])

  const onRowContextMenu = useCallback((e: React.MouseEvent, idx: number) => {
    e.preventDefault()
    const track = live.current.tracks[idx]
    if (!track) return
    if (!live.current.lib.selectedTrackIds.has(track.id)) libDispatch({ type: 'SELECT_TRACK', id: track.id })
    focusedIdx.current = idx
    setCtxMenu({ x: e.clientX, y: e.clientY, idx })
  }, [libDispatch])

  // ── Remove / delete ──
  const removeSongs = useCallback((songs: Track[]) => {
    const fn = live.current.onRemove
    if (!fn || songs.length === 0) return
    const r = fn(songs)
    libDispatch({ type: 'SELECT_NONE' })
    if (r) setUndo({ ...r, key: Date.now() })
  }, [libDispatch])

  // ── Drag ──
  const canReorder = !!onReorder && !sort && !lib.searchQuery
  const canReorderRef = useRef(canReorder)
  canReorderRef.current = canReorder
  const onRowDragStart = useCallback((e: React.DragEvent, idx: number) => {
    const { tracks: list, lib: l } = live.current
    const track = list[idx]
    if (!track) return
    const sel = l.selectedTrackIds
    const songs = sel.has(track.id) && sel.size > 1 ? list.filter((t) => sel.has(t.id)) : [track]
    const ids = songs.map((t) => t.id)
    e.dataTransfer.setData(TRACK_DRAG_TYPE, JSON.stringify(ids))
    e.dataTransfer.setData('text/plain', String(ids.length))
    if (canReorderRef.current) e.dataTransfer.setData(ROWS_DRAG_TYPE, JSON.stringify(ids))
    e.dataTransfer.effectAllowed = canReorderRef.current ? 'copyMove' : 'copy'
    // The drag preview: the song's name, or "12 Songs".
    const ghost = document.createElement('div')
    ghost.className = 'drag-ghost'
    ghost.textContent = dragLabel(songs)
    document.body.appendChild(ghost)
    e.dataTransfer.setDragImage(ghost, 0, 10)
    requestAnimationFrame(() => ghost.remove())
  }, [])

  const accepts = useCallback((e: React.DragEvent): boolean => {
    const types = e.dataTransfer.types
    if (types.includes(ROWS_DRAG_TYPE)) return canReorderRef.current
    return !!live.current.onDropSongs && types.includes(TRACK_DRAG_TYPE)
  }, [])
  const onRowDragOver = useCallback((e: React.DragEvent, idx: number) => {
    if (!accepts(e)) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = e.dataTransfer.types.includes(ROWS_DRAG_TYPE) ? 'move' : 'copy'
    setDropAt((cur) => (cur === idx ? cur : idx))
  }, [accepts])
  const dropAtIdx = useCallback((e: React.DragEvent, idx: number) => {
    setDropAt(null)
    if (!accepts(e)) return
    e.preventDefault()
    e.stopPropagation()
    const { tracks: list, onReorder: reorder, onDropSongs: dropSongs } = live.current
    const beforeId = list[idx]?.id ?? null
    const parse = (raw: string): number[] => {
      try { return (JSON.parse(raw) as unknown[]).map(Number).filter((n) => Number.isInteger(n)) } catch { return [] }
    }
    const rows = e.dataTransfer.getData(ROWS_DRAG_TYPE)
    if (rows) {
      const ids = parse(rows)
      if (ids.length && reorder) reorder(ids, beforeId)
      return
    }
    const ids = parse(e.dataTransfer.getData(TRACK_DRAG_TYPE))
    if (ids.length && dropSongs) dropSongs(ids, beforeId)
  }, [accepts])

  // ── Keys: ↑/↓, Return, Space, type-to-find (shared hook) ──
  const dialogOpen = !!ctxMenu || !!getInfo || !!deleteIds
  useTrackListKeys({
    enabled: active && !dialogOpen,
    tracks,
    focusedIdx,
    lastClickedIdx,
    selectOne: (id) => libDispatch({ type: 'SELECT_TRACK', id }),
    selectRange: (ids) => libDispatch({ type: 'SELECT_RANGE', ids }),
    scrollToIdx: (idx) => { markActivity(); scrollToIdx(idx, 'nearest') },
    play,
    getSelectedIds: () => live.current.lib.selectedTrackIds,
    hasNowPlaying: () => !!live.current.pb.nowPlaying,
  })

  // ⌘A, Delete — this list's own keys, a list layer on the keyboard host
  // (keyboard.ts), never while a dialog is open.
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent): void => {
      if (document.querySelector('.getinfo-overlay, .confirm-overlay')) return
      const el = e.target as HTMLElement | null
      const tag = el?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return
      markActivity()
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        libDispatch({ type: 'SELECT_RANGE', ids: live.current.tracks.map((t) => t.id) })
        return
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const songs = selectedSongs()
        if (!songs.length) return
        e.preventDefault()
        if (live.current.onRemove) removeSongs(songs)
        else if (deleteKeyDeletes) setDeleteIds(songs.map((t) => t.id))
      }
    }
    return addKeyLayer('song-table', onKey)
  }, [active, libDispatch, markActivity, selectedSongs, removeSongs, deleteKeyDeletes])

  useEffect(() => {
    if (!active) return
    const handler = (): void => {
      if (document.querySelector('.getinfo-overlay')) return
      const { tracks: list, lib: l, pb: p } = live.current
      const np = p.nowPlaying ? l.tracks.find((t) => t.id === p.nowPlaying!.id) : undefined
      const target = getInfoTarget(list, l.selectedTrackIds, np)
      if (target) setGetInfo(target)
    }
    window.addEventListener('jaketunes-get-info', handler)
    return () => window.removeEventListener('jaketunes-get-info', handler)
  }, [active])

  // ── ⌘F find: walks the list as shown, highlights the match ──
  const find = useFindState(active)
  const findMatches = useMemo(() => {
    const q = find.query.trim().toLowerCase()
    if (!q) return [] as number[]
    const out: number[] = []
    tracks.forEach((t, i) => {
      if ((t.title || '').toLowerCase().includes(q) || (t.artist || '').toLowerCase().includes(q) || (t.album || '').toLowerCase().includes(q)) out.push(i)
    })
    return out
  }, [tracks, find.query])
  const [findHitId, setFindHitId] = useState<number | null>(null)
  const jumpToFind = useCallback((c: number) => {
    const idx = findMatches[c]
    if (idx === undefined) return
    scrollToIdx(idx, 'center')
    setFindHitId(live.current.tracks[idx]?.id ?? null)
  }, [findMatches, scrollToIdx])
  useEffect(() => {
    if (!find.open || findMatches.length === 0) { setFindHitId(null); return }
    jumpToFind(Math.min(find.cursor, findMatches.length - 1))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [find.open, find.query, findMatches.length])
  const stepFind = (dir: 1 | -1): void => {
    if (findMatches.length === 0) return
    const c = (find.cursor + dir + findMatches.length) % findMatches.length
    find.setCursor(c)
    jumpToFind(c)
  }

  // ── Header: sort, resize, reorder, show/hide ──
  const lastResizeEndAt = useRef(0)
  const onHeaderClick = (col: SongColumn): void => {
    if (Date.now() - lastResizeEndAt.current < 300) return
    if (!col.sortable) return
    onSort(nextSort(sort, col.key as SortColumn))
  }
  const onResizeStart = (col: SongColumn, startWidth: number, e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const onMove = (ev: MouseEvent): void => columns.setWidth(col.key, Math.max(col.minWidth, startWidth + ev.clientX - startX))
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      lastResizeEndAt.current = Date.now()
    }
    document.body.style.cursor = 'col-resize'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // A lead that shows the speaker itself takes the speaker column's place.
  const { visible: visibleCols, widths: colWidths } = useMemo(
    () => withoutPlayingColumn(columns.visible, columns.widths, !!lead?.showsPlaying),
    [columns.visible, columns.widths, lead?.showsPlaying],
  )
  const allWidths = useMemo(() => (lead ? [lead.width, ...colWidths] : colWidths), [lead, colWidths])
  const gridTemplate = useMemo(() => {
    const cols = songsGridTemplate(visibleCols, colWidths)
    return lead ? `${lead.width}px ${cols}` : cols
  }, [visibleCols, colWidths, lead])
  const gridTemplateFixed = useMemo(() => songsGridTemplateFixed(allWidths), [allWidths])

  // The drop line goes when the drag ends anywhere (dropped elsewhere, or Esc).
  useEffect(() => {
    if (dropAt === null) return
    const clear = (): void => setDropAt(null)
    window.addEventListener('dragend', clear, true)
    window.addEventListener('drop', clear, true)
    return () => {
      window.removeEventListener('dragend', clear, true)
      window.removeEventListener('drop', clear, true)
    }
  }, [dropAt])

  // ── The menu ──
  // Built when the menu opens or what it acts on changes — not on every
  // playback tick, which re-renders the table.
  const menuItems = useMemo((): MenuEntry[] => {
    if (!ctxMenu) return []
    const track = tracks[ctxMenu.idx]
    if (!track) return []
    const sel = lib.selectedTrackIds
    const songs = sel.size > 1 && sel.has(track.id) ? tracks.filter((t) => sel.has(t.id)) : [track]
    const extras: MenuEntry[] = [
      ...(menuExtras ? menuExtras(songs, track) : []),
      ...(onRemove ? [{ label: removeLabel ? removeLabel(songs.length) : (songs.length > 1 ? `Remove ${songs.length} Songs from List` : 'Remove from List'), onClick: () => removeSongs(songs) }] : []),
    ]
    return songMenuEntries({
      track,
      tracks: songs,
      library: lib.tracks,
      playlists: lib.playlists,
      libDispatch,
      pbDispatch,
      // Get Info opens on the song right-clicked (a multi-selection edits them all).
      openGetInfo: () => setGetInfo(songs.length > 1
        ? { tracks: songs, index: tracks.indexOf(songs[0]) }
        : { tracks: [track], index: ctxMenu.idx }),
      askDelete: libraryDeleteInMenu ? () => setDeleteIds(songs.map((t) => t.id)) : undefined,
      // Next to "Remove from Playlist", plain "Delete Song" would read as the same thing.
      deleteLabel: onRemove ? (songs.length > 1 ? `Delete ${songs.length} Songs from Library` : 'Delete from Library') : undefined,
      extras,
      openCynthia,
      at: { x: ctxMenu.x, y: ctxMenu.y },
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctxMenu, tracks, lib.selectedTrackIds, lib.tracks, lib.playlists, menuExtras, onRemove, removeLabel, libraryDeleteInMenu])

  const header = (
    <div
      ref={pinned ? undefined : headRef}
      className="songs-header"
      style={{ gridTemplateColumns: gridTemplate }}
      role="row"
      onContextMenu={(e) => { e.preventDefault(); setHeaderMenu({ x: e.clientX, y: e.clientY }) }}
    >
      {lead && (
        <div
          className={`songs-header-cell songs-header-cell--lead ${lead.headerClassName ?? ''} ${!sort ? 'sorted' : ''}`}
          role="columnheader"
          title={ORIGINAL_ORDER}
          onClick={() => { if (sort) onSort(null) }}
        >
          {lead.label}
        </div>
      )}
      {visibleCols.map((col, i) => (
        <div
          key={col.key}
          role="columnheader"
          aria-sort={sort?.column === col.key ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined}
          className={`songs-header-cell songs-header-cell--${col.key} ${sort?.column === col.key ? 'sorted' : ''} ${dragOverKey === col.key ? 'songs-header-cell--drag-over' : ''}`}
          onClick={() => onHeaderClick(col)}
          draggable={!columns.fixed}
          onDragStart={(e) => { e.dataTransfer.setData('application/jaketunes-column', col.key); e.dataTransfer.effectAllowed = 'move' }}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes('application/jaketunes-column')) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            if (dragOverKey !== col.key) setDragOverKey(col.key)
          }}
          onDragLeave={() => setDragOverKey(null)}
          onDrop={(e) => {
            const source = e.dataTransfer.getData('application/jaketunes-column')
            setDragOverKey(null)
            if (!source) return
            e.preventDefault()
            columns.move(source, col.key)
          }}
        >
          {col.label}
          {sort?.column === col.key && <span className="sort-arrow"><SortArrowIcon direction={sort.direction} /></span>}
          {col.resizable && <div className="col-resize-handle" onMouseDown={(e) => onResizeStart(col, colWidths[i], e)} />}
        </div>
      ))}
    </div>
  )

  const rows = tracks.slice(winStart, winEnd)
  const body = (
    <div
      className="songs-body"
      ref={bodyRef}
      role="rowgroup"
      onDragOver={(e) => { if (accepts(e)) { e.preventDefault(); setDropAt(tracks.length) } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDropAt(null) }}
      onDrop={(e) => dropAtIdx(e, tracks.length)}
    >
      {tracks.length === 0 ? empty ?? null : (
        <>
          {/* Fixed-px width anchor: rows are absolutely placed, so this owns the scroll width. */}
          <div className="songs-body-width-sizer" style={{ gridTemplateColumns: gridTemplateFixed }} aria-hidden="true" />
          <div style={{ height: tracks.length * ROW_HEIGHT, position: 'relative', width: '100%' }}>
            <div style={{ position: 'absolute', top: winStart * ROW_HEIGHT, left: 0, width: '100%' }}>
              {rows.map((track, i) => {
                const idx = winStart + i
                return (
                  <SongRow
                    key={`${track.id}-${idx}`}
                    track={track}
                    idx={idx}
                    isPlaying={pb.nowPlaying?.id === track.id}
                    isSelected={lib.selectedTrackIds.has(track.id)}
                    isRecent={isRecentlyAdded(track.id)}
                    isFindHit={findHitId === track.id}
                    isDropTarget={dropAt === idx}
                    gridTemplate={gridTemplate}
                    visibleCols={visibleCols}
                    lead={lead}
                    starDispatch={libDispatch}
                    downloaded={isDownloaded(track.path)}
                    downloading={isDownloading(track.path)}
                    onClick={onRowClick}
                    onDoubleClick={onRowDoubleClick}
                    onContextMenu={onRowContextMenu}
                    onDragStart={onRowDragStart}
                    onDragOver={onRowDragOver}
                    onDrop={dropAtIdx}
                  />
                )
              })}
            </div>
          </div>
          {dropAt === tracks.length && <div className="songs-drop-end" aria-hidden="true" />}
        </>
      )}
    </div>
  )

  const overlays = (
    <>
      {find.open && (
        <FindBar
          query={find.query}
          onQuery={find.setQuery}
          current={find.cursor}
          total={findMatches.length}
          onNext={() => stepFind(1)}
          onPrev={() => stepFind(-1)}
          onClose={find.close}
          placeholder="Find song, artist, album…"
        />
      )}
      {ctxMenu && <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={menuItems} onClose={() => setCtxMenu(null)} />}
      {headerMenu && (
        <ContextMenu
          x={headerMenu.x}
          y={headerMenu.y}
          items={[
            { label: ORIGINAL_ORDER, checked: !sort, onClick: () => onSort(null) },
            ...(columns.fixed ? [] : [{ separator: true as const }]),
            // A page's own short set has no picker: only the shared layout is Jake's to edit.
            ...(columns.fixed ? [] : columns.ordered)
              .filter((c) => !ALWAYS_VISIBLE.has(c.key))
              .map((c) => ({
                label: c.label,
                checked: !columns.hidden.has(c.key),
                onClick: () => {
                  // Hiding the column the list is sorted by goes back to the list's own order.
                  if (!columns.hidden.has(c.key) && sort?.column === c.key) onSort(null)
                  columns.toggle(c.key)
                },
              })),
          ]}
          onClose={() => setHeaderMenu(null)}
        />
      )}
      {getInfo && (
        <GetInfoModal
          tracks={getInfo.tracks}
          allTracks={getInfo.allTracks ?? tracks}
          initialIndex={getInfo.index}
          artworkMap={lib.artworkMap}
          onClose={() => setGetInfo(null)}
          onSave={onGetInfoSave}
          onFetchArt={onFetchArt}
          onSetCustomArt={onSetCustomArt}
        />
      )}
      {deleteIds && <DeleteSongsDialog ids={deleteIds} alsoLeaves={alsoLeaves} onClose={() => setDeleteIds(null)} />}
      {undo && (
        <UndoToast
          key={undo.key}
          message={undo.message}
          onUndo={undo.undo}
          onDismiss={() => setUndo(null)}
        />
      )}
    </>
  )

  const headBlock = pinned
    ? <div className="songs-pin" ref={headRef}>{pinned}{header}</div>
    : header

  if (scroll === 'page') {
    return (
      <div className={`songs-table songs-table--in-page ${className ?? ''}`} role="grid">
        {above}
        {headBlock}
        {body}
        {overlays}
      </div>
    )
  }
  return (
    <div
      className={`songs-view songs-table ${className ?? ''}`}
      ref={ownScrollerRef}
      role="grid"
      style={{ flex: 1, minHeight: 0 }}
    >
      {above}
      {headBlock}
      {body}
      <ScrollTopButton targetRef={ownScrollerRef} />
      {overlays}
    </div>
  )
}
