import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { rmsEnvelope, tailFadeMs, headFadeMs, seamOverlapMs, planSeam, measurePlainJoin, fadeIsReal, crossoverBytes, mixEdges, overlapAdd, bytesForMs, mixSeam, bufferRmsDb, type JoinFacts, type SeamPlan } from '../live-set-seams.ts'

const BPS = 44100 * 2 * 2
function tone(seconds: number, amp: number, gain: (t: number) => number = () => 1, hz = 220): Buffer {
  const frames = Math.floor(44100 * seconds)
  const b = Buffer.alloc(frames * 4)
  for (let i = 0; i < frames; i++) {
    const t = i / 44100
    const v = Math.round(amp * gain(t / seconds) * 32767 * Math.sin(2 * Math.PI * hz * t))
    b.writeInt16LE(v, i * 4); b.writeInt16LE(v, i * 4 + 2)
  }
  return b
}

test('a soundboard cut with no fades gets no overlap (gapless butt splice)', () => {
  const flat = tone(10, 0.4)
  const env = rmsEnvelope(flat, BPS)
  assert.equal(tailFadeMs(env), 0)
  assert.equal(headFadeMs(env), 0)
  assert.equal(seamOverlapMs(env, env), 0)
})

test('an album-style 3 s fade-out / fade-in seam overlaps by about the fade', () => {
  // 10 s tail: full level, then a linear fade over the last 3 s.
  const tail = tone(10, 0.4, (p) => p < 0.7 ? 1 : (1 - p) / 0.3)
  const head = tone(10, 0.4, (p) => p > 0.3 ? 1 : p / 0.3)
  const tf = tailFadeMs(rmsEnvelope(tail, BPS))
  const hf = headFadeMs(rmsEnvelope(head, BPS))
  assert.ok(tf >= 1200 && tf <= 3000, `tail fade ${tf}`)
  assert.ok(hf >= 1200 && hf <= 3000, `head fade ${hf}`)
  const o = seamOverlapMs(rmsEnvelope(tail, BPS), rmsEnvelope(head, BPS))
  assert.ok(o >= 1200 && o <= 3000, `overlap ${o}`)
})

test('the overlap is capped and short blips do not count', () => {
  const tail = tone(20, 0.4, (p) => p < 0.5 ? 1 : (1 - p) / 0.5)   // 10 s fade
  const o = seamOverlapMs(rmsEnvelope(tail, BPS), rmsEnvelope(tone(10, 0.4), BPS), 4000)
  assert.equal(o, 4000)
  const blip = tone(10, 0.4, (p) => p < 0.97 ? 1 : 0.01)          // 0.3 s drop
  assert.equal(seamOverlapMs(rmsEnvelope(blip, BPS), rmsEnvelope(tone(10, 0.4), BPS)), 0)
})

test('left to itself, the overlap stops at 4 s, whatever the fades ask', () => {
  const tail = room(10, 0.1, (t) => (t < 2.4 ? 1 : db(-20)), 186)   // 7.6 s under the body
  assert.equal(tailFadeMs(rmsEnvelope(tail, BPS)), 7600)
  assert.equal(seamOverlapMs(rmsEnvelope(tail, BPS), rmsEnvelope(tone(10, 0.4), BPS)), 4000)
})

test('a fade shorter than 600 ms asks for nothing, one longer asks for its length', () => {
  const flat = rmsEnvelope(room(10, 0.1, () => 1, 70), BPS)
  const endsIn = (secs: number) => rmsEnvelope(room(10, 0.1, (t) => (t < 10 - secs ? 1 : db(-30)), 71), BPS)
  assert.equal(seamOverlapMs(endsIn(0.5), flat), 0)
  assert.equal(seamOverlapMs(endsIn(0.7), flat), 700)
})

test('a side has to fall 12 dB before it asks for anything', () => {
  const tailDown = (depth: number) => rmsEnvelope(room(10, 0.1, (t) => (t < 8 ? 1 : db(-depth)), 72), BPS)
  assert.equal(tailFadeMs(tailDown(8)), 0, 'tail, 8 dB')
  assert.equal(tailFadeMs(tailDown(15)), 2000, 'tail, 15 dB')
  const headUp = (depth: number) => rmsEnvelope(room(10, 0.1, (t) => (t > 2 ? 1 : db(-depth)), 73), BPS)
  assert.equal(headFadeMs(headUp(8)), 0, 'head, 8 dB')
  assert.equal(headFadeMs(headUp(15)), 2000, 'head, 15 dB')
})

test('overlapAdd sums and clamps', () => {
  const a = Buffer.alloc(8), b = Buffer.alloc(8)
  a.writeInt16LE(1000, 0); b.writeInt16LE(-250, 0)
  a.writeInt16LE(30000, 2); b.writeInt16LE(30000, 2)
  const out = overlapAdd(a, b)
  assert.equal(out.readInt16LE(0), 750)
  assert.equal(out.readInt16LE(2), 32767)
  assert.equal(bytesForMs(1000, BPS, 4), BPS)
})

test('mixSeam tapers both edges to zero and lifts a dip toward the reference, capped', () => {
  // 3 s overlap: tail fading 1→0, head 0→1 — summed they dip in the middle.
  // Different tones on each side: like real audio they add in POWER, so the
  // linear crossfade dips ~3 dB in the middle.
  const tail = tone(3, 0.4, (p) => 1 - p, 220)
  const head = tone(3, 0.4, (p) => p, 331)
  const ref = bufferRmsDb(tone(2, 0.4))
  const out = mixSeam(tail, head, BPS, 4, ref)
  assert.equal(out.length, tail.length)
  // Edges are CONTINUOUS with the neighbours: at frame 0 the head contributes
  // nothing (out ≈ tail), at the last frame the tail contributes nothing
  // (out ≈ head) — no step on either side of the seam.
  assert.ok(Math.abs(out.readInt16LE(0) - tail.readInt16LE(0)) <= 2, 'first frame = tail')
  assert.ok(Math.abs(out.readInt16LE(out.length - 4) - head.readInt16LE(head.length - 4)) <= 2, 'last frame = head')
  // the middle is lifted: closer to the reference than the plain sum was
  const midStart = Math.floor(out.length / 2 / 4) * 4
  const midOut = bufferRmsDb(out.subarray(midStart - 44100 * 4 * 0.1, midStart + 44100 * 4 * 0.1))
  const plain = overlapAdd(tail, head)
  const midPlain = bufferRmsDb(plain.subarray(midStart - 44100 * 4 * 0.1, midStart + 44100 * 4 * 0.1))
  assert.ok(midOut > midPlain, `lifted ${midPlain.toFixed(1)} → ${midOut.toFixed(1)}`)
  assert.ok(midOut <= midPlain + 6.5, 'cap respected')
  // a seam that is already at level is left alone (gain never < 1)
  const flat = mixSeam(tone(3, 0.4), tone(3, 0.0001), BPS, 4, ref)
  const flatMid = bufferRmsDb(flat.subarray(midStart - 44100 * 4 * 0.1, midStart + 44100 * 4 * 0.1))
  assert.ok(Math.abs(flatMid - ref) < 1.0, `flat stays ${flatMid.toFixed(1)} vs ref ${ref.toFixed(1)}`)
})

test('mixSeam: the tapers are 60 ms long', () => {
  const quiet = Buffer.alloc(BPS * 2)
  const flat = tone(2, 0.4, () => 1, 3000)
  const out = mixSeam(quiet, flat, BPS, 4, -120)   // a reference this low asks for no gain
  const rmsAt = (at: number, len: number, b: Buffer) => bufferRmsDb(b.subarray(bytesForMs(at, BPS, 4), bytesForMs(at + len, BPS, 4)))
  // Halfway up the ramp the head is 6 dB down; past the end of it, it's all there.
  assert.ok(Math.abs(rmsAt(25, 10, out) - (rmsAt(25, 10, flat) - 6)) < 1, `at 30 ms: ${rmsAt(25, 10, out)} against ${rmsAt(25, 10, flat)}`)
  assert.ok(Math.abs(rmsAt(70, 10, out) - rmsAt(70, 10, flat)) < 0.2, `at 75 ms: ${rmsAt(70, 10, out)} against ${rmsAt(70, 10, flat)}`)
})

test('mixSeam: never more than 6 dB of make-up, and never any cut', () => {
  const tail = tone(3, 0.02, () => 1, 220), head = Buffer.alloc(BPS * 3)
  const midLevel = (b: Buffer) => bufferRmsDb(b.subarray(BPS, BPS * 2))
  const plain = midLevel(tail)
  const lifted = midLevel(mixSeam(tail, head, BPS, 4, plain + 30))
  assert.ok(Math.abs(lifted - plain - 6) < 0.3, `asked for 30 dB, got ${lifted - plain}`)
  const left = midLevel(mixSeam(tail, head, BPS, 4, plain - 30))
  assert.ok(Math.abs(left - plain) < 0.1, `a mix over the reference stays where it is: ${left - plain}`)
})

// ── What a seam gets (2026-11-06) ──────────────────────────────────────────

/** A room: filtered noise, so a cut in it has no step beyond its own slope. */
function room(seconds: number, amp: number, gain: (t: number) => number = () => 1, seed = 1): Buffer {
  const frames = Math.floor(44100 * seconds)
  const b = Buffer.alloc(frames * 4)
  let s = (seed * 2654435761) >>> 0
  const white = (): number => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2147483648 - 1 }
  let l = 0, r = 0
  for (let i = 0; i < frames; i++) {
    l = 0.85 * l + 0.15 * white()
    r = 0.85 * r + 0.15 * white()
    const g = gain(i / 44100) * amp / 0.164
    b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, l * g)) * 32767), i * 4)
    b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, r * g)) * 32767), i * 4 + 2)
  }
  return b
}
const eightSeconds = (fn: (t: number) => number, seed: number, amp = 0.1): Buffer => room(8, amp, fn, seed)
const db = (x: number): number => Math.pow(10, x / 20)
/** A fade straight in dB over the last or first `secs`, as an album's would be. */
const fadesOut = (depth: number, secs = 4) => (t: number): number => (8 - t >= secs ? 1 : db((-depth * (secs - (8 - t))) / secs))
const fadesIn = (depth: number, secs = 4) => (t: number): number => (t >= secs ? 1 : db((-depth * (secs - t)) / secs))
/** A song's edge curving up from nothing over `frames`, like Nassau's. */
function softEdge(b: Buffer, frames: number, end: boolean): Buffer {
  const out = Buffer.from(b)
  const total = out.length / 4
  for (let k = 0; k < frames; k++) {
    const f = end ? total - 1 - k : k
    for (let c = 0; c < 2; c++) {
      const o = f * 4 + c * 2
      out.writeInt16LE(Math.round(out.readInt16LE(o) * (k / frames) ** 2), o)
    }
  }
  return out
}
const ms = (bytes: number): number => (bytes / BPS) * 1000
/** A join's two sides with its overlap in place, meeting mid-overlap. */
function joined(tail: Buffer, head: Buffer, bytes: number, ramp: boolean): { tail: Buffer; head: Buffer } {
  const mixed = mixEdges(tail.subarray(tail.length - bytes), head.subarray(0, bytes), 4, ramp)
  const half = Math.floor(bytes / 2 / 4) * 4
  return {
    tail: Buffer.concat([tail.subarray(0, tail.length - bytes), mixed.subarray(0, half)]),
    head: Buffer.concat([mixed.subarray(half), head.subarray(bytes)]),
  }
}

