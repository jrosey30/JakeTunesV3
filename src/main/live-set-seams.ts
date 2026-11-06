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
 * 70.5 s of it was gone. So each seam now has three possible answers (planSeam):
 *   • a plain join, every sample the sources' own;
 *   • a closed join: a few ms laid over each other, when the plain join would
 *     leave a hole or a step (a fault this short only needs a fix this short);
 *   • a real overlap, when the fades are real (fadeIsReal).
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
 * them). `holeMs` is how long a hole touching the cut lasts, 0 if none does.
 * `jumpOverSlope` is the step across the cut against the steepest step within
 * 20 ms of it. `tailDropDb`/`headDropDb` are how far the cut sits under that
 * side's own body around the overlap, and `dipDb` is the shallower of the two.
 * `headArrivesMs` is how soon after the cut the next song is within 10 dB of its
 * body (null: not in the time we can see), and `headJumps` says most of that climb
 * is one hard entry and not a fade. `tailStopsHard` is the same reading of the
 * tail, backwards from the cut. `headSilentMs` is how much of the head before it
 * arrives is digital silence.
 */
export interface JoinFacts {
  tailDb: number
  headDb: number
  holeMs: number
  jumpOverSlope: number
  tailDropDb: number
  headDropDb: number
  dipDb: number
  headArrivesMs: number | null
  headJumps: boolean
  tailStopsHard: boolean
  headSilentMs: number
}

const DB_FLOOR = -140
/** A hole further than this from the cut is the music's own, not the join's. */
const HOLE_TOUCH_MS = 1.5
/** A notch: this far under what sits right beside the cut, in level and in first difference. */
const NOTCH_LEVEL_DB = 18
const NOTCH_DIFF_DB = 12
/** A side is there once it's within this of its body. */
const THERE_WITHIN_DB = 10
/** Half of the climb inside the last 200 ms is an entry; a fade spreads it out. */
const ENTRY_WINDOWS = 2
const ENTRY_SHARE = 0.5
/** Digital silence, or what's left of it after a lossy decode. */
const SILENT_DB = -85
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
 * How one side of a join gets from the cut to its body. `levels` run outward from
 * the cut, on the 100 ms grid. A climb with half of it inside its last 200 ms is an
 * entry (a band, a stick, a note that stops): measured on Unplugged's rooms, 98% of
 * it is. A fade of 0.6 s or more never gets there, whatever its depth, so this
 * tells a short crowd fade from a band coming in where a clock can't.
 */
function climbFromCut(levels: number[], body: number): { at: number; hard: boolean } {
  const at = levels.findIndex((db) => db >= body - THERE_WITHIN_DB)
  if (at <= 0) return { at, hard: at === 0 }
  const climb = levels[at] - Math.min(...levels.slice(0, at))
  return { at, hard: levels[at] - levels[Math.max(0, at - ENTRY_WINDOWS)] >= ENTRY_SHARE * climb }
}

/**
 * Port of the audit's measures (blip_core.py hole_analysis + click_analysis,
 * build_report.py classify_xfade), with the hole read honestly: see the note on
 * the windows below. `tail` ends and `head` starts at the cut; `overlapBytes` is
 * the overlap the fades asked for, which sets where "the song bodies" are.
 * `holeTouchMs` is how near the cut a hole has to come to count.
 */
