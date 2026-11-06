/**
 * The zeros come out of the moov, and nothing else moves. Chunk offsets are the
 * one thing that has to change, so they get the most checks; the merge-level test
 * proves it on a real afconvert + mutagen file.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compactMoov, dropMoovPadding } from '../mp4-moov-padding.ts'

const FFMPEG_MISSING = (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0 || spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status !== 0) && 'ffmpeg or ffprobe is not on PATH'

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
const stco = (...offsets: number[]): Buffer => box('stco', u32(0, offsets.length, ...offsets))
const co64 = (...offsets: number[]): Buffer => {
  const b = Buffer.alloc(8 + offsets.length * 8)
  b.writeUInt32BE(offsets.length, 4)
  offsets.forEach((o, i) => b.writeBigUInt64BE(BigInt(o), 8 + i * 8))
  return box('co64', b)
}
const trak = (table: Buffer): Buffer => box('trak', box('mdia', box('minf', box('stbl', table))))
const ilst = box('ilst', box('\xa9nam', Buffer.from('a title')))
const isoMeta = (...kids: Buffer[]): Buffer => box('meta', u32(0), box('hdlr', Buffer.alloc(24)), ...kids)
const free = (n: number): Buffer => box('free', Buffer.alloc(n))

const entry = (moov: Buffer, name: 'stco' | 'co64', i: number): number => {
  const at = moov.indexOf(name, 0, 'latin1')
  return name === 'stco' ? moov.readUInt32BE(at + 12 + i * 4) : Number(moov.readBigUInt64BE(at + 12 + i * 8))
}

describe('compactMoov', () => {
  test('takes the free out of meta, fixes every size on the way up, and moves the chunks down', () => {
    const moov = box('moov', trak(stco(5000, 6000)), box('udta', isoMeta(ilst, free(300))))
    const start = 100
    const { moov: out, removed, firstChunk } = compactMoov(moov, start)
    assert.equal(removed, 308)
    assert.equal(out.length, moov.length - 308)
    assert.equal(out.readUInt32BE(0), out.length, 'moov size')
    assert.equal(out.indexOf('free', 0, 'latin1'), -1)
    const udta = out.indexOf('udta', 0, 'latin1') - 4
    const meta = out.indexOf('meta', 0, 'latin1') - 4
    assert.equal(udta + out.readUInt32BE(udta), out.length, 'udta size')
    assert.equal(meta + out.readUInt32BE(meta), out.length, 'meta size')
    assert.equal(entry(out, 'stco', 0), 5000 - 308)
    assert.equal(entry(out, 'stco', 1), 6000 - 308)
    assert.deepEqual(firstChunk, { was: 5000, now: 5000 - 308 })
    assert.ok(out.includes(ilst), 'the tags are untouched')
  })

  test('64-bit chunk tables move too', () => {
    const moov = box('moov', trak(co64(5_000_000_000)), box('udta', isoMeta(ilst, free(100))))
    const { moov: out } = compactMoov(moov, 0)
    assert.equal(entry(out, 'co64', 0), 5_000_000_000 - 108)
  })

  test('audio ahead of the moov keeps its offsets', () => {
    const moov = box('moov', trak(stco(50, 60)), box('udta', isoMeta(ilst, free(100))))
    const { moov: out, removed } = compactMoov(moov, 1000)
    assert.equal(removed, 108)
    assert.equal(entry(out, 'stco', 0), 50)
    assert.equal(entry(out, 'stco', 1), 60)
  })

  test('the QuickTime form of meta (no version bytes) and padding at every level', () => {
    const qtMeta = box('meta', box('hdlr', Buffer.alloc(24)), ilst, free(10))
    const moov = box('moov', free(20), trak(stco(9000)), box('udta', qtMeta, box('skip', Buffer.alloc(30))))
    const { moov: out, removed } = compactMoov(moov, 0)
    assert.equal(removed, 28 + 18 + 38)
    assert.equal(out.indexOf('free', 0, 'latin1'), -1)
    assert.equal(out.indexOf('skip', 0, 'latin1'), -1)
    assert.ok(out.includes(ilst))
    assert.equal(entry(out, 'stco', 0), 9000 - removed)
  })

  test('nothing to take out changes nothing', () => {
    const moov = box('moov', trak(stco(5000)), box('udta', isoMeta(ilst)))
    const { moov: out, removed } = compactMoov(moov, 100)
    assert.equal(removed, 0)
    assert.ok(out.equals(moov))
  })

  test('a free inside a track is the encoder\'s business and stays', () => {
    const moov = box('moov', box('trak', free(16), box('mdia', box('minf', box('stbl', stco(5000))))), box('udta', isoMeta(ilst)))
    const { moov: out, removed } = compactMoov(moov, 0)
    assert.equal(removed, 0)
    assert.ok(out.equals(moov))
  })

  test('a broken moov throws and the caller keeps the file', () => {
    assert.throws(() => compactMoov(Buffer.from('nope nope nope nope'), 0))
    const overrun = box('moov', box('udta', isoMeta(ilst, free(8))))
    overrun.writeUInt32BE(overrun.length + 50, 8)
    assert.throws(() => compactMoov(overrun, 0))
  })
})

describe('dropMoovPadding', { skip: FFMPEG_MISSING }, () => {
  const decode = (path: string): Buffer => execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-i', path, '-map', '0:a:0', '-f', 's16le', '-'], { maxBuffer: 2 ** 28 })
  const realAlac = (dir: string): string => {
    const raw = join(dir, 'in.pcm')
    const pcm = Buffer.alloc(441000 * 4)
    for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(Math.round(9000 * Math.sin(i / 37)), i)
    writeFileSync(raw, pcm)
    const out = join(dir, 'a.m4a')
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 's16le', '-ar', '44100', '-ac', '2', '-i', raw, '-c:a', 'alac', '-metadata', 'title=The Show', '-movflags', '+faststart', out])
    return out
  }
  /** Grows moov/udta/meta with a free atom and moves the chunks up, as mutagen does. */
  const padLikeMutagen = (path: string, pad: number): void => {
    const f = readFileSync(path)
    const find = (start: number, end: number, name: string): { pos: number; end: number } => {
      let pos = start
      while (pos + 8 <= end) {
        const size = f.readUInt32BE(pos)
        if (f.toString('latin1', pos + 4, pos + 8) === name) return { pos, end: pos + size }
        pos += size
      }
      throw new Error(`no ${name}`)
    }
    const moov = find(0, f.length, 'moov')
    const udta = find(moov.pos + 8, moov.end, 'udta')
    const meta = find(udta.pos + 8, udta.end, 'meta')
    const trakAt = find(moov.pos + 8, moov.end, 'trak')
    const mdia = find(trakAt.pos + 8, trakAt.end, 'mdia')
    const minf = find(mdia.pos + 8, mdia.end, 'minf')
    const stbl = find(minf.pos + 8, minf.end, 'stbl')
    const table = find(stbl.pos + 8, stbl.end, 'stco')
    const n = f.readUInt32BE(table.pos + 12)
    for (let i = 0; i < n; i++) f.writeUInt32BE(f.readUInt32BE(table.pos + 16 + i * 4) + pad + 8, table.pos + 16 + i * 4)
    for (const a of [moov, udta, meta]) f.writeUInt32BE(f.readUInt32BE(a.pos) + pad + 8, a.pos)
    writeFileSync(path, Buffer.concat([f.subarray(0, meta.end), free(pad), f.subarray(meta.end)]))
  }

  test('a padded file loses the zeros and decodes to the same samples; a second run does nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-moov-'))
    try {
      const path = realAlac(dir)
      const before = decode(path)
      padLikeMutagen(path, 200_000)
      assert.ok(decode(path).equals(before), 'fixture: the padded file plays the same')
      const paddedSize = readFileSync(path).length
      assert.equal(await dropMoovPadding(path), 200_008)
      assert.equal(readFileSync(path).length, paddedSize - 200_008)
      assert.ok(decode(path).equals(before), 'same samples after')
      assert.equal(await dropMoovPadding(path), 0)
      const title = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format_tags=title', '-of', 'csv=p=0', path], { encoding: 'utf8' }).trim()
      assert.equal(title, 'The Show')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a map that wouldn\'t land on the same bytes is refused, and the file stays as it was', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-moov-map-'))
    try {
      const path = join(dir, 'x.m4a')
      const ftyp = box('ftyp', Buffer.from('M4A \0\0\0\0'))
      const audio = box('mdat', Buffer.alloc(8192, 0x5a))
      // A first chunk inside the moov's own padding: nothing moves it, and what it reads changes.
      const moov = box('moov', trak(stco(ftyp.length + 200)), box('udta', isoMeta(ilst, free(4096))))
      const whole = Buffer.concat([ftyp, moov, audio])
      writeFileSync(path, whole)
      await assert.rejects(dropMoovPadding(path), /first chunk/)
      assert.ok(readFileSync(path).equals(whole))
      assert.deepEqual(execFileSync('sh', ['-c', `cd "${dir}" && echo *`], { encoding: 'utf8' }).trim(), 'x.m4a')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('no temp file is left behind, whatever happens', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-moov-bad-'))
    try {
      const path = join(dir, 'x.m4a')
      const broken = box('moov', box('udta', isoMeta(ilst, free(8))))
      broken.writeUInt32BE(broken.length + 50, 8)
      writeFileSync(path, broken)
      await assert.rejects(dropMoovPadding(path))
      assert.deepEqual(execFileSync('sh', ['-c', `cd "${dir}" && echo *`], { encoding: 'utf8' }).trim(), 'x.m4a')
      assert.ok(readFileSync(path).equals(broken), 'the file is as it was')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