/** A level per stretch: [from this second, this dB]. */
const stretches = (...steps: Array<[number, number]>) => (t: number): number => {
  let at = steps[0][1]
  for (const [from, level] of steps) if (t >= from) at = level
  return db(at)
}
/** Noise that follows a level curve in dBFS, not relative to anything. */
const levelled = (fn: (t: number) => number, seed: number, seconds = 8): Buffer => room(seconds, 1, fn, seed)
/** A slow wave, for a signal with hardly any first difference. */
const slowWave = (frames: number, levelDb: number, hz: number, phase = 0): Buffer => {
  const b = Buffer.alloc(frames * 4)
  for (let i = 0; i < frames; i++) {
    const v = Math.round(db(levelDb) * Math.SQRT2 * 32767 * Math.cos(2 * Math.PI * hz * (i / 44100) + phase))
    b.writeInt16LE(v, i * 4); b.writeInt16LE(v, i * 4 + 2)
  }
  return b
}
/** Noise whose highs are all there: flat, or hard against the top of the band. */
const hiss = (frames: number, levelDb: number, seed: number, alternating = false): Buffer => {
  const b = Buffer.alloc(frames * 4)
  let s = (seed * 2654435761) >>> 0
  const white = (): number => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2147483648 - 1 }
  const g = db(levelDb) * Math.sqrt(3) * 32767
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < 2; c++) {
      const v = alternating ? (i % 2 ? 1 : -1) * Math.abs(white()) : white()
      b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v * g / 32767)) * 32767), i * 4 + c * 2)
    }
  }
  return b
}
/** `pcm` with its last or first frames replaced. */
const endingIn = (pcm: Buffer, last: Buffer): Buffer => Buffer.concat([pcm.subarray(0, pcm.length - last.length), last])
const openingWith = (pcm: Buffer, first: Buffer): Buffer => Buffer.concat([first, pcm.subarray(first.length)])
const frameCount = (msLong: number): number => Math.round((msLong / 1000) * 44100)

test('measurePlainJoin reads the levels either side of the cut', () => {
  const f = measurePlainJoin(room(8, 0.1, () => 1, 2), room(8, 0.01, () => 1, 3), 0, BPS, 4)
  assert.ok(Math.abs(f.tailDb - -20) < 1.5, `tail ${f.tailDb}`)
  assert.ok(Math.abs(f.headDb - -40) < 1.5, `head ${f.headDb}`)
  assert.equal(f.holeMs, 0)
  assert.ok(f.jumpOverSlope < 1.5, `jump ${f.jumpOverSlope}`)
  assert.ok(Math.abs(f.dipDb) < 1.5, `dip ${f.dipDb}`)
})

test('the hole is read at its real length: a gap of zeros at the cut, 1 to 8 ms', () => {
  // The first version read 1.9 ms short: 3 ms of zeros read 1.1 and passed as clean.
  for (const gap of [1, 1.5, 2, 3, 4, 5, 8]) {
    const tail = room(8, 0.1, () => 1, 4), head = room(8, 0.1, () => 1, 5)
    const frames = Math.round((gap / 1000) * 44100), a = Math.floor(frames / 2)
    tail.fill(0, tail.length - a * 4)
    head.fill(0, 0, (frames - a) * 4)
    const { holeMs } = measurePlainJoin(tail, head, 0, BPS, 4)
    assert.ok(Math.abs(holeMs - gap) <= 0.5, `${gap} ms read as ${holeMs}`)
  }
})

test('a long hole is read out to 15 ms either side of the cut and no further', () => {
  const tail = room(8, 0.1, () => 1, 74), head = room(8, 0.1, () => 1, 75)
  tail.fill(0, tail.length - 882 * 4)
  head.fill(0, 0, 882 * 4)   // 40 ms in all
  const { holeMs } = measurePlainJoin(tail, head, 0, BPS, 4)
  assert.ok(holeMs > 29.5 && holeMs < 32, `${holeMs}`)
})

test('the room is read 70-300 ms from the cut, so the last moments can\'t move it', () => {
  const tail = room(8, 0.1, (t) => (t < 7.94 ? 1 : db(-30)), 76), head = room(8, 0.1, (t) => (t > 0.06 ? 1 : db(-30)), 77)
  const f = measurePlainJoin(tail, head, 0, BPS, 4)
  assert.ok(Math.abs(f.tailDb - -20) < 1.5, `tail ${f.tailDb}`)
  assert.ok(Math.abs(f.headDb - -20) < 1.5, `head ${f.headDb}`)
})

test('a hole is held to the quieter side: a song that simply starts lower has none', () => {
  // The head opens on a slow wave 5 dB under its own body: nothing in it is 10 dB down
  // from there, however far it is under the tail.
  const head = openingWith(levelled(() => db(-40), 78), slowWave(frameCount(4), -45, 50))
  assert.equal(measurePlainJoin(levelled(() => db(-20), 79), head, 0, BPS, 4).holeMs, 0)
  // And in first difference: hiss over a dark body has far more of it than the body, however bright the tail.
  const dark = Buffer.concat([hiss(frameCount(4), -55, 80), slowWave(8 * 44100 - frameCount(4), -40, 100)])
  assert.equal(measurePlainJoin(endingIn(room(8, 1, () => db(-20), 81), hiss(frameCount(100), -20, 82)), dark, 0, BPS, 4).holeMs, 0)
})

test('a hole has to be 10 dB down in level and in first difference both', () => {
  const body = (seed: number): Buffer => levelled(() => db(-20), seed)
  const at = (mid: (frames: number) => Buffer): number => {
    const piece = mid(frameCount(4))
    const half = Math.floor(piece.length / 8) * 4
    return measurePlainJoin(endingIn(body(83), piece.subarray(0, half)), openingWith(body(84), piece.subarray(half)), 0, BPS, 4).holeMs
  }
  // 7 dB down, with hardly any highs left: music, not a gap.
  assert.equal(at((n) => slowWave(n, -27, 50)), 0, 'level only 7 dB down')
  // 15 dB down, but only 7 dB down in first difference: a hiss, not a gap.
  assert.equal(at((n) => hiss(n, -35.2, 85)), 0, 'first difference only 7 dB down')
  assert.ok(at((n) => hiss(n, -60, 86)) > 0, 'both well down')
})

test('a hole has to touch the cut: the same gap a little further back is the music\'s own', () => {
  const body = (seed: number): Buffer => room(8, 0.1, () => 1, seed)
  const gapInTail = (fromMs: number, toMs: number): Buffer => {
    const b = body(87)
    b.fill(0, b.length - frameCount(fromMs) * 4, b.length - frameCount(toMs) * 4)
    return b
  }
  const gapInHead = (fromMs: number, toMs: number): Buffer => {
    const b = body(88)
    b.fill(0, frameCount(fromMs) * 4, frameCount(toMs) * 4)
    return b
  }
  assert.ok(measurePlainJoin(gapInTail(4, 0.8), body(88), 0, BPS, 4).holeMs > 0, 'in the tail, up to 0.8 ms from the cut')
  assert.equal(measurePlainJoin(gapInTail(6, 3), body(88), 0, BPS, 4).holeMs, 0, 'in the tail, 3 ms from the cut')
  assert.ok(measurePlainJoin(body(87), gapInHead(0.8, 4), 0, BPS, 4).holeMs > 0, 'in the head, 0.8 ms from the cut')
  assert.equal(measurePlainJoin(body(87), gapInHead(3, 6), 0, BPS, 4).holeMs, 0, 'in the head, 3 ms from the cut')
})

// ── A notch at the cut, read against what sits right beside it ──

/** A cut in a dark song (a slow wave) with noise for 12 ms either side and `mid` for `midMs` at the cut. */
function darkCut(mid: (frames: number) => Buffer, midMs = 2): { tail: Buffer; head: Buffer } {
  const near = frameCount(12)
  const tail = Buffer.concat([slowWave(8 * 44100 - near, -36, 50), room(12 / 1000, 1, () => db(-36), 89)])
  const head = Buffer.concat([room(12 / 1000, 1, () => db(-36), 90), slowWave(8 * 44100 - near, -36, 50)])
  const piece = mid(frameCount(midMs))
  const half = Math.floor(piece.length / 8) * 4
  return { tail: endingIn(tail, piece.subarray(0, half)), head: openingWith(head, piece.subarray(half)) }
}

test('a notch too shallow in first difference for the room 15-70 ms away is still a hole', () => {
  // Nassau 0:34:58: the highs have already gone out there, so the first difference has less
  // far to fall, and it missed by 1.96 dB. Against what sits right beside the cut it's plain.
  const quietMid = (n: number): Buffer => room(n / 44100, 1, () => db(-60), 91)
  const { tail, head } = darkCut(quietMid)
  const f = measurePlainJoin(tail, head, 0, BPS, 4)
  assert.ok(f.holeMs >= 2 && f.holeMs <= 4.5, `reads ${f.holeMs} ms`)
  const plan = planSeam(tail, head, BPS, 4)
  assert.equal(plan.mix, 'edges')
  assert.equal(plan.overlapBytes, bytesForMs(Math.max(2.5, f.holeMs + 0.5), BPS, 4))
})

test('a notch has to fall 18 dB in level', () => {
  // 14 dB down in both, in a room where the rule for holes can't see it either.
  const shallow = darkCut((n) => room(n / 44100, 1, () => db(-50), 92))
  assert.equal(measurePlainJoin(shallow.tail, shallow.head, 0, BPS, 4).holeMs, 0)
})

