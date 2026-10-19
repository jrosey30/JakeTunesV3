/**
 * An import publishes only finished audio at its final library path.
 *
 * 2026-10-18: hop 1 of the Mobile laptop→homemini sync copied files the
 * import was still writing at iPod_Control/Music/Fxx/imported_N.m4a. 12804
 * was taken while mutagen shifted its mdat (old moov, moved audio:
 * "invalid samples per frame"); 11981, 12339 and 12676 while the encode was
 * still growing (no moov). The carrier is add-only, so those torn first
 * copies stayed. The import now builds the file on a hidden sibling and
 * renames it over the 0-byte reservation. These tests poll the final path
 * while an injected slow encoder runs and lock the rule: a reader sees no
 * file, the 0-byte reservation, or the finished file that decodes. Nothing
 * else. A control run of the same writer aimed straight at a final path
 * proves the probe does catch torn states.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { mkdtemp, mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { decodeCheck, importWorkPath } from '../audio-write-guard.ts'
import {
  clearSessionImportedFingerprints,
  importOneFile,
  initImportPipeline,
  type ImportPipelineDeps,
} from '../import-pipeline.ts'

const exec = promisify(execFile)
const FFMPEG_SKIP = 'ffmpeg is not on PATH'

function binOnPath(bin: string): boolean {
  try {
    execFileSync(bin, ['-version'], { stdio: 'ignore' })
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

const sha1 = (b: Buffer): string => createHash('sha1').update(b).digest('hex')
const yieldToLoop = (): Promise<void> => new Promise((r) => setImmediate(r))

type Encoder = NonNullable<ImportPipelineDeps['convertAudio']>

async function setup(): Promise<{ dir: string; musicDir: string; lib: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'jt-publish-'))
  const musicDir = join(dir, 'iPod_Control', 'Music')
  await mkdir(musicDir, { recursive: true })
  const lib = join(dir, 'library.json')
  await writeFile(lib, JSON.stringify({ tracks: [] }))
  return { dir, musicDir, lib }
}

function wire(musicDir: string, lib: string, convertAudio: Encoder): void {
  clearSessionImportedFingerprints()
  initImportPipeline({
    musicDir: () => musicDir,
    libraryPath: () => lib,
    defaultImportFormat: async () => 'alac',
    computeAudioFingerprint: async () => null,
    setCodecForPath: () => {},
    extractEmbeddedArtwork: async () => null,
    readStreamSource: async () => null,
    enqueueStreamConvert: () => {},
    enqueueAnalysis: () => {},
    prewarmAlacCache: async () => {},
    trashItem: async () => {},
    emitToRenderer: () => {},
    convertAudio,
  })
}

/** A 3 s stereo noise WAV (convert path: lossless, not ALAC; noise keeps
 *  the ALAC near real-music size, ~500 KB) and two
 *  moov-LAST ALAC renderings of it. The second carries a big tag, so
 *  writing it over the first in place is what mutagen does on import. */
