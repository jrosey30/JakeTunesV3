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
 * A fade alone is not enough (2026-11-06). 12 dB of drop on one side used to
 * start an overlap, and the blip audit found 24 seams where both sides were
 * still in the room at the cut, so two moments of the show played at once and
 * 70.5 s of it was gone. See seamOverlapBytes.
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

/**
 * What a plain join of these two moments would be, measured at sample level
 * (2026-11-06). `tailDb`/`headDb` are the room's level just either side of the
 * cut (median of 2 ms windows, 70-300 ms away, so the join itself can't move
 * them). `holeMs` is how long the cut sits 10 dB under both sides, in level and
 * in first difference alike. `jumpOverSlope` is the step across the cut against
 * the steepest step within 20 ms of it. `dipDb` is how far the cut sits under
 * the song bodies just outside the overlap, on the shallower side.
 */
export interface JoinFacts {
  tailDb: number
  headDb: number
  holeMs: number
  jumpOverSlope: number
  dipDb: number
}

const DB_FLOOR = -140
function powerDb(p: number): number { return 10 * Math.log10(Math.max(p, 1e-14)) }
function median(values: number[]): number {
  const v = [...values].sort((a, b) => a - b)
  return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2
}
function rmsDbNoFloor(pcm: Buffer): number {
  const n = pcm.length & ~1
  if (n === 0) return DB_FLOOR
  let acc = 0
  for (let i = 0; i < n; i += 2) { const s = pcm.readInt16LE(i) / 32768; acc += s * s }
  const rms = Math.sqrt(acc / (n / 2))
  return rms > 0 ? Math.max(DB_FLOOR, 20 * Math.log10(rms)) : DB_FLOOR
}

/**
 * Port of the audit's measures (blip_core.py hole_analysis + click_analysis,
 * build_report.py classify_xfade). `tail` ends and `head` starts at the cut;
 * `overlapBytes` is the overlap the fades asked for, which sets where "the song
 * bodies" are.
 */