test('a notch has to fall 12 dB in first difference', () => {
  // All three fall 22 dB or more in level. Near the top of the band the first difference
  // falls about 11 dB less than the level does, flat noise about 8 dB less.
  const by = (mid: (n: number) => Buffer): number => { const { tail, head } = darkCut(mid); return measurePlainJoin(tail, head, 0, BPS, 4).holeMs }
  assert.equal(by((n) => hiss(n, -57, 93, true)), 0, 'first difference 10 dB down')
  assert.ok(by((n) => hiss(n, -58, 94)) > 0, 'first difference 14 dB down')
})

test('a notch is read against what sits outside its own ramps', () => {
  // Songs that ramp over 3 ms: 1-2 ms from the cut is still on the way down.
  const { tail, head } = darkCut(() => Buffer.alloc(0))
  const soft = { tail: softEdge(tail, frameCount(3), true), head: softEdge(head, frameCount(3), false) }
  assert.ok(measurePlainJoin(soft.tail, soft.head, 0, BPS, 4).holeMs > 0)
})

test('a notch has to be at the cut: the same one 2-3 ms back is the music\'s own', () => {
  const { tail, head } = darkCut(() => Buffer.alloc(0))
  tail.fill(0, tail.length - frameCount(3) * 4, tail.length - frameCount(1.8) * 4)
  assert.equal(measurePlainJoin(tail, head, 0, BPS, 4).holeMs, 0)
})

test('a notch is read at its real length, out past the middle of it', () => {
  const quietMid = (n: number): Buffer => room(n / 44100, 1, () => db(-60), 91)
  const { tail, head } = darkCut(quietMid, 4)
  const { holeMs } = measurePlainJoin(tail, head, 0, BPS, 4)
  assert.ok(holeMs > 3.5 && holeMs < 5, `4 ms reads ${holeMs}`)
})

test('music with no hole reads no hole', () => {
  assert.equal(measurePlainJoin(room(8, 0.1, () => 1, 6), room(8, 0.1, () => 1, 7), 0, BPS, 4).holeMs, 0)
})

test('a gap in the music away from the cut is not a hole at the cut', () => {
  const tail = room(8, 0.1, () => 1, 60)
  const at = tail.length - 1764 * 4   // 40 ms before the cut
  tail.fill(0, at, at + 220 * 4)      // 5 ms long
  assert.equal(measurePlainJoin(tail, room(8, 0.1, () => 1, 61), 0, BPS, 4).holeMs, 0)
})

test('measurePlainJoin finds a step at the cut against the slope around it', () => {
  // A slow wave in the room, cut at its peak: the head starts near zero.
  const tail = tone(8, 0.3, () => 1, 50)
  const head = tone(8, 0.3, () => 1, 50)
  const frames = tail.length / 4
  const peak = Math.floor((frames - 1) / 882) * 882 + 220   // a crest of the 50 Hz wave
  const cut = Buffer.from(tail.subarray(0, peak * 4))
  const f = measurePlainJoin(cut, head, 0, BPS, 4)
  assert.ok(f.jumpOverSlope > 1.5, `jump over slope ${f.jumpOverSlope}`)
})

/** A slow wave split at a zero crossing, where its own step is 70 LSB. Hands back the two sides to edit. */
const splitWave = (): { tail: Buffer; head: Buffer } => {
  const wave = (i0: number, n: number): Buffer => {
    const b = Buffer.alloc(n * 4)
    for (let i = 0; i < n; i++) {
      const v = Math.round(0.3 * 32767 * Math.sin((2 * Math.PI * 50 * (i0 + i)) / 44100))
      b.writeInt16LE(v, i * 4); b.writeInt16LE(v, i * 4 + 2)
    }
    return b
  }
  return { tail: wave(0, 8 * 44100), head: wave(8 * 44100, 8 * 44100) }
}
const nudge = (b: Buffer, frame: number, by: number): void => {
  for (let c = 0; c < 2; c++) b.writeInt16LE(b.readInt16LE(frame * 4 + c * 2) + by, frame * 4 + c * 2)
}

test('the step across the cut is not compared with the frames right beside it', () => {
  // A step that started a frame early is still one step, on either side.
  const early = splitWave()
  nudge(early.tail, early.tail.length / 4 - 1, 2000)
  assert.ok(measurePlainJoin(early.tail, early.head, 0, BPS, 4).jumpOverSlope > 5, 'in the tail')
  const late = splitWave()
  nudge(late.head, 0, 2000)
  assert.ok(measurePlainJoin(late.tail, late.head, 0, BPS, 4).jumpOverSlope > 5, 'in the head')
})

test('the step across the cut is compared with the 20 ms around it, no more and no less', () => {
  const spikeAt = (msBack: number): number => {
    const { tail, head } = splitWave()
    nudge(tail, tail.length / 4 - frameCount(msBack), 4000)
    nudge(head, 0, 2000)
    return measurePlainJoin(tail, head, 0, BPS, 4).jumpOverSlope
  }
  assert.ok(spikeAt(10) < 1, `a spike 10 ms back sets the slope: ${spikeAt(10)}`)
  assert.ok(spikeAt(40) > 5, `a spike 40 ms back doesn't: ${spikeAt(40)}`)
})

test('measurePlainJoin: how far the cut sits under the bodies, outside the overlap', () => {
  const twoSeconds = 2 * BPS
  // Both sides fall to -60 dB of their bodies inside the overlap.
  const tail = room(8, 0.1, (t) => (t < 6 ? 1 : 0.001), 6)
  const head = room(8, 0.1, (t) => (t > 2 ? 1 : 0.001), 7)
  const f = measurePlainJoin(tail, head, twoSeconds, BPS, 4)
  assert.ok(f.dipDb > 50, `dip ${f.dipDb}`)
  // The shallower side is what counts.
  const g = measurePlainJoin(tail, room(8, 0.1, () => 1, 8), twoSeconds, BPS, 4)
  assert.ok(Math.abs(g.dipDb) < 1.5, `dip ${g.dipDb}`)
})

test('the dip is read from outside a slow fade, not from inside it', () => {
  // The fades are measured down to 6 dB under the body, so just outside the overlap
  // is still in the fade: a pair 30 dB deep used to read 24.7.
  const tail = eightSeconds(fadesOut(30), 40), head = eightSeconds(fadesIn(30), 41)
  const fade = seamOverlapMs(rmsEnvelope(tail, BPS), rmsEnvelope(head, BPS))
  const f = measurePlainJoin(tail, head, bytesForMs(fade, BPS, 4), BPS, 4)
  assert.ok(f.dipDb > 27, `dip ${f.dipDb}`)
})

test('the body beside a fade is read over half a second', () => {
  // A short burst at the end of a quiet stretch can't be the song's body by itself.
  const tail = levelled(stretches([0, -40], [5.9, -20], [6, -60]), 95)
  const head = levelled(() => db(-40), 96)
  const f = measurePlainJoin(tail, head, 2 * BPS, BPS, 4)
  // 100 ms at -20 in 500 ms of -40: -26.8 dBFS, against the -60 at the cut.
  assert.ok(Math.abs(f.tailDropDb - 33.2) < 1.5, `${f.tailDropDb}`)
})

test('the song\'s body is what it settles into, from 4 s on', () => {
  // Loud between 2 s and 4 s: a burst on the way in, not what it settled into.
  const head = levelled(stretches([0, -40], [2, -15], [4, -40]), 97)
  assert.equal(measurePlainJoin(levelled(() => db(-40), 98), head, 0, BPS, 4).headArrivesMs, 0)
})

test('headArrivesMs: when the next song is within 10 dB of its body', () => {
  const at = (fn: (t: number) => number, seed: number): number | null => measurePlainJoin(eightSeconds(() => 1, 8), eightSeconds(fn, seed), 0, BPS, 4).headArrivesMs
  assert.equal(at(() => 1, 9), 0, 'there from the first moment')
  assert.equal(at((t) => (t < 0.3 ? db(-30) : 1), 10), 300, 'a room, then in hard')
  const slow = at(fadesIn(40), 11)
  assert.ok(slow !== null && slow > 2500 && slow < 3500, `a slow fade-in gets there late: ${slow}`)
  // A song that opens loud and later falls quiet: its second half alone would call the room "there".
  const f = measurePlainJoin(eightSeconds(() => 1, 8), eightSeconds((t) => (t < 1.5 ? db(-30) : t < 3.5 ? 1 : db(-25)), 12), bytesForMs(1000, BPS, 4), BPS, 4)
  assert.equal(f.headArrivesMs, 1500)
  // On either side of the line.
  assert.equal(at((t) => (t < 1 ? db(-8) : 1), 13), 0, '8 dB under its body is there')
  assert.equal(at((t) => (t < 1 ? db(-12) : 1), 14), 1000, '12 dB under its body is not')
})

// ── The 13 real shows, as data ──

type RealSeam = JoinFacts & { show: string; seam: number; fadeMs: number; mix: string; overlapBytes: number; cueBytes: number; tail?: number[]; head?: number[] }
const realSeams = (): RealSeam[] => JSON.parse(readFileSync(new URL('./fixtures/live-set-seams-13-shows-2026-11-06.json', import.meta.url), 'utf8')) as RealSeam[]

/** 8 s of unit noise, once: a rebuild is then only a multiply per sample. */
const unitNoise = (seed: number): Float32Array => {
  const out = new Float32Array(8 * 44100 * 2)
  let s = (seed * 2654435761) >>> 0
  const white = (): number => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2147483648 - 1 }
  let l = 0, r = 0
  for (let i = 0; i < out.length; i += 2) {
    l = 0.85 * l + 0.15 * white(); r = 0.85 * r + 0.15 * white()
    out[i] = l / 0.164; out[i + 1] = r / 0.164
  }
  return out
}
let noisePair: { a: Float32Array; b: Float32Array } | null = null
const sharedNoise = (): { a: Float32Array; b: Float32Array } => (noisePair ??= { a: unitNoise(1), b: unitNoise(2) })
/** Noise that follows a seam's 100 ms levels. The floor of those levels is digital silence. */
function fromLevels(levels: number[], gainDb: number, noise: Float32Array): Buffer {
  const out = new Int16Array(levels.length * 4410 * 2)
  levels.forEach((level, w) => {
    const g = level <= -90 ? 0 : Math.pow(10, (level + gainDb) / 20) * 32767
    for (let i = w * 8820; i < (w + 1) * 8820; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(noise[i] * g)))
  })
  return Buffer.from(out.buffer)
}

// ── Were the fades real? ──

const room30: JoinFacts = { tailDb: -30, headDb: -30, holeMs: 0, jumpOverSlope: 0.3, tailDropDb: 5, headDropDb: 5, dipDb: 5, headArrivesMs: 3000, headJumps: false, tailStopsHard: false, headSilentMs: 0 }

