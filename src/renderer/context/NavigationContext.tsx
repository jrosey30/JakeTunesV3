import { createContext, useContext, useRef, useState, useEffect, useCallback, ReactNode } from 'react'
import { useLibrary } from './LibraryContext'
import { recordLocation, locationOf, restoreActionFor, canGoBack as histCanBack, canGoForward as histCanForward } from '../nav-history'
import type { NavLocation, NavHistory } from '../nav-history'
import { reopenSearch } from '../searchNav'
import { markHistoryNavigation } from '../navIntent'
import { HistorySwipeTracker, mouseButtonNav } from '../historySwipe'

/**
 * Browser-style back/forward history for the app's views.
 *
 * Deliberately an OBSERVER on top of LibraryContext (do-not-touch): it watches
 * the navigable fields of lib.state, records a history stack (pure logic in
 * nav-history.ts), and replays entries via the EXISTING actions (SET_VIEW /
 * VIEW_PLAYLIST / VIEW_SMART_PLAYLIST / VIEW_ARTIST_DETAIL / VIEW_ALBUM_DETAIL —
 * restoreActionFor, the same step the startup restore in App.tsx reopens the
 * saved page with). No reducer changes. goBack/goForward move the index first,
 * then dispatch a restore — so the resulting location change is recognized as
 * a landing (recordLocation returns the same state) rather than a new push.
 */

interface NavigationApi {
  canGoBack: boolean
  canGoForward: boolean
  goBack: () => void
  goForward: () => void
  /** Where goBack() will land (null at the start of history) — so a back
   *  button can name the page it actually returns to. */
  backTo: NavLocation | null
  /** goBack() will re-open a search instead (detail opened from search). */
  backToSearch: boolean
  /** Mark that the next navigation opens a detail FROM a search result, so the
   *  first back out of it re-opens the search dropdown with this query. */
  recordSearch: (query: string) => void
  /** The UI is up (App.tsx, uiReady): the page showing now is the FIRST page.
   *  Forgets the placeholder recorded before the saved page was restored (the
   *  reducer's initial view, which only ever showed behind the splash) —
   *  otherwise every launch offers Back, and the back pill, to a page nobody
   *  saw. */
  beginHistory: () => void
}

const NavigationContext = createContext<NavigationApi | null>(null)

