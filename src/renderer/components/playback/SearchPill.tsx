import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import SearchPanel from './SearchPanel'
import { onReopenSearch } from '../../searchNav'
import { useLibrary } from '../../context/LibraryContext'
import { SMART_PLAYLIST_TITLES } from '../../utils/smartPlaylists'
import {
  SEARCH_SCOPE_KEY, parseSearchScope, resolveSearchScope, hasPageScope, pageScopeLabel,
  searchPlaceholder, pageKey, ownsFilterBox, type SearchScope,
} from '../../utils/searchScope'
import { getPageFilter, setPageFilter, subscribePageFilter } from '../../utils/pageFilter'

/**
 * Top-right search pill in the toolbar. Two scopes (Brief 254, Jake
 * 2026-11-20: "a switch thats either all of jaketunes search or library/page
 * search … i think they have this in apple music"):
 *
 *  - JakeTunes: the universal-search panel slides out beneath it on focus +
 *    non-empty query. Picking a row navigates (or plays) instead of
 *    filtering; the last row takes the words to the Record Shop's Search.
 *  - This page (Songs, Albums, Artists, a playlist, a smart playlist): the
 *    box filters the page in place, no dropdown. Songs and playlists read
 *    lib.searchQuery; Albums and Artists read their own box's value
 *    (utils/pageFilter.ts), which this box shares, so the two show the same
 *    words. A page change clears lib.searchQuery here (the reducer only clears
 *    it on SET_VIEW, and LibraryContext.tsx is do-not-touch).
 *
 * The switch shows while the box is focused on a page that has a scope; the
 * choice is remembered in ui-state.json (`searchScope`).
 *
 * 4.5.0-102: Custom caret tracking. The native browser caret has no
 * `caret-width` CSS property so we can't fatten it. Instead we hide it
 * always-when-focused and render a 2px-wide <span> positioned via a
 * hidden measure-span that mirrors the input value up to selectionStart.
 * Updates on input/keydown/keyup/click/select so the fake caret follows
 * the cursor everywhere it would normally land.
 */
const PILL_LEFT_PAD = 8        // .search-pill padding-left
const ICON_WIDTH = 12          // svg width
const ICON_MARGIN_RIGHT = 4    // .search-icon margin-right
const CARET_BASE_LEFT = PILL_LEFT_PAD + ICON_WIDTH + ICON_MARGIN_RIGHT

const PAGE_DEBOUNCE_MS = 120