test('fadeIsReal: both sides in the room, nothing deep: no', () => {
  assert.equal(fadeIsReal(room30), false)
})

test('fadeIsReal: a side 40 dB under its own body', () => {
  assert.equal(fadeIsReal({ ...room30, tailDropDb: 40 }), true, 'tail')
  assert.equal(fadeIsReal({ ...room30, tailDropDb: 39.9 }), false)
  assert.equal(fadeIsReal({ ...room30, headDropDb: 40 }), true, 'head')
  assert.equal(fadeIsReal({ ...room30, headDropDb: 39.9 }), false)
  assert.equal(fadeIsReal({ ...room30, tailDropDb: 40, headJumps: true, headArrivesMs: 0 }), true, 'an arriving song does not rescue it')
  assert.equal(fadeIsReal({ ...room30, tailDb: -75, headDb: -75 }), false, 'how quiet the cut is proves nothing: a quiet record is all down there')
})

test('fadeIsReal: a tail far above a head that climbs slowly is a cliff', () => {
  assert.equal(fadeIsReal({ ...room30, headDb: -40.1 }), true)
  assert.equal(fadeIsReal({ ...room30, headDb: -40 }), false)
  assert.equal(fadeIsReal({ ...room30, headDb: -40.1, headArrivesMs: 100 }), true, 'how soon it gets there is not the point')
  assert.equal(fadeIsReal({ ...room30, headDb: -40.1, headJumps: true }), false, 'a head that opens quiet and then jumps is an intro')
})

test('fadeIsReal: a deep dip counts unless the next song comes in hard', () => {
  assert.equal(fadeIsReal({ ...room30, dipDb: 25 }), true)
  assert.equal(fadeIsReal({ ...room30, dipDb: 24.9 }), false)
  assert.equal(fadeIsReal({ ...room30, dipDb: 40, headArrivesMs: 1000 }), true, 'a short fade, however soon it gets there')
  assert.equal(fadeIsReal({ ...room30, dipDb: 40, headArrivesMs: null }), true, 'never seen to arrive')
  assert.equal(fadeIsReal({ ...room30, dipDb: 40, headArrivesMs: 1000, headJumps: true }), false, 'in hard within a second')
  assert.equal(fadeIsReal({ ...room30, dipDb: 39, headArrivesMs: 3000, headJumps: true }), false, 'in hard after a room of any length')
})

test('fadeIsReal: a tail that fell to well under the room the head opens in', () => {
  const under = { ...room30, tailDb: -40, headDb: -34, dipDb: 12 }
  assert.equal(fadeIsReal(under), true)
  assert.equal(fadeIsReal({ ...under, tailDb: -39.9 }), false, 'not far enough under')
  assert.equal(fadeIsReal({ ...under, dipDb: 11.9 }), false, 'it never came down from anywhere: a quiet tail, not a fade')
  const roomThenBand = { ...under, headJumps: true, headArrivesMs: 3200 }
  assert.equal(fadeIsReal(roomThenBand), true, 'a long room, then the band: Geese, Alive 0:12:37')
  assert.equal(fadeIsReal({ ...roomThenBand, headArrivesMs: 1100 }), true, 'just over a second of room')
  assert.equal(fadeIsReal({ ...roomThenBand, headArrivesMs: 1000 }), false, 'a second or less is the head coming in, not a room')
  assert.equal(fadeIsReal({ ...roomThenBand, headArrivesMs: 600 }), false, 'the head is the next song, not a room')
  assert.equal(fadeIsReal({ ...under, headArrivesMs: 1000 }), false, 'and the same for a head that gets there by climbing')
  assert.equal(fadeIsReal({ ...under, headArrivesMs: null }), true, 'never seen to arrive: all room')
})

test('fadeIsReal: a note that stops, digital silence, then a hard start is a pause', () => {
  const pause = { ...room30, tailStopsHard: true, headJumps: true, headSilentMs: 600, headDropDb: 120, headDb: -140 }
  assert.equal(fadeIsReal(pause), false)
  assert.equal(fadeIsReal({ ...pause, headSilentMs: 500 }), true, 'under 600 ms of silence')
  assert.equal(fadeIsReal({ ...pause, headJumps: false }), true, 'it fades up out of the silence')
  assert.equal(fadeIsReal({ ...pause, tailStopsHard: false }), true, 'the tail faded into the silence')
})

test('every seam of the 13 shows, measured: 59 overlaps, 21 closed by their edges, 3 ramped, 98 plain', () => {
  // The engine's own measures, from homemini's local sources, 2026-11-06. A regression pin, not
  // a proof: the behaviour is proved on built PCM around it. Against the blip audit's list of
  // 24 false crossfades out of 83, four differ, on purpose. Geese, Alive 3 is a real album fade.
  // Geese, Alive 4 and 6 are a room running through and a hard start, read against their own
  // body now. Cameron 8 was kept only for a step of 1.96 x the slope, which has a 2.5 ms answer.
  const seams = realSeams()
  assert.equal(seams.length, 181)
  for (const s of seams) assert.equal(s.fadeMs > 0 && fadeIsReal(s), s.mix === 'fade', `${s.show} seam ${s.seam}`)
  const count = (mix: string): number => seams.filter((s) => s.mix === mix).length
  assert.deepEqual([count('fade'), count('edges'), count('ramp'), count('none')], [59, 21, 3, 98])
})

test('the real seams\' level curves, rebuilt as noise: the same answer, fade or not, at any mastering level', () => {
  // Nothing of the music is here but its level every 100 ms, which is all the fades' rules
  // read. Holes and steps are in the samples, so edges and ramps come out plain here.
  const noise = sharedNoise()
  const wrong: string[] = []
  for (const s of realSeams()) {
    if (!s.tail || !s.head) continue
    for (const gain of [0, -10]) {
      const plan = planSeam(fromLevels(s.tail, gain, noise.a), fromLevels(s.head, gain, noise.b), BPS, 4)
      if ((plan.mix === 'fade') !== (s.mix === 'fade')) wrong.push(`${s.show} ${s.seam} at ${gain} dB: ${plan.mix}, was ${s.mix}`)
    }
  }
  assert.deepEqual(wrong, [])
})

// ── planSeam ──

// What a seam's shape asks of the rules, one at a time, in the show's own terms.

test('planSeam: Amsterdam 0:27:04 falls to -75 dBFS on the way to a head rising slowly: a real pair of fades', () => {
  // 39 dB and 34 dB under the bodies, so under the 40 dB line on both sides. No room does that.
  const tail = levelled(stretches([0, -14], [4.5, -20], [5, -28], [5.3, -52], [5.6, -60], [6, -75], [6.4, -60], [6.8, -52]), 100)
  const head = levelled((t) => db(t < 0.4 ? -50 : t > 3.2 ? -16 : -38 + ((t - 0.4) / 2.8) * 22), 101)
  assert.equal(planSeam(tail, head, BPS, 4).mix, 'fade')
})

test('planSeam: a quiet room on both sides, running through, is plain at any mastering level', () => {
  // Geese, Alive 0:16:08. A record this quiet is under -60 dBFS for seconds at a time.
  for (const gain of [0, -6, -12, -18]) {
    const tail = levelled(stretches([0, -47 + gain], [3, -67 + gain]), 102)
    const head = levelled(stretches([0, -65 + gain], [2, -40 + gain]), 103)
    assert.equal(planSeam(tail, head, BPS, 4).mix, 'none', `${gain} dB`)
  }
})

test('planSeam: a tail faded 50 dB is faded away, and 35 dB is not, at any mastering level', () => {
  for (const gain of [0, -20]) {
    const hard = eightSeconds(() => 1, 105, db(-20 + gain))
    assert.equal(planSeam(eightSeconds(fadesOut(35), 104, db(-20 + gain)), hard, BPS, 4).mix, 'none', `35 dB at ${gain} dB`)
    assert.equal(planSeam(eightSeconds(fadesOut(50), 104, db(-20 + gain)), hard, BPS, 4).mix, 'fade', `50 dB at ${gain} dB`)
  }
})

test('planSeam: a hard tail over a head faded up from far under its body overlaps, the mirror of a tail', () => {
  assert.equal(planSeam(eightSeconds(() => 1, 106), eightSeconds(fadesIn(60), 107), BPS, 4).mix, 'fade')
})

test('planSeam: a quiet intro under a loud tail is plain, however long it runs', () => {
  // Without this, 4 s of the intro went 12 dB under the old song, and at 8 dB it stayed plain.
  assert.equal(planSeam(levelled(() => db(-16), 108), levelled(stretches([0, -28], [5, -16]), 109), BPS, 4).mix, 'none')
})

test('planSeam: a short pair of crowd fades is a pair of fades, not a band coming in', () => {
  // A 1.4 s pair, 40 dB deep at -15 dBFS, was plain: a 34 dB hush, the original complaint.
  for (const secs of [0.7, 1, 1.4]) {
    const tail = levelled((t) => db(8 - t >= secs ? -15 : -15 - (40 * (secs - (8 - t))) / secs), 110)
    const head = levelled((t) => db(t >= secs ? -15 : -15 - (40 * (secs - t)) / secs), 111)
    assert.equal(planSeam(tail, head, BPS, 4).mix, 'fade', `${secs} s`)
  }
})

test('planSeam: the tape runs through a room and the band comes in, however long the room', () => {
  // The clock used to say 1 s. A room of 1.1 s got an overlap 2.2 s into the band's first notes.
  const tail = levelled((t) => db(t < 4 ? -18.4 : -18.4 - 28 * Math.min(1, (t - 4) / 3.5)), 112)
  for (const secs of [0.3, 1, 1.1, 1.5, 2, 3.2, 5]) {
    const head = levelled((t) => db(t < secs ? -46.4 : -18.4), 113)
    assert.notEqual(planSeam(tail, head, BPS, 4).mix, 'fade', `${secs} s of room`)
  }
})

test('planSeam: half of the climb in its last 200 ms is an entry', () => {
  // On the envelope's 100 ms grid. The tail comes down 30 dB, deep enough to overlap if the
  // head is a fade. An entry has no fade to rebuild.
  const tail = eightSeconds(fadesOut(30), 114, 0.1)
  const head = (...climb: number[]): Buffer => levelled((t) => {
    const w = Math.floor(t * 10)
    return db(w < climb.length ? climb[w] : -20)
  }, 115)
  assert.equal(planSeam(tail, head(-50, -50, -50, -50, -42, -32), BPS, 4).mix, 'none', 'the last 200 ms hold 22 dB of 30, the last 100 ms only 12')
  assert.equal(planSeam(tail, head(-50, -50, -50, -50, -40, -32), BPS, 4).mix, 'none', 'the last 200 ms hold 20 dB of 30')
  assert.equal(planSeam(tail, head(-50, -50, -50, -50, -46, -41, -36, -31, -26), BPS, 4).mix, 'fade', 'the last 200 ms hold 10 dB of 24, the last 300 ms 15')
})

