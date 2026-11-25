/**
 * The keyboard host: the ONLY place the renderer listens to the keyboard on
 * window or document (src/main/__tests__/keymap-structural.test.ts fails a
 * build that adds another). What each key means is ../common/keymap.ts; this
 * file holds who is on screen right now and hands each key to one of them.
 *
 * A keydown goes, in order:
 *   1. (capture) to the layers: dialogs first, then the page and its lists,
 *      newest first (keymap.ts layerOrder). A layer that handles a key calls
 *      preventDefault / stopPropagation or returns true, and that's the end.
 *   2. the focused element itself (a text field, a button, a Cover Flow with
 *      focus). It can keep the key the same way.
 *   3. (bubble) to the late layers, then the on-screen Cover Flow's ←/→,
 *      then the global decision (keymap.ts routeKey): Escape to the top-most
 *      surface, ⌘Z to the latest Undo toast, Space / ⌘←→ / ⌘↑↓ … to the app.
 *
 * Pages and panels never add their own window listener. They register here:
 *   addKeyLayer   keys a page, list or dialog handles itself
 *   claimKeys     keys the app's global shortcuts must leave alone while a
 *                 page holds them (Space in the Supreme Court room)
 *   addEscape     a surface Escape closes (top-most first)
 *   addUndo       an Undo toast ⌘Z presses
 * React hooks over these: hooks/useKeyboard.ts.
 */
import { layerOrder, routeKey, type FocusState, type LayerInfo, type Route } from '../common/keymap.ts'
import { handleOwnedArrowKey, OVERLAY_SELECTOR } from './utils/arrowKeyOwner.ts'

export type KeyHandler = (e: KeyboardEvent) => boolean | void

interface Entry { id: string; seq: number }
interface Layer extends Entry, LayerInfo { handler: KeyHandler; keyUp?: (e: KeyboardEvent) => void }
interface EscapeTarget extends Entry { close: () => void; modal: boolean }
interface UndoTarget extends Entry { undo: () => void }
interface Claim extends Entry { codes: ReadonlySet<string> }

const layers: Layer[] = []
const escapes: EscapeTarget[] = []
const undos: UndoTarget[] = []
const claims: Claim[] = []

// Open order. An id keeps its place when React re-runs its effect (cleanup and
// setup in the same commit), so a page re-rendering with new deps never jumps
// above a dialog opened after it. Gone for a whole tick, it starts over.
let nextSeq = 1
const seqOf = new Map<string, number>()
function seqFor(id: string): number {
  let s = seqOf.get(id)
  if (s === undefined) { s = nextSeq++; seqOf.set(id, s) }
  return s
}
function live(id: string): boolean {
  return [layers, escapes, undos, claims].some((list: Entry[]) => list.some((x) => x.id === id))
}
function release<T extends Entry>(list: T[], item: T): () => void {
  return () => {
    const i = list.indexOf(item)
    if (i < 0) return
    list.splice(i, 1)
    queueMicrotask(() => { if (!live(item.id)) seqOf.delete(item.id) })
  }
}

/** Keys a page, list or dialog handles. Returns the release (idempotent). */
export function addKeyLayer(id: string, handler: KeyHandler, opts: { modal?: boolean; late?: boolean; keyUp?: (e: KeyboardEvent) => void } = {}): () => void {
  const l: Layer = { id, seq: seqFor(id), handler, modal: !!opts.modal, late: !!opts.late, keyUp: opts.keyUp }
  layers.push(l)
  return release(layers, l)
}

/** A surface Escape closes. Newest open is top-most. `modal: false` for drawers beside the page. */
export function addEscape(id: string, close: () => void, opts: { modal?: boolean } = {}): () => void {
  const t: EscapeTarget = { id, seq: seqFor(id), close, modal: opts.modal !== false }
  escapes.push(t)
  return release(escapes, t)
}

/** A live Undo toast. ⌘Z outside a text field presses the newest. */
export function addUndo(id: string, undo: () => void): () => void {
  const u: UndoTarget = { id, seq: seqFor(id), undo }
  undos.push(u)
  return release(undos, u)
}

/**
 * A static claim: while it's held the app's global shortcuts leave these key
 * codes alone when pressed with no modifier (⌘→ still skips), and the page's
 * own layer handles them. The generalised claimTransportKeys (input-mode.ts).
 */
export function claimKeys(id: string, codes: readonly string[]): () => void {
  const c: Claim = { id, seq: seqFor(id), codes: new Set(codes) }
  claims.push(c)
  return release(claims, c)
}

