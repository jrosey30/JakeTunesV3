/**
 * P1C1 — the import pipeline's pure decision logic, now reachable by tests
 * for the first time in its life (it spent that life inside index.ts, where
 * node --test cannot follow).
 *
 * The behaviors locked here are the ones whose regressions Jake has already
 * personally reported: the dupe key treating "feat." variants as the same
 * song, track-number prefixes not defeating dedupe, and the fileless-row
 * self-heal (Soulwax "NY Lipps" / "Tuscan Leather" — a library row with no
 * playable file must not veto its own replacement).
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  _normFingerprint,
  _normTitleFingerprint,
  fingerprintTrack,
  loadDupeFingerprintsFromLibrary,
  addSessionImportedFingerprint,
  clearSessionImportedFingerprints,
  findFreeImportedId,
  importOneFile,
  initImportPipeline,
  shouldEnqueueStreamConvert,
  type ImportPipelineDeps,
} from '../import-pipeline.ts'
import { readFileSync } from 'node:fs'

function minimalDeps(over: Partial<ImportPipelineDeps>): ImportPipelineDeps {
  return {
    musicDir: () => '/nonexistent',
    libraryPath: () => '/nonexistent/library.json',
    defaultImportFormat: async () => undefined,
    computeAudioFingerprint: async () => null,
    setCodecForPath: () => {},
    extractEmbeddedArtwork: async () => null,
    readStreamSource: async () => null,
    enqueueStreamConvert: () => {},
    enqueueAnalysis: () => {},
    prewarmAlacCache: async () => {},
    trashItem: async () => {},
    emitToRenderer: () => {},
    ...over,
  }
}

describe('the text dedupe key', () => {
  test('feat variants, punctuation and track-number prefixes collapse', () => {
    assert.equal(_normFingerprint('01 - Slide (feat. Frank Ocean)'), _normFingerprint('Slide'))
    // Punctuation becomes SPACE, not nothing: 'N.Y.' is 'n y', which does
    // NOT equal 'ny'. This is the shipped behavior being documented, and
    // it is a real limitation of the text key (the Soulwax 'NY Lipps'
    // incident was about fileless rows, not this) — changing it would be
    // a behavior change and belongs to its own brief, not a move-only cut.
    assert.equal(_normFingerprint('N.Y. Lipps!'), 'n y lipps')
    assert.notEqual(_normFingerprint('N.Y. Lipps!'), _normFingerprint('NY Lipps'))
  })

  test('edition stamps never split the key; version markers still do (2026-09-05 live run)', () => {
    assert.equal(_normTitleFingerprint('Helicopter (2001 Digital Remaster)'), _normFingerprint('Helicopter'))
    assert.equal(_normTitleFingerprint('Life Begins At The Hop (Remastered 2001)'), _normFingerprint('Life Begins At The Hop'))
    assert.equal(fingerprintTrack({ title: 'Helicopter (2001 Digital Remaster)', artist: 'XTC', duration: 234733 }),
      fingerprintTrack({ title: 'Helicopter', artist: 'XTC', duration: 234733 }))
    assert.notEqual(_normTitleFingerprint('Helicopter (Live)'), _normFingerprint('Helicopter'))
    assert.notEqual(_normTitleFingerprint('Helicopter (Remix)'), _normFingerprint('Helicopter'))
  })

  test('fingerprintTrack refuses partial identities', () => {
    assert.equal(fingerprintTrack({ title: 'X', artist: '', duration: 200000 }), null)
    assert.equal(fingerprintTrack({ title: 'X', artist: 'Y', duration: 0 }), null)
    assert.equal(fingerprintTrack({ title: 'Slide', artist: 'Calvin Harris', duration: 230813 }),
      'slide|calvin harris|231')
  })
})

describe('loadDupeFingerprintsFromLibrary', () => {
  test('a fileless row does NOT claim its signature — the self-heal rule', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-import-'))
    const musicDir = join(dir, 'iPod_Control/Music')
    mkdirSync(join(musicDir, 'F01'), { recursive: true })
    // Track 1 has a real file; track 2's file is missing.
    writeFileSync(join(musicDir, 'F01', 'imported_1.m4a'), 'bytes')
    const lib = join(dir, 'library.json')
    writeFileSync(lib, JSON.stringify({ tracks: [
      { title: 'Here', artist: 'A', duration: 100000, path: ':iPod_Control:Music:F01:imported_1.m4a' },
      { title: 'Ghost', artist: 'B', duration: 100000, path: ':iPod_Control:Music:F01:imported_2.m4a' },
    ] }))
    clearSessionImportedFingerprints()
    initImportPipeline(minimalDeps({ musicDir: () => musicDir, libraryPath: () => lib }))
    const set = await loadDupeFingerprintsFromLibrary()
    assert.ok(set.has('here|a|100'), 'present file claims its signature')
    assert.ok(!set.has('ghost|b|100'), 'missing file must NOT veto its own replacement')
  })

  test('the session set seeds the result before library.json catches up', async () => {
    clearSessionImportedFingerprints()
    addSessionImportedFingerprint('justadded|artist|180')
    initImportPipeline(minimalDeps({ libraryPath: () => '/nonexistent/library.json' }))
    const set = await loadDupeFingerprintsFromLibrary()
    assert.ok(set.has('justadded|artist|180'))
    clearSessionImportedFingerprints()
  })
})

describe('findFreeImportedId', () => {
  test('bumps past occupied slots at ANY audio extension', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-import-'))
    const musicDir = join(dir, 'iPod_Control/Music')
    // id 7 occupied by an .mp3 (F07), id 8 free (F08)
    mkdirSync(join(musicDir, 'F07'), { recursive: true })
    writeFileSync(join(musicDir, 'F07', 'imported_7.mp3'), 'x')
    initImportPipeline(minimalDeps({ musicDir: () => musicDir }))
    assert.equal(await findFreeImportedId(7), 8)
    assert.equal(await findFreeImportedId(9), 9, 'a free slot is returned untouched')
  })
})

describe('duration tolerance — the Slippery rule', () => {
  test('the same recording off two masters, 304.813s vs 304.041s, IS a dupe', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-import-'))
    const musicDir = join(dir, 'iPod_Control/Music')
    mkdirSync(join(musicDir, 'F01'), { recursive: true })
    writeFileSync(join(musicDir, 'F01', 'imported_1.m4a'), 'bytes')
    const lib = join(dir, 'library.json')
    writeFileSync(lib, JSON.stringify({ tracks: [
      { title: 'Slippery (feat. Gucci Mane)', artist: 'Migos', duration: 304813, path: ':iPod_Control:Music:F01:imported_1.m4a' },
    ] }))
    clearSessionImportedFingerprints()
    initImportPipeline(minimalDeps({ musicDir: () => musicDir, libraryPath: () => lib }))
    const set = await loadDupeFingerprintsFromLibrary()
    // Qobuz's edition: feat clause absent, 304041ms → rounds to 304.
    assert.ok(set.has(fingerprintTrack({ title: 'Slippery', artist: 'Migos', duration: 304041 })!),
      'a one-second rounding boundary must not defeat dedupe')
  })

  test('a genuinely different edit, seconds apart, is NOT claimed', async () => {
    clearSessionImportedFingerprints()
    addSessionImportedFingerprint('song|artist|300')
    initImportPipeline(minimalDeps({ libraryPath: () => '/nonexistent/library.json' }))
    const set = await loadDupeFingerprintsFromLibrary()
    assert.ok(!set.has('song|artist|305'), 'five seconds apart = a different edit, imports freely')
    clearSessionImportedFingerprints()
  })
})

describe('ALAC is enqueued for stream convert', () => {
  test('the gate is a fingerprint plus homemini, for every codec including ALAC', () => {
    assert.equal(shouldEnqueueStreamConvert('sha1:abcd|1000', 'homemini'), true)
    assert.equal(shouldEnqueueStreamConvert(null, 'homemini'), false)
    assert.equal(shouldEnqueueStreamConvert(undefined, 'homemini'), false)
    assert.equal(shouldEnqueueStreamConvert('sha1:abcd|1000', null), false)
    assert.equal(shouldEnqueueStreamConvert('sha1:abcd|1000', 'nas'), false)
    const pipeline = readFileSync(new URL('../import-pipeline.ts', import.meta.url), 'utf8')
    assert.equal(pipeline.includes("storedCodec !== 'alac'"), false)
    const cd = readFileSync(new URL('../ipc/cd-ipc.ts', import.meta.url), 'utf8')
    assert.equal(cd.includes("fmt !== 'alac'"), false)
  })

  test('importOneFile enqueues an ALAC file when this machine streams from homemini', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-alac-q-'))
    const musicDir = join(dir, 'iPod_Control/Music')
    mkdirSync(musicDir, { recursive: true })
    const src = join(dir, 'master.alac')
    writeFileSync(src, pcm16Wav(44100, 4410))
    const queued: Array<{ path: string; fp: string }> = []
    initImportPipeline(minimalDeps({
      musicDir: () => musicDir,
      libraryPath: () => join(dir, 'library.json'),
      readStreamSource: async () => 'homemini',
      computeAudioFingerprint: async () => 'sha1:abc123|100',
      enqueueStreamConvert: (path, fp) => { queued.push({ path, fp }) },
    }))
    const r = await importOneFile(src, 1, 'alac', new Set())
    assert.equal(r.ok, true)
    assert.equal(r.track?.codec, 'alac')
    assert.equal(queued.length, 1)
    assert.equal(queued[0].fp, 'sha1:abc123|100')
    assert.match(queued[0].path, /imported_1\.alac$/)

    queued.length = 0
    initImportPipeline(minimalDeps({
      musicDir: () => musicDir,
      libraryPath: () => join(dir, 'library.json'),
      readStreamSource: async () => null,
      computeAudioFingerprint: async () => 'sha1:abc123|100',
      enqueueStreamConvert: (path, fp) => { queued.push({ path, fp }) },
    }))
    const src2 = join(dir, 'other.alac')
    writeFileSync(src2, pcm16Wav(44100, 4410))
    await importOneFile(src2, 2, 'alac', new Set())
    assert.equal(queued.length, 0)
  })
})

function pcm16Wav(sampleRate: number, frames: number): Buffer {
  const blockAlign = 4
  const dataSize = frames * blockAlign
  const buf = Buffer.alloc(44 + dataSize)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(2, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * blockAlign, 28)
  buf.writeUInt16LE(blockAlign, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataSize, 40)
  return buf
}