test('planSeam: a hit before the climb doesn\'t shorten the climb', () => {
  // A stick, then the head fades up from far under it. The climb is from the lowest point, or
  // the hit would make a slow fade read as an entry.
  const tail = eightSeconds(fadesOut(30), 114, 0.1)
  const head = levelled((t) => {
    const w = Math.floor(t * 10)
    return db(w < 8 ? [-35, -55, -50, -45, -40, -36, -32, -28][w] : -20)
  }, 187)
  assert.equal(planSeam(tail, head, BPS, 4).mix, 'fade')
})

test('planSeam: a tail over a head that\'s simply quieter from its first moment is plain', () => {
  // 12 dB apart at the cut, but the head is all there at once: a level change, not a cliff.
  const tail = levelled(stretches([0, -10], [5, -25]), 174)
  const plan = planSeam(tail, levelled(() => db(-37), 175), BPS, 4)
  assert.notEqual(plan.mix, 'fade')
})

test('headJumps: a head that never arrives in what we can see hasn\'t jumped', () => {
  const f = measurePlainJoin(levelled(() => db(-20), 176), room(0.05, 0.1, () => 1, 177), 0, BPS, 4)
  assert.equal(f.headArrivesMs, null)
  assert.equal(f.headJumps, false)
})

test('headSilentMs only counts what comes before the song is there', () => {
  // Hard at once, and a silence later on: nothing to do with this join. QOTSA's kind of seam.
  const head = levelled((t) => (t > 2 && t < 3 ? 0 : db(-15)), 178)
  assert.equal(measurePlainJoin(levelled(() => db(-15), 179), head, 0, BPS, 4).headSilentMs, 0)
  assert.equal(planSeam(levelled((t) => (t < 7 ? db(-15) : 0), 180), head, BPS, 4).mix, 'fade')
})

test('tailStopsHard reads the climb backwards from the cut', () => {
  const faded = measurePlainJoin(eightSeconds(fadesOut(40), 118), levelled(() => db(-20), 117), 2 * BPS, BPS, 4)
  assert.equal(faded.tailStopsHard, false, 'a fade')
  const atBody = measurePlainJoin(levelled(() => db(-20), 116), levelled(() => db(-20), 117), 0, BPS, 4)
  assert.equal(atBody.tailStopsHard, true, 'still at its body at the cut')
  const stopped = measurePlainJoin(levelled((t) => (t < 7 ? db(-20) : 0), 119), levelled(() => db(-20), 117), BPS, BPS, 4)
  assert.equal(stopped.tailStopsHard, true, 'stopped dead, then silence')
})

// ── A pause ──

/** Sticks: four hits over digital silence, then the band. */
const countIn = (seed: number): Buffer => {
  const head = levelled((t) => (t >= 2 ? db(-15) : 0), seed)
  for (const at of [0, 0.5, 1, 1.5]) {
    const f = Math.floor(at * 44100)
    for (let k = 0; k < 90; k++) for (let c = 0; c < 2; c++) head.writeInt16LE(Math.round(20000 * Math.exp(-k / 15) * (k % 2 ? -1 : 1)), (f + k) * 4 + c * 2)
  }
  return head
}

test('planSeam: a count-in over digital silence keeps its pause', () => {
  const plan = planSeam(levelled(() => db(-15), 120), countIn(121), BPS, 4)
  assert.notEqual(plan.mix, 'fade', 'nothing laid over the sticks')
  const f = measurePlainJoin(levelled(() => db(-15), 120), countIn(121), bytesForMs(2000, BPS, 4), BPS, 4)
  assert.equal(f.headSilentMs, 1600, 'the hits are not silence')
})

test('planSeam: digital silence and then the band keeps its pause, at any length', () => {
  for (const secs of [0.6, 1, 2, 3.5, 5]) {
    const plan = planSeam(levelled(() => db(-15), 122), levelled((t) => (t >= secs ? db(-15) : 0), 123), BPS, 4)
    assert.notEqual(plan.mix, 'fade', `${secs} s`)
  }
})

test('planSeam: what a lossy decode leaves of silence still counts as silence', () => {
  // A bit or two of noise: AAC's idea of nothing.
  const head = openingWith(levelled(() => db(-15), 124), hiss(44100, -90, 125))
  assert.notEqual(planSeam(levelled(() => db(-15), 126), head, BPS, 4).mix, 'fade')
})

test('planSeam: a room that happens to be quiet is not silence', () => {
  // Geese, Alive 0:04:40: a room at -63 dBFS, 47 dB under the band. It keeps its overlap.
  assert.equal(planSeam(levelled(() => db(-52), 128), levelled(stretches([0, -63], [3.9, -16]), 127), BPS, 4).mix, 'fade')
  const roomAt75 = levelled(stretches([0, -75], [3.9, -16]), 127)
  assert.equal(planSeam(levelled(() => db(-52), 128), roomAt75, BPS, 4).mix, 'fade', 'nor at -75 dBFS')
})

test('planSeam: the silence is in the old song\'s file and the count-in in the new one\'s: still a pause', () => {
  assert.notEqual(planSeam(levelled((t) => (t < 7 ? db(-15) : 0), 129), countIn(130), BPS, 4).mix, 'fade')
})

test('planSeam: how hard the tail stops is read against the tail\'s own body, whatever the head is', () => {
  // A long fade into silence, and a very quiet head: against the head's level the fade would read as a stop.
  const tail = levelled((t) => (t < 4 ? db(-15) : t > 7 ? 0 : db(-15 - ((t - 4) / 3) * 60)), 188)
  assert.equal(planSeam(tail, levelled((t) => (t < 1 ? 0 : db(-60)), 189), BPS, 4).mix, 'fade')
})

test('planSeam: a song faded long ago, whose quiet room then stops dead, is a fade and not a stop', () => {
  // QOTSA, Alive In The Catacombs 0:21:11 has the tail of this. The body is the song, not the room it faded into.
  const tail = levelled((t) => (t < 1.5 ? db(-15) : t < 2.5 ? db(-15 - (t - 1.5) * 50) : t < 7 ? db(-65) : 0), 190)
  assert.equal(planSeam(tail, levelled((t) => (t < 1 ? 0 : db(-15)), 191), BPS, 4).mix, 'fade')
})

test('planSeam: and a song that only gets loud near its end has that for its body', () => {
  // A quiet first half, then the song, fading slowly to a room that stops dead. Against the quiet
  // half, or the even quieter head, the stop would be all there is to read.
  const tail = levelled((t) => (t < 4 ? db(-50) : t < 6.5 ? db(-15 - (t - 4) * 18) : t < 7 ? db(-60) : 0), 192)
  assert.equal(planSeam(tail, levelled((t) => (t < 1 ? 0 : db(-60)), 193), BPS, 4).mix, 'fade')
})

test('planSeam: real fades into silence stay overlaps', () => {
  // Daft Punk 1:14:01, Nassau 1:17:00: faded to nothing, silence, faded up again.
  const tail = levelled((t) => (t > 6.2 ? 0 : t < 4.7 ? db(-42) : db(-42 - ((t - 4.7) / 1.5) * 34)), 131)
  const head = levelled((t) => (t < 0.4 ? 0 : t > 3.2 ? db(-35) : db(-70 + ((t - 0.4) / 2.8) * 35)), 132)
  assert.equal(planSeam(tail, head, BPS, 4).mix, 'fade')
})

test('planSeam: a tail faded into the silence, then a hard start: the fade is real, so it keeps its overlap', () => {
  const tail = levelled((t) => (t < 4 ? db(-15) : t > 7 ? 0 : db(-15 - ((t - 4) / 3) * 60)), 133)
  assert.equal(planSeam(tail, levelled((t) => (t < 1 ? 0 : db(-15)), 134), BPS, 4).mix, 'fade')
})

test('planSeam: a hard tail, silence, and a head that fades up out of it: a real fade-in', () => {
  // Zeppelin 0:55:11: The Rain Song runs to the cut, then 1 s of nothing, then Dazed fades up.
  const head = levelled((t) => (t < 1 ? 0 : t < 2.8 ? db(-57 + ((t - 1) / 1.8) * 24) : db(-10)), 135)
  assert.equal(planSeam(levelled(() => db(-20), 136), head, BPS, 4).mix, 'fade')
})

test('planSeam: the silence is all in the old song\'s file and the next song starts hard: left as it is', () => {
  // QOTSA, Alive In The Catacombs 0:10:43, for real, so this can't be told apart without flipping
  // it. The overlap takes the pause out but lays nothing over anything: the next song starts
  // where the old one stopped.
  const plan = planSeam(levelled((t) => (t < 7 ? db(-15) : 0), 137), levelled(() => db(-15), 138), BPS, 4)
  assert.equal(plan.mix, 'fade')
  assert.equal(plan.overlapBytes, bytesForMs(1000, BPS, 4))
  assert.equal(plan.cueBytes, 0)
})

// ── The plain answer, and how far it reaches ──

test('planSeam: a 12 dB drop that stays in the room gets no overlap', () => {
  const tail = eightSeconds((t) => (t < 5 ? 1 : t > 6.5 ? 0.2 : 1 - 0.8 * ((t - 5) / 1.5)), 9)
  const head = eightSeconds(() => 1, 10)
  assert.ok(seamOverlapMs(rmsEnvelope(tail, BPS), rmsEnvelope(head, BPS)) > 0, 'the fades alone would overlap')
  assert.deepEqual(planSeam(tail, head, BPS, 4), { mix: 'none', overlapBytes: 0, cueBytes: 0 })
})

test('planSeam: fades down to nothing keep their overlap, in whole frames', () => {
  const tail = eightSeconds((t) => (t < 4.5 ? 1 : t > 7.5 ? 0 : (7.5 - t) / 3), 11)
  const head = eightSeconds((t) => (t > 3.5 ? 1 : t < 0.5 ? 0 : (t - 0.5) / 3), 12)
  const plan = planSeam(tail, head, BPS, 4)
  assert.equal(plan.mix, 'fade')
  assert.ok(plan.overlapBytes >= bytesForMs(600, BPS, 4) && plan.overlapBytes <= bytesForMs(4000, BPS, 4), `overlap ${plan.overlapBytes}`)
  assert.equal(plan.overlapBytes % 4, 0)
})

