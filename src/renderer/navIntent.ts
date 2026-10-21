/**
 * Back / forward RETURNS to a page; it doesn't arrive there again (2026-10-21).
 *
 * NavigationContext marks a history navigation just before it replays the
 * stored location; MainContent takes the mark when the new page mounts and
 * renders it with data-nav="return", which switches off the entrance
 * choreography (the view fade, Home's card/section rise-ins, the artist page's
 * staggered rise). Measured before this: back to the artist page sat WHITE for
 * ~400 ms — the restored scroll position landed inside sections whose rise-in
 * was still waiting out its delay at opacity 0 — and back to Home showed 13
 * blank frames.
 *
 * Module state, not context: the mark crosses from a click handler to the next
 * render of a different component exactly once, then clears.
 */
let pending = false
let clearTimer: ReturnType<typeof setTimeout> | null = null

export function markHistoryNavigation(): void {
  pending = true
  // A back that lands on the same page (nothing remounts) must not leak the
  // mark into the next real arrival.
  if (clearTimer) clearTimeout(clearTimer)
  clearTimer = setTimeout(() => { pending = false; clearTimer = null }, 500)
}

export function takeHistoryNavigation(): boolean {
  const was = pending
  pending = false
  return was
}
