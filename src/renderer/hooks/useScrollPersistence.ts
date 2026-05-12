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

const scrollCache = new Map<string, number>()

export function useScrollPersistence(
  key: string,
  containerRef: React.RefObject<HTMLElement | null>
): void {
  // Restore BEFORE paint so the user never sees scrollTop=0 flash.
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const saved = scrollCache.get(key)
    if (saved !== undefined) el.scrollTop = saved
  }, [key])

  // Track every scroll into the cache (passive, doesn't block paint).
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const handler = () => { scrollCache.set(key, el.scrollTop) }
    el.addEventListener('scroll', handler, { passive: true })
    return () => el.removeEventListener('scroll', handler)
  }, [key])
}
