/**
 * Gapless seam timing — pure math, no Howler / AudioContext / DOM.
 *
 * Head trim (incoming BufferSource offset) shipped first. This module is
 * the tail half: given encoder padding, fire the seam that many seconds
 * before Howler EOF so the next track starts at music-end, not in the
 * encoder's trailing silence (typically 4–23 ms on Jake's AAC library).
 *
 * Flag-gated. Crossfade mode never calls these helpers (useAudio skips
 * the gapless seam path when crossfade is on). Flip
 * `USE_GAPLESS_TAIL_TRIM` to false for instant rollback to head-trim-only.
 *
 * ⚠️ TWIN: none. Counts come from `src/main/gapless-trim.ts` (iTunSMPB /
 * LAME); this file only converts them into scheduler numbers.
 */

/** Instant rollback: false restores head-trim-only seams (pre-tail-trim). */
export const USE_GAPLESS_TAIL_TRIM = true

/**
 * Never subtract more than this from remaining, even if the tag claims
 * a huge pad. AAC padding is < one 1024-sample frame (~23 ms at 44.1k);
 * MP3 is a couple of granules. 80 ms is well above real encoder padding
 * and well below "we ate the last beat."
 */
export const MAX_TAIL_TRIM_SEC = 0.080

export interface GaplessTrimSecs {
  delaySec: number
  paddingSec: number
}

export function clampPaddingSec(paddingSec: number): number {
  if (!Number.isFinite(paddingSec) || paddingSec <= 0) return 0
  return Math.min(paddingSec, MAX_TAIL_TRIM_SEC)
}

/**
 * Howler remaining-ms until file EOF → remaining-ms until MUSIC end.
 * Identity when the flag is off, padding is 0, or remaining is already
 * inside the pad (we still return ≥1 so the seam can fire "now").
 */
export function remainingMsUntilMusicEnd(
  remainingMs: number,
  paddingSec: number,
  enabled: boolean = USE_GAPLESS_TAIL_TRIM,
): number {
  const remaining = Number(remainingMs)
  if (!Number.isFinite(remaining)) return 1
  if (!enabled) return Math.max(1, remaining)
  const padMs = Math.round(clampPaddingSec(paddingSec) * 1000)
  return Math.max(1, remaining - padMs)
}

/** Decoded-buffer duration minus head delay and tail padding. */
export function usableDurationSec(
  bufferDuration: number,
  delaySec: number,
  paddingSec: number,
  enabled: boolean = USE_GAPLESS_TAIL_TRIM,
): number {
  const dur = Number(bufferDuration)
  if (!Number.isFinite(dur) || dur <= 0) return 0
  const delay = Number.isFinite(delaySec) && delaySec > 0 ? delaySec : 0
  const pad = enabled ? clampPaddingSec(paddingSec) : 0
  return Math.max(0, dur - delay - pad)
}

/**
 * `AudioBufferSourceNode.start(when, offset, duration)` duration arg:
 * play this many seconds of MUSIC starting at `offset` (already the
 * head-trim). 0 means "don't start" (degenerate buffer).
 */
export function incomingPlayDurationSec(
  bufferDuration: number,
  delaySec: number,
  paddingSec: number,
  enabled: boolean = USE_GAPLESS_TAIL_TRIM,
): number {
  return usableDurationSec(bufferDuration, delaySec, paddingSec, enabled)
}

export function trimSecsFromProbe(trim: {
  delaySec?: number
  paddingSec?: number
  delaySamples?: number
  paddingSamples?: number
  sampleRate?: number
} | null | undefined): GaplessTrimSecs {
  if (!trim) return { delaySec: 0, paddingSec: 0 }
  const sr = trim.sampleRate && trim.sampleRate > 0 ? trim.sampleRate : 0
  const delaySec = (trim.delaySec && trim.delaySec > 0)
    ? trim.delaySec
    : (sr && trim.delaySamples && trim.delaySamples > 0 ? trim.delaySamples / sr : 0)
  const paddingSec = (trim.paddingSec && trim.paddingSec > 0)
    ? trim.paddingSec
    : (sr && trim.paddingSamples && trim.paddingSamples > 0 ? trim.paddingSamples / sr : 0)
  return {
    delaySec: Number.isFinite(delaySec) ? delaySec : 0,
    paddingSec: Number.isFinite(paddingSec) ? paddingSec : 0,
  }
}