export default function SearchPill() {
  const { state: lib, dispatch } = useLibrary()
  const [query, setQuery] = useState('')
  const [focused, setFocused] = useState(false)
  const [pref, setPref] = useState<SearchScope>('jaketunes')
  const scope = resolveSearchScope(pref, lib.currentView)
  const playlistName = lib.currentView === 'playlist'
    ? lib.playlists.find(p => p.id === lib.activePlaylistId)?.name ?? null
    : null
  const smartName = lib.currentView === 'smart-playlist' && lib.activeSmartPlaylist
    ? SMART_PLAYLIST_TITLES[lib.activeSmartPlaylist] ?? null
    : null
  const pageLabel = pageScopeLabel(lib.currentView, { playlistName, smartName })
  const showSwitch = hasPageScope(lib.currentView)
  // The page filter this box drives in "This page" mode.
  const ownBox = ownsFilterBox(lib.currentView) ? lib.currentView : null
  const ownBoxValue = useSyncExternalStore(subscribePageFilter, () => (ownBox ? getPageFilter(ownBox) : ''))
  const pageQuery = ownBox ? ownBoxValue : lib.searchQuery

  const [caretOffset, setCaretOffset] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const measureRef = useRef<HTMLSpanElement>(null)

  // Re-measure caret X-offset from input's selectionStart. Cheap (single
  // getBoundingClientRect on a span that holds the substring before the
  // cursor) — safe to call on every keystroke.
  const updateCaretOffset = () => {
    const input = inputRef.current
    const measure = measureRef.current
    if (!input || !measure) return
    const selStart = input.selectionStart ?? input.value.length
    measure.textContent = input.value.slice(0, selStart) || ''
    setCaretOffset(measure.getBoundingClientRect().width)
  }

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setQuery('')
        el.blur()
        setFocused(false)
        // In "This page" the filter goes too (a no-op in JakeTunes, where
        // nothing was written).
        if (scopeRef.current === 'page') { cancelPending(); writeRef.current('') }
      }
      // Arrow keys / home / end shift selectionStart without firing
      // onChange; remeasure on keyup so the caret tracks.
      requestAnimationFrame(updateCaretOffset)
    }
    el.addEventListener('keydown', onKey)
    el.addEventListener('keyup', updateCaretOffset)
    el.addEventListener('click', updateCaretOffset)
    el.addEventListener('select', updateCaretOffset)
    return () => {
      el.removeEventListener('keydown', onKey)
      el.removeEventListener('keyup', updateCaretOffset)
      el.removeEventListener('click', updateCaretOffset)
      el.removeEventListener('select', updateCaretOffset)
    }
  }, [])

  // Re-measure when value changes (typing, programmatic clear).
  useEffect(() => {
    requestAnimationFrame(updateCaretOffset)
  }, [query])

  // The remembered scope (per Mac, ui-state.json).
  useEffect(() => {
    let live = true
    window.electronAPI.loadUiState()
      .then((r) => { if (live && r.ok && r.state) setPref(parseSearchScope(r.state[SEARCH_SCOPE_KEY])) })
      .catch(() => undefined)
    return () => { live = false }
  }, [])

  // ── "This page": the box writes the page's filter, debounced. ──
  const sentRef = useRef<string | null>(null)   // the last value this box wrote
  const timerRef = useRef<number | null>(null)
  const writePageFilter = useCallback((q: string) => {
    sentRef.current = q
    if (ownBox) setPageFilter(ownBox, q)
    else if (lib.searchQuery !== q) dispatch({ type: 'SET_SEARCH', query: q })
  }, [ownBox, lib.searchQuery, dispatch])
  const writeRef = useRef(writePageFilter)
  writeRef.current = writePageFilter
  const cancelPending = (): void => {
    if (timerRef.current !== null) { window.clearTimeout(timerRef.current); timerRef.current = null }
  }
  useEffect(() => () => cancelPending(), [])

  const onType = (v: string): void => {
    setQuery(v)
    if (scope !== 'page') return
    cancelPending()
    if (!v.trim()) { writeRef.current(''); return }   // clearing is at once
    timerRef.current = window.setTimeout(() => { timerRef.current = null; writeRef.current(v) }, PAGE_DEBOUNCE_MS)
  }

  // The page's filter changed under the box (the page's own box, a page
  // change, App's Escape): show it. Our own write echoing back is ignored.
  useEffect(() => {
    if (scope !== 'page') return
    if (pageQuery === sentRef.current) return
    cancelPending()
    sentRef.current = pageQuery
    setQuery(pageQuery)
  }, [scope, pageQuery])

  // A page filter belongs to one page. lib.searchQuery survives VIEW_PLAYLIST,
  // VIEW_SMART_PLAYLIST and the detail actions (only SET_VIEW clears it), so a
  // filter typed on Songs would follow you into a playlist: clear it on any
  // page change, before the new page paints. And a scope that ends because
  // the page changed takes its words with it.
  const here = pageKey(lib.currentView, lib.activePlaylistId, lib.activeSmartPlaylist)
  const hereRef = useRef(here)
  const scopeRef = useRef(scope)
  useLayoutEffect(() => {
    if (hereRef.current === here) return
    hereRef.current = here
    cancelPending()
    if (lib.searchQuery) dispatch({ type: 'SET_SEARCH', query: '' })
    if (scopeRef.current === 'page') { sentRef.current = null; setQuery('') }
  }, [here, lib.searchQuery, dispatch])
  useEffect(() => { scopeRef.current = scope }, [scope])

  const chooseScope = (next: SearchScope): void => {
    if (next === scope) return
    setPref(next)
    void window.electronAPI.saveUiState({ [SEARCH_SCOPE_KEY]: next }).catch(() => undefined)
    cancelPending()
    if (next === 'page') {
      writePageFilter(query.trim() ? query : '')
    } else {
      // The words stay in the box and now search JakeTunes; the page unfilters.
      sentRef.current = null
      if (ownBox) setPageFilter(ownBox, '')
      else if (lib.searchQuery) dispatch({ type: 'SET_SEARCH', query: '' })
    }
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  // Search-as-destination: when "back" lands on a detail that was opened from a
  // search result, the NavigationContext fires reopenSearch — restore the query
  // + focus so the SearchPanel re-appears with the same results.
  useEffect(() => onReopenSearch((q) => {
    setQuery(q)
    setFocused(true)
    requestAnimationFrame(() => inputRef.current?.focus())
  }), [])

  const panelOpen = scope === 'jaketunes' && focused && query.trim().length > 0

  // JakeTunes | <page>. Buttons keep the box focused (mousedown is eaten), so
  // flipping the switch never closes it.
  const scopeSwitch = showSwitch && pageLabel ? (
    <div className="search-scope" role="radiogroup" aria-label="Search in">
      {(['jaketunes', 'page'] as const).map((s) => (
        <button
          key={s}
          type="button"
          role="radio"
          aria-checked={scope === s}
          className={`search-scope-btn${scope === s ? ' search-scope-btn--on' : ''}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => chooseScope(s)}
          title={s === 'jaketunes' ? 'Search all of JakeTunes' : `Filter ${pageLabel}`}
        >
          {s === 'jaketunes' ? 'JakeTunes' : pageLabel}
        </button>
      ))}
    </div>
  ) : null

  return (
    <div className="search-pill" style={{ position: 'relative' }}>
      <svg className="search-icon" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="#999" strokeWidth="1.5">
        <circle cx="5" cy="5" r="3.5" />
        <path d="M7.5 7.5L10.5 10.5" strokeLinecap="round" />
      </svg>
      <input
        ref={inputRef}
        type="text"
        className="search-input"
        placeholder={searchPlaceholder(scope, pageLabel)}
        value={query}
        onChange={(e) => onType(e.target.value)}
        onFocus={() => { setFocused(true); requestAnimationFrame(updateCaretOffset) }}
        onBlur={(e) => {
          // SearchPanel result rows are divs (not focusable buttons), so
          // clicking one blurs the input BEFORE its onClick fires. If we
          // synchronously setFocused(false) we unmount the panel and the
          // click is lost. Defer so the click lands first. Also bail out
          // if focus is moving to anything inside the pill (clear button,
          // future focusable panel items).
          const pill = (e.currentTarget as HTMLInputElement).closest('.search-pill')
          const next = e.relatedTarget as Node | null
          if (pill && next && pill.contains(next)) return
          setTimeout(() => setFocused(false), 150)
        }}
      />
      {/* Hidden span that mirrors the substring before the caret, used to
          measure horizontal pixel offset. Must inherit the input's font. */}
      <span ref={measureRef} className="search-caret-measure" aria-hidden="true" />
      {focused && (
        <span
          className="search-fake-caret"
          style={{ left: `${CARET_BASE_LEFT + caretOffset}px` }}
          aria-hidden="true"
        />
      )}
      {query && (
        <button className="search-clear" onClick={() => {
          onType('')
          inputRef.current?.focus()
        }}>×</button>
      )}
      {focused && !panelOpen && scopeSwitch && (
        <div className="search-panel search-panel--scope-only">{scopeSwitch}</div>
      )}
      {panelOpen && (
        <SearchPanel
          query={query}
          header={scopeSwitch}
          inputEl={inputRef.current}
          onClose={() => {
            // Blur too, not just clear: a still-focused input keeps
            // swallowing Space (types instead of pausing after Enter-to-
            // play) and makes the next ⌘F a no-op focus() that never
            // fires onFocus, so the panel can't reopen.
            setQuery('')
            setFocused(false)
            inputRef.current?.blur()
          }}
        />
      )}
    </div>
  )
}
