/**
 * PicksPicker — the sheet behind an empty (or Replace…'d) slot on the TOP 10
 * ISLAND ALBUMS shelf and the FAVORITE ARTISTS row (2026-10-18). A search
 * field over a list the caller has already narrowed (complete albums only /
 * library artists, minus what's already on the shelf). Every typed word must
 * appear in the row's title or subtitle, accent- and case-folded (nameKey).
 * ↑/↓ move the highlight, Enter picks, Esc or a click outside cancels.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { nameKey } from '../../common/fold-text.ts'
import '../styles/synced-picks.css'

export interface PickerItem {
  key: string
  title: string
  subtitle: string
  art: ReactNode
}

interface Props {
  title: string
  sub: string
  placeholder: string
  items: PickerItem[]
  /** Shown when there is nothing to pick from at all (not just no match). */
  emptyText: string
  shape: 'square' | 'round'
  onPick: (key: string) => void
  onClose: () => void
}

/** Rows drawn at once — a library has ~2,000 albums; nobody scrolls past this. */
const MAX_ROWS = 150

export default function PicksPicker({ title, sub, placeholder, items, emptyText, shape, onPick, onClose }: Props): JSX.Element {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const keyed = useMemo(() => items.map((it) => ({ it, hay: nameKey(`${it.title} ${it.subtitle}`) })), [items])
  const words = useMemo(() => nameKey(query).split(' ').filter(Boolean), [query])
  const matches = useMemo(
    () => (words.length === 0 ? keyed : keyed.filter(({ hay }) => words.every((w) => hay.includes(w)))).map(({ it }) => it),
    [keyed, words],
  )
  const shown = matches.slice(0, MAX_ROWS)

  useEffect(() => { setCursor(0) }, [query])

  // Esc backs out from anywhere in the sheet (capture, like BlankTapeSheet,
  // so nothing behind the sheet also acts on it).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  useEffect(() => {
    listRef.current?.querySelector(`[data-i="${cursor}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const onFieldKey = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(c + 1, Math.max(0, shown.length - 1))) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)) }
    else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      const pick = shown[cursor]
      if (pick) onPick(pick.key)
    }
  }

  return (
    <div className="picks-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="picks-sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="picks-sheet-head">
          <h2 className="picks-sheet-title">{title}</h2>
          <p className="picks-sheet-sub">{sub}</p>
          <input
            className="ui-field picks-field"
            type="text"
            value={query}
            autoFocus
            spellCheck={false}
            placeholder={placeholder}
            aria-label={placeholder}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onFieldKey}
          />
        </div>
        <div className="picks-list" ref={listRef} role="listbox" aria-label={title}>
          {items.length === 0 && <div className="picks-empty">{emptyText}</div>}
          {items.length > 0 && shown.length === 0 && <div className="picks-empty">Nothing matches “{query.trim()}”.</div>}
          {shown.map((it, i) => (
            <button
              key={it.key}
              type="button"
              role="option"
              aria-selected={i === cursor}
              data-i={i}
              className={`picks-row${i === cursor ? ' is-active' : ''}`}
              onMouseEnter={() => setCursor(i)}
              onClick={() => onPick(it.key)}
            >
              <span className={`picks-row-art picks-row-art--${shape}`}>{it.art}</span>
              <span className="picks-row-text">
                <span className="picks-row-title">{it.title}</span>
                <span className="picks-row-sub">{it.subtitle}</span>
              </span>
            </button>
          ))}
        </div>
        <div className="picks-sheet-foot">
          <span className="picks-count">
            {matches.length > MAX_ROWS
              ? `Showing ${MAX_ROWS} of ${matches.length.toLocaleString()} — keep typing`
              : matches.length === 0 ? ''
                : words.length > 0 ? `${matches.length.toLocaleString()} match${matches.length === 1 ? '' : 'es'}`
                  : `${matches.length.toLocaleString()} to choose from`}
          </span>
          <button type="button" className="ui-btn ui-btn--sm" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}
