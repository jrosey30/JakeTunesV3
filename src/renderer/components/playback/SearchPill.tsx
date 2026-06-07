import { useEffect, useRef, useState } from 'react'
import SearchPanel from './SearchPanel'
import { onReopenSearch } from '../../searchNav'

/**
 * Top-right search pill in the toolbar. 4.5: now hosts the universal-
 * search panel that slides out beneath it on focus + non-empty query.
 * The pill owns its own LOCAL query state — it intentionally does NOT
 * write to lib.searchQuery, so the main song/album/artist views don't
 * also filter in lockstep. Universal search is the canonical search;
 * picking a row navigates instead of filtering.
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

export default function SearchPill() {
  const [query, setQuery] = useState('')
  const [focused, setFocused] = useState(false)
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

  // Search-as-destination: when "back" lands on a detail that was opened from a
  // search result, the NavigationContext fires reopenSearch — restore the query
  // + focus so the SearchPanel re-appears with the same results.
  useEffect(() => onReopenSearch((q) => {
    setQuery(q)
    setFocused(true)
    requestAnimationFrame(() => inputRef.current?.focus())
  }), [])

  const panelOpen = focused && query.trim().length > 0

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
        placeholder="Search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
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
          setQuery('')
          inputRef.current?.focus()
        }}>×</button>
      )}
      {panelOpen && (
        <SearchPanel
          query={query}
          inputEl={inputRef.current}
          onClose={() => { setQuery(''); setFocused(false) }}
        />
      )}
    </div>
  )
}
