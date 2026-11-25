/**
 * Which rows of a long song list to draw (V7, 2026-11-24). The song table
 * draws only the rows in view plus `overscan` on each side, so a 10,000-song
 * smart playlist or iPod list costs what a screenful costs. SmartPlaylistView
 * used to draw every row, and redraw all of them on each playback tick.
 *
 * Unlike useVirtualScroll (Songs' old windowing, Do-Not-Touch), the list does
 * not have to start at the top of its scroller: an iPod's page has its ad
 * above the songs, an album page has its sleeve. The rows' top is measured
 * inside whatever element scrolls them, so the window is right either way.
 *
 * The state changes only when the window's first or last row changes — not on
 * every pixel of scroll — and that change is rendered in the same frame as the
 * scroll (flushSync), so a fast scroll never shows a blank band.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import { rowWindow, type RowWindow } from '../utils/songTableRules'

export type { RowWindow }

/** The nearest element that scrolls vertically, from `el` up. */
export function scrollParentOf(el: HTMLElement | null): HTMLElement | null {
  let n = el?.parentElement ?? null
  while (n) {
    const oy = getComputedStyle(n).overflowY
    if (oy === 'auto' || oy === 'scroll') return n
    n = n.parentElement
  }
  return null
}

export function useRowWindow(
  count: number,
  rowHeight: number,
  bodyRef: RefObject<HTMLElement | null>,
  /** The scroller, when the table owns it; otherwise the nearest one is found. */
  scrollerRef?: RefObject<HTMLElement | null>,
  overscan = 14,
): RowWindow & { scroller: () => HTMLElement | null; bodyTop: () => number } {
  const [win, setWin] = useState<RowWindow>(() => ({ start: 0, end: Math.min(count, 60) }))
  const winRef = useRef(win)
  winRef.current = win
  const countRef = useRef(count)
  countRef.current = count

  const scroller = useCallback((): HTMLElement | null => scrollerRef?.current ?? scrollParentOf(bodyRef.current), [scrollerRef, bodyRef])
  const bodyTop = useCallback((): number => {
    const sc = scroller()
    const body = bodyRef.current
    if (!sc || !body) return 0
    return body.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop
  }, [scroller, bodyRef])

  const measure = useCallback((sync: boolean) => {
    const sc = scroller()
    if (!sc) return
    const next = rowWindow({
      count: countRef.current, rowHeight, bodyTop: bodyTop(), scrollTop: sc.scrollTop, viewHeight: sc.clientHeight, overscan,
    })
    const cur = winRef.current
    if (next.start === cur.start && next.end === cur.end) return
    winRef.current = next
    if (sync) flushSync(() => setWin(next))
    else setWin(next)
  }, [scroller, bodyTop, rowHeight, overscan])

  // A new count (filter, another list) or first paint: measure from where the
  // scroller really is (a restored scroll position included).
  useLayoutEffect(() => { measure(false) }, [count, measure])

  useEffect(() => {
    const sc = scroller()
    if (!sc) return
    const onScroll = (): void => measure(true)
    sc.addEventListener('scroll', onScroll, { passive: true })
    const ro = new ResizeObserver(() => measure(false))
    ro.observe(sc)
    // The rows' own top moves when something above them grows (an ad's image).
    if (bodyRef.current) ro.observe(bodyRef.current)
    const raf = requestAnimationFrame(() => measure(false))
    return () => {
      sc.removeEventListener('scroll', onScroll)
      ro.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [scroller, measure, bodyRef])

  return { ...win, scroller, bodyTop }
}