export function measurePlainJoin(tail: Buffer, head: Buffer, overlapBytes: number, bytesPerSec: number, frameBytes: number, holeTouchMs = HOLE_TOUCH_MS): JoinFacts {
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
  const hop = Math.max(1, Math.round(rate * 0.00025))
  const levels = (winFrames: number): { tMs: number[]; eRaw: number[]; eDiff: number[] } => {
    const tMs: number[] = [], eRaw: number[] = [], eDiff: number[] = []
    for (let st = 0; st + winFrames <= total; st += hop) {
      tMs.push(((st + winFrames / 2 - before) / rate) * 1000)
      eRaw.push(powerDb((cumRaw[st + winFrames] - cumRaw[st]) / winFrames))
      eDiff.push(powerDb((cumDiff[st + winFrames] - cumDiff[st]) / winFrames))
    }
    return { tMs, eRaw, eDiff }
  }
  const medianBetween = (tMs: number[], arr: number[], lo: number, hi: number): number => {
    const picked = arr.filter((_, i) => tMs[i] >= lo && tMs[i] < hi)
    return picked.length ? median(picked) : DB_FLOOR
  }

  // The room either side, in 2 ms windows so a single cycle can't move it.
  const wide = levels(Math.floor(rate * 0.002))
  const tailDb = medianBetween(wide.tMs, wide.eRaw, -300, -70)
  const headDb = medianBetween(wide.tMs, wide.eRaw, 70, 300)

  // The hole, in 1 ms windows, against the level right beside it. A window only
  // reads once the gap fills 90% of it, so the run is short by that much and it
  // is added back. The first version used the room's 2 ms windows and added
  // nothing: it read 1.9 ms short, a planted 3 ms of zeros read 1.1 and a real
  // 2.4 ms notch read under the 2 ms it was being held to.
  const fine = levels(Math.floor(rate * 0.001))
  const fineWin = Math.floor(rate * 0.001)
  const refRaw = Math.min(medianBetween(fine.tMs, fine.eRaw, -70, -15), medianBetween(fine.tMs, fine.eRaw, 15, 70))
  const refDiff = Math.min(medianBetween(fine.tMs, fine.eDiff, -70, -15), medianBetween(fine.tMs, fine.eDiff, 15, 70))
  const runs: Array<{ first: number; last: number }> = []
  for (let i = 0; i < fine.tMs.length; i++) {
    if (Math.abs(fine.tMs[i]) > 15) continue
    if (!(fine.eRaw[i] < refRaw - 10 && fine.eDiff[i] < refDiff - 10)) continue
    const open = runs[runs.length - 1]
    if (open && open.last === i - 1) open.last = i
    else runs.push({ first: i, last: i })
  }
  // Only a hole that touches the cut is the join's. Music has gaps of its own, and one
  // a few ms away used to lay two full-level songs over each other to fix nothing.
  const touching = runs.find((r) => fine.tMs[r.first] <= holeTouchMs && fine.tMs[r.last] >= -holeTouchMs)
  let holeMs = touching ? (((touching.last - touching.first) * hop + 0.9 * fineWin) / rate) * 1000 : 0
  // Two soft edges in a dark room can miss that by a hair: the highs are already going
  // 15-70 ms out, so the first difference has less far to fall. Nassau 0:34:58 is -40
  // dBFS either side, -66 at the cut, 3 ms wide, and missed by 1.96 dB, so the one drop-out
  // left in a show of 21 was going to be built in for good, while the same fault at -44
  // dBFS two songs earlier was closed. So a V at the cut counts too, against what sits
  // right beside it.
  if (holeMs === 0) {
    const beside = (arr: number[]): number => Math.min(medianBetween(fine.tMs, arr, -4, -2.5), medianBetween(fine.tMs, arr, 2.5, 4))
    const atCut = (arr: number[]): number => Math.min(...arr.filter((_, i) => Math.abs(fine.tMs[i]) <= 1))
    const room = beside(fine.eRaw)
    if (atCut(fine.eRaw) <= room - NOTCH_LEVEL_DB && atCut(fine.eDiff) <= beside(fine.eDiff) - NOTCH_DIFF_DB) {
      const under = fine.eRaw.filter((v, i) => Math.abs(fine.tMs[i]) <= 3 && v < room - 10).length
      holeMs = (((under - 1) * hop + 0.9 * fineWin) / rate) * 1000
    }
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

  // How far the cut sits under the bodies. Just outside the overlap can still be
  // inside a slow fade (the fades are measured down to 6 dB under the body, so a
  // 30 dB pair read 24.7), so a second reading sits 1 s further out and the louder
  // one is the body.
  const half = bytesForMs(500, bytesPerSec, frameBytes)
  const second = bytesForMs(1000, bytesPerSec, frameBytes)
  const overlap = Math.min(overlapBytes, tail.length, head.length)
  const tailBody = (gap: number): number | null => {
    const end = tail.length - overlap - gap
    return end > 0 ? rmsDbNoFloor(tail.subarray(Math.max(0, end - half), end)) : null
  }
  const headBody = (gap: number): number | null => {
    const start = overlap + gap
    return start < head.length ? rmsDbNoFloor(head.subarray(start, Math.min(head.length, start + half))) : null
  }
  const louder = (a: number | null, b: number | null, fallback: number): number => Math.max(a ?? fallback, b ?? fallback)
  const pre = louder(tailBody(0), tailBody(second), tailDb)
  const post = louder(headBody(0), headBody(second), headDb)

  // When the next song is really there. Its body is what it sounds like once it
  // has settled: the loudest reading above, or the second half of what we can see.
  const settled = rmsDbNoFloor(head.subarray(Math.floor(head.length / 2 / frameBytes) * frameBytes))
  const headLevels = rmsEnvelope(head, bytesPerSec).rmsDb
  const headClimb = climbFromCut(headLevels, Math.max(post, settled))
  const tailSettled = rmsDbNoFloor(tail.subarray(0, Math.floor(tail.length / 2 / frameBytes) * frameBytes))
  const tailClimb = climbFromCut(rmsEnvelope(tail, bytesPerSec).rmsDb.reverse(), Math.max(pre, tailSettled))
  const beforeArrival = headClimb.at >= 0 ? headLevels.slice(0, headClimb.at) : headLevels

  return {
    tailDb,
    headDb,
    holeMs,
    jumpOverSlope,
    tailDropDb: pre - tailDb,
    headDropDb: post - headDb,
    dipDb: Math.min(pre - tailDb, post - headDb),
    headArrivesMs: headClimb.at >= 0 ? headClimb.at * 100 : null,
    headJumps: headClimb.hard,
    tailStopsHard: tailClimb.hard,
    headSilentMs: beforeArrival.filter((db) => db <= SILENT_DB).length * 100,
  }
}

/** A side this far under its own body at the cut has been faded away, at any mastering level. */
const FADED_AWAY_DB = 40
/** A pair of real fades digs at least this far under the song bodies. */
const DEEP_DIP_DB = 25
/** A tail this much louder than the head is a hard end above a head coming up
 *  from under it. A soundboard's level can fall 9 dB across a cut (Nassau, High
 *  Time into Lazy Lightnin'), so this is not the same as "different". */
const CLIFF_DB = 10
/** A tail this far under the head's opening, having come down from its body. */
const FELL_UNDER_DB = 6
const FELL_FROM_DB = 12
/** A head room shorter than this is the next song's own start, not a room to fade under. */
const ARRIVES_MS = 1000
/** Digital silence this long before a hard start is a pause. Under it, no fade asks anyway. */
const PAUSE_MS = 600

/**
 * Were these fades real? 12 dB of drop asks for an overlap; this answers. An
 * overlap puts two moments of the show on top of each other, so it has to earn
 * it: the fades have to have taken the room away.
 *   • A note that stops, digital silence, then a hard start: a pause, and it's on
 *     the tape. An overlap deletes it and lays any count-in under the old song.
 *   • A side faded far under its own body: faded out, down to nothing. Against
 *     the music's own level, so a quiet record gets the same answer as a loud one
 *     (at a fixed -60 dBFS, the real seams turned down 15 dB gave 22 false overlaps).
 *   • The next song comes in hard: no. There is no fade-in to rebuild, and an
 *     overlap only lays the old song's end over the new song's start, however
 *     quiet the cut is (Unplugged 0:12:28: the tape runs straight through the
 *     room at -46 dBFS on both sides, then the band comes in). The exception is
 *     a tail faded under the room, next. Whether it's hard comes from the climb and
 *     not a clock: a 1.4 s crowd fade used to pass for the band and leave a 34 dB
 *     hush, and a band after 1.1 s of room used to get an overlap 2.2 s into its
 *     first notes.
 *   • A tail that came down from its body to well under a room the head opens in
 *     for more than a second: a room doesn't fall below its own floor, so the tail
 *     was faded under it (Geese, Alive 0:12:37: 36 dB in 4 s, to 10.8 dB under the
 *     head's room).
 *   • A tail far above a head that climbs slowly: without an overlap, a cliff. A
 *     head that simply opens quiet isn't one (a quiet intro would go under the old song).
 *   • A deep dip: a pair of real fades.
 */
export function fadeIsReal(f: JoinFacts): boolean {
  if (f.tailStopsHard && f.headJumps && f.headSilentMs >= PAUSE_MS) return false
  if (f.tailDropDb >= FADED_AWAY_DB || f.headDropDb >= FADED_AWAY_DB) return true
  const headOpensInARoom = f.headArrivesMs === null || f.headArrivesMs > ARRIVES_MS
  const fellUnder = headOpensInARoom && f.headDb - f.tailDb >= FELL_UNDER_DB && f.dipDb >= FELL_FROM_DB
  if (f.headJumps) return fellUnder
  return fellUnder || f.tailDb - f.headDb > CLIFF_DB || f.dipDb >= DEEP_DIP_DB
}

/** Quieter than this and no one can hear the join: leave its bits alone. */
const AUDIBLE_FLOOR_DB = -70
/** A step this far beyond the local slope is a click. */
const STEP_LIMIT = 1.5
/** How much of each edge a closed join lays over the other. */
const CLOSE_MS = 2.5
/** Past this a hole isn't an edge any more (AAC's padding tops out near 23 ms). */
const CLOSE_MAX_MS = 30

export type SeamMix = 'none' | 'fade' | 'edges' | 'ramp'

/**
 * What to do at one seam. `overlapBytes` of the tail's end and the head's start
 * share the same time; `cueBytes` is where in that time the marker goes.
 * `unclosed` says a plain join has a fault nothing here could close. `openGapMs` says
 * the join keeps a stretch of silence the hole reader can't see.
 */
export interface SeamPlan {
  mix: SeamMix
  overlapBytes: number
  cueBytes: number
  unclosed?: { holeMs: number; jumpOverSlope: number }
  openGapMs?: number
}

/** The join with its overlap in place, as two buffers that meet mid-overlap. */
function closedJoin(tail: Buffer, head: Buffer, mixed: Buffer, frameBytes: number): { tail: Buffer; head: Buffer } {
  const half = Math.floor(mixed.length / 2 / frameBytes) * frameBytes
  return {
    tail: Buffer.concat([tail.subarray(0, tail.length - mixed.length), mixed.subarray(0, half)]),
    head: Buffer.concat([mixed.subarray(half), head.subarray(mixed.length)]),
  }
}

/** Lay a tail's last moments over a head's first. With `ramp` each side is ramped
 *  to nothing across them (a plain crossfade, for a step); without, the two are
 *  simply summed, because the sources' own edges are already the crossfade. */
export function mixEdges(tail: Buffer, head: Buffer, frameBytes: number, ramp: boolean): Buffer {
  if (!ramp) return overlapAdd(tail, head)
  const ch = frameBytes / 2
  const frames = Math.floor(Math.min(tail.length, head.length) / frameBytes)
  const out = Buffer.alloc(frames * frameBytes)
  for (let f = 0; f < frames; f++) {
    const up = (f + 0.5) / frames
    for (let c = 0; c < ch; c++) {
      const o = (f * ch + c) * 2
      const v = tail.readInt16LE(o) * (1 - up) + head.readInt16LE(o) * up
      out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), o)
    }
  }
  return out
}

