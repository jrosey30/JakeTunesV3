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
  nextLibraryId,
  computeNextLibraryId,
  runImportExclusive,
  shouldEnqueueStreamConvert,
  type ImportPipelineDeps,
} from '../import-pipeline.ts'
import { readFileSync, existsSync } from 'node:fs'

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
    assert.equal(shouldEnqueueStreamConvert('sha1:abcd|1000', null, true), true)
    assert.equal(shouldEnqueueStreamConvert(null, null, true), false)
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

    const src3 = join(dir, 'hub.alac')
    writeFileSync(src3, pcm16Wav(44100, 4410))
    initImportPipeline(minimalDeps({
      musicDir: () => musicDir,
      libraryPath: () => join(dir, 'library.json'),
      readStreamSource: async () => null,
      readOffloadAudio: async () => true,
      computeAudioFingerprint: async () => 'sha1:abc123|100',
      enqueueStreamConvert: (path, fp) => { queued.push({ path, fp }) },
    }))
    await importOneFile(src3, 3, 'alac', new Set())
    assert.equal(queued.length, 1)
    assert.equal(queued[0].fp, 'sha1:abc123|100')
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

describe('Brief 170 — import ID allocation', () => {
  test('computeNextLibraryId is max+1 and ignores junk ids', () => {
    assert.equal(computeNextLibraryId(undefined), 1)
    assert.equal(computeNextLibraryId([]), 1)
    assert.equal(computeNextLibraryId([{ id: 7 }, { id: 3 }]), 8)
    assert.equal(computeNextLibraryId([{ id: 'x' }, { id: null }, { id: 41 }]), 42)
  })

  test('nextLibraryId reads the max from a real library', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-nextid-'))
    const lib = join(dir, 'library.json')
    writeFileSync(lib, JSON.stringify({ tracks: [{ id: 5 }, { id: 9001 }] }))
    initImportPipeline(minimalDeps({ libraryPath: () => lib }))
    assert.equal(await nextLibraryId(), 9002)
  })

  test('nextLibraryId THROWS on an unparseable library — no ID-1 fallback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-nextid-'))
    const lib = join(dir, 'library.json')
    writeFileSync(lib, '{torn write, not json')
    initImportPipeline(minimalDeps({ libraryPath: () => lib }))
    await assert.rejects(nextLibraryId(), /does not parse/)
  })

  test('nextLibraryId still bootstraps at 1 when no library exists yet', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-nextid-'))
    initImportPipeline(minimalDeps({ libraryPath: () => join(dir, 'library.json') }))
    assert.equal(await nextLibraryId(), 1)
  })

  test('runImportExclusive never overlaps two imports', async () => {
    let active = 0
    let maxActive = 0
    const order: string[] = []
    const task = (name: string, ms: number) => runImportExclusive(async () => {
      active++; maxActive = Math.max(maxActive, active)
      order.push(`${name}:start`)
      await new Promise((r) => setTimeout(r, ms))
      order.push(`${name}:end`)
      active--
      return name
    })
    const results = await Promise.all([task('a', 30), task('b', 5), task('c', 5)])
    assert.deepEqual(results, ['a', 'b', 'c'])
    assert.equal(maxActive, 1, 'imports run one at a time')
    assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end'])
  })

  test('runImportExclusive survives a rejected import', async () => {
    await assert.rejects(runImportExclusive(async () => { throw new Error('boom') }), /boom/)
    assert.equal(await runImportExclusive(async () => 'next still runs'), 'next still runs')
  })

  test('two concurrent imports asking for the SAME id land on distinct ids and files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-race-'))
    const musicDir = join(dir, 'iPod_Control/Music')
    mkdirSync(musicDir, { recursive: true })
    const srcA = join(dir, 'a.wav')
    const srcB = join(dir, 'b.wav')
    writeFileSync(srcA, pcm16Wav(44100, 4410))
    writeFileSync(srcB, pcm16Wav(44100, 2205))
    initImportPipeline(minimalDeps({
      musicDir: () => musicDir,
      libraryPath: () => join(dir, 'library.json'),
    }))
    // The Brief 170 race: two entry points, same requested id, at the
    // same moment. Before the mutex + atomic reservation, the second
    // conversion overwrote the first's destination.
    const [r1, r2] = await Promise.all([
      importOneFile(srcA, 5, 'wav', new Set()),
      importOneFile(srcB, 5, 'wav', new Set()),
    ])
    assert.equal(r1.ok, true)
    assert.equal(r2.ok, true)
    const ids = [Number(r1.track?.id), Number(r2.track?.id)].sort((x, y) => x - y)
    assert.deepEqual(ids, [5, 6], 'the loser is bumped, not overwritten')
    assert.notEqual(r1.track?.path, r2.track?.path)
    for (const r of [r1, r2]) {
      const rel = String(r.track?.path).replace(/:/g, '/').replace(/^\/iPod_Control\/Music\//, '')
      assert.ok(existsSync(join(musicDir, rel.split('/').slice(-2).join('/'))), `destination exists for id ${String(r.track?.id)}`)
    }
  })
})
