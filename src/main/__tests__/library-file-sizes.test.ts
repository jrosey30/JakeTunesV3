/**
 * Refresh File Sizes measures in main and saves through the renderer.
 *
 * 2026-10-12: the old refresh stat()ed through the offload symlinks to
 * the empty `.jt-streamed` sentinel (169 streamed tracks → fileSize 0),
 * and wrote library.json from main behind the renderer's back, so the
 * renderer's next save-library restored every old size.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { lstat, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { measureLibraryFileSizes, measuredFileUpdates } from '../../common/library-file-sizes.ts'

const SRC = join(import.meta.dirname, '..', '..')

function fakeLstat(files: Record<string, { size: number; kind: 'file' | 'link' | 'dir' }>) {
  return async (p: string) => {
    const f = files[p]
    if (!f) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
    return { size: f.size, isFile: () => f.kind === 'file', isSymbolicLink: () => f.kind === 'link' }
  }
}

describe('measureLibraryFileSizes', () => {
  test('measures regular files only; streamed and missing keep their size', async () => {
    const tracks = [
      { id: 1, path: ':M:F01:a.m4a', fileSize: 100 },
      { id: 2, path: ':M:F02:b.m4a', fileSize: 200 },
      { id: 3, path: ':M:F03:c.m4a', fileSize: 300 },
      { id: 4, path: ':M:F04:d.m4a', fileSize: 400 },
      { id: 5, path: ':M:F05:e.m4a', fileSize: 500 },
      { id: 6, path: '', fileSize: 600 },
    ]
    const progress: Array<{ scanned: number; refreshed: number; total: number }> = []
    const scan = await measureLibraryFileSizes(
      tracks,
      (colon) => colon.replaceAll(':', '/'),
      () => true,
      fakeLstat({
        '/M/F01/a.m4a': { size: 150, kind: 'file' },
        '/M/F02/b.m4a': { size: 200, kind: 'file' },
        '/M/F03/c.m4a': { size: 0, kind: 'link' },
        '/M/F05/e.m4a': { size: 64, kind: 'dir' },
      }),
      (p) => progress.push(p),
    )
    assert.deepEqual(scan.measured, [{ id: 1, fileSize: 150 }, { id: 2, fileSize: 200 }])
    assert.equal(scan.stale, 1)
    assert.equal(scan.streamed, 1)
    assert.equal(scan.missing, 2)
    assert.deepEqual(progress.at(-1), { scanned: 5, refreshed: 1, total: 6 })
  })

  test('the predicate limits what is measured', async () => {
    const scan = await measureLibraryFileSizes(
      [{ id: 1, path: ':a', fileSize: 1 }, { id: 2, path: ':b', fileSize: 1 }],
      (c) => c,
      (abs) => abs === ':b',
      fakeLstat({ ':a': { size: 9, kind: 'file' }, ':b': { size: 7, kind: 'file' } }),
    )
    assert.deepEqual(scan.measured, [{ id: 2, fileSize: 7 }])
  })

  test('fingerprints are measured only when asked, with the track duration', async () => {
    const seen: Array<[string, number]> = []
    const fp = async (abs: string, ms: number) => { seen.push([abs, ms]); return `sha1:${abs.length}|${ms}` }
    const tracks = [
      { id: 1, path: ':a', fileSize: 1, duration: 215000 },
      { id: 2, path: ':link', fileSize: 1, duration: 9 },
    ]
    const lst = fakeLstat({ ':a': { size: 5, kind: 'file' }, ':link': { size: 0, kind: 'link' } })
    const plain = await measureLibraryFileSizes(tracks, (c) => c, () => true, lst)
    assert.deepEqual(plain.measured, [{ id: 1, fileSize: 5 }])
    const withFp = await measureLibraryFileSizes(tracks, (c) => c, () => true, lst, undefined, fp)
    assert.deepEqual(withFp.measured, [{ id: 1, fileSize: 5, audioFingerprint: 'sha1:2|215000' }])
    assert.deepEqual(seen, [[':a', 215000]], 'never fingerprints a streamed symlink')
  })

  test('a real offload symlink to the empty sentinel is not measured as 0 bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jt-sizes-'))
    const sentinel = join(root, '.jt-streamed')
    await writeFile(sentinel, '')
    await writeFile(join(root, 'local.m4a'), Buffer.alloc(4096))
    await symlink(sentinel, join(root, 'streamed.m4a'))
    const scan = await measureLibraryFileSizes(
      [
        { id: 1, path: 'local.m4a', fileSize: 10 },
        { id: 2, path: 'streamed.m4a', fileSize: 8_000_000 },
      ],
      (rel) => join(root, rel),
      () => true,
      lstat,
    )
    assert.deepEqual(scan.measured, [{ id: 1, fileSize: 4096 }])
    assert.equal(scan.streamed, 1)
  })
})

describe('measuredFileUpdates', () => {
  test('only sizes that differ from the renderer copy, for tracks it holds', () => {
    const updates = measuredFileUpdates(
      [{ id: 1, fileSize: 100 }, { id: 2, fileSize: 200 }, { id: 3 }],
      [{ id: 1, fileSize: 100 }, { id: 2, fileSize: 250 }, { id: 3, fileSize: 30 }, { id: 99, fileSize: 1 }],
    )
    assert.deepEqual(updates, [
      { id: 2, field: 'fileSize', value: '250' },
      { id: 3, field: 'fileSize', value: '30' },
    ])
  })

  test('a measured fingerprint replaces a stale one; none measured leaves it alone', () => {
    const updates = measuredFileUpdates(
      [{ id: 1, fileSize: 10, audioFingerprint: 'sha1:old|1' }, { id: 2, fileSize: 20, audioFingerprint: 'sha1:keep|2' }],
      [{ id: 1, fileSize: 11, audioFingerprint: 'sha1:new|1' }, { id: 2, fileSize: 20 }],
    )
    assert.deepEqual(updates, [
      { id: 1, field: 'fileSize', value: '11' },
      { id: 1, field: 'audioFingerprint', value: 'sha1:new|1' },
    ])
  })
})

describe('refresh is saved by the renderer, not written by main', () => {
  const index = readFileSync(join(SRC, 'main', 'index.ts'), 'utf-8')
  const app = readFileSync(join(SRC, 'renderer', 'App.tsx'), 'utf-8')

  test('main measures and does not write library.json for it', () => {
    assert.equal(index.includes('refreshLibraryFileSizes'), false)
    const start = index.indexOf('async function measureFileSizesOnDisk(')
    assert.ok(start > 0)
    const body = index.slice(start, index.indexOf('\n}\n', start))
    assert.equal(/writeFile|rename|lastSelfWriteMtimeMs/.test(body), false, 'no library.json write in the measure path')
    assert.match(body, /measureLibraryFileSizes\(tracks, .*, shouldMeasure, lstat, onProgress, withFingerprints \? computeAudioFingerprint : undefined\)/)
  })

  test('both renderer flows apply the measured sizes with UPDATE_TRACKS', () => {
    assert.match(app, /measuredFileUpdates\(libTracksRef\.current, r\.measured \?\? \[\]\)/)
    assert.match(app, /measuredFileUpdates\(libTracksRef\.current, r\.fileSizes \?\? \[\]\)/)
    assert.equal((app.match(/if \(sizeUpdates\.length\) dispatch\(\{ type: 'UPDATE_TRACKS', updates: sizeUpdates \}\)/g) || []).length, 2)
  })

  test('tag write-back re-measures size and fingerprint; the menu refresh measures sizes only', () => {
    const hookStart = index.indexOf('const result = await writeTagsToFile({ audioFilePath: absPath, overrides })')
    assert.ok(hookStart > 0, 'per-edit write-back still writes tags')
    const hook = index.slice(hookStart, index.indexOf('} else if (!result.ok)', hookStart))
    assert.match(hook, /measureLibraryFileSizes\(\[track\], \(\) => absPath, \(\) => true, lstat, undefined, computeAudioFingerprint\)/)
    assert.match(hook, /sendToRenderer\('tag-writeback:file-changed', measured\[0\]\)/)
    assert.match(index, /measureFileSizesOnDisk\(\(absPath\) => refreshedPaths\.has\(absPath\), undefined, true\)/)
    const menu = index.slice(index.indexOf("ipc.handle('refresh-file-sizes'"), index.indexOf("ipc.handle('refresh-file-sizes'") + 600)
    assert.equal(/measureFileSizesOnDisk\([\s\S]*?,\s*true\s*\)/.test(menu), false, 'the menu refresh does not re-stamp fingerprints')
  })

  test('the renderer applies a per-edit rewrite through UPDATE_TRACKS', () => {
    const at = app.indexOf('window.electronAPI.onTagWritebackFileChanged((m) => {')
    assert.ok(at > app.indexOf('const libTracksRef = useRef('), 'subscribes after libTracksRef exists')
    const body = app.slice(at, at + 300)
    assert.match(body, /measuredFileUpdates\(libTracksRef\.current, \[m\]\)/)
    assert.match(body, /dispatch\(\{ type: 'UPDATE_TRACKS', updates \}\)/)
  })

  test('UPDATE_TRACKS stores fileSize as a number', () => {
    const ctx = readFileSync(join(SRC, 'renderer', 'context', 'LibraryContext.tsx'), 'utf-8')
    const numeric = ctx.match(/const NUMERIC_FIELDS = new Set\(\[([^\]]*)\]\)/)
    assert.ok(numeric && numeric[1].includes("'fileSize'"))
  })
})
