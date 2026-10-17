import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { pitchSemitonesFromEnv, pitchFilter, speedFromEnv } from '../voice-pitch.ts'

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

describe('Music Man pace (MUSIC_MAN_SPEED)', () => {
  const parse = (af: string) => ({
    f: Number(/asetrate=\d+\*([0-9.]+)/.exec(af)?.[1] ?? 1),
    t: Number(/atempo=([0-9.]+)/.exec(af)?.[1] ?? 1),
  })
  it('reads the .env value; absent/garbage = 1; clamped to [0.8, 1.2]', () => {
    assert.equal(speedFromEnv(undefined), 1)
    assert.equal(speedFromEnv('fast'), 1)
    assert.equal(speedFromEnv('0.961'), 0.961)
    assert.equal(speedFromEnv('0.5'), 0.8)
  })
  it("Jake's in-between: -1.4 semitones at 0.961 speed (asetrate f × atempo = speed)", () => {
    const { f, t } = parse(pitchFilter(-1.4, 44100, 0.961)!)
    assert.ok(Math.abs(f - 2 ** (-1.4 / 12)) < 1e-6)
    assert.ok(Math.abs(f * t - 0.961) < 1e-5)
  })
  it('tape-style: speed = pitch factor → no atempo stage at all', () => {
    const f = 2 ** (-1.4 / 12)
    const af = pitchFilter(-1.4, 44100, f)!
    assert.doesNotMatch(af, /atempo/)
  })
  it('speed only (0 semitones): atempo alone', () => {
    assert.equal(pitchFilter(0, 44100, 0.95), 'atempo=0.950000')
    assert.equal(pitchFilter(0, 44100, 1), null)
  })
})
