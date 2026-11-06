import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { rmsEnvelope, tailFadeMs, headFadeMs, seamOverlapMs, planSeam, measurePlainJoin, fadeIsReal, crossoverBytes, mixEdges, overlapAdd, bytesForMs, mixSeam, bufferRmsDb, type JoinFacts } from '../live-set-seams.ts'

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

test('headArrivesMs: when the next song is within 10 dB of its body', () => {
  const at = (fn: (t: number) => number, seed: number): number | null => measurePlainJoin(eightSeconds(() => 1, 8), eightSeconds(fn, seed), 0, BPS, 4).headArrivesMs
  assert.equal(at(() => 1, 9), 0, 'there from the first moment')
  assert.equal(at((t) => (t < 0.3 ? db(-30) : 1), 10), 300, 'a room, then in hard')
  const slow = at(fadesIn(40), 11)
  assert.ok(slow !== null && slow > 2500 && slow < 3500, `a slow fade-in gets there late: ${slow}`)
  // A song that opens loud and later falls quiet: its second half alone would call the room "there".
  const f = measurePlainJoin(eightSeconds(() => 1, 8), eightSeconds((t) => (t < 1.5 ? db(-30) : t < 3.5 ? 1 : db(-25)), 12), bytesForMs(1000, BPS, 4), BPS, 4)
  assert.equal(f.headArrivesMs, 1500)
})

// ── Were the fades real? ──

const room30: JoinFacts = { tailDb: -30, headDb: -30, holeMs: 0, jumpOverSlope: 0.3, dipDb: 5, headArrivesMs: 3000 }

test('fadeIsReal: both sides in the room, nothing deep: no', () => {
  assert.equal(fadeIsReal(room30), false)
})

test('fadeIsReal: a side at the floor at the cut', () => {
  assert.equal(fadeIsReal({ ...room30, tailDb: -60 }), true, 'tail')
  assert.equal(fadeIsReal({ ...room30, tailDb: -59.9, headDb: -59.9 }), false)
  assert.equal(fadeIsReal({ ...room30, tailDb: -55, headDb: -60 }), true, 'head')
  assert.equal(fadeIsReal({ ...room30, tailDb: -55, headDb: -59.9 }), false)
  assert.equal(fadeIsReal({ ...room30, tailDb: -60, headArrivesMs: 0 }), true, 'an arriving song does not rescue it')
})

test('fadeIsReal: a tail far above the head, which is a cliff', () => {
  assert.equal(fadeIsReal({ ...room30, headDb: -40.1 }), true)
  assert.equal(fadeIsReal({ ...room30, headDb: -40 }), false)
  assert.equal(fadeIsReal({ ...room30, headDb: -40.1, headArrivesMs: 100 }), true, 'an arriving song does not rescue it')
})

test('fadeIsReal: a deep dip only counts when the next song is not already coming in', () => {
  assert.equal(fadeIsReal({ ...room30, dipDb: 25 }), true)
  assert.equal(fadeIsReal({ ...room30, dipDb: 24.9 }), false)
  assert.equal(fadeIsReal({ ...room30, dipDb: 40, headArrivesMs: 1000 }), false, 'in hard within a second')
  assert.equal(fadeIsReal({ ...room30, dipDb: 40, headArrivesMs: 1100 }), true, 'not yet')
  assert.equal(fadeIsReal({ ...room30, dipDb: 40, headArrivesMs: null }), true, 'never seen to arrive')
})

test('fadeIsReal: a tail that fell to well under the room the head opens in', () => {
  const under = { ...room30, tailDb: -40, headDb: -34, dipDb: 12 }
  assert.equal(fadeIsReal(under), true)
  assert.equal(fadeIsReal({ ...under, tailDb: -39.9 }), false, 'not far enough under')
  assert.equal(fadeIsReal({ ...under, dipDb: 11.9 }), false, 'it never came down from anywhere: a quiet tail, not a fade')
  assert.equal(fadeIsReal({ ...under, headArrivesMs: 600 }), false, 'the head is the next song, not a room')
})

test('every seam of the 13 shows, measured: 61 overlaps, 20 closed by their edges, 3 ramped, 97 plain', () => {
  // The engine's own measures, from homemini's local sources, 2026-11-06.
  // Against the blip audit's list of 24 false crossfades out of 83, two differ, on
  // purpose. Geese, Alive 3 is a real album fade (src/main/live-set-seams.ts). Cameron 8
  // was kept only for a step of 1.96 x the slope, which now has a 2.5 ms answer.
  const seams = JSON.parse(readFileSync(new URL('./fixtures/live-set-seams-13-shows-2026-11-06.json', import.meta.url), 'utf8')) as Array<JoinFacts & { show: string; seam: number; fadeMs: number; mix: string }>
  assert.equal(seams.length, 181)
  for (const s of seams) assert.equal(s.fadeMs > 0 && fadeIsReal(s), s.mix === 'fade', `${s.show} seam ${s.seam}`)
  const count = (mix: string): number => seams.filter((s) => s.mix === mix).length
  assert.deepEqual([count('fade'), count('edges'), count('ramp'), count('none')], [61, 20, 3, 97])
  const mixOf = (show: string, seam: number): string | undefined => seams.find((s) => s.show === show && s.seam === seam)?.mix
  assert.equal(mixOf('unplugged', 3), 'none', 'Unplugged 0:12:28: the tape runs through, then the band comes in')
  assert.equal(mixOf('unplugged', 4), 'none', 'Unplugged 0:16:49: the same')
  assert.equal(mixOf('unplugged', 1), 'ramp', 'Unplugged 0:03:37: the -20.9 dBFS step')
  assert.equal(mixOf('amsterdam', 9), 'fade', 'Amsterdam 0:27:04: falls to -75 dBFS, no room does that')
  assert.equal(mixOf('geese-alive', 3), 'fade', 'Geese, Alive 0:12:37: a real album fade')
  assert.equal(mixOf('nassau', 15), 'edges', 'Nassau 1:47:26: a soft start, not a 2.1 s crossfade')
  assert.equal(seams.filter((s) => s.show === 'nassau' && s.mix === 'edges').length, 20)
})

// ── planSeam ──

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
