/**
 * 4.5: holder for the mix being viewed in MixDetailView. "Your Mixes" cards are
 * ephemeral (fetched from the homemini backend, not in the library), so they
 * can't be routed by a library key like albums are. Instead the card stashes
 * the mix here and flips the view to 'mix-detail'; MixDetailView reads it back.
 * Mirrors how the iOS app pushes MixDetailView on a card tap (commit #144 —
 * "tapping a mix card opens the mix, doesn't auto-play").
 */
import type { Track, ViewName } from '../types'

export interface VibeMix {
  id: string
  title: string
  subtitle: string
  tracks: Track[]
}

let active: VibeMix | null = null
let returnView: ViewName = 'home'

/** Stash the mix and remember where to return on Back. */
export function openMix(mix: VibeMix, from: ViewName): void {
  active = mix
  returnView = from
}
export function getActiveMix(): VibeMix | null { return active }
export function getMixReturnView(): ViewName { return returnView }
