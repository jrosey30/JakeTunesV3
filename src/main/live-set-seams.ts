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

/**
 * Mix one seam properly (2026-09-02, after the first cut on the McCartney
 * set — Jake: "a pop/crackle and a very slight fade out"):
 *   • EDGE TAPERS: the old tail is ramped to zero over its last `taperMs`
 *     and the new head from zero over its first `taperMs`, so neither side
 *     ever stops or starts with a step. The step at −46 dB was the click.
 *   • MAKE-UP GAIN: two album fades summed don't cancel exactly, leaving a
 *     shallow dip. Per 100 ms window, the mix is lifted toward the quieter
 *     of the two neighbouring body levels (`refDb`), capped at +6 dB,
 *     interpolated between windows so the gain never steps.
 * `tail` and `head` are the overlap region only (equal length).
 */
export function mixSeam(tail: Buffer, head: Buffer, bytesPerSec: number, frameBytes: number, refDb: number, opts: { taperMs?: number; maxGainDb?: number; windowMs?: number } = {}): Buffer {
  const taperMs = opts.taperMs ?? 60
  const maxGain = Math.pow(10, (opts.maxGainDb ?? 6) / 20)
  const windowMs = opts.windowMs ?? 100
  const n = Math.min(tail.length, head.length) & ~1
  const frames = Math.floor(n / frameBytes)
  const ch = frameBytes / 2
  const taperFrames = Math.max(1, Math.floor((bytesPerSec * taperMs) / 1000 / frameBytes))
  // 1. taper + sum into float
  const mix = new Float32Array(frames * ch)
  for (let f = 0; f < frames; f++) {
    const tIn = f >= frames - taperFrames ? (frames - 1 - f) / taperFrames : 1   // tail → 0 at the end
    const hIn = f < taperFrames ? f / taperFrames : 1                             // head from 0 at the start
    for (let c = 0; c < ch; c++) {
      const o = (f * ch + c) * 2
      mix[f * ch + c] = (tail.readInt16LE(o) / 32768) * tIn + (head.readInt16LE(o) / 32768) * hIn
    }
  }
  // 2. per-window gain toward the reference level
  const winFrames = Math.max(1, Math.floor((bytesPerSec * windowMs) / 1000 / frameBytes))
  const nWin = Math.max(1, Math.ceil(frames / winFrames))
  const refRms = Math.pow(10, refDb / 20)
  const gains = new Float32Array(nWin)
  for (let w = 0; w < nWin; w++) {
    let acc = 0, cnt = 0
    for (let f = w * winFrames; f < Math.min(frames, (w + 1) * winFrames); f++) {
      for (let c = 0; c < ch; c++) { const v = mix[f * ch + c]; acc += v * v; cnt++ }
    }
    const rms = Math.sqrt(acc / Math.max(1, cnt))
    gains[w] = rms > 1e-6 ? Math.min(maxGain, Math.max(1, refRms / rms)) : 1
  }
  // 3. apply, linearly interpolated between window centres; unity at both
  //    edges so the seam meets its neighbours at their own level.
  const out = Buffer.alloc(frames * frameBytes)
  for (let f = 0; f < frames; f++) {
    const pos = (f + 0.5) / winFrames - 0.5
    const w0 = Math.max(0, Math.min(nWin - 1, Math.floor(pos)))
    const w1 = Math.min(nWin - 1, w0 + 1)
    const t = Math.max(0, Math.min(1, pos - w0))
    let g = gains[w0] * (1 - t) + gains[w1] * t
    const edge = Math.min(f, frames - 1 - f) / Math.max(1, winFrames)   // 0 at the edges → unity
    if (edge < 1) g = 1 + (g - 1) * edge
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, mix[f * ch + c] * g))
      out.writeInt16LE(Math.round(v * 32767), (f * ch + c) * 2)
    }
  }
  return out
}

/** Mean RMS (dBFS) of a whole buffer — the "body level" next to a seam. */
export function bufferRmsDb(pcm: Buffer): number {
  const n = pcm.length & ~1
  if (n === 0) return SILENCE_DB
  let acc = 0
  for (let i = 0; i < n; i += 2) { const s = pcm.readInt16LE(i) / 32768; acc += s * s }
  const rms = Math.sqrt(acc / (n / 2))
  return rms > 0 ? Math.max(SILENCE_DB, 20 * Math.log10(rms)) : SILENCE_DB
}

/** Whole-frame byte count for a duration. */
export function bytesForMs(ms: number, bytesPerSec: number, frameBytes: number): number {
  return Math.floor((bytesPerSec * ms) / 1000 / frameBytes) * frameBytes
}
