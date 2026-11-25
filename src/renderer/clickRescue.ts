/**
 * A click during a page slide is never lost (V7 motion, pageSlide.ts).
 *
 * While a View Transition runs, Electron 30's Chromium (124) sends every
 * pointer event to <html>, whatever motion.css's
 * `::view-transition { pointer-events: none }` says (newer Chromium honours
 * the rule; then the press reaches its real target and nothing here acts).
 * So, for a press that lands on <html> while a slide runs:
 *   - the slide ends at once (the new page is already live underneath);
 *   - only a primary-button click is carried over, and only if press and
 *     release were within a few px (a drag is never turned into a click);
 *   - it goes to whatever element is under the pointer, SVG icons included,
 *     as a real MouseEvent with its modifiers kept, delivered exactly once;
 *   - inside the page area that was sliding (what you pressed is gone) the
 *     click is dropped; a text field there or anywhere is focused.
 *
 * One rescuer for the whole app (module level), so a click can never be
 * delivered twice. No imports and no globals at load: tests drive it with a
 * fake root and a fake slide (src/main/__tests__/click-rescue.test.ts).
 */

export interface RescueVt { skipTransition: () => void }

export interface RescueEnv {
  /** <html>: where Chromium sends pointer events during a View Transition. */
  root: EventTarget
  /** What is under the pointer once the slide has ended. */
  elementAt: (x: number, y: number) => EventTarget | null
  /** Is it inside the page area that was sliding? */
  inSlidingArea: (el: EventTarget) => boolean
  /** A text field takes focus (the press that would have focused it went to <html>). */
  focusIfField: (el: EventTarget) => void
  /** Hand the click over (in the app: el.dispatchEvent(new MouseEvent('click', init))). */
  deliver: (el: EventTarget, init: RescuedClick) => void
  /** How long a press waits for its click after the slide has ended. */
  setTimer?: (fn: () => void, ms: number) => unknown
}

export interface RescuedClick {
  bubbles: true
  cancelable: true
  composed: true
  clientX: number
  clientY: number
  screenX: number
  screenY: number
  button: number
  buttons: number
  detail: number
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
}

/** Press and release further apart than this are a drag, not a click. */
export const RESCUE_SLOP_PX = 4

interface PointerLike extends Event {
  button?: number
  clientX?: number
  clientY?: number
}

export interface ClickRescuer {
  /** A slide started: presses on <html> end it and their clicks are carried over. */
  arm: (vt: RescueVt) => void
  /** The slide ended. A press already made still gets its click. */
  disarm: () => void
}

export function createClickRescuer(env: RescueEnv): ClickRescuer {
  let vt: RescueVt | null = null
  let press: { x: number; y: number; released: boolean } | null = null
  let pressSeq = 0
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const setTimer = env.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))

  const onDown = (e: Event): void => {
    const p = e as PointerLike
    if (!vt || e.target !== env.root) return
    vt.skipTransition()
    if (num(p.button) !== 0) { press = null; return }
    press = { x: num(p.clientX), y: num(p.clientY), released: false }
    const mine = ++pressSeq
    // A press that never becomes a click is forgotten.
    setTimer(() => { if (pressSeq === mine) press = null }, 1000)
  }
  const onUp = (e: Event): void => {
    if (!press) return
    if (e.type === 'pointercancel') { press = null; return }
    const p = e as PointerLike
    if (Math.abs(num(p.clientX) - press.x) > RESCUE_SLOP_PX || Math.abs(num(p.clientY) - press.y) > RESCUE_SLOP_PX) { press = null; return }
    press.released = true
  }
  const onClick = (e: Event): void => {
    const was = press
    press = null
    if (!was || !was.released || e.target !== env.root) return
    const m = e as MouseEvent
    const x = num(m.clientX)
    const y = num(m.clientY)
    const el = env.elementAt(x, y)
    if (!el || el === env.root) return
    e.stopImmediatePropagation()
    env.focusIfField(el)
    if (env.inSlidingArea(el)) return
    env.deliver(el, {
      bubbles: true, cancelable: true, composed: true,
      clientX: x, clientY: y, screenX: num(m.screenX), screenY: num(m.screenY),
      button: 0, buttons: 0, detail: num(m.detail) || 1,
      ctrlKey: !!m.ctrlKey, shiftKey: !!m.shiftKey, altKey: !!m.altKey, metaKey: !!m.metaKey,
    })
  }

  // Listening from the start, once, ahead of anything else on <html>: a
  // rescued click stops there (stopImmediatePropagation) and is delivered once.
  env.root.addEventListener('pointerdown', onDown, true)
  env.root.addEventListener('pointerup', onUp, true)
  env.root.addEventListener('pointercancel', onUp, true)
  env.root.addEventListener('click', onClick, true)

  return {
    arm: (next) => { vt = next },
    disarm: () => { vt = null },
  }
}

/** The app's one rescuer, on the real document (made on first use). */
let appRescuer: ClickRescuer | null = null
export function documentClickRescuer(): ClickRescuer {
  if (appRescuer) return appRescuer
  const root = document.documentElement
  appRescuer = createClickRescuer({
    root,
    elementAt: (x, y) => document.elementFromPoint(x, y),
    inSlidingArea: (el) => el instanceof Element && el.closest('.main-content-shell-view') !== null,
    focusIfField: (el) => {
      if (el instanceof HTMLElement && el.matches('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) el.focus()
    },
    deliver: (el, init) => { el.dispatchEvent(new MouseEvent('click', init)) },
  })
  return appRescuer
}
