/**
 * "Was this really seen?" (2026-10-19, taste-engine repairs).
 *
 * Discovery counted a card as served the moment the feed was handed to the
 * page — whole lanes, including cards cut by a shelf's cap or sitting off
 * the end of a sideways scroller — and its acceptance rate divided by
 * nothing at all (it read 100%). An impression now means: at least 60% of
 * the card inside the window for one continuous second, while the app is
 * the visible window. IntersectionObserver with the viewport as root clips
 * through every scrolling ancestor, so a card hidden in a horizontal shelf
 * does not count until it is scrolled into view.
 *
 * Each key fires at most once per mount; seen items are flushed in batches
 * (main also drops same-day duplicates).
 */
import { useCallback, useEffect, useRef } from 'react'

const THRESHOLD = 0.6
const DWELL_MS = 1000
const FLUSH_MS = 2000

export function useImpressions<M>(onSeen: (batch: Array<{ key: string; meta: M }>) => void): (key: string, meta: M) => (el: Element | null) => void {
  const onSeenRef = useRef(onSeen)
  onSeenRef.current = onSeen
  const seen = useRef(new Set<string>())
  const pending = useRef<Array<{ key: string; meta: M }>>([])
  const timers = useRef(new Map<string, number>())
  const byEl = useRef(new Map<Element, { key: string; meta: M }>())
  const refs = useRef(new Map<string, (el: Element | null) => void>())
  const elOf = useRef(new Map<string, Element>())
  const observer = useRef<IntersectionObserver | null>(null)

  const flush = useCallback(() => {
    if (pending.current.length === 0) return
    const batch = pending.current
    pending.current = []
    onSeenRef.current(batch)
  }, [])

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const item = byEl.current.get(e.target)
        if (!item || seen.current.has(item.key)) continue
        const visible = e.isIntersecting && e.intersectionRatio >= THRESHOLD
        const t = timers.current.get(item.key)
        if (visible && t === undefined) {
          timers.current.set(item.key, window.setTimeout(() => {
            timers.current.delete(item.key)
            if (document.visibilityState !== 'visible' || seen.current.has(item.key)) return
            seen.current.add(item.key)
            pending.current.push(item)
          }, DWELL_MS))
        } else if (!visible && t !== undefined) {
          window.clearTimeout(t)
          timers.current.delete(item.key)
        }
      }
    }, { threshold: [0, THRESHOLD] })
    observer.current = io
    for (const el of byEl.current.keys()) io.observe(el)
    const iv = window.setInterval(flush, FLUSH_MS)
    const timerMap = timers.current
    return () => {
      io.disconnect()
      observer.current = null
      window.clearInterval(iv)
      for (const t of timerMap.values()) window.clearTimeout(t)
      timerMap.clear()
      flush()
    }
  }, [flush])

  // Stable ref callback per key, so a re-render does not unobserve/observe.
  return useCallback((key: string, meta: M) => {
    let cb = refs.current.get(key)
    if (!cb) {
      cb = (el: Element | null) => {
        const prev = elOf.current.get(key)
        if (prev && prev !== el) {
          observer.current?.unobserve(prev)
          byEl.current.delete(prev)
          elOf.current.delete(key)
        }
        if (el) {
          elOf.current.set(key, el)
          byEl.current.set(el, { key, meta })
          observer.current?.observe(el)
        }
      }
      refs.current.set(key, cb)
    }
    return cb
  }, [])
}
