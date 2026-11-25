/**
 * V7 motion: pages slide like an iPod menu.
 *
 * Opening a page slides it in from the right while the page you were on
 * slides off to the left; Back slides the page you're leaving out to the
 * right while the one you go back to comes in from the left. One fifth of a
 * second (--motion-normal), the one curve.
 *
 * It is a View Transition on the content area only (styles/motion.css names
 * `.main-content-shell-view` `jt-page` while :root.jt-page-vt is on), so the
 * sidebar, the toolbar and Now Playing never move and keep drawing live. Both
 * pages are snapshots for those 200 ms: the GPU slides two pictures, nothing
 * is laid out per frame (scripts/motion-frames measures it).
 *
 * MainContent's useDiscHandoffView (discHandoff.ts) holds the old view for the
 * frame the browser captures it and calls runPageSlide; the jewel-case disc
 * handoff keeps its own transition and wins when it applies.
 *
 * Reduce Motion, or no View Transitions: the page just appears.
 */
import { flushSync } from 'react-dom'
import { prefersReducedMotion } from './motion'

export type PageSlideKind = 'in' | 'out'

const VT_CLASS = 'jt-page-vt'
let runSeq = 0
let sliding = false

/** A slide is running: a page mounted now arrives by the slide, not by its own fade. */
export function pageSlideRunning(): boolean {
  return sliding
}

/** Back slides the page out to the right; everything else slides a page in from the right. */
export function pageSlideKind(history: 'back' | 'forward' | null): PageSlideKind {
  return history === 'back' ? 'out' : 'in'
}

/**
 * Does this page change slide? Only between different kinds of page. A change
 * within one kind (album to album, one playlist to another, a playlist to a
 * smart playlist) keeps the quick fade: the page held on screen for the slide
 * would already be showing the new subject, so there is nothing to slide away.
 */
const LIST_PAGES = new Set(['playlist', 'smart-playlist'])
export function slidesBetween(fromView: string, toView: string): boolean {
  if (fromView === toView) return false
  if (LIST_PAGES.has(fromView) && LIST_PAGES.has(toView)) return false
  return true
}

export function pageSlideSupported(): boolean {
  return typeof document !== 'undefined'
    && typeof document.startViewTransition === 'function'
    && document.visibilityState === 'visible'
    && !prefersReducedMotion()
}

/**
 * Slide: `release` renders the new page synchronously (inside flushSync,
 * once the old one has been captured). Always calls `release` exactly once.
 */
export function runPageSlide(kind: PageSlideKind, release: () => void): void {
  const root = document.documentElement
  const run = ++runSeq
  let released = false
  const doRelease = (): void => {
    if (released) return
    released = true
    flushSync(release)
  }
  const done = (): void => {
    if (run !== runSeq) return
    sliding = false
    root.classList.remove(VT_CLASS, `${VT_CLASS}--in`, `${VT_CLASS}--out`)
  }
  root.classList.remove(`${VT_CLASS}--in`, `${VT_CLASS}--out`)
  root.classList.add(VT_CLASS, `${VT_CLASS}--${kind}`)
  sliding = true
  let vt: ViewTransition
  try {
    vt = document.startViewTransition(() => { doRelease() })
  } catch (err) {
    console.warn('[page-slide] View Transition refused; the page just appears', err)
    doRelease()
    done()
    return
  }
  const stopRescue = rescueClicks(vt)
  vt.finished.then(() => { stopRescue(); done() }, () => { stopRescue(); done() })
  vt.ready.catch(() => { /* skipped (window hidden, a newer transition): the swap stands */ })
  // A transition the browser never starts must not strand the old page.
  vt.updateCallbackDone.catch(() => doRelease())
}

/**
 * A click during the slide is never lost (Sidebar, toolbar, Pause). While a
 * View Transition runs, Chromium 124 (Electron 30) sends every pointer event
 * to <html>, whatever motion.css's `::view-transition { pointer-events: none }`
 * says (newer Chromium honours that rule; this covers the one we ship). So a
 * press ends the slide at once (the new page is already live underneath) and
 * the click it makes goes to what is actually under the pointer.
 */
export function rescueClicks(vt: { skipTransition: () => void }): () => void {
  const root = document.documentElement
  let pressed = false
  const onDown = (e: PointerEvent): void => {
    if (e.target !== root) return
    pressed = true
    vt.skipTransition()
  }
  const onClick = (e: MouseEvent): void => {
    if (!pressed || e.target !== root) return
    pressed = false
    const el = document.elementFromPoint(e.clientX, e.clientY)
    if (el instanceof HTMLElement && el !== root) {
      e.stopPropagation()
      el.click()
    }
  }
  root.addEventListener('pointerdown', onDown, true)
  root.addEventListener('click', onClick, true)
  // The click comes after the slide has ended: keep listening a moment longer.
  return () => {
    root.removeEventListener('pointerdown', onDown, true)
    setTimeout(() => root.removeEventListener('click', onClick, true), 1000)
  }
}
