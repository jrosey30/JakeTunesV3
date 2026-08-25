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
  fingerprintTrack,
  loadDupeFingerprintsFromLibrary,
  addSessionImportedFingerprint,
  clearSessionImportedFingerprints,
  findFreeImportedId,
  initImportPipeline,
  type ImportPipelineDeps,
} from '../import-pipeline.ts'

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
