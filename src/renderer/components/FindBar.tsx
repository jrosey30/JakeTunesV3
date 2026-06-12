import { useEffect, useRef } from 'react'

/**
 * 4.5: the ⌘F find bar — floating top-right like Word/browser find.
 * Enter = next match, Shift+Enter = previous, Esc = close.
 * Presentational; the owning view supplies match count + navigation.
 */
interface FindBarProps {
  query: string
  onQuery: (q: string) => void
  current: number   // 0-based index of the active match
  total: number
  onNext: () => void
  onPrev: () => void
  onClose: () => void
  placeholder: string
}

export default function FindBar({ query, onQuery, current, total, onNext, onPrev, onClose, placeholder }: FindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select() }, [])

  return (
    <div className="find-bar" role="search">
      <span className="find-bar-icon" aria-hidden="true">⌕</span>
      <input
        ref={inputRef}
        className="find-bar-input"
        type="text"
        value={query}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) onPrev(); else onNext() }
          else if (e.key === 'Escape') { e.preventDefault(); onClose() }
        }}
        aria-label="Find in view"
      />
      <span className="find-bar-count">{query ? `${total === 0 ? 0 : current + 1} of ${total}` : ''}</span>
      <button type="button" className="find-bar-nav" onClick={onPrev} disabled={total === 0} title="Previous (⇧↩)" aria-label="Previous match">‹</button>
      <button type="button" className="find-bar-nav" onClick={onNext} disabled={total === 0} title="Next (↩)" aria-label="Next match">›</button>
      <button type="button" className="find-bar-close" onClick={onClose} title="Close (Esc)" aria-label="Close find">×</button>
    </div>
  )
}