test('planSeam: one side at the floor keeps the overlap, the other side\'s level doesn\'t rescue it', () => {
  // The audit's "tail ends hard, head fades in": the head starts from nothing.
  const tail = eightSeconds(() => 1, 13)
  const head = eightSeconds((t) => (t > 3.5 ? 1 : t < 0.5 ? 0 : (t - 0.5) / 3), 14)
  assert.equal(planSeam(tail, head, BPS, 4).mix, 'fade')
})

test('planSeam: no fades and a clean join, the sources\' own bits', () => {
  const flat = eightSeconds(() => 1, 15)
  assert.deepEqual(planSeam(flat, eightSeconds(() => 1, 16), BPS, 4), { mix: 'none', overlapBytes: 0, cueBytes: 0 })
})

test('planSeam: the tape runs through a quiet room and the band comes in: no overlap, however deep', () => {
  // Unplugged 0:12:28. The old song decays 28 dB into a room at -46 dBFS, the head
  // is that room for 300 ms, then the next song. An overlap can only lay the old
  // song's end under the new song's start.
  const under = db(-28)
  const tail = eightSeconds((t) => (t < 6 ? 1 : t > 7.5 ? under : db((-28 * (t - 6)) / 1.5)), 42, 0.12)
  const head = eightSeconds((t) => (t < 0.3 ? under : 1), 43, 0.12)
  const fade = seamOverlapMs(rmsEnvelope(tail, BPS), rmsEnvelope(head, BPS))
  assert.ok(fade > 0, 'the fades alone would overlap')
  const f = measurePlainJoin(tail, head, bytesForMs(fade, BPS, 4), BPS, 4)
  assert.ok(f.dipDb >= 25, `the dip alone would overlap: ${f.dipDb}`)
  assert.equal(planSeam(tail, head, BPS, 4).mix, 'none')
})

test('planSeam: the same depth with the head rising slowly out of the cut is a pair of fades', () => {
  // Amsterdam 0:27:04, and any pair of album fades that stop above the floor.
  const tail = eightSeconds(fadesOut(40), 44), head = eightSeconds(fadesIn(40), 45)
  assert.equal(planSeam(tail, head, BPS, 4).mix, 'fade')
})

test('planSeam: a shallow pair of fades stays plain, a deep one overlaps', () => {
  // Under about 25 dB the room is still there, and on a real show that's a lull.
  for (const depth of [15, 20]) {
    assert.equal(planSeam(eightSeconds(fadesOut(depth), 46), eightSeconds(fadesIn(depth), 47), BPS, 4).mix, 'none', `${depth} dB`)
  }
  for (const depth of [30, 35, 50]) {
    assert.equal(planSeam(eightSeconds(fadesOut(depth), 46), eightSeconds(fadesIn(depth), 47), BPS, 4).mix, 'fade', `${depth} dB`)
  }
})

test('planSeam: a tail ending hard above a head fading in from under it is a cliff, not a join', () => {
  // The first version made this a plain join: a 38 dB drop between two samples.
  const plan = planSeam(eightSeconds(() => 1, 48, 0.2), eightSeconds(fadesIn(40), 49, 0.2), BPS, 4)
  assert.equal(plan.mix, 'fade')
})

test('planSeam: a tail faded to under the room the head opens in', () => {
  // Geese, Alive 0:12:37: 36 dB down in 4 s, to 10.8 dB under a head that is a quiet
  // room for 3.2 s before the next song. Plain, that's a 22 dB hush for 2.7 s.
  const tail = eightSeconds(fadesOut(30), 50, 0.1)
  const head = eightSeconds((t) => (t < 3.2 ? db(-20) : 1), 51, 0.08)
  const facts = measurePlainJoin(tail, head, bytesForMs(seamOverlapMs(rmsEnvelope(tail, BPS), rmsEnvelope(head, BPS)), BPS, 4), BPS, 4)
  assert.ok(facts.dipDb < 25, `under the dip gate: ${facts.dipDb}`)
  assert.ok(facts.headDb - facts.tailDb >= 6, `${facts.tailDb} under ${facts.headDb}`)
  assert.equal(planSeam(tail, head, BPS, 4).mix, 'fade')
})

test('planSeam: a tail that fades under a hard start is a plain join', () => {
  // Cameron 0:14:22 and 0:40:41. No overlap can do anything here but bury the start.
  assert.equal(planSeam(eightSeconds(fadesOut(30), 52), eightSeconds(() => 1, 53, 0.2), BPS, 4).mix, 'none')
})

// ── Closed joins ──

test('planSeam: two soft edges back to back are closed by laying them over each other', () => {
  // Nassau: each song ramps over 1-2 ms. The first version joined them plainly, 2.4 ms down.
  const tail = softEdge(eightSeconds(() => 1, 20), 77, true)
  const head = softEdge(eightSeconds(() => 1, 21), 88, false)
  const before = measurePlainJoin(tail, head, 0, BPS, 4)
  assert.ok(before.holeMs >= 1.5, `the notch reads ${before.holeMs} ms`)
  const plan = planSeam(tail, head, BPS, 4)
  assert.equal(plan.mix, 'edges')
  assert.ok(ms(plan.overlapBytes) >= 2 && ms(plan.overlapBytes) <= 4, `overlap ${ms(plan.overlapBytes)} ms`)
  assert.equal(plan.overlapBytes % 4, 0)
  assert.equal(plan.cueBytes, Math.floor(plan.overlapBytes / 2 / 4) * 4, 'the marker sits in the middle of it')
  const after = joined(tail, head, plan.overlapBytes, false)
  assert.equal(measurePlainJoin(after.tail, after.head, 0, BPS, 4).holeMs, 0)
})

test('planSeam: a hole where the fades ask for an overlap still gets only what closes it', () => {
  // Nassau 1:47:26. A failed hole gate used to answer with the fades' whole 2.1 s.
  const tail = softEdge(eightSeconds((t) => (t < 5 ? 1 : t > 6.5 ? 0.2 : 1 - 0.8 * ((t - 5) / 1.5)), 22), 77, true)
  const head = softEdge(eightSeconds((t) => (t < 0.3 ? 0.2 : 1), 23), 88, false)
  assert.ok(seamOverlapMs(rmsEnvelope(tail, BPS), rmsEnvelope(head, BPS)) > 1000, 'the fades ask for seconds')
  const plan = planSeam(tail, head, BPS, 4)
  assert.equal(plan.mix, 'edges')
  assert.ok(ms(plan.overlapBytes) < 5, `overlap ${ms(plan.overlapBytes)} ms`)
})

test('planSeam: padding no file declared, all in the tail, closes too', () => {
  const tail = eightSeconds(() => 1, 24)
  tail.fill(0, tail.length - 1000 * 4)   // 22.7 ms
  const plan = planSeam(tail, eightSeconds(() => 1, 25), BPS, 4)
  assert.equal(plan.mix, 'edges')
  assert.ok(ms(plan.overlapBytes) >= 22.7 && ms(plan.overlapBytes) <= 30, `overlap ${ms(plan.overlapBytes)} ms`)
  assert.equal(plan.unclosed, undefined)
})

test('planSeam: a hole too long to be an edge is left alone, and says so', () => {
  const tail = eightSeconds(() => 1, 26), head = eightSeconds(() => 1, 27)
  tail.fill(0, tail.length - 882 * 4)
  head.fill(0, 0, 882 * 4)   // 40 ms
  const plan = planSeam(tail, head, BPS, 4)
  assert.equal(plan.mix, 'none')
  assert.equal(plan.overlapBytes, 0)
  assert.ok(plan.unclosed && plan.unclosed.holeMs > 0, 'it says so')
})

test('planSeam: the sum starts just past the hole, and grows by half each try', () => {
  // A hole the reading sees all of: the first try closes it.
  const tail = softEdge(eightSeconds(() => 1, 140), 110, true)
  const head = softEdge(eightSeconds(() => 1, 141), 110, false)
  const seen = measurePlainJoin(tail, head, 0, BPS, 4).holeMs
  assert.ok(seen > 2.5, `${seen}`)
  assert.equal(planSeam(tail, head, BPS, 4).overlapBytes, bytesForMs(seen + 0.5, BPS, 4))
  // 22.7 ms of padding reads only 15 ms: the first try can't close it, the second can.
  const padded = eightSeconds(() => 1, 24)
  padded.fill(0, padded.length - 1000 * 4)
  const after = eightSeconds(() => 1, 25)
  const short = measurePlainJoin(padded, after, 0, BPS, 4).holeMs
  assert.ok(short < 16, `${short}`)
  assert.equal(planSeam(padded, after, BPS, 4).overlapBytes, bytesForMs((short + 0.5) * 1.5, BPS, 4))
})

test('planSeam: 30 ms is as far as a sum goes', () => {
  const gap = (tailMs: number, headMs: number): { tail: Buffer; head: Buffer } => {
    const tail = eightSeconds(() => 1, 142), head = eightSeconds(() => 1, 143)
    tail.fill(0, tail.length - frameCount(tailMs) * 4)
    head.fill(0, 0, frameCount(headMs) * 4)
    return { tail, head }
  }
  // The reading stops at 15 ms on the tail's side, so this one's second try lands at 27 ms and closes it.
  const closes = gap(24, 2)
  const plan = planSeam(closes.tail, closes.head, BPS, 4)
  assert.equal(plan.mix, 'edges')
  assert.ok(ms(plan.overlapBytes) > 26 && ms(plan.overlapBytes) <= 30, `${ms(plan.overlapBytes)} ms`)
  // This one's second try would land at 33 ms. A sum that long isn't an edge any more.
  const tooFar = gap(20, 6)
  const left = planSeam(tooFar.tail, tooFar.head, BPS, 4)
  assert.equal(left.mix, 'none')
  assert.ok(left.unclosed && left.unclosed.holeMs > 20, 'it says so')
})

test('planSeam: a sum that leaves a step at its middle isn\'t used', () => {
  // Soft edges that close at the first try, 110 frames, except that a click in the head sits
  // exactly where the two halves of that try would meet. The second try moves the middle off it.
  const tail = softEdge(eightSeconds(() => 1, 144), 44, true)
  const head = softEdge(eightSeconds(() => 1, 145), 44, false)
  for (let c = 0; c < 2; c++) head.writeInt16LE(9000, 55 * 4 + c * 2)
  const first = bytesForMs(2.5, BPS, 4)
  assert.ok(measurePlainJoin(tail, head, 0, BPS, 4).holeMs <= 2, 'the first try is the shortest one')
  const plan = planSeam(tail, head, BPS, 4)
  assert.equal(plan.mix, 'edges')
  assert.equal(plan.overlapBytes, bytesForMs(2.5 * 1.5, BPS, 4), `not the ${first} bytes with the click in its middle`)
})

