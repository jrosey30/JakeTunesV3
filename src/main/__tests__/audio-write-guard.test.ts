/**
 * Writes to library audio must never leave a file that doesn't decode.
 *
 * 2026-10-17: 44 songs imported Oct 10–11 (mostly Bandcamp ALAC, copied
 * in as-is since #52) stopped decoding. save-metadata-override starts one
 * tag_writer.py per field and does not wait, so a five-field save ran five
 * mutagen writers on one unpadded file. Each shifted the mdat against the
 * others. These tests lock the guard: one writer per file, edits land
 * only if the result decodes, and imports refuse audio that won't decode.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdtemp, mkdir, open, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  decodeCheck,
  ensureLandedDecodes,
  onlyAlacFlushFrame,
  withFileWriteLock,
  writeVerified,
  type DecodeCheck,
} from '../audio-write-guard.ts'
import { writeTagsToFile } from '../tag-writer.ts'
import { PYTHON_CMD } from '../platform.ts'
import {
  clearSessionImportedFingerprints,
  importOneFile,
  initImportPipeline,
} from '../import-pipeline.ts'

const exec = promisify(execFile)
const TAG_WRITER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'core', 'tag_writer.py')

function binOnPath(bin: string): boolean {
  try {
    execFileSync(bin, ['-version'], { stdio: 'ignore' })
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

function mutagenAvailable(): boolean {
  try {
    execFileSync(PYTHON_CMD ?? 'python3', ['-c', 'import mutagen'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const FFMPEG_SKIP = 'ffmpeg is not on PATH'
const MUTAGEN_SKIP = 'no python3 with mutagen (the tag writer)'

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

/** An ALAC .m4a shaped like a Bandcamp download: ffmpeg-muxed, moov
 *  first, no tag padding. Noise, so the mdat stays big (~10 MB) and a
 *  tag write has real data to shift. */
async function makeUnpaddedAlac(dir: string, name = 'song.m4a'): Promise<string> {
  const out = join(dir, name)
  await exec('ffmpeg', [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', 'anoisesrc=d=90:c=pink:r=48000:a=0.3',
    '-ac', '2', '-c:a', 'alac', '-sample_fmt', 's32p',
    '-metadata', 'title=Probe', '-metadata', 'artist=Guard',
    '-movflags', '+faststart', out,
  ], { maxBuffer: 1024 * 1024 })
  return out
}

/** Overwrite 64 KB in the middle of the mdat payload with random bytes. */
async function damageMdat(path: string): Promise<void> {
  const buf = await readFile(path)
  let pos = 0
  while (pos + 8 <= buf.length) {
    let size = buf.readUInt32BE(pos)
    const name = buf.toString('latin1', pos + 4, pos + 8)
    let hdr = 8
    if (size === 1) { size = Number(buf.readBigUInt64BE(pos + 8)); hdr = 16 }
    if (name === 'mdat') {
      const at = pos + hdr + Math.floor((size - hdr) / 2)
      const fh = await open(path, 'r+')
      try { await fh.write(randomBytes(64 * 1024), 0, 64 * 1024, at) } finally { await fh.close() }
      return
    }
    if (size < 8) break
    pos += size
  }
  throw new Error(`no mdat in ${path}`)
}

async function ffprobeTags(path: string): Promise<Record<string, string>> {
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format_tags', '-of', 'json', path])
  const tags = (JSON.parse(stdout) as { format?: { tags?: Record<string, string> } }).format?.tags ?? {}
  return Object.fromEntries(Object.entries(tags).map(([k, v]) => [k.toLowerCase(), v]))
}

describe('one writer per file', () => {
  test('same-path jobs run one at a time in order; other paths overlap; a failure does not jam the queue', async () => {
    const events: string[] = []
    const job = (tag: string, ms: number, fail = false) => async (): Promise<string> => {
      events.push(`start ${tag}`)
      await new Promise((r) => setTimeout(r, ms))
      events.push(`end ${tag}`)
      if (fail) throw new Error(tag)
      return tag
    }
    const a1 = withFileWriteLock('/lib/F01/a.m4a', job('a1', 30, true))
    const a2 = withFileWriteLock('/lib/F01/./a.m4a', job('a2', 5))
    const b1 = withFileWriteLock('/lib/F02/b.m4a', job('b1', 5))
    await assert.rejects(a1, /a1/)
    assert.equal(await a2, 'a2')
    assert.equal(await b1, 'b1')
    // b1 ran while a1 was still running; a2 waited for a1 (same file).
    assert.ok(events.indexOf('start b1') < events.indexOf('end a1'))
    assert.ok(events.indexOf('start a2') > events.indexOf('end a1'))
  })
})

