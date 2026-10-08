/**
 * Phone mirrors (2026-08-30) — the pins: HTTP wins over the NAS, a dead
 * backend falls back to the NAS, a torn payload never replaces a good
 * mirror, and audio pulls are identity-addressed, path-gated, and never
 * overwrite.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtemp, writeFile, readFile, mkdir, stat, utimes } from 'fs/promises'
import { refreshPhoneMirrors, ensureMobileImportAudio } from '../phone-mirrors.ts'

const httpServing = (payload: Record<string, { mtimeMs: number; body: string }>) => (async (url: string) => {
  const name = decodeURIComponent(String(url).split('/phone-sidecars/')[1] || '')
  if (payload[name]) return { ok: true, json: async () => ({ name, ...payload[name] }) }
  return { ok: false, status: 404 }
}) as unknown as typeof fetch

const deadFetch = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch

describe('refreshPhoneMirrors', () => {
  test('HTTP-first: a fresher backend copy lands locally, NAS never touched', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pm-'))
    let nasProbed = false
    const refreshed = await refreshPhoneMirrors({
      files: ['mobile-imports.json'],
      localDir: dir, nasDir: join(dir, 'nas-nonexistent'),
      backendUrl: 'http://hub',
      nasAvailable: async () => { nasProbed = true; return true },
      fetchFn: httpServing({ 'mobile-imports.json': { mtimeMs: Date.now(), body: '{"tracks":[{"id":1}]}' } }),
    })
    assert.deepEqual(refreshed, ['mobile-imports.json'])
    assert.equal(JSON.parse(await readFile(join(dir, 'mobile-imports.json'), 'utf-8')).tracks.length, 1)
    assert.equal(nasProbed, false, 'HTTP answered — the flappy mount must not be touched')
  })

  test('an already-current mirror is left alone (HTTP authoritative)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pm-'))
    await writeFile(join(dir, 'mobile-imports.json'), '{"tracks":[]}')
    const refreshed = await refreshPhoneMirrors({
      files: ['mobile-imports.json'], localDir: dir, nasDir: '/nonexistent',
      backendUrl: 'http://hub', nasAvailable: async () => true,
      fetchFn: httpServing({ 'mobile-imports.json': { mtimeMs: 1000, body: '{"tracks":[{"id":9}]}' } }),
    })
    assert.deepEqual(refreshed, [], 'older backend mtime must not clobber the local mirror')
  })

  test('backend dead → NAS fallback still refreshes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pm-'))
    const nas = join(dir, 'nas'); await mkdir(nas)
    await writeFile(join(nas, 'mobile-imports.json'), '{"tracks":[{"id":7}]}')
    const refreshed = await refreshPhoneMirrors({
      files: ['mobile-imports.json'], localDir: dir, nasDir: nas,
      backendUrl: 'http://hub', nasAvailable: async () => true, fetchFn: deadFetch,
    })
    assert.deepEqual(refreshed, ['mobile-imports.json'])
  })

  test('a TORN payload never replaces a good mirror', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pm-'))
    await writeFile(join(dir, 'mobile-imports.json'), '{"tracks":[{"id":1}]}')
    await utimes(join(dir, 'mobile-imports.json'), new Date(0), new Date(0))
    const refreshed = await refreshPhoneMirrors({
      files: ['mobile-imports.json'], localDir: dir, nasDir: '/nonexistent',
      backendUrl: 'http://hub', nasAvailable: async () => false,
      fetchFn: httpServing({ 'mobile-imports.json': { mtimeMs: Date.now(), body: '{"tracks": TORN' } }),
    })
    assert.deepEqual(refreshed, [])
    assert.equal(JSON.parse(await readFile(join(dir, 'mobile-imports.json'), 'utf-8')).tracks[0].id, 1)
  })
})

describe('ensureMobileImportAudio', () => {
  const audioFetch = (bytes: Buffer) => (async () => ({
    ok: true,
    headers: { get: (k: string) => k.toLowerCase() === 'content-length' ? String(bytes.length) : null },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
  })) as unknown as typeof fetch

  test('pulls a missing file to the row\'s own path; never overwrites an existing one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lib-'))
    const rows = [{ id: 10915, path: ':iPod_Control:Music:F15:imported_10915.flac', title: 'Crayola' }]
    const n = await ensureMobileImportAudio(rows, { libraryRoot: root, backendUrl: 'http://hub', fetchFn: audioFetch(Buffer.alloc(4096, 3)), log: () => {} })
    assert.equal(n, 1)
    const dest = join(root, 'iPod_Control/Music/F15/imported_10915.flac')
    assert.equal((await stat(dest)).size, 4096)
    const again = await ensureMobileImportAudio(rows, { libraryRoot: root, backendUrl: 'http://hub', fetchFn: deadFetch, log: () => {} })
    assert.equal(again, 0, 'existing file → no fetch, no overwrite')
  })

  test('path gate: traversal and non-library paths are refused outright', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lib-'))
    const rows = [
      { id: 1, path: ':iPod_Control:..:..:etc:passwd' },
      { id: 2, path: '/etc/passwd' },
    ]
    let fetched = false
    const spy = (async () => { fetched = true; return { ok: false, status: 500 } }) as unknown as typeof fetch
    const n = await ensureMobileImportAudio(rows, { libraryRoot: root, backendUrl: 'http://hub', fetchFn: spy, log: () => {} })
    assert.equal(n, 0)
    assert.equal(fetched, false, 'a bad path must not even reach the network')
  })

  test('a short read is refused — no torn audio on disk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lib-'))
    const short = (async () => ({
      ok: true,
      headers: { get: () => '99999' },
      arrayBuffer: async () => Buffer.alloc(10).buffer,
    })) as unknown as typeof fetch
    const n = await ensureMobileImportAudio([{ id: 5, path: ':iPod_Control:Music:F01:x.flac' }], { libraryRoot: root, backendUrl: 'http://hub', fetchFn: short, log: () => {} })
    assert.equal(n, 0)
    await assert.rejects(() => stat(join(root, 'iPod_Control/Music/F01/x.flac')))
  })
})
