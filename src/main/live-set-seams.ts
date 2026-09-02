/**
 * live-set-seams — crossfaded seams for a merged live set (2026-09-02).
 *
 * Live albums cut for track-by-track play usually FADE the room out at the
 * end of each track and back in at the start of the next. Butt-splicing
 * those is a dip at every seam — on a stadium crowd (McCartney, Citi Field)
 * it is unmistakable: roar → hush → roar. Jake: "the tracks don't merge
 * bc the crowd fades in and out."
 *
 * A soundboard cut with no fades (Nassau '80) must stay a gapless butt
 * splice — overlapping two full-level signals would double them. So every
 * seam is MEASURED: the tail's RMS envelope says whether it fades and for
 * how long, the head's says the same, and the overlap is the fade length
 * (capped). A fade-out summed over a fade-in is ≈ a constant room, which is
 * exactly what the tape had before the album cut it.
 *
 * Pure functions on 16-bit interleaved PCM buffers; the merge engine owns
 * the I/O.
 */

export interface Envelope { windowMs: number; rmsDb: number[] }

const SILENCE_DB = -90

/** RMS per window (dBFS), over interleaved s16 PCM. */
export function rmsEnvelope(pcm: Buffer, bytesPerSec: number, windowMs = 100): Envelope {
  const win = Math.max(2, Math.floor((bytesPerSec * windowMs) / 1000 / 2) * 2)
  const out: number[] = []
  for (let off = 0; off + win <= pcm.length; off += win) {
    let acc = 0
    const n = win / 2
    for (let i = 0; i < n; i++) {
      const s = pcm.readInt16LE(off + i * 2) / 32768
      acc += s * s
    }
    const rms = Math.sqrt(acc / n)
    out.push(rms > 0 ? Math.max(SILENCE_DB, 20 * Math.log10(rms)) : SILENCE_DB)
  }
  return { windowMs, rmsDb: out }
}

/**
 * How long the END of a segment fades, in ms (0 = no fade). Reference level
 * is the loudest window in the "body" zone (4–8 s before the end); the fade
 * starts at the last window still within 6 dB of it, and only counts as a
 * fade when the final windows actually drop ≥ 12 dB below the reference.
 */
export function tailFadeMs(env: Envelope): number {
  const w = env.rmsDb, n = w.length, ms = env.windowMs
  if (n * ms < 3000) return 0
  const bodyEnd = n - Math.floor(4000 / ms)
  const bodyStart = Math.max(0, n - Math.floor(8000 / ms))
  const ref = Math.max(...w.slice(bodyStart, Math.max(bodyStart + 1, bodyEnd)))
  const lastAvg = w.slice(Math.max(0, n - Math.floor(300 / ms))).reduce((a, b) => a + b, 0) / Math.max(1, Math.floor(300 / ms))
  if (ref - lastAvg < 12) return 0
  let i = n - 1
  while (i >= 0 && w[i] < ref - 6) i--
  return (n - 1 - i) * ms
}

/** Mirror of tailFadeMs for the START of a segment. */
export function headFadeMs(env: Envelope): number {
  const w = env.rmsDb, n = w.length, ms = env.windowMs
  if (n * ms < 3000) return 0
  const bodyStart = Math.floor(4000 / ms)
  const bodyEnd = Math.min(n, Math.floor(8000 / ms))
  const ref = Math.max(...w.slice(bodyStart, Math.max(bodyStart + 1, bodyEnd)))
  const firstAvg = w.slice(0, Math.max(1, Math.floor(300 / ms))).reduce((a, b) => a + b, 0) / Math.max(1, Math.floor(300 / ms))
  if (ref - firstAvg < 12) return 0
  let i = 0
  while (i < n && w[i] < ref - 6) i++
  return i * ms
}

/** The overlap for one seam: the longer of the two fades, capped; 0 when
 *  neither side fades (gapless butt splice, as before). */
export function seamOverlapMs(tail: Envelope, head: Envelope, capMs = 4000, minMs = 600): number {
  const t = tailFadeMs(tail), h = headFadeMs(head)
  const o = Math.max(t, h)
  if (o < minMs) return 0
  return Math.min(capMs, o)
}

/** Sum two equal-length s16 buffers sample-by-sample, clamped. */
export function overlapAdd(a: Buffer, b: Buffer): Buffer {
  const n = Math.min(a.length, b.length) & ~1
  const out = Buffer.alloc(n)
  for (let i = 0; i < n; i += 2) {
    const s = a.readInt16LE(i) + b.readInt16LE(i)
    out.writeInt16LE(s > 32767 ? 32767 : s < -32768 ? -32768 : s, i)
  }
  return out
}

/** Whole-frame byte count for a duration. */
export function bytesForMs(ms: number, bytesPerSec: number, frameBytes: number): number {
  return Math.floor((bytesPerSec * ms) / 1000 / frameBytes) * frameBytes
}