describe('decodeCheck', () => {
  test('a clean ALAC passes, a damaged mdat fails, MP3 is not checked', async (t) => {
    if (!binOnPath('ffmpeg')) { t.skip(FFMPEG_SKIP); return }
    const dir = await mkdtemp(join(tmpdir(), 'jt-guard-'))
    const good = await makeUnpaddedAlac(dir)
    assert.deepEqual(await decodeCheck(good), { ok: true })
    const bad = await makeUnpaddedAlac(dir, 'bad.m4a')
    await damageMdat(bad)
    const r = await decodeCheck(bad)
    assert.equal(r.ok, false)
    assert.equal((await decodeCheck(join(dir, 'x.mp3'))).ok, null)
  })
})

describe("Apple's ALAC flush frame is not damage", () => {
  // Exact lines from library files that Apple's decoder plays to the end
  // (imported_10278, imported_12467; ffmpeg 8). Both spellings of the
  // follow-on line occur across ffmpeg builds.
  const FLUSH = [
    '[alac @ 0x7d8801c00] invalid samples per frame: 0',
    '[aist#0:0/alac @ 0x7d8c14180] [dec:alac @ 0x7d8c18280] Decoding error: Invalid data found when processing input',
  ]
  const DAMAGE = [
    '[alac @ 0x94b043b80] invalid samples per frame: 487506594',
    '[aist#0:0/alac @ 0x8df014300] [dec:alac @ 0x8df018280] Error submitting packet to decoder: Not yet implemented in FFmpeg, patches welcome',
  ]

  test('one zero-sample frame passes; anything more is damage', () => {
    assert.equal(onlyAlacFlushFrame(FLUSH), true)
    assert.equal(onlyAlacFlushFrame([FLUSH[0]]), true)
    assert.equal(onlyAlacFlushFrame([FLUSH[0], '[aist#0:0/alac @ 0x1] [dec:alac @ 0x2] Error submitting packet to decoder: Invalid data found when processing input']), true)
    assert.equal(onlyAlacFlushFrame([]), false)
    assert.equal(onlyAlacFlushFrame([FLUSH[0], FLUSH[0]]), false)
    assert.equal(onlyAlacFlushFrame([FLUSH[0], '    Last message repeated 1 times']), false)
    assert.equal(onlyAlacFlushFrame(DAMAGE), false)
    assert.equal(onlyAlacFlushFrame([DAMAGE[0]]), false)
  })

  test('decodeCheck reads ffmpeg the same way (stand-in ffmpeg)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jt-guard-ff-'))
    const fake = async (name: string, lines: string[], code = 0): Promise<string> => {
      const bin = join(dir, name)
      await writeFile(bin, `#!/bin/sh\n${lines.map((l) => `echo ${JSON.stringify(l)} >&2`).join('\n')}\nexit ${code}\n`)
      await chmod(bin, 0o755)
      return bin
    }
    const song = join(dir, 'song.m4a')
    assert.deepEqual(await decodeCheck(song, { ffmpeg: await fake('flush', FLUSH) }), { ok: true })
    assert.deepEqual(await decodeCheck(song, { ffmpeg: await fake('clean', []) }), { ok: true })
    const bad = await decodeCheck(song, { ffmpeg: await fake('damage', DAMAGE) })
    assert.equal(bad.ok, false)
    assert.equal((await decodeCheck(song, { ffmpeg: await fake('crash', [], 1) })).ok, false)
  })
})

