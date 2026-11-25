/**
 * The song table's column layout — which columns show, their widths and their
 * order — ONE layout for every page (V7, 2026-11-24). It was the Songs view's
 * alone: a playlist, a smart playlist and an album each had their own fixed
 * set, so BPM and Key existed on one page only.
 *
 * The cache and its story (why App.tsx primes it before any view mounts) live
 * in utils/columnState.ts. This hook reads it, writes it, and saves it to
 * ui-state through App.tsx's 'jaketunes-save-columns' listener, 500 ms after
 * the last change. The save shape and colsV are the ones Songs always wrote.
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import {
  getColumnCache, setColumnCache, subscribeColumnCache, primeColumnCacheFromUiState,
  widenedForDateTime, orderColumnKeys, DEFAULT_HIDDEN, type ColumnState,
} from '../utils/columnState'
import { SONG_COLUMNS, SONG_COLUMN_KEYS, type SongColumn } from '../utils/songTableRules'

const EMPTY: ColumnState = { hidden: [...DEFAULT_HIDDEN], widths: {}, order: [] }
const read = (): ColumnState => getColumnCache() ?? EMPTY

let saveTimer: ReturnType<typeof setTimeout> | null = null
function saveSoon(next: ColumnState): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    window.dispatchEvent(new CustomEvent('jaketunes-save-columns', {
      detail: { colWidthMap: next.widths, hiddenCols: next.hidden, columnOrder: next.order, colsV: 5 },
    }))
  }, 500)
}

function update(change: (cur: ColumnState) => ColumnState): void {
  const next = change(read())
  setColumnCache(next)   // synchronously: a page opened sooner than the save must see it
  saveSoon(next)
}

// The saved layout arriving after the cache was primed (App.tsx fires it once
// at startup). Listened for here, once, not inside a view that may not exist yet.
if (typeof window !== 'undefined') {
  window.addEventListener('jaketunes-restore-columns', (e: Event) => {
    const { colWidthMap, hiddenCols, columnOrder, colsV } = (e as CustomEvent).detail ?? {}
    const widths = colWidthMap && typeof colWidthMap === 'object'
      ? { ...read().widths, ...widenedForDateTime(colWidthMap as Record<string, number>, colsV) }
      : read().widths
    if (Array.isArray(hiddenCols)) primeColumnCacheFromUiState({ hiddenCols, colsV })
    const order = Array.isArray(columnOrder) && columnOrder.length > 0
      ? columnOrder.filter((k: unknown): k is string => typeof k === 'string')
      : read().order
    setColumnCache({ ...read(), widths, order })
  })
}

export interface ColumnLayout {
  /** Every column the page may show, in Jake's order (shown or not). */
  ordered: SongColumn[]
  /** The ones shown, in order. */
  visible: SongColumn[]
  widths: number[]
  hidden: ReadonlySet<string>
  toggle: (key: string) => void
  setWidth: (key: string, width: number) => void
  /** Header drag: `source` lands after `target` when moving right, before it moving left. */
  move: (source: string, target: string) => void
}

/**
 * `fixed`: a page's own short set, in that order, all shown (the album page's
 * #, Name, Artist, Plays, Time). It is not the shared layout, so the header
 * picker and header drags leave it alone; widths still come from the shared
 * layout so a column sized on one page is that size on every page.
 */
export function useColumnLayout(fixed?: readonly string[]): ColumnLayout & { fixed: boolean } {
  const state = useSyncExternalStore(subscribeColumnCache, read)
  const fixedKey = (fixed ?? []).join(',')
  const layout = useMemo(() => {
    const byKey = new Map(SONG_COLUMNS.map((c) => [c.key as string, c]))
    const ordered = fixedKey
      ? fixedKey.split(',').map((k) => byKey.get(k)).filter((c): c is SongColumn => !!c)
      : orderColumnKeys(state.order, SONG_COLUMN_KEYS).map((k) => byKey.get(k)!)
    const hidden = new Set(fixedKey ? [] : state.hidden)
    const visible = ordered.filter((c) => !hidden.has(c.key))
    const widths = visible.map((c) => state.widths[c.key] ?? c.defaultWidth)
    return { ordered, visible, widths, hidden }
  }, [state, fixedKey])

  const toggle = useCallback((key: string) => update((cur) => {
    const hidden = new Set(cur.hidden)
    if (hidden.has(key)) hidden.delete(key)
    else hidden.add(key)
    return { ...cur, hidden: Array.from(hidden) }
  }), [])
  const setWidth = useCallback((key: string, width: number) => update((cur) => ({ ...cur, widths: { ...cur.widths, [key]: width } })), [])
  const move = useCallback((source: string, target: string) => update((cur) => {
    const next = orderColumnKeys(cur.order, SONG_COLUMN_KEYS)
    const from = next.indexOf(source)
    const to = next.indexOf(target)
    if (from < 0 || to < 0 || from === to) return cur
    next.splice(from, 1)
    next.splice(next.indexOf(target) + (from < to ? 1 : 0), 0, source)
    return { ...cur, order: next }
  }), [])

  return { ...layout, toggle, setWidth, move, fixed: !!fixedKey }
}
