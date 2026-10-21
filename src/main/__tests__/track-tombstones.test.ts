/**
 * 2026-10-20, Jake: "why is fucked up on beer and drugs in my library i
 * deleted it". The desktop half of the evening, replayed:
 *
 *   21:42  the phone imports "Punched In The Head" (Drunks With Guns) → 12915
 *   21:44  this Mac absorbs it from the phone-import mirror
 *   21:48  Jake deletes it here
 *   21:50  a new download (Cowboy Hunters) gets the freed id 12915
 *   then   homemini re-homes its stale row to 12916; the next mirror tick
 *          absorbs the deleted song back
 *
 * Now: the delete becomes a tombstone (pushed to homemini), the mirror rows
 * it covers are never absorbed again, and 12915 is never handed out twice.
 *
 * ⚠️ TWIN: ~/JakeTunesMobile backend/src/util/__tests__/deletedImportNeverReturns.test.ts
 * (homemini's half: the sidecar row is dropped, its audio held, never re-homed).
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TRACK_TOMBSTONES_FILE,
  TRACK_TOMBSTONES_MERGE_PATH,
  createTrackTombstones,
  indexTombstones,
  mergeTombstones,
  parseTombstones,
  tombstoneFor,
  tombstonesForRemoved,
  type TrackTombstone,
} from '../track-tombstones.ts'
import { TRACK_ID_HIGH_WATER_FILE, createIdHighWater, nextIdAbove, raiseHighWater } from '../track-id-high-water.ts'
import { createPhoneImportGuard } from '../phone-import-guard.ts'
import { computeNextLibraryId, findFreeImportedId, initImportPipeline, nextLibraryId, type ImportPipelineDeps } from '../import-pipeline.ts'

const FP_DRUNKS = '31ff25895ff6a417a77cccca91b0cbde'   // the real row's fingerprint (phone format)
const drunks = {
  id: 12915,
  title: 'Punched In The Head',
  artist: 'Drunks With Guns',
  album: 'Fucked Up On Beer & Drugs',
  path: ':iPod_Control:Music:F15:imported_12915.flac',
  fileSize: 12517130,
  duration: 93693,
  audioFingerprint: FP_DRUNKS,
  dateAdded: '2026-10-21T01:42:06.729Z',
}
const orb = { id: 12914, title: 'Electric Blanket', artist: 'ORB', path: ':iPod_Control:Music:F14:imported_12914.m4a', duration: 963152, audioFingerprint: 'sha1:a2b3a0e2e186a3ba|963152' }
const cowboyAt = (id: number) => ({ id, title: 'Punched In The Head', artist: 'Cowboy Hunters', path: `:iPod_Control:Music:F${String(id % 50).padStart(2, '0')}:imported_${id}.m4a`, duration: 201004, audioFingerprint: 'sha1:9d2c0aa1b2c3d4e5|201004' })

type Call = { url: string; body: { v: number; tombstones: TrackTombstone[] } }
function fakeHomemini(ok = true) {
  const calls: Call[] = []
  return {
    calls,
    ok,
    fetchImpl: async (url: string, init?: Record<string, unknown>) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) })
      return { ok, status: ok ? 200 : 503 }
    },
  }
}
const quiet = { warn: () => {}, log: () => {} }

function writeMirror(dir: string, rows: unknown[]): string {
  const p = join(dir, 'mobile-imports.json')
  writeFileSync(p, JSON.stringify({ tracks: rows }))
  return p
}

describe('the evening, replayed on the desktop', () => {
  test('import → absorb → delete → id reuse → re-homed row: the deleted song never comes back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-tomb-'))
    const hub = fakeHomemini()
    let library: Array<Record<string, unknown>> = [orb]
    const guard = createPhoneImportGuard({ dir, baseUrl: 'http://homemini:3000/', libraryTracks: async () => library, fetchImpl: hub.fetchImpl, ...quiet })

    // 21:42–21:44 — the phone's row arrives through the mirror and is absorbed.
    const mirror = writeMirror(dir, [drunks])
    assert.deepEqual((await guard.absorbableImports(mirror)).map((r) => (r as { id: number }).id), [12915])
    assert.equal(await guard.idHighWater.floor(), 12915, 'an id the phone used is spent')
    // homemini's own mark rides in the same file and counts too (⚠️ TWIN).
    writeFileSync(join(dir, 'mirror-mark.json'), JSON.stringify({ tracks: [], importIdHighWater: 12910 }))
    await guard.absorbableImports(join(dir, 'mirror-mark.json'))
    assert.equal(await guard.idHighWater.floor(), 12915, 'never lowered')
    const before = library
    library = [orb, drunks]
    await guard.afterSave(before, library, {})
    assert.deepEqual(await guard.tombstones.list(), [], 'an absorb deletes nothing')

    // 21:48 — Jake deletes it. The save records exactly one tombstone.
    const withDrunks = library
    library = [orb]
    await guard.afterSave(withDrunks, library, {})
    const tombs = await guard.tombstones.list()
    assert.equal(tombs.length, 1)
    assert.deepEqual({ ...tombs[0], deletedAt: 'x' }, {
      id: '12915', audioFingerprint: FP_DRUNKS, title: 'Punched In The Head', artist: 'Drunks With Guns', durationMs: 93693, deletedAt: 'x',
    })
    // ...and tells homemini (whole list, to the merge route).
    assert.equal(await guard.tombstones.pushNow(), true)
    assert.equal(hub.calls.at(-1)?.url, `http://homemini:3000${TRACK_TOMBSTONES_MERGE_PATH}`)
    assert.deepEqual(hub.calls.at(-1)?.body.tombstones.map((t) => t.audioFingerprint), [FP_DRUNKS])

    // 21:50 — the next download can never be 12915 again.
    assert.equal(computeNextLibraryId(library, await guard.idHighWater.floor()), 12916)
    const cowboy = cowboyAt(12916)

    // homemini's stale row lingers (its save is refused), or was re-homed
    // to a new id before the deletion reached it — neither is absorbed.
    assert.deepEqual(await guard.absorbableImports(writeMirror(dir, [drunks])), [])
    const rehomed = { ...drunks, id: 12917, path: ':iPod_Control:Music:F17:imported_12917.flac' }
    assert.deepEqual(await guard.absorbableImports(writeMirror(dir, [rehomed])), [])
    assert.equal(await guard.idHighWater.floor(), 12917, 'the re-homed id is spent too')

    // The new track is untouched by any of it.
    library = [orb, cowboy]
    assert.equal(tombstoneFor(cowboy, indexTombstones(tombs)), null)
    await guard.afterSave([orb], library, {})
    assert.equal((await guard.tombstones.list()).length, 1, 'adding the new track records nothing')
  })

  test('the push inside the save window: the renderer holds a just-deleted fingerprint (App.tsx)', () => {
    const app = readFileSync(join(import.meta.dirname, '..', '..', 'renderer', 'App.tsx'), 'utf-8')
    assert.match(app, /!justDeleted\(t\.audioFingerprint\)/)
    assert.match(app, /goneFingerprintsRef\.current\.set\(fp, now\)/)
  })

  test('a delete AFTER absorption completed: tombstoned, and a later phone re-download is a deliberate re-add', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-tomb-'))
    let library: Array<Record<string, unknown>> = [orb, drunks]
    const guard = createPhoneImportGuard({ dir, baseUrl: 'http://homemini:3000', libraryTracks: async () => library, fetchImpl: fakeHomemini().fetchImpl, ...quiet })
    // homemini already dropped the row (absorbed + stable): the mirror is empty.
    assert.deepEqual(await guard.absorbableImports(writeMirror(dir, [])), [])
    library = [orb]
    await guard.afterSave([orb, drunks], library, {})
    assert.equal((await guard.tombstones.list()).length, 1)
    const again = { ...drunks, id: 12931, path: ':iPod_Control:Music:F31:imported_12931.flac', dateAdded: '2099-01-01T00:00:00.000Z' }
    assert.deepEqual((await guard.absorbableImports(writeMirror(dir, [again]))).map((r) => (r as { id: number }).id), [12931])
  })

  test("homemini's importIdHighWater in the mirror raises the desktop's mark", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-tomb-'))
    const guard = createPhoneImportGuard({ dir, baseUrl: 'http://homemini:3000', libraryTracks: async () => [orb], fetchImpl: fakeHomemini().fetchImpl, ...quiet })
    writeFileSync(join(dir, 'mobile-imports.json'), JSON.stringify({ tracks: [], absorbed: {}, importIdHighWater: 12916 }))
    assert.deepEqual(await guard.absorbableImports(join(dir, 'mobile-imports.json')), [])
    assert.equal(computeNextLibraryId([orb], await guard.idHighWater.floor()), 12917)
  })

  test('a phone import that is NOT deleted still absorbs normally', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-tomb-'))
    let library: Array<Record<string, unknown>> = [orb, cowboyAt(12900)]
    const guard = createPhoneImportGuard({ dir, baseUrl: 'http://homemini:3000', libraryTracks: async () => library, fetchImpl: fakeHomemini().fetchImpl, ...quiet })
    await guard.afterSave(library, [orb], {})   // an unrelated delete
    library = [orb]
    assert.equal((await guard.tombstones.list()).length, 1)
    assert.deepEqual((await guard.absorbableImports(writeMirror(dir, [drunks]))).map((r) => (r as { id: number }).id), [12915])
  })

  test('a torn / partial library load records nothing and blocks no real import', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-tomb-'))
    const torn: Array<Record<string, unknown>> = []
    const guard = createPhoneImportGuard({ dir, baseUrl: 'http://homemini:3000', libraryTracks: async () => torn, fetchImpl: fakeHomemini().fetchImpl, ...quiet })
    // Only a save that LANDED records (index.ts calls afterSave after the
    // write), and a hub-adoption or forced (recovery) save never does.
    await guard.afterSave([orb, drunks], [orb], { adoption: true })
    await guard.afterSave([orb, drunks], [orb], { force: true })
    assert.deepEqual(await guard.tombstones.list(), [])
    // With no deletion on record, the row absorbs even though the library read came back empty.
    assert.equal((await guard.absorbableImports(writeMirror(dir, [drunks]))).length, 1)
    // A missing or torn mirror is "no rows yet", never a throw.
    writeFileSync(join(dir, 'mobile-imports.json'), '{"tracks": [')
    assert.deepEqual(await guard.absorbableImports(join(dir, 'mobile-imports.json')), [])
  })

  test('save-library wires it: after the write, both mirror reads, the import pipeline, the mirror tick', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'index.ts'), 'utf-8')
    const save = src.slice(src.indexOf('async function saveLibraryImpl'), src.indexOf('// ── Watch library.json for EXTERNAL modifications'))
    assert.ok(save.indexOf('phoneImportGuard.afterSave(prevTracks') > save.indexOf('await renameFS(tmp, LIBRARY_PATH)'), 'recorded only after the save landed')
    assert.match(save, /afterSave\(prevTracks as never, tracks as never, \{ adoption, force \}\)/)
    assert.equal(src.split('phoneImportGuard.absorbableImports(').length - 1, 2, 'boot pull + mid-session push')
    assert.match(src, /idHighWater: phoneImportGuard\.idHighWater/)
    assert.match(src, /void phoneImportGuard\.tombstones\.tick\(\)/)
  })
})

describe('what a save deleted', () => {
  test('id AND fingerprint gone → a tombstone; a dedupe (same bytes kept) or no fingerprint → none', () => {
    const at = '2026-10-21T01:48:33.000Z'
    assert.equal(tombstonesForRemoved([orb, drunks], [orb], at).length, 1)
    const keptCopy = { ...drunks, id: 12940 }
    assert.deepEqual(tombstonesForRemoved([orb, drunks, keptCopy], [orb, keptCopy], at), [])
    assert.deepEqual(tombstonesForRemoved([{ id: 5, title: 'no fp' }], [], at), [])
    assert.deepEqual(tombstonesForRemoved([orb], [orb], at), [])
  })

  test('the store survives a restart, and a refused push stays owed until it lands', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-tomb-'))
    const down = fakeHomemini(false)
    const a = createTrackTombstones({ dir, baseUrl: 'http://homemini:3000', fetchImpl: down.fetchImpl, ...quiet, debounceMs: 60_000 })
    await a.recordSave([orb, drunks], [orb])
    assert.equal(await a.pushNow(), false)
    await a.tick()
    assert.equal(down.calls.length, 2, 'refused → owed → the tick retries')
    const onDisk = parseTombstones(JSON.parse(readFileSync(join(dir, TRACK_TOMBSTONES_FILE), 'utf-8')))
    assert.equal(onDisk.length, 1)
    const up = fakeHomemini(true)
    const b = createTrackTombstones({ dir, baseUrl: 'http://homemini:3000', fetchImpl: up.fetchImpl, ...quiet })
    assert.equal((await b.list()).length, 1, 'read back after a restart')
    await b.tick()
    await b.tick()
    assert.equal(up.calls.length, 1, 'one push per session once it lands')
  })
})

describe('the shared rules (⚠️ TWIN with homemini)', () => {
  const idx = indexTombstones([{ id: '12915', audioFingerprint: 'fp', title: '', artist: '', durationMs: 0, deletedAt: '2026-10-21T01:48:33.000Z' }])
  test('identity, still deleted, before the deletion', () => {
    assert.equal(tombstoneFor({ audioFingerprint: 'other' }, idx), null)
    assert.equal(tombstoneFor({ audioFingerprint: 'fp', dateAdded: '2026-10-21T01:42:06.729Z' }, idx), Date.parse('2026-10-21T01:48:33.000Z'))
    assert.equal(tombstoneFor({ audioFingerprint: 'fp', dateAdded: '2026-10-22T00:00:00Z' }, idx), null)
    assert.equal(tombstoneFor({ audioFingerprint: 'fp' }, idx, new Set(['fp'])), null)
  })
  test('merge is a union that keeps the later deletion', () => {
    const t = (deletedAt: string) => ({ id: '1', audioFingerprint: 'fp', title: '', artist: '', durationMs: 0, deletedAt })
    assert.equal(mergeTombstones([t('2026-10-01T00:00:00.000Z')], []).changed, false)
    const r = mergeTombstones([t('2026-10-01T00:00:00.000Z')], [t('2026-10-05T00:00:00.000Z')])
    assert.equal(r.merged.length, 1)
    assert.equal(r.merged[0].deletedAt, '2026-10-05T00:00:00.000Z')
  })
})

describe('a freed id is never reissued', () => {
  test('the mark only rises and survives a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-hw-'))
    const path = join(dir, TRACK_ID_HIGH_WATER_FILE)
    const hw = createIdHighWater(path)
    assert.equal(await hw.floor(), 0)
    await hw.raise([12914, 12915, 'junk'])
    await hw.raise([3])
    assert.equal(await hw.floor(), 12915)
    assert.equal(await createIdHighWater(path).floor(), 12915)
    assert.equal(raiseHighWater(12915, [12000]), 12915)
    assert.equal(nextIdAbove([12914], 12915), 12916)
    assert.equal(nextIdAbove([], 0), 1)
  })

  test('downloads (nextLibraryId) and every slot scan (findFreeImportedId) start above the mark', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-hw-'))
    const musicDir = join(dir, 'iPod_Control', 'Music')
    mkdirSync(musicDir, { recursive: true })
    const lib = join(dir, 'library.json')
    writeFileSync(lib, JSON.stringify({ tracks: [orb] }))   // 12915 was deleted: max id is 12914
    const idHighWater = createIdHighWater(join(dir, TRACK_ID_HIGH_WATER_FILE))
    await idHighWater.raise([12915])
    const deps: ImportPipelineDeps = {
      musicDir: () => musicDir,
      libraryPath: () => lib,
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
      idHighWater,
    }
    initImportPipeline(deps)
    assert.equal(await nextLibraryId(), 12916, 'never the freed 12915')
    assert.equal(await findFreeImportedId(12915), 12916, 'the renderer counter asking for 12915 is bumped')
    assert.equal(await findFreeImportedId(12920), 12920, 'above the mark: untouched')
    initImportPipeline({ ...deps, idHighWater: undefined })
    assert.equal(await nextLibraryId(), 12915, 'without the mark (the old allocator) the freed id came back')
  })
})
