/**
 * The transport-key claim, kept for the pages that use it (the Supreme Court
 * room, the Listen List's Inbox, the Top 1000 blind check). Since V7 it is a
 * thin name over the keyboard host's general claim (keyboard.ts claimKeys):
 * while a page holds a claim, the app's global shortcuts leave those key codes
 * alone, with any modifiers, and the page's own key layer handles them.
 *
 * Deliberately a CLAIM, not focus: a game's canvas often doesn't hold DOM
 * focus, and "Space toggles the music unless the canvas happens to be
 * focused" is the unpredictable behaviour this removes. Escape, ⌘F, "/" and
 * the media keys are never transport keys, so they keep working. Releasing is
 * immediate and idempotent; a stale release from a page that already handed
 * over does nothing to the live claim.
 */
import { claimKeys, isClaimed, keysClaimed } from './keyboard.ts'

export type TransportKey = 'Space' | 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown'

const TRANSPORT_KEYS: readonly TransportKey[] = ['Space', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']

/** Claim the transport keys (all five, or the ones named). Returns the release. */
export function claimTransportKeys(id: string, keys: readonly TransportKey[] = TRANSPORT_KEYS): () => void {
  return claimKeys(id, keys)
}

export function transportKeysClaimed(): boolean {
  return keysClaimed()
}

/** True when the app's global shortcuts must ignore a key with this `code`. */
export function shouldYieldToClaim(code: string): boolean {
  return isClaimed(code)
}
