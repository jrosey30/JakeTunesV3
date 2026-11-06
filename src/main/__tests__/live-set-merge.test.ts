/**
 * The merge, end to end: real ffmpeg decode, the real concat, the real ALAC
 * encode and the real tagger, then the finished file decoded back and compared.
 * The seam functions have their own tests; none of them would have seen the
 * blip audit's findings of 2026-11-05, which all live in how the merge uses them:
 * encoder padding copied into the show (holes up to 22.9 ms at 90 joins), every
 * marker 8.000 s early in 8 shows, 24 crossfades the recording never asked for,
 * and 62-71% of every moov being zeros.
 *
 * Sources are synthetic with known lengths, so "the song's real frames" is a
 * fact here and not a reading of the same code under test.
 */
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addSmpb } from './m4a-itunsmpb.ts'

// `electron` -> a stub whose app root is the repo, so platform.ts's tag step
// runs the real core/tag_writer.py, as the headless merger does.
register('../../../scripts/concert/electron-hooks.mjs', import.meta.url)
const { mergeLiveSet } = await import('../live-set-merge.ts')

const RATE = 44100
const FRAME = 4
const FFMPEG_MISSING = (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0 || spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status !== 0) && 'ffmpeg or ffprobe is not on PATH'

/** A deterministic bed of filtered noise: nothing repeats, so a misplaced
 *  sample can't compare equal by luck. `gain` is per frame. */
function bed(frames: number, seed: number, amp: number, gain: (frame: number) => number = () => 1): Buffer {
  const b = Buffer.alloc(frames * FRAME)
  let s = (seed * 2654435761) >>> 0
  const white = (): number => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2147483648 - 1 }
  let l = 0, r = 0
  const norm = (amp * 32767) / 0.164
  for (let i = 0; i < frames; i++) {
    l = 0.85 * l + 0.15 * white()
    r = 0.85 * r + 0.15 * white()
    const g = gain(i)
    b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, l * g * norm / 32767)) * 32767), i * FRAME)
    b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, r * g * norm / 32767)) * 32767), i * FRAME + 2)
  }
  return b
}

function encode(dir: string, name: string, pcm: Buffer, args: string[], rate = RATE): string {
  const raw = join(dir, `${name}.pcm`)
  const out = join(dir, name)
  writeFileSync(raw, pcm)
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 's16le', '-ar', String(rate), '-ac', '2', '-i', raw, ...args, out])
  rmSync(raw)
  return out
}
const AAC = ['-c:a', 'aac', '-b:a', '256k']
const FLAC = ['-c:a', 'flac']

/** The engine's own decode arguments. What a song's samples "are". */
function decode(path: string): Buffer {
  return execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-i', path, '-map', '0:a:0', '-ac', '2', '-ar', String(RATE), '-sample_fmt', 's16', '-f', 's16le', '-'], { maxBuffer: 2 ** 30 })
}

async function merge(dir: string, sources: Array<{ path: string; frames: number }>) {
  const inputs = sources.map((s, i) => ({ id: i + 1, title: `Song ${i + 1}`, artist: 'Test Band', absPath: s.path, durationMs: (s.frames / RATE) * 1000 }))
  return mergeLiveSet(inputs, { name: 'Test Show', artist: 'Test Band' }, join(dir, 'scratch'), () => undefined)
}

const msOf = (frames: number): number => Math.round((frames / RATE) * 1000)

function assertSameBytes(actual: Buffer, expected: Buffer, label: string): void {
  assert.equal(actual.length / FRAME, expected.length / FRAME, `${label}: frame count`)
  if (actual.equals(expected)) return
  let i = 0
  while (actual[i] === expected[i]) i++
  assert.fail(`${label}: first different byte in frame ${Math.floor(i / FRAME)}`)
}

/** Every 1 ms against the median level: the deepest drop anywhere in the show. */
function deepestHoleDb(pcm: Buffer): { db: number; atMs: number } {
  const win = 44
  const levels: number[] = []
  for (let f = 0; f + win <= pcm.length / FRAME; f += win) {
    let acc = 0
    for (let i = 0; i < win; i++) {
      const l = pcm.readInt16LE((f + i) * FRAME), r = pcm.readInt16LE((f + i) * FRAME + 2)
      acc += l * l + r * r
    }
    levels.push(10 * Math.log10(Math.max(acc / (win * 2), 1e-3)))
  }
  const med = [...levels].sort((a, b) => a - b)[Math.floor(levels.length / 2)]
  let worst = 0, at = 0
  levels.forEach((v, i) => { if (v - med < worst) { worst = v - med; at = i } })
  return { db: worst, atMs: at }
}