export function isClaimed(code: string): boolean {
  return claims.some((c) => c.codes.has(code))
}
export function keysClaimed(): boolean {
  return claims.length > 0
}

const bySeq = <T extends Entry>(list: readonly T[]): T[] => [...list].sort((a, b) => a.seq - b.seq)
/** Escape's stack, oldest first (the last one is top-most). */
export function escapeStack(): readonly { id: string; modal: boolean }[] {
  return bySeq(escapes)
}
export function undoStack(): readonly { id: string }[] {
  return bySeq(undos)
}
export function modalOpen(): boolean {
  return layers.some((l) => l.modal) || escapes.some((t) => t.modal)
}

// ── dispatch ─────────────────────────────────────────────────────────────

function isField(el: unknown): el is HTMLElement {
  if (!el || typeof el !== 'object') return false
  const t = el as { tagName?: string; isContentEditable?: boolean }
  const tag = (t.tagName || '').toUpperCase()
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!t.isContentEditable
}

export function focusStateOf(target: unknown): FocusState {
  if (!isField(target)) return 'none'
  const inOverlay = typeof (target as Element).closest === 'function' && !!(target as Element).closest(OVERLAY_SELECTOR)
  return inOverlay ? 'field-in-overlay' : 'field'
}

function handled(e: KeyboardEvent, r: boolean | void): boolean {
  return r === true || e.defaultPrevented || e.cancelBubble
}

/** Offer a key to the layers of one phase. True: one took it. */
export function offerToLayers(e: KeyboardEvent, phase: 'early' | 'late'): boolean {
  if (e.key === 'Escape') return false
  for (const l of layerOrder(layers, phase, modalOpen())) {
    if (handled(e, l.handler(e))) return true
  }
  return false
}

export interface KeyboardActions {
  /** A keymap-wired shortcut (common/keymap.ts SHORTCUTS, wiring 'keymap'). */
  shortcut: (id: string, e: KeyboardEvent) => void
  /** Escape with nothing open: clear the search. */
  clearSearch: () => void
}

/** The global decision for a key the layers and the focused element left alone. */
export function routeGlobal(e: KeyboardEvent): Route {
  return routeKey(e, { focus: focusStateOf(e.target), claimed: isClaimed, escape: escapeStack(), undo: undoStack() })
}

export function applyRoute(route: Route, e: KeyboardEvent, actions: KeyboardActions): void {
  switch (route.to) {
    case 'escape': {
      const t = escapes.find((x) => x.id === route.id)
      if (!t) return
      e.preventDefault()
      t.close()
      return
    }
    case 'let-go': {
      const el = e.target
      if (isField(el)) (el as HTMLElement).blur?.()
      actions.clearSearch()
      return
    }
    case 'clear-search': actions.clearSearch(); return
    case 'undo': {
      const u = undos.find((x) => x.id === route.id)
      if (!u) return
      e.preventDefault()
      u.undo()
      return
    }
    case 'shortcut':
      e.preventDefault()
      actions.shortcut(route.id, e)
      return
    case 'native': return
  }
}

/** Mount once (App). Installs the app's only window keyboard listeners. */
export function installKeyboard(actions: KeyboardActions): () => void {
  // A layer that took the key early by returning true (without preventDefault)
  // has it: the late phase must not hand it on to the app as well.
  const taken = new WeakSet<KeyboardEvent>()
  const early = (e: KeyboardEvent): void => {
    if (e.isComposing) return
    if (offerToLayers(e, 'early')) taken.add(e)
  }
  const late = (e: KeyboardEvent): void => {
    if (e.isComposing || taken.has(e)) return
    if (offerToLayers(e, 'late')) return
    // An on-screen Cover Flow owns plain ←/→/Return (utils/arrowKeyOwner.ts).
    if (!e.defaultPrevented && handleOwnedArrowKey(e)) return
    applyRoute(routeGlobal(e), e, actions)
  }
  const up = (e: KeyboardEvent): void => {
    for (const l of layerOrder(layers, 'early', false)) l.keyUp?.(e)
  }
  window.addEventListener('keydown', early, true)
  window.addEventListener('keydown', late)
  window.addEventListener('keyup', up, true)
  return () => {
    window.removeEventListener('keydown', early, true)
    window.removeEventListener('keydown', late)
    window.removeEventListener('keyup', up, true)
  }
}

/** Tests only: forget every registration. */
export function resetKeyboardForTests(): void {
  layers.length = 0; escapes.length = 0; undos.length = 0; claims.length = 0
  seqOf.clear()
}
