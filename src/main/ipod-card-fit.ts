/**
 * Does the set fit on the card? Asked before the card is touched (2026-11-13).
 *
 * A list can now hold 5,000 songs (about 150 GB lossless). Nothing used to
 * check that a set fits: a first big sync onto a card too small for it copied
 * until the card was full, failed its verify, and the engine's stop then
 * emptied the card after hours of copying. The engine asks this before any
 * wipe or write, with the sizes of the files it is about to put on.
 *
 * `capacityBytes` is the card's whole size (statfs blocks), so the answer is
 * the same for a swap and a full copy: the finished set must fit. Unknown
 * capacity (null, 0, not a number) is unknown and refuses nothing, as before.
 *
 * Pure — node --test loads it.
 */

/** Room held back for the catalog, artwork and the file system's own rounding: per song, and a share of the card. */
export const CARD_FIT_PER_SONG_BYTES = 4 * 1024
export const CARD_FIT_SHARE = 0.01

const gb = (n: number): string => {
  const v = n / 1024 ** 3
  return v >= 10 ? v.toFixed(0) : v >= 0.1 ? v.toFixed(1) : v.toFixed(3)
}

export interface CardFit { needBytes: number; roomBytes: number }

/** What the set needs and what the card can give it; null when the card's size isn't known. */
export function cardFit(copySizes: readonly number[], capacityBytes: number | null | undefined): CardFit | null {
  if (typeof capacityBytes !== 'number' || !Number.isFinite(capacityBytes) || capacityBytes <= 0) return null
  let songs = 0
  for (const s of copySizes) songs += Number.isFinite(s) && s > 0 ? s : 0
  return {
    needBytes: songs + copySizes.length * CARD_FIT_PER_SONG_BYTES,
    roomBytes: Math.floor(capacityBytes * (1 - CARD_FIT_SHARE)),
  }
}

/** null = it fits (or the card's size is unknown); otherwise the plain refusal, with the numbers. */
export function cardTooSmall(copySizes: readonly number[], capacityBytes: number | null | undefined, ipodName = 'this iPod'): string | null {
  const fit = cardFit(copySizes, capacityBytes)
  if (!fit || fit.needBytes <= fit.roomBytes) return null
  const n = copySizes.length.toLocaleString('en-US')
  return `These ${n} songs need about ${gb(fit.needBytes)} GB and ${ipodName} holds ${gb(fit.roomBytes)} GB, so they won’t fit. ` +
    `Nothing on the iPod was touched. Make the list shorter, or sync smaller (AAC) copies.`
}
