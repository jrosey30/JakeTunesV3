/**
 * Encoder-delay / padding parsers for gapless playback.
 * Pure parse tests plus an optional ffmpeg-generated MP3 (LAME tag).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseSMPB,
  parseLameGapless,
  toGaplessTrim,
  isSaneTrimSamples,
  readGaplessTrim,
} from '../gapless-trim.ts'

describe('parseSMPB (iTunSMPB)', () => {
  it('reads delay, padding, and original sample count from the canonical hex string', () => {
    // Jake's measured AAC-LC: delay 0x840 = 2112, padding 0xCE = 206.
    const parsed = parseSMPB(' 00000000 00000840 000000CE 00000000002CB2D4 00000000 00000000')
    assert.ok(parsed)
    assert.equal(parsed.delaySamples, 2112)
    assert.equal(parsed.paddingSamples, 206)
    assert.equal(parsed.originalSamples, 0x2CB2D4)
  })

  it('accepts padding-only tags (delay 0) so tail trim can still fire', () => {
    const parsed = parseSMPB('00000000 00000000 00000064 0000000000001000')
    assert.ok(parsed)
    assert.equal(parsed.delaySamples, 0)
    assert.equal(parsed.paddingSamples, 0x64)
  })

  it('rejects truncated or non-hex strings', () => {
    assert.equal(parseSMPB(''), null)
    assert.equal(parseSMPB('00000000 00000840'), null)
    assert.equal(parseSMPB('not a tag'), null)
  })
})

describe('toGaplessTrim sanity gates', () => {
  it('converts 2112/206 at 44100 into seconds', () => {
    const t = toGaplessTrim({ delaySamples: 2112, paddingSamples: 206, originalSamples: 0 }, 44100)
    assert.ok(t)
    assert.ok(Math.abs(t.delaySec - 2112 / 44100) < 1e-12)
    assert.ok(Math.abs(t.paddingSec - 206 / 44100) < 1e-12)
    assert.equal(t.sampleRate, 44100)
  })

  it('accepts delay-only and padding-only', () => {
    assert.ok(toGaplessTrim({ delaySamples: 2112, paddingSamples: 0, originalSamples: 0 }, 44100))
    assert.ok(toGaplessTrim({ delaySamples: 0, paddingSamples: 400, originalSamples: 0 }, 44100))
  })

  it('refuses both-zero and half-second-plus misreads', () => {
    assert.equal(toGaplessTrim({ delaySamples: 0, paddingSamples: 0, originalSamples: 0 }, 44100), null)
    assert.equal(toGaplessTrim({ delaySamples: 44100, paddingSamples: 0, originalSamples: 0 }, 44100), null)
    assert.equal(toGaplessTrim({ delaySamples: 0, paddingSamples: 30000, originalSamples: 0 }, 44100), null)
  })

  it('isSaneTrimSamples matches the half-second cap', () => {
    assert.equal(isSaneTrimSamples(2112, 44100), true)
    assert.equal(isSaneTrimSamples(0, 44100), true)
    assert.equal(isSaneTrimSamples(22050, 44100), false)
    assert.equal(isSaneTrimSamples(-1, 44100), false)
  })
})

/** MPEG1 Layer III stereo header + Xing/Info + LAME extra with known delay/pad. */
function lameInfoFrame(delay: number, padding: number): Uint8Array {
  const frame = Buffer.alloc(256, 0)
  frame[0] = 0xff
  frame[1] = 0xfb
  frame[2] = 0x90
  frame[3] = 0x00
  frame.write('Info', 36)
  frame[36 + 7] = 0x03 // frames + bytes flags
  const lameOff = 36 + 8 + 8 // 8 flag payload bytes
  frame.write('LAME3.100', lameOff)
  const delayPadOff = lameOff + 0x15
  frame[delayPadOff] = (delay >> 4) & 0xff
  frame[delayPadOff + 1] = ((delay & 0x0f) << 4) | ((padding >> 8) & 0x0f)
  frame[delayPadOff + 2] = padding & 0xff
  return new Uint8Array(frame)
}

describe('parseLameGapless (MP3 Info tag)', () => {
  it('reads 12-bit delay and padding from a synthetic LAME Info frame', () => {
    const parsed = parseLameGapless(lameInfoFrame(576, 1000))
    assert.ok(parsed)
    assert.equal(parsed.delaySamples, 576)
    assert.equal(parsed.paddingSamples, 1000)
  })

  it('returns null for a frame with no Xing/Info tag', () => {
    const frame = Buffer.alloc(64, 0)
    frame[0] = 0xff
    frame[1] = 0xfb
    frame[2] = 0x90
    frame[3] = 0x00
    assert.equal(parseLameGapless(new Uint8Array(frame)), null)
  })

  it('returns null when the LAME extra has zero delay and zero padding', () => {
    assert.equal(parseLameGapless(lameInfoFrame(0, 0)), null)
  })
})

describe('readGaplessTrim on a real LAME MP3', () => {
  it('returns delay+padding from ffmpeg libmp3lame output', async () => {
    let ffmpeg = true
    try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }) } catch { ffmpeg = false }
    if (!ffmpeg) return

    const dir = mkdtempSync(join(tmpdir(), 'gapless-trim-'))
    const mp3 = join(dir, 'sine.mp3')
    try {
      execFileSync('ffmpeg', [
        '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.4',
        '-c:a', 'libmp3lame', '-q:a', '4', mp3,
      ], { stdio: 'ignore', timeout: 15000 })
      const trim = await readGaplessTrim(mp3)
      assert.ok(trim, 'libmp3lame should write a LAME Info tag')
      assert.ok(trim.delaySamples > 0 && trim.delaySamples < 3000, `delay ${trim.delaySamples}`)
      assert.ok(trim.paddingSamples >= 0 && trim.paddingSamples < 3000, `padding ${trim.paddingSamples}`)
      assert.ok(trim.paddingSec >= 0)
      assert.equal(trim.delaySec, trim.delaySamples / trim.sampleRate)
      assert.equal(trim.paddingSec, trim.paddingSamples / trim.sampleRate)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns null for a symlink (workmini farm must not follow)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gapless-trim-link-'))
    const target = join(dir, 't.mp3')
    const link = join(dir, 'l.mp3')
    try {
      writeFileSync(target, 'not audio')
      const { symlinkSync } = await import('node:fs')
      symlinkSync(target, link)
      assert.equal(await readGaplessTrim(link), null)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
