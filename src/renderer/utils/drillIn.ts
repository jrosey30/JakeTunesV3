/**
 * 4.4.27: cross-view "drill into a specific item" handoff.
 *
 * Why this exists:
 * When the user clicks an artist card on the Home view, we want
 * ArtistsView (on next mount) to expand and scroll to that specific
 * artist — not just open the generic Artists list. Same pattern for
 * Album cards → AlbumsView (future).
 *
 * Why module-level state instead of LibraryContext:
 *   - One-shot consumption: the value is read exactly once on mount
 *     of the destination view and then cleared, never persisted.
 *   - No dependency tree noise: the source view dispatches a
 *     plain SET_VIEW action; only the destination view reads this
 *     module. No reducer changes, no new actions in LibraryContext.
 *   - Same shape as `scrollCache` in useScrollPersistence — small
 *     module-level Map for cross-mount data handoff.
 *
 * Usage:
 *   // Source (HomeView):
 *   requestDrillIn('artist', card.name)
 *   dispatch({ type: 'SET_VIEW', view: 'artists' })
 *
 *   // Destination (ArtistsView, useEffect on mount):
 *   const target = consumeDrillIn('artist')
 *   if (target) { setExpanded(new Set([target])); scrollToArtist(target) }
 *
 * Add `'album'` (or other) targets here as new drill-ins land.
 */

export type DrillTarget = 'artist' | 'album'

interface PendingDrillIn {
  target: DrillTarget
  key: string
  /** Wall-clock when set; stale entries (>5 sec) are discarded so a
   *  forgotten request can't fire weeks later on a stray view-switch. */
  setAt: number
}

const STALE_AFTER_MS = 5000

let pending: PendingDrillIn | null = null

export function requestDrillIn(target: DrillTarget, key: string): void {
  pending = { target, key, setAt: Date.now() }
}

/**
 * Consume the pending drill-in for `target`. Returns the key (and
 * clears the pending state) if one is queued for THIS target and is
 * still fresh; returns null otherwise.
 */
export function consumeDrillIn(target: DrillTarget): string | null {
  const p = pending
  if (!p) return null
  if (p.target !== target) return null
  if (Date.now() - p.setAt > STALE_AFTER_MS) {
    pending = null
    return null
  }
  pending = null
  return p.key
}
