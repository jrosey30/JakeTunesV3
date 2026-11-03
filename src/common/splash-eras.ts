/**
 * The intro page is an evolution of every JakeTunes logo (Jake, 2026-11-02:
 * "make the jaketunes intro page an evolution of all the logos we have used
 * for jaketunes"). The boot no longer resolves one mark; it walks the lineage,
 * oldest first, and lands on the mark that ships.
 *
 * The five marks, in the order git remembers them:
 *   April 14 2026   the portrait — a cartoon Jake in a circle, the V3 /
 *                   iTunes 7 replica's first icon (build/icon.icns, 79878c60)
 *   May 15 2026     the cream eighth note on a burnt-orange tile
 *                   (build/icon-source.png, aed63ef5) — the iPhone still wears it
 *   August 8 2026   the brush J over a faded click wheel ("THE LOGO", 870842d0,
 *                   locked c7ee8142, rolled into the app 83f88635)
 *   August 8 2026   the pixel iPod with the J on its screen — the COLD BOOT
 *                   mark, ten hours later (cccddb60)
 *   August 9 2026   the pixel eighth note, white with a black outline on hot
 *                   orange — 2.0 at noon (e87bef3e), 2.1 an hour later
 *                   (1afe3142); the mark that ships today
 *
 * This module is the TIMELINE, pure, so the choreography is unit-tested
 * (src/main/__tests__/splash-eras.test.ts). SplashScreen.tsx draws it.
 */

export interface SplashEra {
  /** Asset key; the last one is the shipping mark (SplashScreen's logoUrl). */
  key: 'portrait' | 'cream-note' | 'brush-j' | 'pixel-ipod' | 'pixel-note'
  /** The caption shown under the mark while this era is on screen. */
  label: string
}

export const SPLASH_ERAS: readonly SplashEra[] = [
  { key: 'portrait', label: 'April 2026 · the portrait' },
  { key: 'cream-note', label: 'May 2026 · the note' },
  { key: 'brush-j', label: 'August 2026 · the brush J' },
  { key: 'pixel-ipod', label: 'August 2026 · the pixel iPod' },
  { key: 'pixel-note', label: 'August 2026 · the pixel note' },
]

/** How long each earlier mark holds, fully shown, before the next dissolves in. */
export const ERA_HOLD_MS = 260
/** The cross-dissolve from one mark into the next. */
export const ERA_FADE_MS = 200
/** One era's slot: its dissolve in, then its hold. */
export const ERA_STEP_MS = ERA_FADE_MS + ERA_HOLD_MS

/** When the last mark is fully on screen, measured from the lineage's start. */
export const LINEAGE_MS = (SPLASH_ERAS.length - 1) * ERA_STEP_MS + ERA_FADE_MS

export interface EraFrame {
  /** The era dissolving in (or holding). */
  index: number
  /** 0 → 1 over ERA_FADE_MS: how far `index` has dissolved in over the one before it. */
  blend: number
  /** The era underneath while `blend` < 1, or null for the first. */
  under: number | null
  /** True once the last mark is fully on screen. */
  done: boolean
}

/**
 * Where the lineage is at `t` ms after it starts. Era i dissolves in from
 * i·STEP to i·STEP + FADE and holds until (i+1)·STEP; the last era holds
 * forever. Negative time is the first era not yet begun.
 */
export function eraAt(t: number): EraFrame {
  const last = SPLASH_ERAS.length - 1
  if (!(t > 0)) return { index: 0, blend: 0, under: null, done: false }
  const index = Math.min(last, Math.floor(t / ERA_STEP_MS))
  const blend = Math.min(1, (t - index * ERA_STEP_MS) / ERA_FADE_MS)
  return {
    index,
    blend,
    under: index > 0 && blend < 1 ? index - 1 : null,
    done: index === last && blend >= 1,
  }
}

/** The caption for a frame: the era that owns most of the screen. */
export function eraLabelAt(t: number): string {
  const f = eraAt(t)
  const shown = f.blend >= 0.5 || f.under === null ? f.index : f.under
  return SPLASH_ERAS[shown]!.label
}
