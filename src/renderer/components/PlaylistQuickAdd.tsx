import { useState, useMemo, useRef, useEffect } from 'react'
import type { Track } from '../types'
import { quickAddMatches } from '../utils/quickAddMatch'

/**
 * Quick add — a small search box inside the "Suggested for this playlist"
 * strip for songs the brain did NOT suggest but Jake already knows he wants
 * (2026-09-04: "a quick add for songs that aren't being suggested but that I
 * know I want to add off the top of my head").
 *
 * Every typed word must appear somewhere in title / artist / album, same rule
 * as the library search. Songs already on the playlist never show. Enter adds
 * the highlighted row and clears the box so the next name can be typed
 * straight away; Escape clears; arrows move the highlight.
 */
interface Props {
  pool: Track[]
  excludeIds: Set<number>
  onAdd: (track: Track) => void
}

export function PlaylistQuickAdd({ pool, excludeIds, onAdd }: Props) {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const [focused, setFocused] = useState(false)
  const [justAdded, setJustAdded] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const results = useMemo(() => quickAddMatches(pool, excludeIds, query), [pool, excludeIds, query])

  useEffect(() => { setCursor(0) }, [query])
  useEffect(() => {
    if (!justAdded) return
    const id = window.setTimeout(() => setJustAdded(null), 1600)
    return () => window.clearTimeout(id)
  }, [justAdded])

  const add = (t: Track) => {
    onAdd(t)
    setJustAdded(t.title)
    setQuery('')
    inputRef.current?.focus()
  }

  const open = focused && query.trim().length > 0

  return (
    <div className="pl-quick" onMouseDown={(e) => { if (e.target !== inputRef.current) e.preventDefault() }}>
      {/* Same 12px magnifier the toolbar's search pill draws (SearchPill.tsx) —
          the shelf's field reads as a sibling of that one, not a web pill. */}
      <svg className="pl-quick-icon" aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="5" cy="5" r="3.5" />
        <path d="M7.5 7.5L10.5 10.5" strokeLinecap="round" />
      </svg>
      <input
        ref={inputRef}
        className="pl-quick-input"
        type="text"
        value={query}
        placeholder={justAdded ? `Added “${justAdded}”` : 'Quick add a song…'}
        aria-label="Quick add a song to this playlist"
        spellCheck={false}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); if (query) setQuery(''); else inputRef.current?.blur(); return }
          if (!results.length) return
          if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(c => (c + 1) % results.length) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor(c => (c - 1 + results.length) % results.length) }
          else if (e.key === 'Enter') { e.preventDefault(); add(results[Math.min(cursor, results.length - 1)]) }
        }}
      />
      {open && (
        <div className="pl-quick-pop" role="listbox">
          {results.length === 0 ? (
            <div className="pl-quick-empty">Nothing in the library matches “{query.trim()}”</div>
          ) : results.map((t, i) => (
            <div
              key={t.id}
              role="option"
              aria-selected={i === cursor}
              className={`pl-quick-hit${i === cursor ? ' pl-quick-hit--active' : ''}`}
              onMouseEnter={() => setCursor(i)}
              onClick={() => add(t)}
              title={`Add "${t.title}" to this playlist`}
            >
              <span className="pl-quick-hit-title">{t.title}</span>
              <span className="pl-quick-hit-sub">{t.artist}{t.album ? ` · ${t.album}` : ''}</span>
              <span className="pl-quick-hit-add" aria-hidden="true">＋</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
