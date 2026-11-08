/**
 * Keyboard moves on a song list (Jake, 2026-11-07: "i cant go up and down
 * any playlist with the up down arrows!!!"). Songs had them; playlists and
 * smart playlists didn't, so ↑/↓ there fell through to App.tsx's global
 * volume shortcut. The pure part lives here (tested in
 * src/main/__tests__/track-list-keys.test.ts); hooks/useTrackListKeys.ts
 * wires it to a view.
 *
 *   ↑ / ↓        move the selection one row (in the view's current order)
 *   ⇧↑ / ⇧↓      extend it from the anchor (the last plain click / move)
 *   Enter        play the focused row
 *   Space        nothing loaded: play the highlighted row; else play/pause
 *   a letter     type-to-find on the title (800 ms buffer)
 *
 * ⌥↑ / ⌥↓ are never taken: a sidebar section header uses them to move itself.
 */

export type ListKeyIntent =
  | { kind: 'move'; dir: 1 | -1; extend: boolean }
  | { kind: 'enter' }
  | { kind: 'space' }
  | { kind: 'char'; char: string }

export interface ListKeyLike {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

export function listKeyIntent(e: ListKeyLike): ListKeyIntent | null {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (e.altKey) return null
    return { kind: 'move', dir: e.key === 'ArrowDown' ? 1 : -1, extend: e.shiftKey }
  }
  if (e.key === 'Enter') return { kind: 'enter' }
  if (e.key === ' ') return { kind: 'space' }
  if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) return { kind: 'char', char: e.key.toLowerCase() }
  return null
}

/**
 * The row a move lands on. Nothing focused yet (current < 0): ↓ starts at
 * the top, ↑ at the bottom. Clamped to the list; -1 for an empty list.
 */
export function nextListIndex(current: number, dir: 1 | -1, length: number): number {
  if (length <= 0) return -1
  const next = current < 0 ? (dir === 1 ? 0 : length - 1) : current + dir
  return Math.max(0, Math.min(length - 1, next))
}

/** ⇧-move: the inclusive range from the anchor (or the new row, with no anchor) to the new row. */
export function shiftRange(anchor: number, next: number): { from: number; to: number } {
  const a = anchor >= 0 ? anchor : next
  return { from: Math.min(a, next), to: Math.max(a, next) }
}

/** Type-to-find: the first row whose title starts with the typed letters, or -1. */
export function typeToFindIndex(tracks: ReadonlyArray<{ title?: string | null }>, query: string): number {
  if (!query) return -1
  return tracks.findIndex(t => (t.title || '').toLowerCase().startsWith(query))
}

/** Someone is typing: a text field, a select, or contenteditable keeps every key. */
export function isTypingTarget(el: { tagName?: string; isContentEditable?: boolean } | null | undefined): boolean {
  if (!el) return false
  const tag = (el.tagName || '').toUpperCase()
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!el.isContentEditable
}

/**
 * Bring row `idx` of a plain (non-virtual) list into view, nearest edge,
 * below a header that sits inside the same scroller. Rows are the
 * `.songs-row` children of `.songs-body`.
 */
export function scrollListRowIntoView(container: HTMLElement | null, idx: number): void {
  if (!container || idx < 0) return
  const rows = container.querySelectorAll<HTMLElement>(':scope > .songs-body > .songs-row')
  const row = rows[idx]
  if (!row) return
  const box = container.getBoundingClientRect()
  const header = container.querySelector<HTMLElement>(':scope > .songs-header')
  // Sticky or scrolled away, the header covers whatever is above its bottom edge.
  const top = header ? Math.max(box.top, header.getBoundingClientRect().bottom) : box.top
  const r = row.getBoundingClientRect()
  if (r.top < top) container.scrollTop -= top - r.top
  else if (r.bottom > box.bottom) container.scrollTop += r.bottom - box.bottom
}