/** Top-level and moov-level layout of an m4a. */
function atomMap(file: Buffer): { top: string[]; padding: string[]; firstChunk: number; mdat: number; moovEnd: number } {
  const padding: string[] = []
  const top: string[] = []
  let firstChunk = -1, mdat = -1, moovEnd = -1
  const walk = (start: number, end: number, path: string): void => {
    let pos = start
    while (pos + 8 <= end) {
      const size = file.readUInt32BE(pos)
      if (size < 8 || pos + size > end) return
      const name = file.toString('latin1', pos + 4, pos + 8)
      const here = path ? `${path}/${name}` : name
      if (!path) top.push(name)
      if (name === 'moov' && !path) moovEnd = pos + size
      if (name === 'mdat' && !path) mdat = pos
      if (path && (name === 'free' || name === 'skip')) padding.push(`${here}:${size}`)
      if (name === 'stco' && firstChunk < 0) firstChunk = file.readUInt32BE(pos + 16)
      if (['moov', 'udta', 'trak', 'mdia', 'minf', 'stbl'].includes(name)) walk(pos + 8, pos + size, here)
      if (name === 'meta') walk(pos + 12, pos + size, here)
      pos += size
    }
  }
  walk(0, file.length, '')
  return { top, padding, firstChunk, mdat, moovEnd }
}

describe('mergeLiveSet, ffmpeg-made AAC (three plain joins worth of padding)', { skip: FFMPEG_MISSING }, () => {
  let dir = ''
  let result: Awaited<ReturnType<typeof merge>>
  let merged: Buffer
  let expected: Buffer
  const real = [881764, 926100, 970000]

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'jt-merge-aac-'))
    const sources = real.map((frames, i) => ({ path: encode(dir, `song${i}.m4a`, bed(frames, 11 + i, 0.1), AAC), frames }))
    const decoded = sources.map((s) => decode(s.path))
    decoded.forEach((d, i) => assert.ok(d.length / FRAME - real[i] >= 300, `fixture: song ${i} decodes with padding (${d.length / FRAME} vs ${real[i]})`))
    expected = Buffer.concat(decoded.map((d, i) => d.subarray(0, real[i] * FRAME)))
    result = await merge(dir, sources)
    merged = decode(result.mergedPath)
  })
  after(() => { rmSync(dir, { recursive: true, force: true }) })

  test('no hole anywhere in the show', () => {
    const hole = deepestHoleDb(merged)
    assert.ok(hole.db > -20, `${hole.db.toFixed(1)} dB under the show's level at ${hole.atMs} ms`)
  })

  test('the show is exactly the songs, bit for bit, and only their real frames', () => {
    assertSameBytes(merged, expected, 'merged audio')
    assert.equal(result.totalDurationMs, msOf(real[0] + real[1] + real[2]))
  })

  test('markers land on each song\'s real first frame', () => {
    assert.deepEqual(result.cues.map((c) => c.startMs), [0, msOf(real[0]), msOf(real[0] + real[1])])
    assert.deepEqual(result.cues.map((c) => c.durationMs), [msOf(real[0]), msOf(real[0] + real[1]) - msOf(real[0]), result.totalDurationMs - msOf(real[0] + real[1])])
  })
})

