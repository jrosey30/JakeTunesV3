import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmsEnvelope, tailFadeMs, headFadeMs, seamOverlapMs, overlapAdd, bytesForMs } from '../live-set-seams.ts'

const BPS = 44100 * 2 * 2
function tone(seconds: number, amp: number, gain: (t: number) => number = () => 1): Buffer {
  const frames = Math.floor(44100 * seconds)
  const b = Buffer.alloc(frames * 4)
  for (let i = 0; i < frames; i++) {
    const t = i / 44100
    const v = Math.round(amp * gain(t / seconds) * 32767 * Math.sin(2 * Math.PI * 220 * t))
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
