import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmsEnvelope, tailFadeMs, headFadeMs, seamOverlapMs, overlapAdd, bytesForMs, mixSeam, bufferRmsDb } from '../live-set-seams.ts'

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
