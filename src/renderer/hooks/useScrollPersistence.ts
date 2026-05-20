/**
 * 4.4.13: persist a scroll container's scrollTop across view unmounts
 * within the same session.
 *
 * Why this exists:
 * MainContent.tsx switches views via a switch/case that returns one
 * component at a time. When the user navigates Songs → Artists → Songs,
 * SongsView UNMOUNTS — useVirtualScroll's internal `scrollTop` resets to
 * 0, the new container's scrollTop is 0, and the user loses their place.
 *
 * The fix: a module-level Map keyed by view (`'songs'`, `'albums'`,
 * `'playlist:<id>'`, etc.) caches the last known scrollTop. On mount,
 * useLayoutEffect runs BEFORE paint and restores the saved value so the
 * user never sees the flash at scrollTop=0. A passive scroll listener
 * keeps the cache fresh on every scroll.
 *
 * Cross-launch persistence (writing this to disk and restoring on app
 * start) is intentionally NOT here — that's Phase C. This module-level
 * Map dies with the renderer, which is what we want for in-session.
 *
 * Notes:
 * - This hook ADDS an event listener via addEventListener — it doesn't
 *   touch the view's existing React `onScroll` handler. Both fire on
 *   scroll; this one is non-React and just updates the cache.
 * - The key is reactive: changing it (e.g. switching from playlist A
 *   to playlist B inside PlaylistView) triggers a fresh restore from
 *   the new key's cached value, so each playlist remembers its own
 *   position independently.
 * - Programmatic scrollTop writes from scrollToIdx/auto-follow ALSO
 *   fire 'scroll' events and update the cache — that's correct: the
 *   cache should reflect the actual current scroll position regardless
 *   of who wrote it.
 */

import { useEffect, useLayoutEffect } from 'react'

interface ScrollPosition {
  top: number
  left: number
}

const scrollCache = new Map<string, ScrollPosition>()

/**
 * 4.4.22: read the cached scrollTop for a key without subscribing.
 * Lets virtualized lists seed their internal scroll state on mount
 * BEFORE first render — without this, the DOM scrolls to the saved
 * position via useScrollPersistence's useLayoutEffect, but the
 * virtual viewport still has internal scrollTop=0 and renders rows
 * from the top; the user sees blank space at the saved scroll
 * position until a real scroll event propagates back into React.
 *
 * Pair with useScrollPersistence(key, ref) on the same scrollable
 * element — both share the same cache map.
 */
export function getSavedScrollTop(key: string): number {
  return scrollCache.get(key)?.top ?? 0
}

/** 4.4.23: same as getSavedScrollTop but for horizontal axis. Needed
 *  for Home view's card rows where the meaningful scroll axis is X. */
export function getSavedScrollLeft(key: string): number {
  return scrollCache.get(key)?.left ?? 0
}

export function useScrollPersistence(
  key: string,
  containerRef: React.RefObject<HTMLElement | null>
): void {
  // Restore BEFORE paint so the user never sees scroll-position-0 flash.
  // 4.4.23: now persists BOTH axes — Home view's `.home-card-row` scrolls
  // horizontally, AlbumsView's grid scrolls vertically, both shapes use
  // this hook. Setting scrollLeft on a non-horizontal scroller is a
  // harmless no-op (clamps to 0).
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const saved = scrollCache.get(key)
    if (saved !== undefined) {
      el.scrollTop = saved.top
      el.scrollLeft = saved.left
    }
  }, [key])

  // Track every scroll (passive — doesn't block paint).
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const handler = () => {
      scrollCache.set(key, { top: el.scrollTop, left: el.scrollLeft })
    }
    el.addEventListener('scroll', handler, { passive: true })
    return () => el.removeEventListener('scroll', handler)
  }, [key])
}
