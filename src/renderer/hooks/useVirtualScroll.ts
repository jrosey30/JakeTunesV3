import { useState, useCallback, useRef, useEffect } from 'react'

interface VirtualScrollResult {
  startIndex: number
  endIndex: number
  totalHeight: number
  offsetY: number
  // MutableRefObject (not RefObject) so callers can assign the ref to
  // a JSX prop. React 18 narrowed RefObject<T> to require non-null T,
  // which clashes with our nullable initial value. MutableRefObject
  // keeps the nullable T and is still assignable to React's `ref` prop.
  containerRef: React.MutableRefObject<HTMLDivElement | null>
  onScroll: () => void
}

export function useVirtualScroll(
  itemCount: number,
  itemHeight: number,
  buffer = 10,
  /**
   * 4.4.22: optional seed for the internal scrollTop state. Pair with
   * `useScrollPersistence(key, containerRef)` on the same element and
   * pass `getSavedScrollTop(key)` here so the first render computes
   * the correct startIndex/endIndex from the persisted position.
   * Without this, the DOM scrolls to the saved offset (via
   * useScrollPersistence's useLayoutEffect) but the virtual viewport
   * shows blank space until a scroll event propagates back into React.
   */
  initialScrollTop = 0,
): VirtualScrollResult {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(initialScrollTop)
  const [containerHeight, setContainerHeight] = useState(600)

  // 2026-07-08 surgical fix (Jake: "half the screen is blank"). The observer
  // used to bind to the FIRST container element forever. View-mode round
  // trips (list→grid→list) recreate the container: the old element's final
  // ResizeObserver tick reports height 0 as it detaches — poisoning
  // visibleCount down to the bare buffer (20 rows, top of the screen only)
  // — and the new element was never observed, so no later resize (window
  // grows included) ever reached the row math again. Track the live element
  // identity on every render and observe exactly the current one; ignore
  // ticks from anything that is no longer the observed element.
  const observedElRef = useRef<HTMLDivElement | null>(null)
  const roRef = useRef<ResizeObserver | null>(null)
  useEffect(() => {
    const el = containerRef.current
    if (el === observedElRef.current) return
    if (!roRef.current) {
      roRef.current = new ResizeObserver((entries) => {
        for (const entry of entries) {
          if (entry.target !== observedElRef.current) continue // stale detach tick
          setContainerHeight(entry.contentRect.height)
        }
      })
    }
    if (observedElRef.current) roRef.current.unobserve(observedElRef.current)
    observedElRef.current = el
    if (el) {
      roRef.current.observe(el)
      setContainerHeight(el.clientHeight)
    }
  }) // no dep array: the identity check makes re-runs free and catches ref swaps
  useEffect(() => () => { roRef.current?.disconnect() }, [])

  const onScroll = useCallback(() => {
    if (containerRef.current) {
      setScrollTop(containerRef.current.scrollTop)
    }
  }, [])

  const totalHeight = itemCount * itemHeight
  const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - buffer)
  const visibleCount = Math.ceil(containerHeight / itemHeight) + buffer * 2
  const endIndex = Math.min(itemCount, startIndex + visibleCount)
  const offsetY = startIndex * itemHeight

  return { startIndex, endIndex, totalHeight, offsetY, containerRef, onScroll }
}
