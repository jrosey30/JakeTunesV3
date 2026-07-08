/**
 * 4.4.13: persist a scroll container's scrollTop across view unmounts
 * within the same session.
 *
 * 4.5.0-115: cross-launch persistence — scroll positions hydrate from
 * ui-state.json on boot and flush back debounced on scroll.
 */

import { useEffect, useLayoutEffect } from 'react'

interface ScrollPosition {
  top: number
  left: number
}

const scrollCache = new Map<string, ScrollPosition>()
const SCROLL_UI_KEY = 'scrollPositions'

/** In-memory ui-state snapshot — avoids loadUiState on every scroll flush. */
let uiStateSnapshot: Record<string, unknown> | null = null

let persistTimer: ReturnType<typeof setTimeout> | null = null

export function hydrateScrollCacheFromUiState(state: Record<string, unknown> | null | undefined): void {
  if (state && typeof state === 'object') {
    uiStateSnapshot = { ...state }
  }
  const raw = state?.[SCROLL_UI_KEY]
  if (!raw || typeof raw !== 'object') return
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    const v = val as { top?: unknown; left?: unknown }
    if (typeof v?.top === 'number') {
      scrollCache.set(key, {
        top: v.top,
        left: typeof v.left === 'number' ? v.left : 0,
      })
    }
  }
}

function schedulePersistScrollCache(): void {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    void flushScrollCacheToUiState()
  }, 500)
}

async function flushScrollCacheToUiState(): Promise<void> {
  if (scrollCache.size === 0) return
  try {
    if (!uiStateSnapshot) {
      const r = await window.electronAPI.loadUiState()
      uiStateSnapshot = (r.ok && r.state && typeof r.state === 'object') ? r.state as Record<string, unknown> : {}
    }
    const scrollPositions: Record<string, ScrollPosition> = {}
    for (const [k, v] of scrollCache) scrollPositions[k] = v
    const merged = { ...uiStateSnapshot, [SCROLL_UI_KEY]: scrollPositions }
    uiStateSnapshot = merged
    await window.electronAPI.saveUiState(merged)
  } catch {
    /* non-fatal — in-session cache still works */
  }
}

export function getSavedScrollTop(key: string): number {
  return scrollCache.get(key)?.top ?? 0
}

export function getSavedScrollLeft(key: string): number {
  return scrollCache.get(key)?.left ?? 0
}

export function useScrollPersistence(
  key: string,
  containerRef: React.RefObject<HTMLElement | null>
): void {
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const saved = scrollCache.get(key)
    if (saved !== undefined) {
      el.scrollTop = saved.top
      el.scrollLeft = saved.left
      // 2026-07-08 (the "blank library" P0): a programmatic scrollTop
      // assignment doesn't reach virtualizers synchronously, and if the
      // assignment CLAMPED (content not at full height yet on remount)
      // the virtual window and the real scroll position disagree — the
      // list renders rows thousands of px away from the viewport and
      // looks EMPTY until a manual scroll. Dispatching a real scroll
      // event forces every listener (useVirtualScroll's onScroll, the
      // cache handler) to recompute from the ACTUAL DOM position, making
      // the restore self-healing no matter which race happened.
      el.dispatchEvent(new Event('scroll'))
    }
  }, [key, containerRef])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const handler = () => {
      scrollCache.set(key, { top: el.scrollTop, left: el.scrollLeft })
      schedulePersistScrollCache()
    }
    el.addEventListener('scroll', handler, { passive: true })
    return () => el.removeEventListener('scroll', handler)
  }, [key, containerRef])
}