/**
 * A sum is new audio with two new joins of its own, where it meets each song, and a click
 * there is as loud as the one it replaced. The reading across its middle can't see them: a
 * natural dip at the cut read as clean while its ends stepped 18 times what a plain join had
 * there (Taxes 0:28, 2150 against 117), and a sum of two loud songs clipped where neither
 * did (Such Great Heights 3:07). Each end is held to the steepest step beside the overlap or
 * the step of the plain join it replaces, whichever is more: padding, then a hard start,
 * is a step either way.
 */
function sumFits(tail: Buffer, head: Buffer, mixed: Buffer, bytesPerSec: number, frameBytes: number): boolean {
  const bytes = mixed.length
  const tailStart = tail.length - bytes
  if (tailStart < frameBytes || bytes + frameBytes > head.length) return false   // no music left to meet
  for (let o = 0; o < bytes; o += 2) {
    if (tail.readInt16LE(tailStart + o) + head.readInt16LE(o) !== mixed.readInt16LE(o)) return false   // it clipped
  }
  const step = (a: Buffer, aAt: number, b: Buffer, bAt: number): number => {
    let m = 0
    for (let c = 0; c < frameBytes; c += 2) m = Math.max(m, Math.abs(a.readInt16LE(aAt + c) - b.readInt16LE(bAt + c)))
    return m
  }
  const steepest = (buf: Buffer, from: number, to: number): number => {
    let m = 0
    for (let o = Math.max(0, from); o + frameBytes < Math.min(buf.length, to); o += frameBytes) m = Math.max(m, step(buf, o, buf, o + frameBytes))
    return m
  }
  const span = bytesForMs(20, bytesPerSec, frameBytes)
  const entry = step(mixed, 0, tail, tailStart - frameBytes)
  const exit = step(head, bytes, mixed, bytes - frameBytes)
  const beside = Math.max(steepest(tail, tailStart - span, tailStart), steepest(head, bytes, bytes + span))
  const plain = step(tail, tail.length - frameBytes, head, 0)
  return Math.max(entry, exit) < STEP_LIMIT * Math.max(beside, plain, 1)
}

