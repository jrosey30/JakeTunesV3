import { useState, useCallback, useRef, useEffect } from 'react'

interface VirtualScrollResult {
  startIndex: number
  endIndex: number
  totalHeight: number
  offsetY: number
  containerRef: React.RefObject<HTMLDivElement | null>
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

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerHeight(entry.contentRect.height)
      }
    })
    ro.observe(el)
    setContainerHeight(el.clientHeight)
    return () => ro.disconnect()
  }, [])

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