test('planSeam: a sum has to leave the whole overlap clean, not only its middle', () => {
  // 12 ms of padding, and a gap in the music itself a little way into the head: the sum that
  // closes the padding still has that gap in it, off to one side of its middle.
  const tail = eightSeconds(() => 1, 166), head = eightSeconds(() => 1, 167)
  tail.fill(0, tail.length - frameCount(12) * 4)
  head.fill(0, frameCount(8) * 4, frameCount(11) * 4)
  const seen = measurePlainJoin(tail, head, 0, BPS, 4).holeMs
  assert.ok(seen > 11 && seen < 13, `${seen}`)
  // So the first try isn't used. One long enough to lay the old song's music over the gap is.
  assert.ok(ms(planSeam(tail, head, BPS, 4).overlapBytes) > 20)
})

test('planSeam: a side no longer than the overlap it needs has nothing to meet', () => {
  // Nothing real is this short (the merge holds 8 s back), but the arithmetic has to hold.
  const padded = (msLong: number, msZero: number, seed: number): Buffer => {
    const b = room(msLong / 1000, 0.1, () => 1, seed)
    b.fill(0, b.length - frameCount(msZero) * 4)
    return b
  }
  const zeroedHead = eightSeconds(() => 1, 169)
  zeroedHead.fill(0, 0, frameCount(18) * 4)
  assert.notEqual(planSeam(room(1, 0.1, () => 1, 168).subarray(0, 684 * 4), zeroedHead, BPS, 4).mix, 'edges', 'the tail is all overlap')
  assert.notEqual(planSeam(padded(8000, 18, 171), room(1, 0.1, () => 1, 170).subarray(0, 695 * 4), BPS, 4).mix, 'edges', 'the head is all overlap')
  for (const [t, h] of [[0, 0], [1, 1], [10, 8000], [8000, 10], [99, 99]]) {
    const plan = planSeam(room(t / 1000, 0.1, () => 1, 172), room(h / 1000, 0.1, () => 1, 173), BPS, 4)
    assert.equal(plan.overlapBytes % 4, 0, `${t} and ${h} ms`)
    assert.ok(plan.cueBytes >= 0 && plan.cueBytes <= plan.overlapBytes, `${t} and ${h} ms`)
  }
})

test('planSeam: a sum that would clip is not used', () => {
  // Such Great Heights 3:07: two loud edges, 1 ms soft, summed where both are still up.
  const loud = (seed: number): Buffer => {
    const noise = eightSeconds(() => 1, seed, 0.25)
    for (let i = 0; i < noise.length / 4; i++) {
      const v = 0.8 * 32767 * Math.sin((2 * Math.PI * 60 * i) / 44100)
      for (let c = 0; c < 2; c++) noise.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(noise.readInt16LE(i * 4 + c * 2) + v))), i * 4 + c * 2)
    }
    return noise
  }
  // Both at a crest of the same 60 Hz wave.
  const crest = Math.round(44100 / 240)
  const tail = softEdge(loud(146).subarray(0, (8 * 735 * 60 + crest) * 4), 44, true)
  const head = softEdge(loud(147).subarray((735 + crest) * 4 - 44 * 4), 44, false)
  const clipsAt = (bytes: number): number => {
    const sum = mixEdges(tail.subarray(tail.length - bytes), head.subarray(0, bytes), 4, false)
    let clipped = 0
    for (let i = 0; i < bytes; i += 2) if (Math.abs(sum.readInt16LE(i)) >= 32767) clipped++
    return clipped
  }
  const first = bytesForMs(2.5, BPS, 4)
  assert.ok(clipsAt(first) > 0, 'the first try clips')
  assert.ok(measurePlainJoin(tail, head, 0, BPS, 4).holeMs <= 2, 'and there is a hole for it to close')
  const plan = planSeam(tail, head, BPS, 4)
  assert.notEqual(plan.overlapBytes, first)
  assert.ok(plan.mix === 'ramp' || clipsAt(plan.overlapBytes) === 0, `${plan.mix} ${plan.overlapBytes}`)
})

/** A slow wave with its level pulled down around one moment, smoothly, so there's no step in it. */
function dippedWave(frames: number, offset: number, dipAt: number): Buffer {
  const b = Buffer.alloc(frames * 4)
  for (let i = 0; i < frames; i++) {
    const t = (i + offset - dipAt) / 44.1   // ms from the dip
    const dip = Math.abs(t) > 6 ? 1 : (1 - Math.cos((Math.PI * t) / 6)) / 2
    const v = Math.round(9000 * dip * Math.sin((2 * Math.PI * 170 * (i + offset)) / 44100 + 0.9))
    b.writeInt16LE(v, i * 4); b.writeInt16LE(v, i * 4 + 2)
  }
  return b
}

test('planSeam: a natural dip at the cut doesn\'t get a sum: its ends would step', () => {
  // Taxes 0:28. The audio is continuous, so a plain join has no step at all. The dip is just
  // before the cut, so the head is back up where the sum would start.
  const n = 8 * 44100
  const tail = dippedWave(n, 0, n - 30), head = dippedWave(n, n, n - 30)
  const f = measurePlainJoin(tail, head, 0, BPS, 4)
  assert.ok(f.holeMs > 0, `it reads as a hole: ${f.holeMs}`)
  assert.notEqual(planSeam(tail, head, BPS, 4).mix, 'edges')
})

test('planSeam: padding and then a hard start is a step either way, so the sum is no worse', () => {
  // A slow wave at a crest makes the head's first sample far bigger than the music's own slope.
  const wave = (i0: number, n: number): Buffer => {
    const b = Buffer.alloc(n * 4)
    for (let i = 0; i < n; i++) {
      const v = Math.round(0.3 * 32767 * Math.cos((2 * Math.PI * 50 * (i0 + i)) / 44100))
      b.writeInt16LE(v, i * 4); b.writeInt16LE(v, i * 4 + 2)
    }
    return b
  }
  const noisy = Buffer.alloc(8 * 44100 * 4)
  const a = room(8, 0.03, () => 1, 148), b = wave(0, 8 * 44100)
  for (let i = 0; i < noisy.length; i += 2) noisy.writeInt16LE(a.readInt16LE(i) + b.readInt16LE(i), i)
  const tail = Buffer.from(noisy)
  tail.fill(0, tail.length - 200 * 4)   // 4.5 ms of padding
  const plan = planSeam(tail, noisy, BPS, 4)
  assert.equal(plan.mix, 'edges')
})

test('planSeam: an end no steeper than the steepest step beside the overlap is fine, out to 20 ms and no further', () => {
  // The same dip as Taxes, with a real transient near it that's steeper than the sum's ends.
  const n = 8 * 44100
  const first = bytesForMs(Math.max(2.5, measurePlainJoin(dippedWave(n, 0, n - 30), dippedWave(n, n, n - 30), 0, BPS, 4).holeMs + 0.5), BPS, 4)
  const spiked = (inTail: boolean, msAway: number): SeamPlan => {
    const tail = dippedWave(n, 0, n - 30), head = dippedWave(n, n, n - 30)
    if (inTail) nudge(tail, n - frameCount(msAway), 12000)
    else nudge(head, frameCount(msAway), 12000)
    return planSeam(tail, head, BPS, 4)
  }
  for (const inTail of [true, false]) {
    const near = spiked(inTail, 14)
    assert.equal(near.mix, 'edges', `14 ms away, ${inTail ? 'tail' : 'head'}`)
    assert.equal(near.overlapBytes, first, 'at the first try')
    assert.notEqual(spiked(inTail, 70).mix, 'edges', `70 ms away, past where the longest try reads, ${inTail ? 'tail' : 'head'}`)
  }
})

test('planSeam: the quieter side can be silent, the louder side still counts', () => {
  // A tail cut on a crest into silence: 8230 LSB, 87 times the slope. It used to pass as nobody can hear it.
  const wave = tone(8, 0.25, () => 1, 80)
  const crest = Math.floor((wave.length / 4 - 1) / 551.25) * 551.25 + 138
  const tail = Buffer.from(wave.subarray(0, Math.round(crest) * 4))
  const head = levelled((t) => (t < 0.3 ? 0 : db(-15)), 149)
  assert.ok(measurePlainJoin(tail, head, 0, BPS, 4).jumpOverSlope > 20, 'the step is there')
  assert.equal(planSeam(tail, head, BPS, 4).mix, 'ramp')
  // And a fault nothing can close says so, with the other side all but silent: the same 40 ms gap, and a room at -75 dBFS.
  const quietTail = room(8, 0.03, () => 1, 150)
  quietTail.fill(0, quietTail.length - 882 * 4)
  const quietHead = openingWith(levelled(() => db(-75), 151), Buffer.alloc(882 * 4))
  const left = planSeam(quietTail, quietHead, BPS, 4)
  assert.equal(left.mix, 'none')
  assert.ok(left.unclosed && left.unclosed.holeMs > 0, 'it says so')
})

test('planSeam: edges at -60 dBFS are quiet, not silent: they close', () => {
  const tail = softEdge(eightSeconds(() => 1, 152, db(-60)), 77, true)
  const head = softEdge(eightSeconds(() => 1, 153, db(-60)), 88, false)
  assert.equal(planSeam(tail, head, BPS, 4).mix, 'edges')
})

test('planSeam: a step of 1.3 x the slope is left alone, and of 2 x gets the ramp', () => {
  const withStep = (k: number): Buffer[] => {
    const { tail, head } = splitWave()
    const shifted = Buffer.alloc(head.length)
    const by = Math.round(70 * (k - 1))
    for (let i = 0; i < head.length; i += 2) shifted.writeInt16LE(head.readInt16LE(i) + by, i)
    return [tail, shifted]
  }
  const [a, b] = withStep(1.3), [c, d] = withStep(2)
  assert.ok(Math.abs(measurePlainJoin(a, b, 0, BPS, 4).jumpOverSlope - 1.3) < 0.05, 'the first is 1.3 x')
  assert.ok(Math.abs(measurePlainJoin(c, d, 0, BPS, 4).jumpOverSlope - 2) < 0.05, 'the second is 2 x')
  assert.equal(planSeam(a, b, BPS, 4).mix, 'none')
  assert.equal(planSeam(c, d, BPS, 4).mix, 'ramp')
})

