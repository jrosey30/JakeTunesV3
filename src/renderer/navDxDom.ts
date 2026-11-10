/**
 * dx.nav — the page side (navDx.ts is the row). Everything here is a no-op
 * until initNavDx() finds the flag on: `"navDx": true` in ui-state.json, or
 * JT_NAV_DX=1 in the app's environment. Off, no listener or observer exists.
 */
import { createNavDx, type NavDx, type NavHow } from './navDx'

let on = false
let dx: NavDx | null = null
let lastPointerDown: number | null = null
let pendingHow: NavHow | null = null
let lastActivity = 0
let settleTimer: ReturnType<typeof setInterval> | null = null
const imgSeen = new WeakMap<HTMLImageElement, number>()

const QUIET_MS = 300
const SETTLE_CAP_MS = 8000

/** Is the recorder on? (The artist page skips its own bookkeeping when not.) */
export const navDxOn = (): boolean => on

function activity(): void { lastActivity = performance.now() }

export async function initNavDx(): Promise<void> {
  const api = window.electronAPI
  try {
    const [ui, env] = await Promise.all([
      api.loadUiState().then((r) => (r.ok && r.state && typeof r.state === 'object' ? (r.state as Record<string, unknown>).navDx === true : false)).catch(() => false),
      api.navDxEnv ? api.navDxEnv().catch(() => false) : Promise.resolve(false),
    ])
    if (!ui && !env) return
  } catch { return }
  if (on) return
  on = true
  dx = createNavDx({
    now: () => performance.now(),
    emit: (tag, detail) => { try { api.dxRecord?.(tag, detail) } catch { /* observation only */ } },
    enabled: () => on,
  })
  window.addEventListener('pointerdown', () => { lastPointerDown = performance.now() }, { capture: true, passive: true })
  // Images: when each one's src was set, and when it loaded.
  const root = document.body
  const note = (el: Element): void => {
    if (el instanceof HTMLImageElement) imgSeen.set(el, performance.now())
    else for (const im of el.querySelectorAll?.('img') ?? []) imgSeen.set(im as HTMLImageElement, performance.now())
  }
  new MutationObserver((records) => {
    for (const rec of records) {
      if (rec.type === 'attributes') note(rec.target as Element)
      else for (const n of rec.addedNodes) if (n instanceof Element) note(n)
    }
  }).observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] })
  document.addEventListener('load', (e) => {
    const im = e.target
    if (!(im instanceof HTMLImageElement) || !dx?.open()) return
    activity()
    const src = im.currentSrc || im.src || ''
    const scheme = src.slice(0, Math.max(0, src.indexOf(':'))) || 'unknown'
    const size = Number(/[?&]s=(\d+)/.exec(src)?.[1] ?? 0)
    const seen = imgSeen.get(im)
    dx.image({ scheme, size, natural: [im.naturalWidth, im.naturalHeight], ms: seen === undefined ? -1 : performance.now() - seen })
  }, true)
  document.addEventListener('animationend', (e) => {
    if (e.target instanceof Element && e.target.classList.contains('ad-rise')) activity()
  }, true)
  if (typeof PerformanceObserver !== 'undefined') {
    const watch = (type: string, each: (e: PerformanceEntry) => void): void => {
      try { new PerformanceObserver((list) => { for (const e of list.getEntries()) each(e) }).observe({ type, buffered: false }) } catch { /* not supported here */ }
    }
    watch('layout-shift', (e) => {
      const s = e as PerformanceEntry & { value?: number; hadRecentInput?: boolean }
      if (s.hadRecentInput) return
      activity()
      dx?.shift(s.value ?? 0)
    })
    watch('longtask', (e) => dx?.longTask(e.duration))
  }
}

/** Back / Forward / swipe say so before they navigate; anything else is a click. */
export function noteNavHow(how: NavHow): void {
  if (!on) return
  if (pendingHow === 'swipe' && how !== 'swipe') return   // the swipe handler runs goBack: keep the finer word
  pendingHow = how
}

/** A page was committed (MainContent's layout effect, once per page key). */
export function navDxNavigated(nav: { from: string; to: string; kind: 'arrive' | 'return'; remount: boolean }): void {
  if (!on || !dx) return
  const how = pendingHow ?? (nav.kind === 'return' ? 'back' : 'click')
  pendingHow = null
  dx.begin({ ...nav, how, tClick: lastPointerDown })
  lastPointerDown = null
  dx.mark('commit')
  activity()
  requestAnimationFrame(() => requestAnimationFrame(() => { dx?.mark('paint') }))
  const began = performance.now()
  if (settleTimer) clearInterval(settleTimer)
  settleTimer = setInterval(() => {
    const now = performance.now()
    if (now - lastActivity < QUIET_MS && now - began < SETTLE_CAP_MS) return
    if (settleTimer) { clearInterval(settleTimer); settleTimer = null }
    const scroller = document.querySelector('.main-content-view:not(.main-content-view--parked) .artist-detail')
    dx?.settle(scroller ? scroller.scrollTop : null)
  }, 100)
}

/** The artist page's own rows. Each is a no-op while the recorder is off. */
export const navDxSource = (name: string, ms: number, from: string): void => { if (on) { activity(); dx?.source(name, ms, from) } }
export const navDxHero = (src: string | null): void => { if (on) { activity(); dx?.hero(src) } }
// A page's layout effect (where it restores its scroll) runs BEFORE MainContent's
// (where the row for this navigation is opened): a microtask later, the row is open.
export const navDxScroll = (part: { saved?: number | null; restored?: number | null }): void => { if (on) queueMicrotask(() => dx?.scroll(part)) }

/** Time one of the page's asks: `from` names where the answer came from once it is in. */
export function navDxTimed<T>(name: string, p: Promise<T>, from: (v: T) => string): Promise<T> {
  if (!on) return p
  const began = performance.now()
  return p.then((v) => { navDxSource(name, performance.now() - began, from(v)); return v }, (err) => { navDxSource(name, performance.now() - began, 'error'); throw err })
}
