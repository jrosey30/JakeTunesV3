/**
 * 4.4.13: persist a scroll container's scrollTop across view unmounts
 * within the same session.
 *
 * 4.5.0-115: cross-launch persistence — scroll positions hydrate from
 * ui-state.json on boot and flush back debounced on scroll.
 */

import { useEffect, useLayoutEffect, useRef } from 'react'

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
  // True while a restore is still chasing its target on an async page.
  // The recorder effect below must NOT capture positions during this
  // window — before this guard existed, a clamped restore (content not
  // loaded yet → scrollTop pinned to 0) dispatched a scroll event that
  // RECORDED the 0, erasing the saved position on every revisit. That
  // was Jake's "many pages don't remember where I was" (2026-08-07):
  // pages with async content (Home, Discover…) wiped their own memory.
  const restoringRef = useRef(false)

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const saved = scrollCache.get(key)
    if (saved === undefined) return
    const apply = (): void => {
      el.scrollTop = saved.top
      el.scrollLeft = saved.left
      // 2026-07-08 (the "blank library" P0): a programmatic scrollTop
      // assignment doesn't reach virtualizers synchronously. Dispatching
      // a real scroll event forces every listener (useVirtualScroll's
      // onScroll) to recompute from the ACTUAL DOM position.
      el.dispatchEvent(new Event('scroll'))
    }
    apply()
    if (Math.abs(el.scrollTop - saved.top) <= 2) return   // reached — done

    // The assignment CLAMPED: content hasn't grown tall enough yet
    // (async sections still loading). Keep re-applying as the page
    // grows, for up to 4s — a real user input takes ownership instead.
    restoringRef.current = true
    let raf = 0
    const deadline = performance.now() + 4000
    const cancel = (): void => {
      restoringRef.current = false
      if (raf) cancelAnimationFrame(raf)
      el.removeEventListener('wheel', cancel)
      el.removeEventListener('pointerdown', cancel)
      el.removeEventListener('keydown', cancel)
    }
    const tick = (): void => {
      if (!restoringRef.current) return
      if (el.scrollHeight >= saved.top + el.clientHeight) apply()
      if (Math.abs(el.scrollTop - saved.top) <= 2 || performance.now() > deadline) { cancel(); return }
      raf = requestAnimationFrame(tick)
    }
    el.addEventListener('wheel', cancel, { passive: true })
    el.addEventListener('pointerdown', cancel, { passive: true })
    el.addEventListener('keydown', cancel)
    raf = requestAnimationFrame(tick)
    return cancel
  }, [key, containerRef])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const handler = () => {
      if (restoringRef.current) return   // never record a clamped restore
      scrollCache.set(key, { top: el.scrollTop, left: el.scrollLeft })
      schedulePersistScrollCache()
    }
    el.addEventListener('scroll', handler, { passive: true })
    return () => el.removeEventListener('scroll', handler)
  }, [key, containerRef])
}