export function NavigationProvider({ children }: { children: ReactNode }) {
  const { state: lib, dispatch } = useLibrary()
  // Each subject is captured ONLY while its view is showing (locationOf says
  // why: the reducer leaves pendingAlbumKey / activeArtist / activePlaylistId
  // lingering after you navigate away).
  const loc: NavLocation = locationOf(lib)

  // History in a ref (synchronous read/write across the observer + handlers);
  // `tick` just forces a repaint so derived canGoBack/Forward update.
  const navRef = useRef<NavHistory>({ history: [loc], index: 0 })
  const [, tick] = useState(0)
  const repaint = useCallback(() => tick((n) => n + 1), [])

  // Side-channel for search-as-destination: search isn't a view, so it can't
  // live in the history stack. Instead we remember the query + the index the
  // search-opened detail lands at; the first back from that index restores the
  // origin view AND re-opens the search dropdown.
  const searchReturnRef = useRef<{ query: string; atIndex: number } | null>(null)
  const recordSearch = useCallback((query: string) => {
    searchReturnRef.current = { query, atIndex: navRef.current.index + 1 }
  }, [])

  // The latest location, for beginHistory — called from a child's effect,
  // which runs before this provider's own recording effect in the same commit,
  // so the entry it starts from is the restored page.
  const locRef = useRef(loc)
  locRef.current = loc
  const beginHistory = useCallback(() => {
    navRef.current = { history: [locRef.current], index: 0 }
    searchReturnRef.current = null
    repaint()
  }, [repaint])

  // One rule for re-entering a page (nav-history.ts) — shared with the startup
  // restore in App.tsx, so a history entry and a saved page land identically.
  const restore = useCallback((t: NavLocation) => { dispatch(restoreActionFor(t)) }, [dispatch])

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
    const sr = searchReturnRef.current
    if (sr && sr.atIndex === s.index) {
      // On a detail opened from search → first back returns to the results:
      // restore the underlying origin view, then re-open the search dropdown.
      searchReturnRef.current = null
      if (s.index > 0) {
        navRef.current = { history: s.history, index: s.index - 1 }
        repaint()
        markHistoryNavigation()
        restore(navRef.current.history[navRef.current.index])
      }
      reopenSearch(sr.query)
      return
    }
    if (s.index <= 0) return
    searchReturnRef.current = null
    navRef.current = { history: s.history, index: s.index - 1 }
    repaint()
    markHistoryNavigation()
    restore(navRef.current.history[navRef.current.index])
  }, [restore, repaint])

  const goForward = useCallback(() => {
    const s = navRef.current
    if (s.index >= s.history.length - 1) return
    navRef.current = { history: s.history, index: s.index + 1 }
    repaint()
    markHistoryNavigation()
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

  // 2026-10-21 — parity with the phone's swipe-back. Every input below runs
  // the same goBack/goForward as ‹ › and ⌘[ ⌘] (so the same smooth return).
  useEffect(() => {
    const go = (d: 'back' | 'forward' | null): void => { if (d === 'back') goBack(); else if (d === 'forward') goForward() }
    // Mouse side buttons (MX Master's thumb buttons): button 3 / 4. Swallow
    // the press too, so Chromium's own history default never runs.
    const onMouseDown = (e: MouseEvent): void => { if (mouseButtonNav(e.button)) e.preventDefault() }
    const onMouseUp = (e: MouseEvent): void => {
      const d = mouseButtonNav(e.button)
      if (!d) return
      e.preventDefault()
      go(d)
    }
    // Two-finger horizontal swipe (historySwipe.ts has the rules). Never when
    // the gesture belongs to something under the pointer: Cover Flow's side
    // scroll preventDefaults it, and horizontal carousels scroll it.
    const tracker = new HistorySwipeTracker()
    const onWheel = (e: WheelEvent): void => {
      if (e.ctrlKey) return   // pinch-zoom
      // Only a sideways-dominant event pays for the ancestor walk (it reads
      // layout) — ordinary vertical scrolling stays free.
      const sideways = Math.abs(e.deltaX) > Math.abs(e.deltaY)
      const consumed = e.defaultPrevented || (sideways && insideHorizontalScroller(e.target))
      go(tracker.push({ t: e.timeStamp, dx: e.deltaX, dy: e.deltaY, consumed }))
    }
    // Main relays the older-style macOS 'swipe' (and Windows/Linux
    // browser-backward/forward app-commands) as menu actions.
    const offMenu = window.electronAPI.onMenuAction?.((action: string) => {
      if (action === 'history-back') goBack()
      else if (action === 'history-forward') goForward()
    })
    window.addEventListener('mousedown', onMouseDown)
    window.addEventListener('mouseup', onMouseUp)
    window.addEventListener('wheel', onWheel, { passive: true })
    return () => {
      window.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('mouseup', onMouseUp)
      window.removeEventListener('wheel', onWheel)
      offMenu?.()
    }
  }, [goBack, goForward])

  const api: NavigationApi = {
    canGoBack: histCanBack(navRef.current),
    canGoForward: histCanForward(navRef.current),
    goBack,
    goForward,
    backTo: navRef.current.index > 0 ? navRef.current.history[navRef.current.index - 1] : null,
    backToSearch: !!searchReturnRef.current && searchReturnRef.current.atIndex === navRef.current.index,
    recordSearch,
    beginHistory,
  }

  return <NavigationContext.Provider value={api}>{children}</NavigationContext.Provider>
}

/** Is `target` inside something that scrolls sideways (a carousel, a shelf row)? */
function insideHorizontalScroller(target: EventTarget | null): boolean {
  for (let el = target instanceof Element ? target : null; el && el !== document.body; el = el.parentElement) {
    if (el.scrollWidth > el.clientWidth + 1) {
      const ox = getComputedStyle(el).overflowX
      if (ox === 'auto' || ox === 'scroll') return true
    }
  }
  return false
}

export function useNavigation(): NavigationApi {
  const ctx = useContext(NavigationContext)
  if (!ctx) throw new Error('useNavigation must be inside NavigationProvider')
  return ctx
}