// ── What's left open says so ──

test('planSeam: silence the hole reader can\'t see stays as it is, and says so', () => {
  const tail = eightSeconds(() => 1, 154), head = eightSeconds(() => 1, 155)
  for (const gap of [46, 60, 100, 300, 550]) {
    const inTail = Buffer.from(tail), inHead = Buffer.from(head)
    inTail.fill(0, inTail.length - frameCount(gap) * 4)
    inHead.fill(0, 0, frameCount(gap) * 4)
    const a = planSeam(inTail, head, BPS, 4), b = planSeam(tail, inHead, BPS, 4)
    assert.equal(measurePlainJoin(inTail, head, 0, BPS, 4).holeMs, 0, `the reader can't see ${gap} ms`)
    assert.ok(a.openGapMs !== undefined && Math.abs(a.openGapMs - gap) <= 1, `${gap} ms in the tail: ${a.openGapMs}`)
    assert.ok(b.openGapMs !== undefined && Math.abs(b.openGapMs - gap) <= 1, `${gap} ms in the head: ${b.openGapMs}`)
    assert.notEqual(a.mix, 'fade')
    assert.notEqual(b.mix, 'fade')
    assert.equal(a.mix === 'edges' || b.mix === 'edges', false, 'nothing closes it')
  }
})

test('planSeam: a gap of near silence is the same blind spot as a gap of zeros', () => {
  const tail = endingIn(eightSeconds(() => 1, 181), hiss(frameCount(60), -80, 182))
  assert.equal(measurePlainJoin(tail, eightSeconds(() => 1, 183), 0, BPS, 4).holeMs, 0)
  const plan = planSeam(tail, eightSeconds(() => 1, 183), BPS, 4)
  assert.ok(plan.openGapMs !== undefined && Math.abs(plan.openGapMs - 60) <= 1, `${plan.openGapMs}`)
})

test('planSeam: a join closed or ramped doesn\'t also say it couldn\'t be', () => {
  const closed = planSeam(softEdge(eightSeconds(() => 1, 184), 77, true), softEdge(eightSeconds(() => 1, 185), 88, false), BPS, 4)
  assert.equal(closed.mix, 'edges')
  assert.equal(closed.unclosed, undefined)
})

test('planSeam: no log line for a gap the reader can see, or a pause, or one nobody can hear', () => {
  const tail = eightSeconds(() => 1, 156), head = eightSeconds(() => 1, 157)
  const seen = Buffer.from(tail)
  seen.fill(0, seen.length - frameCount(40) * 4)
  const a = planSeam(seen, head, BPS, 4)
  assert.equal(a.openGapMs, undefined, '40 ms is read as a hole')
  assert.ok(a.unclosed, 'and says so itself')
  const pause = planSeam(tail, levelled((t) => (t < 1 ? 0 : db(-20)), 158), BPS, 4)
  assert.equal(pause.openGapMs, undefined, 'a pause, kept on purpose')
  const zeroEnd = Buffer.from(tail), zeroStart = Buffer.from(head)
  zeroEnd.fill(0, zeroEnd.length - frameCount(300) * 4)
  zeroStart.fill(0, 0, frameCount(300) * 4)
  assert.equal(planSeam(zeroEnd, zeroStart, BPS, 4).openGapMs, undefined, 'nothing near the cut to hear it against')
})

test('planSeam: edges nobody can hear keep their bits', () => {
  const tail = softEdge(eightSeconds(() => 1, 28, 0.0001), 77, true)
  const head = softEdge(eightSeconds(() => 1, 29, 0.0001), 88, false)
  assert.ok(measurePlainJoin(tail, head, 0, BPS, 4).holeMs > 0, 'the notch is there')
  assert.deepEqual(planSeam(tail, head, BPS, 4), { mix: 'none', overlapBytes: 0, cueBytes: 0 })
})

test('planSeam: a step gets a 2.5 ms ramp, not a crossfade of seconds', () => {
  const crest = (frames: number): number => Math.floor((frames - 1) / 882) * 882 + 220
  const wave = tone(8, 0.3, () => 1, 50)
  const tail = Buffer.from(wave.subarray(0, crest(wave.length / 4) * 4))
  const head = tone(8, 0.3, () => 1, 50)
  const plan = planSeam(tail, head, BPS, 4)
  assert.equal(plan.mix, 'ramp')
  assert.equal(plan.overlapBytes, bytesForMs(2.5, BPS, 4))
  const after = joined(tail, head, plan.overlapBytes, true)
  assert.ok(measurePlainJoin(after.tail, after.head, 0, BPS, 4).jumpOverSlope < 1.5)
})

test('planSeam: a step where the fades ask for an overlap gets the same 2.5 ms', () => {
  // Cameron 0:40:41 and Unplugged 0:26:39: a failed step gate used to answer with 4 s.
  const fall = (t: number): number => (t < 5 ? 1 : t > 6.5 ? 0.2 : 1 - 0.8 * ((t - 5) / 1.5))
  const wave = tone(8, 0.3, (p) => fall(p * 8), 50)
  const crest = Math.floor((wave.length / 4 - 1) / 882) * 882 + 220
  const tail = Buffer.from(wave.subarray(0, crest * 4))
  const head = tone(8, 0.06, () => 1, 50)
  assert.ok(seamOverlapMs(rmsEnvelope(tail, BPS), rmsEnvelope(head, BPS)) > 0, 'the fades ask')
  assert.ok(measurePlainJoin(tail, head, 0, BPS, 4).jumpOverSlope >= 1.5, 'the step is there')
  const plan = planSeam(tail, head, BPS, 4)
  assert.equal(plan.mix, 'ramp')
  assert.equal(plan.overlapBytes, bytesForMs(2.5, BPS, 4))
})

test('mixEdges: summed, each side untouched; ramped, each side to nothing across the overlap', () => {
  const frames = 110
  const tail = Buffer.alloc(frames * 4), head = Buffer.alloc(frames * 4)
  for (let f = 0; f < frames; f++) for (let c = 0; c < 2; c++) { tail.writeInt16LE(10000, f * 4 + c * 2); head.writeInt16LE(-4000, f * 4 + c * 2) }
  const summed = mixEdges(tail, head, 4, false)
  assert.equal(summed.readInt16LE(0), 6000)
  assert.equal(summed.readInt16LE(frames * 4 - 2), 6000)
  const ramped = mixEdges(tail, head, 4, true)
  assert.ok(Math.abs(ramped.readInt16LE(0) - 10000) < 100, `starts on the tail: ${ramped.readInt16LE(0)}`)
  assert.ok(Math.abs(ramped.readInt16LE(frames * 4 - 4) - -4000) < 100, `ends on the head: ${ramped.readInt16LE(frames * 4 - 4)}`)
  assert.ok(Math.abs(ramped.readInt16LE(55 * 4) - 3000) < 100, `half and half in the middle: ${ramped.readInt16LE(55 * 4)}`)
})

// ── Where the marker goes ──

test('crossoverBytes: even fades cross near the middle', () => {
  const tail = room(4, 0.1, (t) => 1 - t / 4, 30), head = room(4, 0.1, (t) => t / 4, 31)
  const at = ms(crossoverBytes(tail, head, BPS, 4))
  assert.ok(at >= 1600 && at <= 2400, `${at} ms`)
})

test('crossoverBytes: the next song louder from the first moment takes the marker to the start', () => {
  // Whole Lotta Love into The Ocean: the tail is 12 dB under the head all the way.
  const tail = room(4, 0.05, (t) => 1 - t / 4, 32), head = room(4, 0.2, () => 1, 33)
  assert.equal(crossoverBytes(tail, head, BPS, 4), 0)
})

test('crossoverBytes: the old song on top until nearly the end holds the marker back', () => {
  // The Rain Song into Dazed And Confused: on top for 2.8 s of 2.9 s.
  const tail = room(2.9, 0.1, () => 1, 34), head = room(2.9, 0.1, (t) => (t < 2.8 ? 0.05 : 2), 35)
  assert.equal(ms(crossoverBytes(tail, head, BPS, 4)), 2800)
})

test('crossoverBytes: the old song only just ahead is still ahead', () => {
  // No slack toward early: a marker that flips early is the complaint.
  const tail = room(4, 0.1, () => 1, 62), head = room(4, 0.1, (t) => (t < 2 ? 0.8 : 2), 63)
  assert.equal(ms(crossoverBytes(tail, head, BPS, 4)), 2000)
})

test('crossoverBytes: a late blip of the old song still counts, and the marker is whole frames', () => {
  const tail = room(4, 0.1, (t) => (t < 1 ? 1 : t > 3 && t < 3.2 ? 3 : 0.1), 36), head = room(4, 0.1, () => 1, 37)
  const at = crossoverBytes(tail, head, BPS, 4)
  assert.equal(ms(at), 3200)
  assert.equal(at % 4, 0)
})

test('crossoverBytes: a tie goes to the next song', () => {
  const same = room(4, 0.1, () => 1, 161)
  assert.equal(crossoverBytes(same, same, BPS, 4), 0)
})

test('crossoverBytes: -50 dBFS is quiet but it has a where, -80 dBFS doesn\'t', () => {
  const late = (level: number, seedA: number, seedB: number): number => {
    const tail = room(4, 1, (t) => db(t < 3.5 ? level : level - 12), seedA), head = room(4, 1, (t) => db(t < 3.5 ? level - 12 : level), seedB)
    return ms(crossoverBytes(tail, head, BPS, 4))
  }
  assert.equal(late(-50, 162, 163), 3500)
  assert.equal(late(-80, 164, 165), 2000)
})

test('crossoverBytes: nothing to hear on either side, the middle', () => {
  const quiet = room(4, 0.00001, () => 1, 38)
  assert.equal(crossoverBytes(quiet, room(4, 0.00001, () => 1, 39), BPS, 4), bytesForMs(2000, BPS, 4))
  assert.equal(crossoverBytes(Buffer.alloc(BPS * 4), Buffer.alloc(BPS * 4), BPS, 4), bytesForMs(2000, BPS, 4))
})

test('planSeam: the marker comes from the levels, not the middle', () => {
  // A tail faded to nothing under a hard start: the audit's Zeppelin 2:06:31.
  const plan = planSeam(eightSeconds((t) => (t < 4.5 ? 1 : t > 7.5 ? 0 : (7.5 - t) / 3), 54, 0.05), eightSeconds(() => 1, 55, 0.2), BPS, 4)
  assert.equal(plan.mix, 'fade')
  assert.equal(plan.cueBytes, 0)
})
