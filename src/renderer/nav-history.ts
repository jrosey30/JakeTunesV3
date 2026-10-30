/**
 * Pure history-stack logic for NavigationContext, extracted so the tricky
 * "new navigation vs back/forward landing" decision can be unit-tested (the
 * React context + effect that drive it can't be exercised headlessly).
 *
 * `view` is kept as a plain string here to stay dependency-free at runtime
 * (the only import is types); restoreActionFor casts back to ViewName /
 * SmartPlaylistId when it builds the dispatch (every value stored originated
 * from those typed fields).
 */
import type { ViewName, SmartPlaylistId } from './types'

export interface NavLocation {
  view: string
  playlistId: string | null
  smartPlaylistId: string | null
  artist: string | null
  albumKey: string | null
}

export interface NavHistory {
  history: NavLocation[]
  index: number
}

export function sameLoc(a: NavLocation | undefined, b: NavLocation | undefined): boolean {
  return (
    !!a && !!b &&
    a.view === b.view &&
    a.playlistId === b.playlistId &&
    a.smartPlaylistId === b.smartPlaylistId &&
    a.artist === b.artist &&
    a.albumKey === b.albumKey
  )
}

/**
 * Record a location change. If it equals the entry at the current index (a
 * back/forward landing, or a redundant re-dispatch), returns the SAME state
 * object unchanged (identity-comparable). Otherwise it's a NEW navigation:
 * drop any forward entries and push, capping the stack length.
 */
export function recordLocation(state: NavHistory, loc: NavLocation, max = 100): NavHistory {
  if (sameLoc(loc, state.history[state.index])) return state
  const next = state.history.slice(0, state.index + 1)
  next.push(loc)
  const trimmed = next.length > max ? next.slice(next.length - max) : next
  return { history: trimmed, index: trimmed.length - 1 }
}

export function canGoBack(state: NavHistory): boolean {
  return state.index > 0
}

export function canGoForward(state: NavHistory): boolean {
  return state.index < state.history.length - 1
}

/** The navigable slice of LibraryState a location is read from. */
export interface NavigableState {
  currentView: string
  activePlaylistId: string | null
  activeSmartPlaylist: string | null
  activeArtist: string | null
  pendingAlbumKey: string | null
}

/**
 * Where the app is, read from the library state. Each subject is captured ONLY
 * while its own view is showing: the reducer leaves activePlaylistId /
 * activeArtist / pendingAlbumKey lingering after you navigate away (SET_VIEW
 * only swaps currentView), so reading them unconditionally would make two
 * visits to e.g. Albums look like different places and corrupt the stack —
 * and would let a playlist you visited an hour ago define where you are now.
 */
export function locationOf(s: NavigableState): NavLocation {
  return {
    view: s.currentView,
    playlistId: s.currentView === 'playlist' ? s.activePlaylistId : null,
    smartPlaylistId: s.currentView === 'smart-playlist' ? s.activeSmartPlaylist : null,
    artist: s.currentView === 'artist-detail' ? s.activeArtist : null,
    albumKey: s.currentView === 'album-detail' ? s.pendingAlbumKey : null,
  }
}

/** The existing reducer actions that re-enter a page (no reducer changes). */
export type RestoreAction =
  | { type: 'SET_VIEW'; view: ViewName }
  | { type: 'VIEW_PLAYLIST'; id: string }
  | { type: 'VIEW_SMART_PLAYLIST'; id: SmartPlaylistId }
  | { type: 'VIEW_ARTIST_DETAIL'; artistName: string }
  | { type: 'VIEW_ALBUM_DETAIL'; albumKey: string }

/**
 * The ONE action that re-enters `t` — Back / Forward replay a history entry
 * with it, and the startup restore (App.tsx) reopens the saved page with it,
 * so a history entry and a saved page re-enter identically. A detail page
 * whose subject is missing can't be re-entered: it falls back to the browse
 * root it belongs to (Albums / Artists / Songs).
 */
export function restoreActionFor(t: NavLocation): RestoreAction {
  switch (t.view) {
    case 'playlist':
      return t.playlistId ? { type: 'VIEW_PLAYLIST', id: t.playlistId } : { type: 'SET_VIEW', view: 'songs' }
    case 'smart-playlist':
      return t.smartPlaylistId
        ? { type: 'VIEW_SMART_PLAYLIST', id: t.smartPlaylistId as SmartPlaylistId }
        : { type: 'SET_VIEW', view: 'songs' }
    case 'artist-detail':
      return t.artist ? { type: 'VIEW_ARTIST_DETAIL', artistName: t.artist } : { type: 'SET_VIEW', view: 'artists' }
    case 'album-detail':
      return t.albumKey ? { type: 'VIEW_ALBUM_DETAIL', albumKey: t.albumKey } : { type: 'SET_VIEW', view: 'albums' }
    default:
      return { type: 'SET_VIEW', view: t.view as ViewName }
  }
}

/**
 * The page to reopen on, from the saved ui-state (App.tsx writes currentView
 * plus the subjects of the views that have one). Read with the same rule as
 * locationOf — a subject counts only for the view that was showing — because
 * the lingering ids are saved too: an album page saved next to the id of a
 * playlist you visited earlier must reopen as that album, not as the playlist
 * (Jake 2026-10-30: "I flip from Perfecth to a playlist page, and I don't have
 * any way of going back to the Perfecth page"). No saved view → Home. The
 * hidden Record Store placeholder has no sidebar entry to leave by, so a
 * session that ended there reopens on Songs (4.5.0-63).
 */
export function savedLocation(ui: Record<string, unknown> | null | undefined): NavLocation {
  const str = (k: string): string | null => { const v = ui?.[k]; return typeof v === 'string' ? v : null }
  const saved = str('currentView')
  const view = saved === null ? 'home' : saved === 'recordstore' ? 'songs' : saved
  return locationOf({
    currentView: view,
    activePlaylistId: str('activePlaylistId'),
    activeSmartPlaylist: str('activeSmartPlaylist'),
    activeArtist: str('activeArtist'),
    pendingAlbumKey: str('pendingAlbumKey'),
  })
}
