/**
 * Who owns the keyboard right now.
 *
 * The app binds transport shortcuts globally — Space, and the four arrows
 * for next/previous/volume — on `document` AND in the CAPTURE phase on
 * `window`. Capture phase matters: it runs before any view's own listener,
 * so a view cannot take a key back by calling stopPropagation. Step Inside
 * uses Space and the arrows for digging, so without this the arrows skipped
 * tracks while you were flipping through a crate.
 *
 * Deliberately a CLAIM, not focus. The game's canvas often does not hold
 * DOM focus (you might have clicked the HUD, or nothing at all), and
 * "arrows skip tracks unless the canvas happens to be focused" is exactly
 * the unpredictable behaviour we are removing.
 *
 * Narrow on purpose:
 *   • Only the transport keys are withheld.
 *   • Escape, Cmd+F, "/" and the dedicated media keys keep working — a
 *     media key is explicit hardware intent, and Escape is the way out.
 *   • Mouse playback controls are untouched; this is keyboard only.
 *   • Releasing is immediate, and idempotent, so leaving the game — by
 *     button, by Escape, or by the view unmounting — restores the app's
 *     shortcuts in the same tick.
 */
let owner: string | null = null

/** Claim the transport keys. Returns the release function; call it on
 *  unmount. Releasing a claim someone else now holds does nothing. */
export function claimTransportKeys(id: string): () => void {
  owner = id
  return () => { if (owner === id) owner = null }
}

export function transportKeysClaimed(): boolean {
  return owner !== null
}

/** The keys a claim withholds. Everything else falls through to the app. */
const WITHHELD = new Set(['Space', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'])

/** True when the app's global shortcut handlers must ignore this event.
 *  Takes the event's `code` so it is testable without a DOM. */
export function shouldYieldToClaim(code: string): boolean {
  return owner !== null && WITHHELD.has(code)
}