/**
 * A plain join that would leave a hole or a step gets the shortest overlap that
 * closes it (2026-11-06). Nassau's songs each start and stop with a ramp of 1-2 ms,
 * which is right for a track on its own; two of them back to back are a notch of
 * 0.9-3.1 ms, 21-34 dB deep, at 19 of 20 joins. And a song the album cut hard is a
 * click (Unplugged 0:03:37, a -20.9 dBFS step). Either is a local fault and has a
 * local answer. Answering it with the fades' 2-4 s, as the first version did, would
 * lay whole moments of the show over each other to fix a few milliseconds.
 * Tried, then measured: an answer that doesn't leave the join clean isn't used.
 */
function closeJoin(tail: Buffer, head: Buffer, f: JoinFacts, bytesPerSec: number, frameBytes: number): SeamPlan | null {
  // The louder side: a tail cut on a crest into silence is a click however quiet the other side is.
  if (Math.max(f.tailDb, f.headDb) <= AUDIBLE_FLOOR_DB) return null
  if (f.holeMs === 0 && f.jumpOverSlope < STEP_LIMIT) return null
  const tryMix = (ms: number, ramp: boolean): SeamPlan | null => {
    const bytes = Math.min(bytesForMs(ms, bytesPerSec, frameBytes), tail.length, head.length)
    if (bytes === 0) return null
    const mixed = mixEdges(tail.subarray(tail.length - bytes), head.subarray(0, bytes), frameBytes, ramp)
    const joined = closedJoin(tail, head, mixed, frameBytes)
    const after = measurePlainJoin(joined.tail, joined.head, 0, bytesPerSec, frameBytes, (bytes / bytesPerSec) * 500 + HOLE_TOUCH_MS)
    if (after.holeMs > 0 || after.jumpOverSlope >= STEP_LIMIT) return null
    if (!ramp && !sumFits(tail, head, mixed, bytesPerSec, frameBytes)) return null
    return { mix: ramp ? 'ramp' : 'edges', overlapBytes: bytes, cueBytes: Math.floor(bytes / 2 / frameBytes) * frameBytes }
  }
  // The hole's reading stops at 15 ms either side, so a long one may need a second try.
  if (f.holeMs > 0) {
    for (let ms = Math.max(CLOSE_MS, f.holeMs + 0.5); ms <= CLOSE_MAX_MS; ms *= 1.5) {
      const closed = tryMix(ms, false)
      if (closed) return closed
    }
  }
  return tryMix(CLOSE_MS, true)
}

