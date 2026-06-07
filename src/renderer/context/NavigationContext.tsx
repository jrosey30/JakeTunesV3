import { createContext, useContext, useRef, useState, useEffect, useCallback, ReactNode } from 'react'
import { useLibrary } from './LibraryContext'
import type { ViewName, SmartPlaylistId } from '../types'
import { recordLocation, canGoBack as histCanBack, canGoForward as histCanForward } from '../nav-history'
import type { NavLocation, NavHistory } from '../nav-history'

/**
 * Browser-style back/forward history for the app's views.
 *
 * Deliberately an OBSERVER on top of LibraryContext (do-not-touch): it watches
 * the navigable fields of lib.state, records a history stack (pure logic in
 * nav-history.ts), and replays entries via the EXISTING actions (SET_VIEW /
 * VIEW_PLAYLIST / VIEW_SMART_PLAYLIST / VIEW_ARTIST_DETAIL / VIEW_ALBUM_DETAIL).
 * No reducer changes. goBack/goForward move the index first, then dispatch a
 * restore — so the resulting location change is recognized as a landing
 * (recordLocation returns the same state) rather than a new push.
 */

interface NavigationApi {
  canGoBack: boolean
  canGoForward: boolean
  goBack: () => void
  goForward: () => void
}

const NavigationContext = createContext<NavigationApi | null>(null)

export function NavigationProvider({ children }: { children: ReactNode }) {
  const { state: lib, dispatch } = useLibrary()
  // Capture each key ONLY when its view is active. The reducer leaves
  // pendingAlbumKey / activeArtist / activePlaylistId lingering after you
  // navigate away (SET_VIEW only swaps currentView), so reading them
  // unconditionally would make two visits to e.g. "Albums" look like
  // different locations and corrupt the back/forward stack.
  const loc: NavLocation = {
    view: lib.currentView,
    playlistId: lib.currentView === 'playlist' ? lib.activePlaylistId : null,
    smartPlaylistId: lib.currentView === 'smart-playlist' ? lib.activeSmartPlaylist : null,
    artist: lib.currentView === 'artist-detail' ? lib.activeArtist : null,
    albumKey: lib.currentView === 'album-detail' ? lib.pendingAlbumKey : null,
  }

  // History in a ref (synchronous read/write across the observer + handlers);
  // `tick` just forces a repaint so derived canGoBack/Forward update.
  const navRef = useRef<NavHistory>({ history: [loc], index: 0 })
  const [, tick] = useState(0)
  const repaint = useCallback(() => tick((n) => n + 1), [])

  const restore = useCallback((t: NavLocation) => {
    switch (t.view) {
      case 'playlist':
        if (t.playlistId) dispatch({ type: 'VIEW_PLAYLIST', id: t.playlistId })
        else dispatch({ type: 'SET_VIEW', view: 'songs' })
        break
      case 'smart-playlist':
        if (t.smartPlaylistId) dispatch({ type: 'VIEW_SMART_PLAYLIST', id: t.smartPlaylistId as SmartPlaylistId })
        else dispatch({ type: 'SET_VIEW', view: 'songs' })
        break
      case 'artist-detail':
        if (t.artist) dispatch({ type: 'VIEW_ARTIST_DETAIL', artistName: t.artist })
        else dispatch({ type: 'SET_VIEW', view: 'artists' })
        break
      case 'album-detail':
        if (t.albumKey) dispatch({ type: 'VIEW_ALBUM_DETAIL', albumKey: t.albumKey })
        else dispatch({ type: 'SET_VIEW', view: 'albums' })
        break
      default:
        dispatch({ type: 'SET_VIEW', view: t.view as ViewName })
    }
  }, [dispatch])

  // Record location changes. recordLocation returns the SAME object on a
  // back/forward landing (index already moved) or a no-op → identity check
  // tells us whether anything actually changed.
  useEffect(() => {
    const prev = navRef.current
    const next = recordLocation(prev, loc)
    if (next === prev) return
    navRef.current = next
    repaint()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.view, loc.playlistId, loc.smartPlaylistId, loc.artist, loc.albumKey])

  const goBack = useCallback(() => {
    const s = navRef.current
    if (s.index <= 0) return
    navRef.current = { history: s.history, index: s.index - 1 }
    repaint()
    restore(navRef.current.history[navRef.current.index])
  }, [restore, repaint])

  const goForward = useCallback(() => {
    const s = navRef.current
    if (s.index >= s.history.length - 1) return
    navRef.current = { history: s.history, index: s.index + 1 }
    repaint()
    restore(navRef.current.history[navRef.current.index])
  }, [restore, repaint])

  // ⌘[ / ⌘] (ctrl on non-mac) — skip while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === '[') { e.preventDefault(); goBack() }
      else if (e.key === ']') { e.preventDefault(); goForward() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [goBack, goForward])

  const api: NavigationApi = {
    canGoBack: histCanBack(navRef.current),
    canGoForward: histCanForward(navRef.current),
    goBack,
    goForward,
  }

  return <NavigationContext.Provider value={api}>{children}</NavigationContext.Provider>
}

export function useNavigation(): NavigationApi {
  const ctx = useContext(NavigationContext)
  if (!ctx) throw new Error('useNavigation must be inside NavigationProvider')
  return ctx
}
