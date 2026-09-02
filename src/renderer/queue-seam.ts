/**
 * queue-seam — the ONE way the audio engine locates itself in the live
 * queue at a track boundary (2026-09-02, Jake: "fix the queue and make
 * damn sure that every which way that i can affect the queue, add,
 * delete, switch order is fixed").
 *
 * The bug: at the seam the engine installed a queue SNAPSHOT taken when
 * the next track was primed (≤10 s before the end, or at crossfade start)
 * and advanced by a REMEMBERED index. Any add / remove / reorder made
 * after that moment was erased or misread. The cure is to never trust a
 * remembered queue or index across time: locate the track that just
 * ended by its id in the LIVE queue (the remembered index is only a hint
 * for duplicates), and take whatever is next in that live queue.
 *
 * Pure, Electron-free, unit-tested. Used by useAudio.ts (seams) and
 * PlaybackContext.tsx (PLAY_TRACK with locateInQueue).
 */
export interface SeamTrack { id: number }

/** Index of `trackId` in `queue`, preferring the occurrence nearest to
 *  `hint` (the same song can sit in a queue twice). -1 when absent. */
export function locateTrackIndex(queue: ReadonlyArray<SeamTrack>, trackId: number, hint: number = -1): number {
  if (hint >= 0 && hint < queue.length && queue[hint]?.id === trackId) return hint
  let best = -1
  let bestDist = Number.POSITIVE_INFINITY
  for (let i = 0; i < queue.length; i++) {
    if (queue[i]?.id !== trackId) continue
    const d = hint >= 0 ? Math.abs(i - hint) : i
    if (d < bestDist) { best = i; bestDist = d }
  }
  return best
}

export interface SeamAdvance {
  /** Where the ended track sits in the live queue (-1 if it was removed). */
  currentIndex: number
  /** Index of what plays next in the live queue, or -1 for "stop". */
  nextIndex: number
}

/**
 * Given the LIVE queue and the track that just ended, decide what plays
 * next. If the ended track was removed from the queue mid-play, fall back
 * to the hint so playback continues from where the listener left it.
 */
export function resolveSeamAdvance(
  queue: ReadonlyArray<SeamTrack>,
  endedTrackId: number,
  hintIndex: number,
  repeat: 'off' | 'all' | 'one',
): SeamAdvance {
  if (queue.length === 0) return { currentIndex: -1, nextIndex: -1 }
  let currentIndex = locateTrackIndex(queue, endedTrackId, hintIndex)
  if (currentIndex < 0) {
    // Ended track is gone from the queue (removed while playing). The
    // hint still points at the slot it occupied, so the track now at
    // that slot IS the next one; clamp into range.
    const slot = Math.max(0, Math.min(hintIndex, queue.length))
    const next = slot < queue.length ? slot : (repeat === 'all' ? 0 : -1)
    return { currentIndex: -1, nextIndex: next }
  }
  let nextIndex = currentIndex + 1
  if (nextIndex >= queue.length) nextIndex = repeat === 'all' ? 0 : -1
  return { currentIndex, nextIndex }
}
