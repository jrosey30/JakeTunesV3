/**
 * The visible Cover Flow owns ← / → (Jake, 2026-10-21: "i press arrow left
 * and right on keyboard and it plays tracks. i have to click inside the home
 * page for it to cover flow. come on!!!!"). The iTunes way: while a Cover
 * Flow is ON SCREEN, plain ←/→ move its covers and Enter/Return opens the
 * front album — no click first. Everywhere else ←/→ stay previous / next
 * track, and ⌘←/⌘→ are ALWAYS previous / next track, even over the flow.
 *
 * A view registers an owner while it's mounted (hooks/useArrowKeyOwner.ts:
 * "I own ←/→ while ≥ 50% of my stage is visible"); App.tsx's document-level
 * transport handler asks handleOwnedArrowKey(e) first. A view's OWN focused
 * key handler still runs before this (and stops the bubble), so a focused
 * flow behaves exactly as before.
 *
 * Never taken: a modified arrow (⌘ / Ctrl / ⌥ / ⇧), focus in a text field,
 * a select, contenteditable or a widget that uses arrows itself (slider,
 * listbox, menu, grid…), or while a menu or dialog is open. Enter is taken
 * only when focus is on nothing in particular — on a focused button or link
 * Enter presses that.
 *
 * Unlike input-mode.ts's claimTransportKeys (a static claim on every
 * transport key, modifiers included — Step Inside, the Listen List), an
 * owner holds only plain ←/→/Enter and only while it's on screen.
 */

export interface ArrowKeyOwner {
  /** On screen and able to take keys right now. */
  isActive: () => boolean
  /** ← = −1, → = +1. */
  step: (delta: -1 | 1) => void
  /** Enter / Return; omit to leave Enter alone. */
  enter?: () => void
}

export type ArrowIntent = 'left' | 'right' | 'enter'

/** What a key event asks for, if it's one an owner may take. */
export interface KeyLike {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  defaultPrevented?: boolean
  isComposing?: boolean
}

export function arrowIntent(e: KeyLike): ArrowIntent | null {
  if (e.defaultPrevented || e.isComposing) return null
  // ⌘←/⌘→ (and any other modified arrow) stay the transport's.
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null
  if (e.key === 'ArrowLeft') return 'left'
  if (e.key === 'ArrowRight') return 'right'
  if (e.key === 'Enter') return 'enter'
  return null
}

/**
 * Where focus is, as far as the keys go:
 *   neutral  nothing in particular (the page, a non-interactive element)
 *   control  a button / link / checkbox — arrows are free, Enter presses it
 *   text     a text field, select, contenteditable, or a widget that uses
 *            the arrows itself — hands off
 *   overlay  inside, or under, an open menu or dialog — hands off
 */
export type FocusKind = 'neutral' | 'control' | 'text' | 'overlay'

/** The parts of an Element this reads (testable without a DOM). */
export interface FocusLike {
  tagName: string
  isContentEditable?: boolean
  getAttribute(name: string): string | null
  closest?(selector: string): unknown
}

const ARROW_WIDGET_ROLES = new Set([
  'textbox', 'searchbox', 'combobox', 'slider', 'spinbutton', 'listbox', 'option', 'menu', 'menubar', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'grid', 'gridcell', 'treegrid', 'tree', 'treeitem', 'tablist', 'tab', 'radiogroup',
])
const CONTROL_ROLES = new Set(['button', 'link', 'checkbox', 'switch', 'radio'])
const BUTTONISH_INPUTS = new Set(['button', 'submit', 'reset', 'checkbox', 'radio', 'image', 'color', 'file'])

/** Every open menu or dialog surface in the app (autoNavGuard's modal list + menus and plain dialogs). */
export const OVERLAY_SELECTOR = [
  '[aria-modal="true"]', '[role="dialog"]', '[role="alertdialog"]', '[role="menu"]', 'dialog[open]',
  '.context-menu', '.confirm-overlay', '.getinfo-overlay', '.imp-backdrop', '.agm-overlay', '.picks-overlay', '.visualizer-overlay',
].join(', ')

/** A menu or dialog is open somewhere: the flows keep their hands off the arrows. */
export function overlayOpen(): boolean {
  return typeof document !== 'undefined' && !!document.querySelector(OVERLAY_SELECTOR)
}

export function classifyFocus(el: FocusLike | null, overlayOpen: boolean): FocusKind {
  if (overlayOpen) return 'overlay'
  if (!el) return 'neutral'
  const tag = el.tagName.toUpperCase()
  if (tag === 'BODY' || tag === 'HTML') return 'neutral'
  if (el.closest?.(OVERLAY_SELECTOR)) return 'overlay'
  if (tag === 'TEXTAREA' || tag === 'SELECT') return 'text'
  if (tag === 'INPUT') return BUTTONISH_INPUTS.has((el.getAttribute('type') || 'text').toLowerCase()) ? 'control' : 'text'
  if (el.isContentEditable) return 'text'
  const role = (el.getAttribute('role') || '').toLowerCase()
  if (ARROW_WIDGET_ROLES.has(role)) return 'text'
  if (tag === 'BUTTON' || tag === 'SUMMARY' || (tag === 'A' && el.getAttribute('href') !== null) || CONTROL_ROLES.has(role)) return 'control'
  return 'neutral'
}

export function focusAllows(intent: ArrowIntent, kind: FocusKind): boolean {
  if (kind === 'text' || kind === 'overlay') return false
  if (intent === 'enter') return kind === 'neutral'
  return true
}

// ── the registry ─────────────────────────────────────────────────────────

const owners: ArrowKeyOwner[] = []

/** Register; returns the release (idempotent). The newest active owner wins. */
export function claimArrowKeys(owner: ArrowKeyOwner): () => void {
  owners.push(owner)
  return () => {
    const i = owners.lastIndexOf(owner)
    if (i >= 0) owners.splice(i, 1)
  }
}

/** The owner that would take a key now, if any. */
export function activeArrowKeyOwner(): ArrowKeyOwner | null {
  for (let i = owners.length - 1; i >= 0; i--) {
    if (owners[i].isActive()) return owners[i]
  }
  return null
}

/**
 * Route one key (pure, given the focus kind): run the owner and say so, or
 * leave it to the transport. Enter goes nowhere when the owner takes no Enter.
 */
export function routeArrowKey(e: KeyLike, focus: FocusKind): { owner: ArrowKeyOwner; intent: ArrowIntent } | null {
  const intent = arrowIntent(e)
  if (!intent || !focusAllows(intent, focus)) return null
  const owner = activeArrowKeyOwner()
  if (!owner) return null
  if (intent === 'enter' && !owner.enter) return null
  return { owner, intent }
}

/**
 * App.tsx's transport handler asks this first: true = an on-screen Cover
 * Flow took the key (it has run; the transport must not).
 */
export function handleOwnedArrowKey(e: KeyboardEvent): boolean {
  if (owners.length === 0) return false
  const active = document.activeElement
  const focus = classifyFocus(active instanceof Element ? active : null, overlayOpen())
  const route = routeArrowKey(e, focus)
  if (!route) return false
  e.preventDefault()
  if (route.intent === 'enter') route.owner.enter?.()
  else route.owner.step(route.intent === 'left' ? -1 : 1)
  return true
}