async function makeFixtures(dir: string, title: string): Promise<{ src: string; untagged: Buffer; tagged: Buffer }> {
  const src = join(dir, `${title}.wav`)
  await exec('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'anoisesrc=d=3:a=0.3:s=7', '-ac', '2', '-metadata', `title=${title}`, '-metadata', 'artist=Publish Test', src])
  const untagged = join(dir, `${title}.untagged.m4a`)
  await exec('ffmpeg', ['-y', '-v', 'error', '-i', src, '-map', '0:a:0', '-c:a', 'alac', '-map_metadata', '-1', untagged])
  const tagged = join(dir, `${title}.tagged.m4a`)
  await exec('ffmpeg', ['-y', '-v', 'error', '-i', src, '-map', '0:a:0', '-c:a', 'alac', '-metadata', `comment=${'x'.repeat(20000)}`, tagged])
  return { src, untagged: await readFile(untagged), tagged: await readFile(tagged) }
}

/** Writes `first` in small chunks, then rewrites the same file in place
 *  with `second` (truncating to its length), calling probe() after every
 *  chunk. That is the import's old write sequence at the final path:
 *  the encode grows the file, then the tag writer reshapes it. */
async function slowWrite(dest: string, first: Buffer, second: Buffer, probe: () => void): Promise<void> {
  const CHUNK = 16 * 1024
  for (const [buf, flags] of [[first, 'w'], [second, 'r+']] as const) {
    const fh = await open(dest, flags)
    try {
      for (let off = 0; off < buf.length; off += CHUNK) {
        await fh.write(buf, off, Math.min(CHUNK, buf.length - off), off)
        probe()
        await yieldToLoop()
      }
      await fh.truncate(buf.length)
    } finally {
      await fh.close()
    }
    probe()
  }
}

interface Observation { size: number | null; sha: string | null }

/** What a carrier copying `path` right now would get. */
function look(path: string): Observation {
  try {
    const b = readFileSync(path)
    return { size: b.length, sha: sha1(b) }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { size: null, sha: null }
    throw err
  }
}

/** Polls `path` and its directory on every turn of the event loop (it
 *  also runs while ffmpeg child processes do the faststart remux and the
 *  decode check) until stop() is called. */
function startPoller(path: string): { seen: Observation[]; names: Set<string>; stop: () => Promise<void> } {
  const seen: Observation[] = []
  const names = new Set<string>()
  let running = true
  const loop = (async () => {
    while (running) {
      seen.push(look(path))
      try {
        for (const n of readdirSync(dirname(path))) names.add(n)
      } catch { /* F-dir not created yet */ }
      await yieldToLoop()
    }
  })()
  return { seen, names, stop: async () => { running = false; await loop } }
}

function moovBeforeMdat(b: Buffer): boolean {
  const order: string[] = []
  let pos = 0
  while (pos + 8 <= b.length && order.length < 8) {
    let size = b.readUInt32BE(pos)
    order.push(b.toString('latin1', pos + 4, pos + 8))
    if (size === 1) size = Number(b.readBigUInt64BE(pos + 8))
    if (size < 8) break
    pos += size
  }
  return order.indexOf('moov') >= 0 && order.indexOf('moov') < order.indexOf('mdat')
}

describe('importWorkPath', () => {
  test('a hidden sibling in the same F-dir that keeps the extension, fresh each call', () => {
    const dest = '/lib/iPod_Control/Music/F04/imported_12804.m4a'
    const a = importWorkPath(dest)
    const b = importWorkPath(dest)
    assert.equal(dirname(a), dirname(dest))
    assert.match(basename(a), /^\.imported_12804\.m4a\.importing-[0-9a-f]{8}\.m4a$/)
    assert.notEqual(a, b)
    assert.match(importWorkPath('/x/F01/imported_7.flac'), /\/\.imported_7\.flac\.importing-[0-9a-f]{8}\.flac$/)
  })
})

describe('an import publishes only finished audio at the final path', () => {
  test('control: the same slow writer aimed at a final path IS seen torn', async (t) => {
    if (!binOnPath('ffmpeg')) { t.skip(FFMPEG_SKIP); return }
    const { dir } = await setup()
    const fx = await makeFixtures(dir, 'control')
    const dest = join(dir, 'imported_99.m4a')
    const seen: Observation[] = []
    await slowWrite(dest, fx.untagged, fx.tagged, () => { seen.push(look(dest)) })
    const finalSha = sha1(fx.tagged)
    const torn = seen.filter((o) => o.size !== null && o.size > 0 && o.sha !== finalSha)
    assert.ok(torn.length > 10, `the probe must catch an in-place write mid-flight (torn observations: ${torn.length})`)
  })

  test('a reader of imported_N.m4a sees nothing, 0 bytes, or the finished decoding file', async (t) => {
    if (!binOnPath('ffmpeg')) { t.skip(FFMPEG_SKIP); return }
    const { dir, musicDir, lib } = await setup()
    const fx = await makeFixtures(dir, 'publish')
    const finalPath = join(musicDir, 'F01', 'imported_1.m4a')
    const handedTo: string[] = []
    const probes: Observation[] = []
    wire(musicDir, lib, async (_src, dest) => {
      handedTo.push(dest)
      await slowWrite(dest, fx.untagged, fx.tagged, () => { probes.push(look(finalPath)) })
    })
    const poll = startPoller(finalPath)
    const r = await importOneFile(fx.src, 1, 'alac', new Set())
    await poll.stop()
    assert.equal(r.ok, true, r.error)
    assert.equal(r.track?.path, ':iPod_Control:Music:F01:imported_1.m4a')

    const final = await readFile(finalPath)
    const finalSha = sha1(final)

    for (const [label, list] of [['probe', probes], ['poller', poll.seen]] as const) {
      const bad = list.filter((o) => o.size !== null && o.size !== 0 && o.sha !== finalSha)
      assert.equal(bad.length, 0,
        `${label}: ${bad.length} of ${list.length} reads of the final path got an unfinished file ` +
        `(sizes ${[...new Set(bad.map((o) => o.size))].slice(0, 6).join(', ')}…; finished is ${final.length})`)
    }
    assert.equal((await decodeCheck(finalPath)).ok, true, 'the published file decodes')
    assert.equal(moovBeforeMdat(final), true, 'faststart ran before the publish (the fixtures are moov-last)')
    assert.equal(r.track?.fileSize, final.length)
    assert.ok(probes.length > 20, 'the encoder probed the final path after every chunk')
    assert.ok(probes.every((o) => o.size === 0), 'while encoding, the final path is the 0-byte reservation')
    assert.ok(poll.seen.length > 50, `the poller sampled throughout (${poll.seen.length} samples)`)
    assert.ok(poll.seen.some((o) => o.size === final.length), 'the poller saw the published file')

    assert.equal(handedTo.length, 1)
    assert.equal(dirname(handedTo[0]), dirname(finalPath), 'the encoder writes in the same F-dir (rename stays on one volume)')
    assert.match(basename(handedTo[0]), /^\.imported_1\.m4a\.importing-[0-9a-f]{8}\.m4a$/)
    assert.deepEqual([...poll.names].filter((n) => !n.startsWith('.')), ['imported_1.m4a'],
      'no other visible name ever appeared in the F-dir')
    assert.ok([...poll.names].some((n) => /^\.imported_1\.m4a\.importing-[0-9a-f]{8}\.m4a\.faststart\.m4a$/.test(n)),
      `the faststart remux ran on the work file and its temp was hidden too (seen: ${[...poll.names].join(', ')})`)
    assert.deepEqual(await readdir(join(musicDir, 'F01')), ['imported_1.m4a'], 'no work file left behind')
  })

  test('a bad first encode is redone on the work file; the final path never holds it', async (t) => {
    if (!binOnPath('ffmpeg')) { t.skip(FFMPEG_SKIP); return }
    const { dir, musicDir, lib } = await setup()
    const fx = await makeFixtures(dir, 'redo')
    // The finished tagged file with its audio scrambled: parses, does not decode.
    const broken = Buffer.from(fx.tagged)
    for (let i = Math.floor(broken.length / 3); i < broken.length - 64 * 1024; i += 997) broken[i] ^= 0xa5
    const finalPath = join(musicDir, 'F02', 'imported_2.m4a')
    let calls = 0
    wire(musicDir, lib, async (_src, dest) => {
      calls++
      await slowWrite(dest, fx.untagged, calls === 1 ? broken : fx.tagged, () => {})
    })
    const poll = startPoller(finalPath)
    const r = await importOneFile(fx.src, 2, 'alac', new Set())
    await poll.stop()
    assert.equal(r.ok, true, r.error)
    assert.equal(calls, 2, 'ensureLandedDecodes redid the encode')
    const finalSha = sha1(await readFile(finalPath))
    assert.equal((await decodeCheck(finalPath)).ok, true)
    assert.deepEqual(poll.seen.filter((o) => o.size !== null && o.size !== 0 && o.sha !== finalSha), [])
    assert.deepEqual(await readdir(join(musicDir, 'F02')), ['imported_2.m4a'])
  })

  test('an encode that never decodes is refused: no reservation, no work file', async (t) => {
    if (!binOnPath('ffmpeg')) { t.skip(FFMPEG_SKIP); return }
    const { dir, musicDir, lib } = await setup()
    const fx = await makeFixtures(dir, 'refuse')
    const broken = Buffer.from(fx.tagged)
    for (let i = Math.floor(broken.length / 3); i < broken.length - 64 * 1024; i += 997) broken[i] ^= 0xa5
    wire(musicDir, lib, async (_src, dest) => { await slowWrite(dest, fx.untagged, broken, () => {}) })
    const r = await importOneFile(fx.src, 3, 'alac', new Set())
    assert.equal(r.ok, false)
    assert.deepEqual(await readdir(join(musicDir, 'F03')), [])
  })

  test('a failed encode falls back to copying the source; the abandoned work file goes too', async (t) => {
    if (!binOnPath('ffmpeg')) { t.skip(FFMPEG_SKIP); return }
    const { dir, musicDir, lib } = await setup()
    const fx = await makeFixtures(dir, 'fallback')
    wire(musicDir, lib, async (_src, dest) => {
      await writeFile(dest, fx.untagged.subarray(0, 40000))
      throw new Error('encoder died mid-write')
    })
    const r = await importOneFile(fx.src, 4, 'alac', new Set())
    assert.equal(r.ok, true, r.error)
    assert.equal(r.track?.path, ':iPod_Control:Music:F04:imported_4.wav')
    assert.deepEqual(await readdir(join(musicDir, 'F04')), ['imported_4.wav'], 'no .m4a reservation, no work files')
    assert.equal(sha1(await readFile(join(musicDir, 'F04', 'imported_4.wav'))), sha1(await readFile(fx.src)))
  })
})
