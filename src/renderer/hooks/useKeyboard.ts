/**
 * React hooks over the keyboard host (keyboard.ts). Each registers while
 * `enabled` and keeps its place in the open order across re-renders: the
 * latest callback is read from a ref, so a new closure never re-registers.
 * The id names the surface; each mounted instance gets its own (useId), so
 * two dialogs of one kind keep their own places on the stack.
 */
import { useEffect, useId, useRef } from 'react'
import { addEscape, addKeyLayer, addUndo, type KeyHandler } from '../keyboard'

/** Escape closes this surface while it's open (top-most first). Drawers beside the page pass modal: false. */
export function useEscape(id: string, enabled: boolean, close: () => void, opts: { modal?: boolean } = {}): void {
  const ref = useRef(close)
  ref.current = close
  const modal = opts.modal !== false
  const key = `${id}:${useId()}`
  useEffect(() => {
    if (!enabled) return
    return addEscape(key, () => ref.current(), { modal })
  }, [key, enabled, modal])
}

/** Keys this page, list or dialog handles while `enabled`. */
export function useKeyLayer(id: string, enabled: boolean, handler: KeyHandler, opts: { modal?: boolean; late?: boolean } = {}): void {
  const ref = useRef(handler)
  ref.current = handler
  const { modal, late } = opts
  const key = `${id}:${useId()}`
  useEffect(() => {
    if (!enabled) return
    return addKeyLayer(key, (e) => ref.current(e), { modal, late })
  }, [key, enabled, modal, late])
}

/** ⌘Z (outside a text field) presses this Undo while it's showing. */
export function useUndoShortcut(id: string, enabled: boolean, undo: () => void): void {
  const ref = useRef(undo)
  ref.current = undo
  const key = `${id}:${useId()}`
  useEffect(() => {
    if (!enabled) return
    return addUndo(key, () => ref.current())
  }, [key, enabled])
}
