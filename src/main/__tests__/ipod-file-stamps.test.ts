/**
 * Brief 265 Part 3: the iTunesDB's sample rate, bitrate and length describe the file on
 * the iPod, not the master (ipod-file-stamps.ts).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyFileStamps, createFileStampCache, fileToStamp, parseAfinfo, parseFfprobeJson, stampRowFromFile,
} from '../ipod-file-stamps.ts'

// afinfo on the Apple encode of "Do I Wanna Know?" now on the IndieSleaze nano.
const AFINFO_AAC = `File:           dwk.m4a
File type ID:   m4af
Num Tracks:     1
----
Data format:     2 ch,  44100 Hz, aac  (0x00000000) 0 bits/channel, 0 bytes/packet, 1024 frames/packet, 0 bytes/frame
Channel layout: Stereo (L R)
estimated duration: 272.394104 sec
audio bytes: 8716552
audio packets: 11734
bit rate: 255999 bits per second
`

describe('reading a file\'s facts', () => {
  it('afinfo: rate, gapless-exact length, bitrate', () => {
    assert.deepEqual(parseAfinfo(AFINFO_AAC), { sampleRate: 44100, bitrateKbps: 256, durationMs: 272394 })
  })
  it('ffprobe json', () => {
    const j = JSON.stringify({ streams: [{ sample_rate: '44100', bit_rate: '258450' }], format: { duration: '272.394', bit_rate: '259887' } })
    assert.deepEqual(parseFfprobeJson(j), { sampleRate: 44100, bitrateKbps: 258, durationMs: 272394 })
    assert.deepEqual(parseFfprobeJson('not json'), {})
  })
  it('nonsense is dropped, never stamped', () => {
    assert.deepEqual(parseAfinfo('Data format: 2 ch, 0 Hz, aac\nbit rate: 0 bits per second'), {})
  })
})

describe('stamping a row', () => {
  it('a 96 kHz master converted to 44.1 kHz AAC is stamped as the AAC, not the master', () => {
    const row = { id: 1, sampleRate: 96000, bitRate: 4608, duration: 230373, fileSize: 7418910 }
    stampRowFromFile(row, { sampleRate: 44100, bitrateKbps: 256, durationMs: 230373 })
    assert.deepEqual(row, { id: 1, sampleRate: 44100, bitRate: 256, duration: 230373, fileSize: 7418910 })
  })
  it('a 48 kHz master → 44.1 kHz stamps', () => {
    const row: Record<string, unknown> = { sampleRate: 48000, bitRate: 1411 }
    stampRowFromFile(row, { sampleRate: 44100, bitrateKbps: 256 })
    assert.equal(row.sampleRate, 44100)
    assert.equal(row.bitRate, 256)
  })
  it('a fact the probe did not give keeps the row\'s; the sample rate is never 0', () => {
    const row: Record<string, unknown> = { sampleRate: 0, bitRate: 900, duration: 1000 }
    stampRowFromFile(row, {})
    assert.deepEqual(row, { sampleRate: 44100, bitRate: 900, duration: 1000 })
  })
})

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'b265-stamps-'))
  const cache = join(dir, 'sync-convert-cache')
  const card = join(dir, 'card')
  const lib = join(dir, 'lib')
  for (const d of [cache, card, lib]) await mkdir(d, { recursive: true })
  return { dir, cache, card, lib }
}

describe('which file is probed', () => {
  it('a converted mirror the same size as the card file: the mirror, locally', async () => {
    const { cache, card } = await setup()
    await writeFile(join(cache, 'abc.m4a'), Buffer.alloc(100))
    await writeFile(join(card, 'X.m4a'), Buffer.alloc(100))
    assert.equal(await fileToStamp(join(card, 'X.m4a'), join(cache, 'abc.m4a'), cache), join(cache, 'abc.m4a'))
  })
  it('the library master itself (unconverted, an ALAC Mini): nothing is probed, the row stands', async () => {
    const { cache, card, lib } = await setup()
    await writeFile(join(lib, 'm.m4a'), Buffer.alloc(100))
    await writeFile(join(card, 'X.m4a'), Buffer.alloc(100))
    assert.equal(await fileToStamp(join(card, 'X.m4a'), join(lib, 'm.m4a'), cache), undefined)
  })
  it('a source of another size, or none: the card\'s own file; a missing card file: none', async () => {
    const { cache, card, lib } = await setup()
    await writeFile(join(lib, 'm.m4a'), Buffer.alloc(500))
    await writeFile(join(card, 'X.m4a'), Buffer.alloc(100))
    assert.equal(await fileToStamp(join(card, 'X.m4a'), join(lib, 'm.m4a'), cache), join(card, 'X.m4a'))
    assert.equal(await fileToStamp(join(card, 'X.m4a'), undefined, cache), join(card, 'X.m4a'))
    assert.equal(await fileToStamp(join(card, 'gone.m4a'), undefined, cache), undefined)
  })
})

describe('the stamp cache', () => {
  it('probes a file once; a changed file (size or mtime) is probed again; survives a restart', async () => {
    const { dir, cache } = await setup()
    const f = join(cache, 'a.m4a')
    await writeFile(f, Buffer.alloc(10))
    let probes = 0
    const probe = async () => { probes++; return { sampleRate: 44100, bitrateKbps: 256, durationMs: 1000 } }
    const file = join(dir, 'stamps.json')
    const c1 = createFileStampCache({ file, probe })
    await c1.stampsFor(f); await c1.stampsFor(f)
    assert.equal(probes, 1)
    await c1.flush()
    const c2 = createFileStampCache({ file, probe })
    assert.deepEqual(await c2.stampsFor(f), { sampleRate: 44100, bitrateKbps: 256, durationMs: 1000 })
    assert.equal(probes, 1, 'remembered across a restart')
    await utimes(f, new Date(), new Date(Date.now() + 5000))
    await c2.stampsFor(f)
    assert.equal(probes, 2, 'a changed file is probed again')
    assert.ok(JSON.parse(await readFile(file, 'utf-8')))
  })

  it('a file that cannot be probed is not probed again until it changes', async () => {
    const { dir, cache } = await setup()
    const f = join(cache, 'bad.m4a')
    await writeFile(f, Buffer.alloc(10))
    let probes = 0
    const c = createFileStampCache({ file: join(dir, 's.json'), probe: async () => { probes++; return {} } })
    assert.deepEqual(await c.stampsFor(f), {})
    await c.stampsFor(f)
    assert.equal(probes, 1)
  })

  it('applyFileStamps: converted rows take the mirror\'s facts; master rows are untouched', async () => {
    const rows = [
      { id: 1, sampleRate: 96000, bitRate: 4608, duration: 230373 },
      { id: 2, sampleRate: 44100, bitRate: 900, duration: 200000 },
    ]
    const probe = async (p: string) => (p === 'mirror' ? { sampleRate: 44100, bitrateKbps: 256, durationMs: 230373 } : {})
    const n = await applyFileStamps(rows, (r) => (r.id === 1 ? 'mirror' : undefined), { stampsFor: probe })
    assert.equal(n, 1)
    assert.deepEqual(rows[0], { id: 1, sampleRate: 44100, bitRate: 256, duration: 230373 })
    assert.deepEqual(rows[1], { id: 2, sampleRate: 44100, bitRate: 900, duration: 200000 })
  })
})

describe('both engines stamp from the file, through the same code', () => {
  it('sync-engine and the activity engine call applyFileStamps + fileToStamp before the DB write', async () => {
    for (const f of ['../sync-engine/index.ts', '../ipod-activity-engine.ts']) {
      const src = await readFile(new URL(f, import.meta.url), 'utf-8')
      const stamp = src.indexOf('await applyFileStamps(')
      const write = src.indexOf("'--write'")
      assert.ok(stamp > 0 && write > stamp, `${f}: stamps applied before the catalog write`)
      assert.match(src, /fileToStamp\(/)
    }
  })
})