export function measurePlainJoin(tail: Buffer, head: Buffer, overlapBytes: number, bytesPerSec: number, frameBytes: number): JoinFacts {
  const ch = frameBytes / 2
  const rate = bytesPerSec / frameBytes
  const reach = Math.ceil(rate * 0.32)   // 300 ms plus one window
  const tailFrames = Math.floor(tail.length / frameBytes)
  const headFrames = Math.floor(head.length / frameBytes)
  const before = Math.min(reach, tailFrames)
  const after = Math.min(reach, headFrames)
  const total = before + after
  const sampleAt = (i: number, c: number): number => {
    const f = i - before   // relative to the cut
    return f < 0
      ? tail.readInt16LE((tailFrames + f) * frameBytes + c * 2)
      : head.readInt16LE(f * frameBytes + c * 2)
  }

  // Running power of the signal and of its first difference.
  const win = Math.floor(rate * 0.002)
  const hop = Math.max(1, Math.round(rate * 0.00025))
  const cumRaw = new Float64Array(total + 1)
  const cumDiff = new Float64Array(total + 1)
  for (let i = 0; i < total; i++) {
    let raw = 0, diff = 0
    for (let c = 0; c < ch; c++) {
      const s = sampleAt(i, c) / 32768
      const d = i > 0 ? s - sampleAt(i - 1, c) / 32768 : 0
      raw += s * s
      diff += d * d
    }
    cumRaw[i + 1] = cumRaw[i] + raw / ch
    cumDiff[i + 1] = cumDiff[i] + diff / ch
  }
  const tMs: number[] = [], eRaw: number[] = [], eDiff: number[] = []
  for (let st = 0; st + win <= total; st += hop) {
    tMs.push(((st + win / 2 - before) / rate) * 1000)
    eRaw.push(powerDb((cumRaw[st + win] - cumRaw[st]) / win))
    eDiff.push(powerDb((cumDiff[st + win] - cumDiff[st]) / win))
  }
  const medianBetween = (arr: number[], lo: number, hi: number): number => {
    const picked = arr.filter((_, i) => tMs[i] >= lo && tMs[i] < hi)
    return picked.length ? median(picked) : DB_FLOOR
  }
  const tailDb = medianBetween(eRaw, -300, -70)
  const headDb = medianBetween(eRaw, 70, 300)
  const refRaw = Math.min(tailDb, headDb)
  const refDiff = Math.min(medianBetween(eDiff, -300, -70), medianBetween(eDiff, 70, 300))

  // The run under both references, nearest the cut, within 70 ms of it.
  const runs: Array<{ first: number; last: number }> = []
  for (let i = 0; i < tMs.length; i++) {
    if (tMs[i] < -70 || tMs[i] > 70) continue
    if (!(eRaw[i] < refRaw - 10 && eDiff[i] < refDiff - 10)) continue
    const open = runs[runs.length - 1]
    if (open && i - open.last <= 2) open.last = i
    else runs.push({ first: i, last: i })
  }
  let holeMs = 0
  if (runs.length) {
    const distance = (r: { first: number; last: number }): number => Math.abs(tMs[r.first + Math.floor((r.last - r.first + 1) / 2)])
    const nearest = runs.reduce((a, b) => (distance(b) < distance(a) ? b : a))
    holeMs = (((nearest.last - nearest.first + 1) * hop) / rate) * 1000
  }

  // The step across the cut, against the steepest step within 20 ms of it.
  let jumpOverSlope = 0
  if (before >= 2 && after >= 2) {
    const stepAt = (i: number): number => {
      let m = 0
      for (let c = 0; c < ch; c++) m = Math.max(m, Math.abs(sampleAt(i + 1, c) - sampleAt(i, c)))
      return m
    }
    const span = Math.floor(rate * 0.02)
    let slope = 0
    for (let i = Math.max(0, before - span); i < before - 3; i++) slope = Math.max(slope, stepAt(i))
    for (let i = before + 2; i < Math.min(total - 1, before + span); i++) slope = Math.max(slope, stepAt(i))
    jumpOverSlope = stepAt(before - 1) / Math.max(1, slope)
  }

  // How far the cut sits under the bodies just outside the overlap.
  const half = bytesForMs(500, bytesPerSec, frameBytes)
  const overlap = Math.min(overlapBytes, tail.length, head.length)
  const preBytes = tail.subarray(Math.max(0, tail.length - overlap - half), tail.length - overlap)
  const postBytes = head.subarray(overlap, Math.min(head.length, overlap + half))
  const pre = preBytes.length ? rmsDbNoFloor(preBytes) : tailDb
  const post = postBytes.length ? rmsDbNoFloor(postBytes) : headDb
  return { tailDb, headDb, holeMs, jumpOverSlope, dipDb: Math.min(pre - tailDb, post - headDb) }
}

/**
 * Both sides still in the room at the cut, so a plain join is the recording
 * running straight through and overlapping it would lay two moments of the show
 * on top of each other. Louder than -60 dBFS on both sides, no hole, no step
 * beyond the local slope, and the cut less than 25 dB under the song bodies (a
 * pair of real fades digs deeper than that).
 */
export function plainJoinIsClean(f: JoinFacts): boolean {
  return Math.min(f.tailDb, f.headDb) > -60 && f.holeMs <= 2 && f.jumpOverSlope < 1.5 && f.dipDb < 25
}

/**
 * The overlap for one seam, in whole frames. `tail` is the held-back end of the
 * previous song and `head` the start of the next, each cut at the song's real
 * edge. 12 dB of drop on one side is not enough to overlap (the 2026-09-02 rule
 * alone laid 24 seams, 70.5 s of music, over themselves): the join has to need it.
 */
export function seamOverlapBytes(tail: Buffer, head: Buffer, bytesPerSec: number, frameBytes: number): number {
  const ms = seamOverlapMs(rmsEnvelope(tail, bytesPerSec), rmsEnvelope(head, bytesPerSec))
  if (ms === 0) return 0
  const overlap = Math.min(bytesForMs(ms, bytesPerSec, frameBytes), tail.length)
  return plainJoinIsClean(measurePlainJoin(tail, head, overlap, bytesPerSec, frameBytes)) ? 0 : overlap
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
