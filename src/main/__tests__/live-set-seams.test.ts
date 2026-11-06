import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { rmsEnvelope, tailFadeMs, headFadeMs, seamOverlapMs, seamOverlapBytes, measurePlainJoin, plainJoinIsClean, overlapAdd, bytesForMs, mixSeam, bufferRmsDb } from '../live-set-seams.ts'

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

// ── The overlap rule (2026-11-06) ──────────────────────────────────────────

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
const clean = { tailDb: -30, headDb: -30, holeMs: 0, jumpOverSlope: 0.3, dipDb: 5 }
const eightSeconds = (fn: (t: number) => number, seed: number, amp = 0.1): Buffer => room(8, amp, fn, seed)

test('plainJoinIsClean: each gate alone refuses, at the audit\'s thresholds', () => {
  assert.equal(plainJoinIsClean(clean), true)
  assert.equal(plainJoinIsClean({ ...clean, tailDb: -60 }), false, 'tail at the floor')
  assert.equal(plainJoinIsClean({ ...clean, tailDb: -59.9 }), true)
  assert.equal(plainJoinIsClean({ ...clean, headDb: -60 }), false, 'head at the floor')
  assert.equal(plainJoinIsClean({ ...clean, holeMs: 2.01 }), false, 'a hole')
  assert.equal(plainJoinIsClean({ ...clean, holeMs: 2 }), true)
  assert.equal(plainJoinIsClean({ ...clean, jumpOverSlope: 1.5 }), false, 'a step')
  assert.equal(plainJoinIsClean({ ...clean, jumpOverSlope: 1.49 }), true)
  assert.equal(plainJoinIsClean({ ...clean, dipDb: 25 }), false, 'a deep dip')
  assert.equal(plainJoinIsClean({ ...clean, dipDb: 24.9 }), true)
})

test('plainJoinIsClean on the audit\'s measurements: 24 of 83 crossfades were never needed', () => {
  const seams = JSON.parse(readFileSync(new URL('./fixtures/live-set-seams-audit-2026-11-05.json', import.meta.url), 'utf8')) as Array<{ show: string; seam: number; plain: boolean; tailDb: number; headDb: number; holeMs: number; jumpOverSlope: number; dipDb: number }>
  assert.equal(seams.length, 83)
  for (const s of seams) assert.equal(plainJoinIsClean(s), s.plain, `${s.show} seam ${s.seam}`)
  assert.equal(seams.filter((s) => s.plain).length, 24)
})

test('measurePlainJoin reads the levels either side of the cut', () => {
  const f = measurePlainJoin(room(8, 0.1, () => 1, 2), room(8, 0.01, () => 1, 3), 0, BPS, 4)
  assert.ok(Math.abs(f.tailDb - -20) < 1.5, `tail ${f.tailDb}`)
  assert.ok(Math.abs(f.headDb - -40) < 1.5, `head ${f.headDb}`)
  assert.equal(f.holeMs, 0)
  assert.ok(f.jumpOverSlope < 1.5, `jump ${f.jumpOverSlope}`)
  assert.ok(Math.abs(f.dipDb) < 1.5, `dip ${f.dipDb}`)
})

test('measurePlainJoin finds a hole left at the cut, and sizes it', () => {
  const tail = room(8, 0.1, () => 1, 4)
  tail.fill(0, tail.length - 882 * 4)   // 20 ms of nothing, like AAC padding
  const f = measurePlainJoin(tail, room(8, 0.1, () => 1, 5), 0, BPS, 4)
  assert.ok(f.holeMs > 15 && f.holeMs < 25, `hole ${f.holeMs} ms`)
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

test('seamOverlapBytes: a 12 dB drop that stays in the room gets no overlap', () => {
  const tail = eightSeconds((t) => (t < 5 ? 1 : t > 6.5 ? 0.2 : 1 - 0.8 * ((t - 5) / 1.5)), 9)
  const head = eightSeconds(() => 1, 10)
  assert.ok(seamOverlapMs(rmsEnvelope(tail, BPS), rmsEnvelope(head, BPS)) > 0, 'the fades alone would overlap')
  assert.equal(seamOverlapBytes(tail, head, BPS, 4), 0)
})

test('seamOverlapBytes: fades down to nothing keep their overlap, in whole frames', () => {
  const tail = eightSeconds((t) => (t < 4.5 ? 1 : t > 7.5 ? 0 : (7.5 - t) / 3), 11)
  const head = eightSeconds((t) => (t > 3.5 ? 1 : t < 0.5 ? 0 : (t - 0.5) / 3), 12)
  const o = seamOverlapBytes(tail, head, BPS, 4)
  assert.ok(o >= bytesForMs(600, BPS, 4) && o <= bytesForMs(4000, BPS, 4), `overlap ${o}`)
  assert.equal(o % 4, 0)
})

test('seamOverlapBytes: one side at the floor keeps the overlap, the other side\'s level doesn\'t rescue it', () => {
  // The audit's "tail ends hard, head fades in": the head starts from nothing.
  const tail = eightSeconds(() => 1, 13)
  const head = eightSeconds((t) => (t > 3.5 ? 1 : t < 0.5 ? 0 : (t - 0.5) / 3), 14)
  assert.ok(seamOverlapBytes(tail, head, BPS, 4) > 0)
})

test('seamOverlapBytes: no fades, no overlap, without measuring anything else', () => {
  const flat = eightSeconds(() => 1, 15)
  assert.equal(seamOverlapBytes(flat, eightSeconds(() => 1, 16), BPS, 4), 0)
})
