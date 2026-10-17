import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { pitchSemitonesFromEnv, pitchFilter } from '../voice-pitch.ts'

describe('Music Man voice pitch', () => {
  it('reads the .env value; absent/0/garbage = untouched; clamped to ±6', () => {
    assert.equal(pitchSemitonesFromEnv(undefined), 0)
    assert.equal(pitchSemitonesFromEnv(''), 0)
    assert.equal(pitchSemitonesFromEnv('0'), 0)
    assert.equal(pitchSemitonesFromEnv('deeper'), 0)
    assert.equal(pitchSemitonesFromEnv(' -1.5 '), -1.5)
    assert.equal(pitchSemitonesFromEnv('-40'), -6)
  })
  it('lowers pitch at constant speed: asetrate × f, atempo × 1/f (they cancel in duration)', () => {
    const af = pitchFilter(-1.5, 44100)!
    const f = Number(/asetrate=44100\*([0-9.]+)/.exec(af)![1])
    const t = Number(/atempo=([0-9.]+)/.exec(af)![1])
    assert.ok(Math.abs(f - 2 ** (-1.5 / 12)) < 1e-6)
    assert.ok(Math.abs(f * t - 1) < 1e-5, 'speed preserved')
    assert.match(af, /aresample=44100/)
  })
  it('no-op for 0 semitones or an unknown sample rate', () => {
    assert.equal(pitchFilter(0, 44100), null)
    assert.equal(pitchFilter(-1.5, NaN), null)
  })
})