describe('mergeLiveSet, sources that declare their own length', { skip: FFMPEG_MISSING }, () => {
  test('iTunes AAC: the iTunSMPB count decides where the song ends', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-merge-smpb-'))
    try {
      const framesA = 881764, framesB = 882000
      const a = encode(dir, 'a.m4a', bed(framesA, 21, 0.1), AAC)
      const b = encode(dir, 'b.m4a', bed(framesB, 22, 0.1), AAC)
      addSmpb(a, 1024, 0, 1)
      const decodedA = decode(a)
      // Not the sample table's answer: only the tag can say this count.
      const declared = decodedA.length / FRAME - 777
      assert.notEqual(declared, framesA)
      rmSync(a)
      encode(dir, 'a.m4a', bed(framesA, 21, 0.1), AAC)
      addSmpb(a, 1024, 777, declared)
      const result = await merge(dir, [{ path: a, frames: framesA }, { path: b, frames: framesB }])
      const expected = Buffer.concat([decodedA.subarray(0, declared * FRAME), decode(b).subarray(0, framesB * FRAME)])
      assertSameBytes(decode(result.mergedPath), expected, 'merged audio')
      assert.equal(result.cues[1].startMs, msOf(declared))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a song at another sample rate is clamped at the merge\'s rate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-merge-rate-'))
    try {
      const frames48k = 960000 + 100
      const a = encode(dir, 'a.m4a', bed(frames48k, 31, 0.1), [...AAC, '-ar', '48000'], 48000)
      const b = encode(dir, 'b.flac', bed(882000, 32, 0.1), FLAC)
      const real = Math.round((frames48k * RATE) / 48000)
      const decodedA = decode(a)
      assert.ok(decodedA.length / FRAME > real, 'fixture: the 44.1k decode runs past the song')
      const result = await merge(dir, [{ path: a, frames: real }, { path: b, frames: 882000 }])
      const expected = Buffer.concat([decodedA.subarray(0, real * FRAME), decode(b)])
      assertSameBytes(decode(result.mergedPath), expected, 'merged audio')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('lossless songs are not clamped: real silence at a song\'s end stays, and the marker after it is right', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-merge-flac-'))
    try {
      const framesA = 882000 + 2205
      const a = encode(dir, 'a.flac', bed(framesA, 41, 0.1, (f) => (f < 882000 ? 1 : 0)), FLAC)
      const b = encode(dir, 'b.flac', bed(882000, 42, 0.1), FLAC)
      const c = encode(dir, 'c.flac', bed(882000, 43, 0.1), FLAC)
      const result = await merge(dir, [{ path: a, frames: framesA }, { path: b, frames: 882000 }, { path: c, frames: 882000 }])
      assert.deepEqual(result.cues.map((q) => q.startMs), [0, msOf(framesA), msOf(framesA + 882000)])
      assertSameBytes(decode(result.mergedPath), Buffer.concat([decode(a), decode(b), decode(c)]), 'merged audio')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('mergeLiveSet, the overlap rule', { skip: FFMPEG_MISSING }, () => {
  test('a tail that drops 14 dB but stays in the room joins plainly, nothing laid over anything', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-merge-false-'))
    try {
      const frames = 882000
      const drop = (f: number): number => {
        const left = (frames - f) / RATE
        return left > 3 ? 1 : left < 1.5 ? 0.2 : 0.2 + 0.8 * ((left - 1.5) / 1.5)
      }
      const a = encode(dir, 'a.flac', bed(frames, 51, 0.1, drop), FLAC)
      const b = encode(dir, 'b.flac', bed(frames, 52, 0.1), FLAC)
      const result = await merge(dir, [{ path: a, frames }, { path: b, frames }])
      assertSameBytes(decode(result.mergedPath), Buffer.concat([decode(a), decode(b)]), 'merged audio')
      assert.equal(result.cues[1].startMs, msOf(frames))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a real fade pair keeps its overlap: the marker sits at the crossover and everything outside it is the sources\' bits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-merge-fade-'))
    try {
      const frames = 882000
      const out = (f: number): number => {
        const left = (frames - f) / RATE
        return left > 3.5 ? 1 : left < 0.5 ? 0 : (left - 0.5) / 3
      }
      const inn = (f: number): number => {
        const t = f / RATE
        return t > 3.5 ? 1 : t < 0.5 ? 0 : (t - 0.5) / 3
      }
      const a = encode(dir, 'a.flac', bed(frames, 61, 0.1, out), FLAC)
      const b = encode(dir, 'b.flac', bed(frames, 62, 0.1, inn), FLAC)
      const c = encode(dir, 'c.flac', bed(frames, 63, 0.1), FLAC)
      const pa = decode(a), pb = decode(b), pc = decode(c)
      const result = await merge(dir, [{ path: a, frames }, { path: b, frames }, { path: c, frames }])
      const merged = decode(result.mergedPath)

      const overlapTotal = 3 * frames - merged.length / FRAME
      assert.ok(overlapTotal > 0, 'the fades overlapped')
      const overlap = overlapTotal   // only a->b: b runs flat straight into c
      assert.ok(overlap >= 0.6 * RATE && overlap <= 4 * RATE, `overlap ${overlap} frames`)

      const headOfB = frames - overlap
      assert.equal(result.cues[1].startMs, msOf(headOfB + Math.floor(overlap / 2)), 'the marker sits mid-overlap')
      assert.equal(result.cues[2].startMs, msOf(2 * frames - overlap), 'the next marker is right too')
      assertSameBytes(merged.subarray(0, headOfB * FRAME), pa.subarray(0, headOfB * FRAME), 'before the overlap')
      assertSameBytes(merged.subarray(frames * FRAME), Buffer.concat([pb.subarray(overlap * FRAME), pc]), 'after the overlap')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('mergeLiveSet, the finished file', { skip: FFMPEG_MISSING }, () => {
  test('the moov carries no padding: audio, tags and moov-first all as they were', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-merge-moov-'))
    try {
      const frames = 882000
      const a = encode(dir, 'a.flac', bed(frames, 71, 0.1), FLAC)
      const b = encode(dir, 'b.flac', bed(frames, 72, 0.1), FLAC)
      const result = await merge(dir, [{ path: a, frames }, { path: b, frames }])
      const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format_tags=title,album,artist,album_artist,track', '-of', 'json', result.mergedPath], { encoding: 'utf8' })) as { format?: { tags?: Record<string, string> } }
      const tags = probe.format?.tags ?? {}
      // No mutagen on this machine: the tagger never ran, so there is no padding to prove anything about.
      if (!tags.title) { t.skip('the tagger did not run (mutagen missing?)'); return }
      assert.equal(tags.title, 'Test Show — Full Set')
      assert.equal(tags.album, 'Test Show (Live Set)')
      assert.equal(tags.artist, 'Test Band')

      const file = readFileSync(result.mergedPath)
      const map = atomMap(file)
      assert.deepEqual(map.padding, [], 'no free or skip inside moov, udta or meta')
      assert.ok(map.top.indexOf('moov') < map.top.indexOf('mdat'), `moov first: ${map.top.join(',')}`)
      assert.ok(map.firstChunk > map.moovEnd && map.firstChunk >= map.mdat + 8, `chunk offsets land in mdat (${map.firstChunk}, mdat at ${map.mdat})`)
      assertSameBytes(decode(result.mergedPath), Buffer.concat([decode(a), decode(b)]), 'merged audio')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