describe('writeVerified', () => {
  test('an edit that breaks the audio never reaches the original', async (t) => {
    if (!binOnPath('ffmpeg')) { t.skip(FFMPEG_SKIP); return }
    const dir = await mkdtemp(join(tmpdir(), 'jt-guard-'))
    const f = await makeUnpaddedAlac(dir)
    const before = sha256(await readFile(f))
    const r = await writeVerified(f, async (target) => {
      await damageMdat(target)
      return { ok: true }
    })
    assert.equal(r.ok, false)
    assert.match(r.error ?? '', /original kept/)
    assert.equal(sha256(await readFile(f)), before)
    assert.deepEqual(await readdir(dir), ['song.m4a'])
  })

  test('a streamed symlink is refused, not replaced by a regular file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jt-guard-'))
    await writeFile(join(dir, '.jt-streamed'), '')
    const link = join(dir, 'imported_1.m4a')
    await symlink(join(dir, '.jt-streamed'), link)
    let called = false
    const r = await writeVerified(link, async () => { called = true; return { ok: true } })
    assert.equal(r.ok, false)
    assert.equal(called, false)
  })
})

describe('the Oct 10–11 write-back burst', () => {
  test('writeTagsToFile never runs two writers on one file at once; different files still overlap', async (t) => {
    const py = PYTHON_CMD ?? 'python3'
    if (!binOnPath(py)) { t.skip('python3 is not on PATH'); return }
    const dir = await mkdtemp(join(tmpdir(), 'jt-guard-lock-'))
    const log = join(dir, 'spans.log')
    // Stand-in tag writer: logs when it starts and stops on which song.
    // .mp3 is not decode-checked, so this needs no ffmpeg.
    const fake = join(dir, 'fake_writer.py')
    await writeFile(fake, [
      'import sys, time, os, re',
      'song = re.sub(r"^\\.|\\.tagwrite-[0-9a-f]+\\.mp3$", "", os.path.basename(sys.argv[1]))',
      'sys.stdin.read()',
      `open(${JSON.stringify(log)}, "a").write(f"start {song} {time.time()}\\n")`,
      'time.sleep(0.15)',
      `open(${JSON.stringify(log)}, "a").write(f"end {song} {time.time()}\\n")`,
    ].join('\n'))
    const a = join(dir, 'a.mp3')
    const b = join(dir, 'b.mp3')
    await writeFile(a, 'a')
    await writeFile(b, 'b')
    const jobs = [
      ...['genre', 'albumArtist', 'album', 'title'].map((field) => ({ path: a, field })),
      ...['genre', 'album'].map((field) => ({ path: b, field })),
    ]
    const results = await Promise.all(jobs.map((j) =>
      writeTagsToFile({ audioFilePath: j.path, overrides: { [j.field]: 'x' } }, { script: fake })))
    for (const r of results) assert.equal(r.ok, true, r.error)
    const spans = new Map<string, Array<[number, number]>>()
    const open_ = new Map<string, number>()
    for (const line of (await readFile(log, 'utf8')).trim().split('\n')) {
      const [kind, song, at] = line.split(' ')
      if (kind === 'start') open_.set(song, Number(at))
      else spans.set(song, [...(spans.get(song) ?? []), [open_.get(song)!, Number(at)]])
    }
    const sa = (spans.get('a.mp3') ?? []).sort((x, y) => x[0] - y[0])
    assert.equal(sa.length, 4)
    for (let i = 1; i < sa.length; i++) assert.ok(sa[i][0] >= sa[i - 1][1], `writers on a.mp3 overlapped: ${JSON.stringify(sa)}`)
    const sb = spans.get('b.mp3') ?? []
    assert.equal(sb.length, 2)
    assert.ok(sb[0][0] < sa[sa.length - 1][0], 'b.mp3 waited for a.mp3; the lock should be per file')
  })

  test('five concurrent field write-backs on an unpadded ALAC leave a file that decodes and carries every field', async (t) => {
    if (!binOnPath('ffmpeg')) { t.skip(FFMPEG_SKIP); return }
    if (!mutagenAvailable()) { t.skip(MUTAGEN_SKIP); return }
    const dir = await mkdtemp(join(tmpdir(), 'jt-guard-'))
    // Three songs of one album, like the album saves on Oct 10–11. With
    // the guard bypassed this failed 7 of 8 runs (lost tags or broken
    // audio). The test below proves the no-overlap rule every run.
    const songs = await Promise.all(['s1.m4a', 's2.m4a', 's3.m4a'].map((n) => makeUnpaddedAlac(dir, n)))
    for (const f of songs) assert.deepEqual(await decodeCheck(f), { ok: true })
    // What save-metadata-override fires per song for a fresh album
    // (augmentPairFields pairs the counts): five writes, none awaited.
    const fields: Array<Record<string, string>> = [
      { albumArtist: 'Scarlet Rose' },
      { genre: 'Rock' },
      { trackNumber: '3', trackCount: '10' },
      { discNumber: '1', discCount: '1' },
      { album: 'Pangea' },
    ]
    const results = await Promise.all(songs.flatMap((f) => fields.map((overrides) =>
      writeTagsToFile({ audioFilePath: f, overrides }, { script: TAG_WRITER }))))
    for (const r of results) assert.equal(r.ok, true, r.error)
    for (const f of songs) {
      assert.deepEqual(await decodeCheck(f), { ok: true }, `${f} no longer decodes`)
      const tags = await ffprobeTags(f)
      assert.equal(tags.album_artist, 'Scarlet Rose')
      assert.equal(tags.genre, 'Rock')
      assert.equal(tags.track, '3/10')
      assert.equal(tags.disc, '1/1')
      assert.equal(tags.album, 'Pangea')
    }
    // Only the songs and their tag backups remain; no clone left behind.
    assert.deepEqual((await readdir(dir)).sort(), [
      's1.m4a', 's1.m4a.original-tags.json', 's2.m4a', 's2.m4a.original-tags.json', 's3.m4a', 's3.m4a.original-tags.json',
    ])
  })
})

