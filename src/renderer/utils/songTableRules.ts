/**
 * The rules of the one song table (V7, 2026-11-24) — the pure part, tested in
 * src/main/__tests__/song-table.test.ts. components/SongTable.tsx draws it.
 *
 * The song list used to be built six times (Songs, a playlist, a smart
 * playlist, an album, Genres, an iPod's playlist) and the six had drifted:
 * different columns, two of them unsortable, three menus in three orders,
 * one with no arrow keys, one that said "this song" for twelve. Everything a
 * list does with its songs is decided here once:
 *
 *   columns        SONG_COLUMNS: one set, BPM / Key / Subgenre on every page
 *   sorting        nextSort: ascending → descending → back to the list's own
 *                  order, which every page calls "Original Order"
 *   the menu       assembleSongMenu: the same entries, in the same order
 *   delete words   deleteSongsWording / removedFromListNotice: one vs many
 *   dragging       dragLabel ("12 Songs") and moveRows (multi-row reorder)
 */
import type { MenuEntry } from '../components/ContextMenu'
import type { SortColumn, SortDirection } from '../types'
import { sortTracksByName } from './artistSort.ts'
import { DATE_TIME_COLUMN_WIDTH } from './columnState.ts'
import {
  lastPlayedEverywhere, NO_PLAYS_ELSEWHERE, playsEverywhere, type ElsewhereOverlay,
} from '../../common/plays-elsewhere.ts'

// ── Columns ──────────────────────────────────────────────────────────────

export type SongColumnKey = SortColumn | 'playing'

export interface SongColumn {
  key: SongColumnKey
  label: string
  defaultWidth: number
  minWidth: number
  resizable: boolean
  /** Every column but the now-playing speaker sorts — Time included. */
  sortable: boolean
}

/** The table's columns, in their default left-to-right order. One set for
 *  every page; which are shown, their widths and their order are Jake's,
 *  saved once (utils/columnState.ts) and shared by every page. */
export const SONG_COLUMNS: readonly SongColumn[] = [
  { key: 'playing', label: '', defaultWidth: 24, minWidth: 24, resizable: false, sortable: false },
  { key: 'title', label: 'Name', defaultWidth: 240, minWidth: 80, resizable: true, sortable: true },
  { key: 'time', label: 'Time', defaultWidth: 50, minWidth: 40, resizable: true, sortable: true },
  { key: 'artist', label: 'Artist', defaultWidth: 180, minWidth: 60, resizable: true, sortable: true },
  { key: 'album', label: 'Album', defaultWidth: 180, minWidth: 60, resizable: true, sortable: true },
  { key: 'genre', label: 'Genre', defaultWidth: 100, minWidth: 50, resizable: true, sortable: true },
  // 2026-10-11 (Jake): where the artist is from — the genre says the sound,
  // Origin says the place. MusicBrainz country; blank when unknown. Visible.
  { key: 'origin', label: 'Origin', defaultWidth: 120, minWidth: 60, resizable: true, sortable: true },
  // AI-assigned subgenre; hover a cell for the general→specific path. Hidden by default.
  { key: 'subgenre', label: 'Subgenre', defaultWidth: 150, minWidth: 60, resizable: true, sortable: true },
  { key: 'year', label: 'Year', defaultWidth: 50, minWidth: 35, resizable: true, sortable: true },
  // 2026-11-05 (Jake): 1/2/2004 5:56:02 PM, and a Last Played beside it in the same form.
  { key: 'dateAdded', label: 'Date Added', defaultWidth: DATE_TIME_COLUMN_WIDTH, minWidth: DATE_TIME_COLUMN_WIDTH, resizable: true, sortable: true },
  { key: 'lastPlayedAt', label: 'Last Played', defaultWidth: DATE_TIME_COLUMN_WIDTH, minWidth: DATE_TIME_COLUMN_WIDTH, resizable: true, sortable: true },
  { key: 'playCount', label: 'Plays', defaultWidth: 50, minWidth: 35, resizable: true, sortable: true },
  { key: 'channelMode', label: 'Channels', defaultWidth: 70, minWidth: 50, resizable: true, sortable: true },
  // 2026-07-31 (Jake): BPM + Camelot for harmonic mixing. Hidden by default.
  { key: 'bpm', label: 'BPM', defaultWidth: 55, minWidth: 40, resizable: true, sortable: true },
  { key: 'camelotKey', label: 'Key', defaultWidth: 55, minWidth: 40, resizable: true, sortable: true },
  // The star is not a column: it sits after the title (hover to see it unstarred).
]

