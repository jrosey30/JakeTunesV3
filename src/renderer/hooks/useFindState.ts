import { useEffect, useState, useCallback, useRef } from 'react'

/**
 * 4.5: ⌘F "find in view" state — Word-style find, not search-filter.
 *
 * Owns the open/query/cursor state and the global ⌘F listener (capture phase,
 * so it wins over view-level keyboard nav; views unmount their listener when
 * they unmount, so only the active view responds). The VIEW computes its own
 * match list from `query` and jumps/highlights — this hook stays dumb on
 * purpose so Songs (virtualized) and Artists/Albums (DOM scroll) can each
 * jump their own way.
 */
export interface FindState {
  open: boolean
  query: string
  cursor: number
  setQuery: (q: string) => void
  setCursor: (c: number) => void
  close: () => void
}

/**
 * `enabled` (2026-10-21): a browse page can stay mounted, hidden, under an
 * artist / album page (keptView.ts). A hidden page must not answer ⌘F — its
 * capture-phase listener would open an invisible find bar and swallow the key.
 */
export function useFindState(enabled = true): FindState {
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  const [open, setOpen] = useState(false)
  const [query, setQueryRaw] = useState('')
  const [cursor, setCursor] = useState(0)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!enabledRef.current) return
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        e.stopPropagation()
        setOpen(true)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const setQuery = useCallback((q: string) => { setQueryRaw(q); setCursor(0) }, [])
  const close = useCallback(() => { setOpen(false); setQueryRaw(''); setCursor(0) }, [])

  return { open, query, cursor, setQuery, setCursor, close }
}
