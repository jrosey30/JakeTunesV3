/**
 * Where a source says its song ends. The merge-level tests prove the clamp reaches
 * the show; these lock the reading and the sanity gate, including the file shapes
 * no synthetic source there has (a cover track ahead of the audio, 64-bit edits).
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_PADDING_FRAMES, audioTableFromMoov, readDeclaredLength, realSegmentBytes, type DeclaredLength } from '../live-set-source-length.ts'
import { addSmpb } from './m4a-itunsmpb.ts'

const FFMPEG_MISSING = (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0 || spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status !== 0) && 'ffmpeg or ffprobe is not on PATH'
const FB = 4
const at = (frames: number, sampleRate = 44100): DeclaredLength => ({ frames, sampleRate, source: 'iTunSMPB' })

describe('realSegmentBytes', () => {
  test('cuts the padding, to the frame', () => {
    assert.equal(realSegmentBytes(1000 * FB, at(792), 44100, FB), 792 * FB)
  })
  test('a file that declares nothing keeps its decode', () => {
    assert.equal(realSegmentBytes(1000 * FB, null, 44100, FB), 1000 * FB)
    assert.equal(realSegmentBytes(1000 * FB, at(0), 44100, FB), 1000 * FB)
  })
  test('never lengthens: a declared count past the decode keeps the decode', () => {
    assert.equal(realSegmentBytes(1000 * FB, at(1000), 44100, FB), 1000 * FB)
    assert.equal(realSegmentBytes(1000 * FB, at(5000), 44100, FB), 1000 * FB)
  })
  test('a count too far from the decode to be padding cuts nothing', () => {
    const decoded = 1_000_000
    assert.equal(realSegmentBytes(decoded * FB, at(decoded - MAX_PADDING_FRAMES), 44100, FB), (decoded - MAX_PADDING_FRAMES) * FB, 'the edge still counts as padding')
    assert.equal(realSegmentBytes(decoded * FB, at(decoded - MAX_PADDING_FRAMES - 1), 44100, FB), decoded * FB, 'a frame past it is a stale tag, not padding')
    assert.equal(realSegmentBytes(decoded * FB, at(decoded - 44100), 44100, FB), decoded * FB, 'a second of music is never padding')
  })
  test('a source at another rate is scaled to the merge\'s rate first', () => {
    assert.equal(realSegmentBytes(44200 * FB, at(48000, 48000), 44100, FB), 44100 * FB)
    assert.equal(realSegmentBytes(44200 * FB, at(96000, 96000), 44100, FB), 44100 * FB)
  })
})

function box(name: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts)
  const head = Buffer.alloc(8)
  head.writeUInt32BE(8 + body.length, 0)
  head.write(name, 4, 'latin1')
  return Buffer.concat([head, body])
}
const u32 = (...v: number[]): Buffer => {
  const b = Buffer.alloc(v.length * 4)
  v.forEach((x, i) => b.writeUInt32BE(x, i * 4))
  return b
}
const hdlr = (kind: string): Buffer => box('hdlr', u32(0, 0), Buffer.from(kind, 'latin1'), Buffer.alloc(12))
const mdhd = (timescale: number): Buffer => box('mdhd', u32(0, 0, 0, timescale, 0, 0))
const stts = (...pairs: Array<[number, number]>): Buffer => box('stts', u32(0, pairs.length), ...pairs.map(([c, d]) => u32(c, d)))
const elst32 = (...edits: Array<[number, number]>): Buffer => {
  const b = Buffer.alloc(8 + edits.length * 12)
  b.writeUInt32BE(edits.length, 4)
  edits.forEach(([dur, media], i) => { b.writeUInt32BE(dur, 8 + i * 12); b.writeInt32BE(media, 12 + i * 12); b.writeUInt32BE(0x10000, 16 + i * 12) })
  return box('elst', b)
}
const elst64 = (dur: bigint, media: bigint): Buffer => {
  const b = Buffer.alloc(8 + 20)
  b[0] = 1
  b.writeUInt32BE(1, 4)
  b.writeBigUInt64BE(dur, 8)
  b.writeBigInt64BE(media, 16)
  b.writeUInt32BE(0x10000, 24)
  return box('elst', b)
}
const trak = (kind: string, timescale: number, table: Buffer, edit?: Buffer): Buffer => box('trak',
  ...(edit ? [box('edts', edit)] : []),
  box('mdia', mdhd(timescale), hdlr(kind), box('minf', box('stbl', table))))

describe('audioTableFromMoov', () => {
  test('sums the sample table and reads the first edit', () => {
    const t = audioTableFromMoov(trak('soun', 44100, stts([11632, 1024], [1, 239]), elst32([270076, 1024])))
    assert.deepEqual(t, { sampleCount: 11632 * 1024 + 239, editStart: 1024, timescale: 44100 })
  })
  test('the sound track, not a cover art track ahead of it', () => {
    const t = audioTableFromMoov(Buffer.concat([trak('vide', 90000, stts([1, 512])), trak('soun', 44100, stts([10, 1024]), elst32([1000, 2112]))]))
    assert.deepEqual(t, { sampleCount: 10240, editStart: 2112, timescale: 44100 })
  })
  test('no edit list is a start of 0, an empty edit is a delay and not a start', () => {
    assert.equal(audioTableFromMoov(trak('soun', 44100, stts([10, 1024])))?.editStart, 0)
    assert.equal(audioTableFromMoov(trak('soun', 44100, stts([10, 1024]), elst32([500, -1], [9000, 1024])))?.editStart, 1024)
  })
  test('64-bit edits', () => {
    assert.equal(audioTableFromMoov(trak('soun', 44100, stts([10, 1024]), elst64(9000n, 2112n)))?.editStart, 2112)
  })
  test('a moov with no sound track answers null', () => {
    assert.equal(audioTableFromMoov(trak('vide', 90000, stts([1, 512]))), null)
    assert.equal(audioTableFromMoov(Buffer.alloc(0)), null)
  })
})

describe('readDeclaredLength', { skip: FFMPEG_MISSING }, () => {
  const make = (dir: string, name: string, frames: number, args: string[]): string => {
    const raw = join(dir, 'in.pcm')
    writeFileSync(raw, Buffer.alloc(frames * FB, 1))
    const out = join(dir, name)
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 's16le', '-ar', '44100', '-ac', '2', '-i', raw, ...args, out])
    return out
  }

  test('ffmpeg-made AAC: the sample table total minus the edit list\'s start is the input\'s length', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-source-aac-'))
    try {
      const declared = await readDeclaredLength(make(dir, 'a.m4a', 100100, ['-c:a', 'aac']))
      assert.deepEqual(declared, { frames: 100100, sampleRate: 44100, source: 'sample-table' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('iTunes AAC: the tag\'s 4th field, whatever the sample table says', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-source-smpb-'))
    try {
      const path = make(dir, 'a.m4a', 100100, ['-c:a', 'aac'])
      addSmpb(path, 2112, 400, 99999)
      assert.deepEqual(await readDeclaredLength(path), { frames: 99999, sampleRate: 44100, source: 'iTunSMPB' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a tag with no priming is not iTunes AAC\'s tag: the sample table answers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-source-smpb0-'))
    try {
      const path = make(dir, 'a.m4a', 100100, ['-c:a', 'aac'])
      addSmpb(path, 0, 400, 99999)
      assert.equal((await readDeclaredLength(path))?.frames, 100100)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('lossless files answer null, even one carrying an iTunSMPB tag: their decode is already exact', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-source-lossless-'))
    try {
      assert.equal(await readDeclaredLength(make(dir, 'a.flac', 100100, ['-c:a', 'flac'])), null)
      const alac = make(dir, 'a.m4a', 100100, ['-c:a', 'alac'])
      assert.equal(await readDeclaredLength(alac), null)
      addSmpb(alac, 2112, 400, 99999)
      assert.equal(await readDeclaredLength(alac), null)
      assert.equal(await readDeclaredLength(make(dir, 'a.wav', 100100, [])), null)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a file ffprobe can\'t read rejects, and the caller keeps the decode', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-source-bad-'))
    try {
      const bad = join(dir, 'x.m4a')
      writeFileSync(bad, 'not audio')
      await assert.rejects(readDeclaredLength(bad))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