/**
 * The columns drawn when a page's lead column shows the playing speaker itself
 * (the Top 1000's '#'): the table's own speaker column goes, widths with it,
 * so no empty column sits between the '#' and Name. Pure; `widths` lines up
 * with `visible`.
 */
export function withoutPlayingColumn<C extends { key: string }>(visible: readonly C[], widths: readonly number[], leadShowsPlaying: boolean): { visible: C[]; widths: number[] } {
  if (!leadShowsPlaying) return { visible: visible.slice(), widths: widths.slice() }
  const keep = visible.map((c, i) => ({ c, w: widths[i] })).filter((x) => x.c.key !== 'playing')
  return { visible: keep.map((x) => x.c), widths: keep.map((x) => x.w) }
}

/** Columns the header's picker can't hide. */
export const ALWAYS_VISIBLE: ReadonlySet<string> = new Set(['playing', 'title'])

export const SONG_COLUMN_KEYS: readonly string[] = SONG_COLUMNS.map((c) => c.key)

// ── Sorting ──────────────────────────────────────────────────────────────

/** A column sort. `null` is the list's own order. */
export interface SongSort { column: SortColumn; direction: SortDirection }

/** What the header picker and every page call the list's own order. */
export const ORIGINAL_ORDER = 'Original Order'

/**
 * A header click: a new column sorts ascending, the sorted column turns
 * descending, and a third click goes back to the list's own order.
 */
export function nextSort(cur: SongSort | null, column: SortColumn): SongSort | null {
  if (!cur || cur.column !== column) return { column, direction: 'asc' }
  if (cur.direction === 'asc') return { column, direction: 'desc' }
  return null
}

const SORT_COLUMNS: ReadonlySet<string> = new Set(SONG_COLUMNS.filter((c) => c.sortable).map((c) => c.key))

/**
 * The Songs sort read back from ui-state at launch (App.tsx saves
 * `sortColumn` / `sortDirection`). `null` = Original Order was saved and is
 * restored as such; `undefined` = nothing usable was saved, keep the default.
 */
export function savedSongsSort(ui: { sortColumn?: unknown; sortDirection?: unknown }): SongSort | null | undefined {
  if (ui.sortColumn === null) return null
  if (typeof ui.sortColumn !== 'string' || !SORT_COLUMNS.has(ui.sortColumn)) return undefined
  return { column: ui.sortColumn as SortColumn, direction: ui.sortDirection === 'desc' ? 'desc' : 'asc' }
}

/** One row's sort fields (a Track has them all). */
export interface SortableSong {
  id: number
  title?: string
  artist?: string
  album?: string
  albumArtist?: string
  genre?: string
  subgenre?: string
  origin?: string
  year?: number | string
  duration?: number
  dateAdded?: string
  lastPlayedAt?: number
  playCount?: number
  rating?: number
  channelMode?: string
  bpm?: number
  camelotKey?: string
}

const camelot = (v: unknown): [number, string] => {
  const m = /^(\d{1,2})([AB])$/i.exec(String(v ?? '').trim())
  return m ? [Number(m[1]), m[2].toUpperCase()] : [999, 'Z']
}

/**
 * Sort a list by one column. Numbers compare as numbers (100 after 72),
 * Artist and Album the way the Artists page does ("The Strokes" under S),
 * Key around the Camelot wheel (1A 1B 2A …), Plays and Last Played counting
 * the phone and workmini too. `null` returns the list as it came. Stable:
 * ties keep the list's own order.
 */