/** Quieter than this on both sides for a whole overlap, there is no "where the
 *  song changes" to find. */
const NOTHING_TO_HEAR_DB = -70

/**
 * Where in an overlap the next song takes over: the first moment from which it
 * stays louder than the old one. The middle isn't it. On a pair of even fades it's
 * close, but Whole Lotta Love's tail is 12 dB under The Ocean from the first moment
 * and The Rain Song is on top for 2.8 s of its 2.9 s, and a marker that flips early
 * is Jake's complaint from the first cut: "it jumped to Jet before the end of Drive
 * My Car". `tail` and `head` are the overlap only. On the envelope's 100 ms grid,
 * in whole frames.
 */
export function crossoverBytes(tail: Buffer, head: Buffer, bytesPerSec: number, frameBytes: number): number {
  const length = Math.min(tail.length, head.length)
  const t = rmsEnvelope(tail, bytesPerSec).rmsDb
  const h = rmsEnvelope(head, bytesPerSec).rmsDb
  const n = Math.min(t.length, h.length)
  if (n === 0 || Math.max(...t.slice(0, n), ...h.slice(0, n)) <= NOTHING_TO_HEAR_DB) {
    return Math.floor(length / 2 / frameBytes) * frameBytes
  }
  let take = 0
  for (let i = n - 1; i >= 0; i--) {
    if (t[i] > h[i]) { take = i + 1; break }
  }
  return Math.min(bytesForMs(take * 100, bytesPerSec, frameBytes), length)
}

