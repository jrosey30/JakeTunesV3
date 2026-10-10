/**
 * Which button Enter presses in a ConfirmDialog (spec-03, 2026-10-09).
 *
 * The dialog used to call onConfirm on every Enter while it focused Cancel,
 * so a reflexive Enter on "Delete this?" deleted. The rule now is the
 * macOS one: Enter presses the button that has focus. A destructive dialog
 * opens on Cancel; any other dialog opens on its confirm button. If focus
 * is somewhere else entirely, Enter presses that default.
 *
 * Pure so it is testable without a DOM.
 */
export type ConfirmButton = 'cancel' | 'confirm'

/** The button a dialog focuses when it opens. */
export function defaultButton(destructive: boolean, hideCancel: boolean): ConfirmButton {
  return destructive && !hideCancel ? 'cancel' : 'confirm'
}

/** The button Enter presses, given which one (if either) has focus. */
export function enterPresses(focused: ConfirmButton | null, destructive: boolean, hideCancel: boolean): ConfirmButton {
  if (focused === 'cancel' && !hideCancel) return 'cancel'
  if (focused === 'confirm') return 'confirm'
  return defaultButton(destructive, hideCancel)
}