export function sortSongs<T extends SortableSong>(
  tracks: readonly T[],
  sort: SongSort | null,
  elsewhere: ElsewhereOverlay = NO_PLAYS_ELSEWHERE,
): T[] {
  if (!sort) return tracks.slice()
  const { column, direction } = sort
  if (column === 'artist' || column === 'album') return sortTracksByName(tracks as T[], column, direction)
  const value = (t: T): unknown => {
    switch (column) {
      case 'time': return t.duration
      case 'playCount': return playsEverywhere(t as never, elsewhere)
      case 'lastPlayedAt': return lastPlayedEverywhere(t as never, elsewhere)
      default: return (t as unknown as Record<string, unknown>)[column]
    }
  }
  const sign = direction === 'asc' ? 1 : -1
  return tracks
    .map((t, i) => ({ t, i, v: value(t) }))
    .sort((a, b) => {
      let cmp: number
      if (column === 'camelotKey') {
        const [an, al] = camelot(a.v)
        const [bn, bl] = camelot(b.v)
        cmp = an !== bn ? an - bn : (al < bl ? -1 : al > bl ? 1 : 0)
      } else {
        const an = Number(a.v)
        const bn = Number(b.v)
        const bothNumeric = a.v != null && b.v != null && a.v !== '' && b.v !== ''
          && Number.isFinite(an) && Number.isFinite(bn)
        if (bothNumeric) cmp = an - bn
        else {
          const as = String(a.v ?? '').toLowerCase()
          const bs = String(b.v ?? '').toLowerCase()
          cmp = as < bs ? -1 : as > bs ? 1 : 0
        }
      }
      return cmp !== 0 ? cmp * sign : a.i - b.i
    })
    .map((x) => x.t)
}