/** From this long, silence on one side of the cut fills the hole reader's own reference,
 *  so it reads 0. Under it, a hole is seen, and either closed or reported. */
const GAP_UNSEEN_MS = 46
/** From this long the fades take over: a gap is an overlap or a pause, not a blind spot. */
const GAP_TAKEN_OVER_MS = 600

/** How long `pcm` stays under the audible floor, in 1 ms blocks outward from the cut. */
function silenceAtCutMs(pcm: Buffer, atEnd: boolean, bytesPerSec: number, frameBytes: number): number {
  const block = bytesForMs(1, bytesPerSec, frameBytes)
  let ms = 0
  while (ms < GAP_TAKEN_OVER_MS && (ms + 1) * block <= pcm.length) {
    const piece = atEnd ? pcm.subarray(pcm.length - (ms + 1) * block, pcm.length - ms * block) : pcm.subarray(ms * block, (ms + 1) * block)
    if (rmsDbNoFloor(piece) > AUDIBLE_FLOOR_DB) break
    ms++
  }
  return ms
}

/**
 * The answer for one seam. `tail` is the held-back end of the previous song and
 * `head` the start of the next, each cut at the song's real edge.
 */
export function planSeam(tail: Buffer, head: Buffer, bytesPerSec: number, frameBytes: number): SeamPlan {
  const fadeMs = seamOverlapMs(rmsEnvelope(tail, bytesPerSec), rmsEnvelope(head, bytesPerSec))
  const fadeBytes = Math.min(bytesForMs(fadeMs, bytesPerSec, frameBytes), tail.length, head.length)
  const facts = measurePlainJoin(tail, head, fadeBytes, bytesPerSec, frameBytes)
  if (fadeMs > 0 && fadeIsReal(facts)) {
    return {
      mix: 'fade',
      overlapBytes: fadeBytes,
      cueBytes: crossoverBytes(tail.subarray(tail.length - fadeBytes), head.subarray(0, fadeBytes), bytesPerSec, frameBytes),
    }
  }
  const plan: SeamPlan = closeJoin(tail, head, facts, bytesPerSec, frameBytes) ?? { mix: 'none', overlapBytes: 0, cueBytes: 0 }
  const audible = Math.max(facts.tailDb, facts.headDb) > AUDIBLE_FLOOR_DB
  if (plan.mix === 'none' && audible && (facts.holeMs > 0 || facts.jumpOverSlope >= STEP_LIMIT)) {
    plan.unclosed = { holeMs: facts.holeMs, jumpOverSlope: facts.jumpOverSlope }
  }
  // Left as it is, on purpose: nothing here is short enough to close it, and it may be
  // the show's own. But a fault nobody can see stays wrong for good, so it goes in the log.
  const gapMs = Math.max(silenceAtCutMs(tail, true, bytesPerSec, frameBytes), silenceAtCutMs(head, false, bytesPerSec, frameBytes))
  if (audible && gapMs >= GAP_UNSEEN_MS && gapMs < GAP_TAKEN_OVER_MS) plan.openGapMs = gapMs
  return plan
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