describe('import refuses audio that does not decode', () => {
  test('ensureLandedDecodes: a damaged source is refused; a bad landing is rewritten once', async () => {
    const state = new Map<string, DecodeCheck>()
    const check = async (p: string): Promise<DecodeCheck> => state.get(p) ?? { ok: true }
    let redos = 0
    state.set('src', { ok: false, error: 'invalid samples per frame' })
    state.set('dest', { ok: false, error: 'invalid samples per frame' })
    const refused = await ensureLandedDecodes('src', 'dest', async () => { redos++ }, check)
    assert.equal(refused.ok, false)
    assert.match(refused.error ?? '', /source audio does not decode/)
    assert.equal(redos, 0)

    state.set('src', { ok: true })
    const healed = await ensureLandedDecodes('src', 'dest', async () => { redos++; state.set('dest', { ok: true }) }, check)
    assert.equal(healed.ok, true)
    assert.equal(redos, 1)

    state.set('dest', { ok: false, error: 'bits left' })
    const stillBad = await ensureLandedDecodes('src', 'dest', async () => { redos++ }, check)
    assert.equal(stillBad.ok, false)
    assert.match(stillBad.error ?? '', /imported audio does not decode/)
  })

  test('importOneFile refuses an ALAC source that does not decode and leaves no file behind', async (t) => {
    if (!binOnPath('ffmpeg')) { t.skip(FFMPEG_SKIP); return }
    const dir = await mkdtemp(join(tmpdir(), 'jt-guard-import-'))
    const musicDir = join(dir, 'iPod_Control', 'Music')
    await mkdir(musicDir, { recursive: true })
    const lib = join(dir, 'library.json')
    await writeFile(lib, JSON.stringify({ tracks: [] }))
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
    })
    const src = await makeUnpaddedAlac(dir, 'damaged.m4a')
    await damageMdat(src)
    const r = await importOneFile(src, 9, 'alac', new Set())
    assert.equal(r.ok, false)
    await assert.rejects(() => stat(join(musicDir, 'F09', 'imported_9.m4a')))

    const clean = await makeUnpaddedAlac(dir, 'clean.m4a')
    const ok = await importOneFile(clean, 10, 'alac', new Set())
    assert.equal(ok.ok, true)
    assert.equal(sha256(await readFile(join(musicDir, 'F10', 'imported_10.m4a'))), sha256(await readFile(clean)))
  })
})