/** The "This page" filter: every word typed appears somewhere in the row. */
export function filterSongs<T extends SortableSong>(tracks: readonly T[], query: string): T[] {
  const words = (query || '').toLowerCase().split(/\s+/).filter((w) => w.length > 0)
  if (words.length === 0) return tracks as T[]
  return tracks.filter((t) => {
    const hay = `${t.title || ''} ${t.artist || ''} ${t.album || ''} ${t.genre || ''} ${t.subgenre || ''} ${t.origin || ''} ${t.year || ''}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}

// ── Delete, remove, drag ─────────────────────────────────────────────────

/** The question before songs leave the library — right for one or many. */
export function deleteSongsWording(count: number, alsoLeaves?: string): { message: string; detail: string } {
  // Deleting from a smart list or an iPod's list takes the songs off it too: say so by name.
  const also = alsoLeaves ? ` ${count === 1 ? 'It' : 'They'} also ${count === 1 ? 'leaves' : 'leave'} ${alsoLeaves}.` : ''
  return count === 1
    ? {
        message: 'Are you sure you want to delete this song from your library?',
        detail: `This will remove it from all playlists.${also} This cannot be undone.`,
      }
    : {
        message: `Are you sure you want to delete ${count} songs from your library?`,
        detail: `This will remove them from all playlists.${also} This cannot be undone.`,
      }
}

/** The Undo toast's line after songs come out of a list (not the library). */
export function removedFromListNotice(count: number, listName: string): string {
  return `Removed ${count === 1 ? '1 song' : `${count} songs`} from “${listName}”`
}

/** The drag preview: the song's name for one, "12 Songs" for more. */
export function dragLabel(songs: ReadonlyArray<{ title?: string }>): string {
  if (songs.length === 1) return songs[0].title || '1 Song'
  return `${songs.length} Songs`
}

/**
 * Multi-row reorder. `order` is the list's ids; the `moving` ids (in any
 * order — they keep the list's) go in before the row that sat at `toIndex`
 * (order.length = the end). A drop inside the moving block changes nothing.
 */
export function moveRows(order: readonly number[], moving: ReadonlyArray<number>, toIndex: number): number[] {
  const set = new Set(moving)
  const block = order.filter((id) => set.has(id))
  if (block.length === 0) return order.slice()
  const at = Math.max(0, Math.min(order.length, toIndex))
  // The first id at or after the drop point that stays put; the block goes before it.
  let anchor: number | null = null
  for (let i = at; i < order.length; i++) if (!set.has(order[i])) { anchor = order[i]; break }
  const rest = order.filter((id) => !set.has(id))
  const pos = anchor === null ? rest.length : rest.indexOf(anchor)
  return [...rest.slice(0, pos), ...block, ...rest.slice(pos)]
}

// ── Long lists (hooks/useRowWindow.ts draws only these rows) ──────────────

export interface RowWindow { start: number; end: number }

/** The rows to draw for a scroll position: the ones in view plus `overscan`
 *  each side. `bodyTop` lets the list start below other content. */
export function rowWindow(opts: {
  count: number
  rowHeight: number
  /** Where the first row sits inside the scroller's content. */
  bodyTop: number
  scrollTop: number
  viewHeight: number
  overscan: number
}): RowWindow {
  const { count, rowHeight, bodyTop, scrollTop, viewHeight, overscan } = opts
  if (count <= 0) return { start: 0, end: 0 }
  const top = scrollTop - bodyTop
  const first = Math.floor(top / rowHeight)
  const last = Math.ceil((top + Math.max(viewHeight, rowHeight)) / rowHeight)
  const start = Math.max(0, Math.min(count, first - overscan))
  const end = Math.max(start, Math.min(count, last + overscan))
  return { start, end }
}

// ── The menu ─────────────────────────────────────────────────────────────

/**
 * The song menu's first ten entries, in this order on every page (Jake, V7):
 * Play Next, Add to Up Next, Add to Playlist ▸, Add to iPod Playlist ▸, Go to
 * Album, Go to Artist, Star, Download, Share…, Get Info. `menuSlot` names an
 * entry by its slot whatever its label says right now ("Unstar", "Remove
 * Download", "Download 3 Songs").
 */
export const SONG_MENU_CORE = [
  'play-next', 'up-next', 'playlist', 'ipod-playlist', 'go-album', 'go-artist', 'star', 'download', 'share', 'get-info',
] as const
export type SongMenuSlot = (typeof SONG_MENU_CORE)[number]

export function menuSlot(label: string): SongMenuSlot | null {
  if (label === 'Play Next') return 'play-next'
  if (label === 'Add to Up Next') return 'up-next'
  if (label === 'Add to Playlist') return 'playlist'
  if (label === 'Add to iPod Playlist') return 'ipod-playlist'
  if (label === 'Go to Album') return 'go-album'
  if (label === 'Go to Artist') return 'go-artist'
  if (label === 'Star' || label === 'Unstar') return 'star'
  if (/^(Download|Downloading|Remove (\d+ )?Download)/.test(label)) return 'download'
  if (label === 'Share…') return 'share'
  if (label === 'Get Info') return 'get-info'
  return null
}

export interface SongMenuParts {
  /** Only surfaces without a double-click to play (the Home's cards). */
  play?: MenuEntry
  /** Play Next, Add to Up Next. */
  queue: MenuEntry[]
  playlist: MenuEntry
  ipodPlaylist: MenuEntry
  goAlbum: MenuEntry
  goArtist: MenuEntry
  star: MenuEntry
  /** Absent on a Mac that keeps every song (nothing to download). */
  download?: MenuEntry
  share: MenuEntry
  getInfo: MenuEntry
  /** Artist radio, the tape, artwork, Cynthia — after the ten. */
  more: MenuEntry[]
  /** The page's own (Remove from Playlist, Make a Mixtape…). */
  extras: MenuEntry[]
  /** Delete Song — only where deleting from the library is the page's job. */
  del?: MenuEntry
}

const sep: MenuEntry = { separator: true as const }

/** The menu, in its one order, with separators between its groups. */
export function assembleSongMenu(p: SongMenuParts): MenuEntry[] {
  const groups: MenuEntry[][] = [
    p.play ? [p.play] : [],
    p.queue,
    [p.playlist, p.ipodPlaylist],
    [p.goAlbum, p.goArtist],
    [p.star, ...(p.download ? [p.download] : []), p.share, p.getInfo],
    p.more,
    p.extras,
    p.del ? [p.del] : [],
  ]
  const out: MenuEntry[] = []
  for (const g of groups) {
    const items = g.filter((m) => !m.separator)
    if (items.length === 0) continue
    if (out.length) out.push(sep)
    out.push(...g.filter((m, i) => !(m.separator && (i === 0 || i === g.length - 1))))
  }
  return out
}

/** One iPod's playlists Jake made, for the "Add to iPod Playlist ▸" flyout. */
export interface IpodMenuGroup {
  ipodName: string
  playlists: ReadonlyArray<{ name: string; onClick: () => void }>
}

/**
 * "Add to iPod Playlist ▸" — ONE entry (it used to be one entry per iPod).
 * Its flyout names each iPod (greyed, as a heading) with that iPod's own
 * playlists under it. With none made yet it is there, greyed, so it is found.
 */
export function ipodPlaylistMenuEntry(groups: readonly IpodMenuGroup[]): MenuEntry {
  const withLists = groups.filter((g) => g.playlists.length > 0)
  if (withLists.length === 0) return { label: 'Add to iPod Playlist', disabled: true }
  const submenu: MenuEntry[] = []
  for (const g of withLists) {
    if (submenu.length) submenu.push(sep)
    submenu.push({ label: g.ipodName, disabled: true })
    for (const p of g.playlists) submenu.push({ label: p.name, onClick: p.onClick })
  }
  return { label: 'Add to iPod Playlist', submenu }
}
