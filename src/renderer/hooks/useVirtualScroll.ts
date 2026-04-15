import { useState, useCallback, useRef, useEffect } from 'react'

interface VirtualScrollResult {
  startIndex: number
  endIndex: number
  totalHeight: number
  offsetY: number
  containerRef: React.RefObject<HTMLDivElement | null>
  onScroll: () => void
}

export function useVirtualScroll(itemCount: number, itemHeight: number, buffer = 10): VirtualScrollResult {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
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
