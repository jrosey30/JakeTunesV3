/**
 * A drag that ends on a card is not a click on it (V7 follow-up to #490).
 *
 * Cover Flow flips by dragging, and the browser still fires `click` after a
 * drag that ends on a cover. The old guard asked the drag record, but
 * pointerup had already cleared it, so the click always saw "not moved" and a
 * short drag onto the front cover opened the album. The guard keeps the
 * "moved" answer from pointerup until the click has read it (or until the next
 * pointerdown), whichever comes first.
 *
 * Pure: the view feeds it events; the tests feed it sequences.
 */
export interface DragClickGuard {
  down: () => void
  /** A move far enough to count as a drag. */
  moved: () => void
  /** Pointer up, leave or cancel. */
  up: () => void
  /** The click: true when it may act. Reading it spends the drag. */
  click: () => boolean
}

export function dragClickGuard(): DragClickGuard {
  let dragging = false
  let moved = false
  let spentOnClick = false
  return {
    down: () => { dragging = true; moved = false; spentOnClick = false },
    moved: () => { if (dragging) moved = true },
    up: () => { dragging = false },
    click: () => {
      if (spentOnClick) return true
      spentOnClick = true
      const ok = !moved
      moved = false
      return ok
    },
  }
}
