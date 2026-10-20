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

  // 2026-10-20 (#209 testing): the mirror's mtime is when WE wrote it, so a
  // phone edit landing <1s later failed "source > local + 1s" — and stayed
  // invisible until the phone touched that file again.
  test('HTTP: a source edit landing <1s after a mirror write lands on the next pass', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pm-'))
    const name = 'playlist-additions.json'
    const payload = { [name]: { mtimeMs: Date.now() - 60_000, body: '{"additions":[]}' } }
    const deps = { files: [name], localDir: dir, nasDir: '/nonexistent', backendUrl: 'http://hub', nasAvailable: async () => false, fetchFn: httpServing(payload) }
    assert.deepEqual(await refreshPhoneMirrors(deps), [name])
    const mirroredAt = (await stat(join(dir, name))).mtimeMs
    payload[name] = { mtimeMs: mirroredAt + 100, body: '{"additions":[{"playlistId":"p1","trackId":"42"}]}' }
    assert.deepEqual(await refreshPhoneMirrors(deps), [name], 'the edit 100 ms after the mirror write must not be skipped')
    assert.equal(JSON.parse(await readFile(join(dir, name), 'utf-8')).additions[0].trackId, '42')
    assert.deepEqual(await refreshPhoneMirrors(deps), [], 'unchanged source → no rewrite')
  })

  test('NAS: a source edit landing <1s after a mirror write lands on the next pass', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pm-'))
    const nas = join(dir, 'nas'); await mkdir(nas)
    const name = 'mobile-playlists.json'
    await writeFile(join(nas, name), '{"playlists":[]}')
    await utimes(join(nas, name), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
    const deps = { files: [name], localDir: dir, nasDir: nas, backendUrl: 'http://hub', nasAvailable: async () => true, fetchFn: deadFetch }
    assert.deepEqual(await refreshPhoneMirrors(deps), [name])
    const mirroredAt = (await stat(join(dir, name))).mtimeMs
    await writeFile(join(nas, name), '{"playlists":[{"id":"p1","name":"New","trackIds":[]}]}')
    await utimes(join(nas, name), new Date(mirroredAt + 100), new Date(mirroredAt + 100))
    assert.deepEqual(await refreshPhoneMirrors(deps), [name])
    assert.equal(JSON.parse(await readFile(join(dir, name), 'utf-8')).playlists[0].id, 'p1')
  })

  test('source clock behind ours: every newer source version still lands; an older one never rolls back', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pm-'))
    const name = 'mobile-imports.json'
    const payload = { [name]: { mtimeMs: 1000, body: '{"tracks":[]}' } }
    const deps = { files: [name], localDir: dir, nasDir: '/nonexistent', backendUrl: 'http://hub', nasAvailable: async () => false, fetchFn: httpServing(payload) }
    assert.deepEqual(await refreshPhoneMirrors(deps), [name])
    payload[name] = { mtimeMs: 2000, body: '{"tracks":[{"id":2}]}' }
    assert.deepEqual(await refreshPhoneMirrors(deps), [name], 'newer than what we mirrored, even though far older than our write')
    payload[name] = { mtimeMs: 1500, body: '{"tracks":[{"id":1}]}' }
    assert.deepEqual(await refreshPhoneMirrors(deps), [], 'an older source copy must not replace a newer mirror')
    assert.equal(JSON.parse(await readFile(join(dir, name), 'utf-8')).tracks[0].id, 2)
  })

  test('a local write by the app (mobile-stars.json) keeps the old guard — never easier to replace', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pm-'))
    const name = 'mobile-stars.json'
    const t0 = Date.now() - 60_000
    const payload = { [name]: { mtimeMs: t0, body: '{"trackIds":["1"]}' } }
    const deps = { files: [name], localDir: dir, nasDir: '/nonexistent', backendUrl: 'http://hub', nasAvailable: async () => false, fetchFn: httpServing(payload) }
    assert.deepEqual(await refreshPhoneMirrors(deps), [name])
    // The app's star cache flushes its own copy after the mirror.
    const appWroteAt = t0 + 30_000
    await writeFile(join(dir, name), '{"trackIds":["1","7"]}')
    await utimes(join(dir, name), new Date(appWroteAt), new Date(appWroteAt))
    // A source edit newer than what we mirrored but not clearly newer than the app's write.
    payload[name] = { mtimeMs: appWroteAt + 500, body: '{"trackIds":["1","9"]}' }
    assert.deepEqual(await refreshPhoneMirrors(deps), [])
    assert.deepEqual(JSON.parse(await readFile(join(dir, name), 'utf-8')).trackIds, ['1', '7'])
    payload[name] = { mtimeMs: appWroteAt + 2000, body: '{"trackIds":["1","9"]}' }
    assert.deepEqual(await refreshPhoneMirrors(deps), [name], 'clearly newer than the app write → same as before')
  })

  test('an unreadable sources record falls back to the old guard, then heals', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pm-'))
    const name = 'mobile-plays.json'
    await writeFile(join(dir, 'phone-mirrors-sources.json'), '{ torn')   // the V3-private record
    const payload = { [name]: { mtimeMs: Date.now() + 5000, body: '{"plays":{}}' } }
    const deps = { files: [name], localDir: dir, nasDir: '/nonexistent', backendUrl: 'http://hub', nasAvailable: async () => false, fetchFn: httpServing(payload) }
    await writeFile(join(dir, name), '{"plays":{"old":1}}')
    assert.deepEqual(await refreshPhoneMirrors(deps), [name])
    assert.ok(JSON.parse(await readFile(join(dir, 'phone-mirrors-sources.json'), 'utf-8'))[name], 'record rewritten after a refresh')
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

// 2026-10-20 — mobile-stars.json is MERGED, never copied over the local file:
// the copy wiped every star workmini made that homemini did not have yet.
describe('refreshPhoneMirrors: merged files are never copied over', () => {
  test('a newer source is handed to the merger; the local file is untouched and not reported', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pm-'))
    await writeFile(join(dir, 'mobile-stars.json'), '{"v":2,"trackIds":["11952"],"removed":{},"added":{"11952":5}}')
    const merged: string[] = []
    const refreshed = await refreshPhoneMirrors({
      files: ['mobile-stars.json'], localDir: dir, nasDir: '/nonexistent',
      backendUrl: 'http://hub', nasAvailable: async () => true,
      fetchFn: httpServing({ 'mobile-stars.json': { mtimeMs: Date.now() + 60_000, body: '{"v":2,"trackIds":["1"],"removed":{},"added":{}}' } }),
      merge: { 'mobile-stars.json': async (body) => { merged.push(body) } },
    })
    assert.deepEqual(refreshed, [], 'not reported — no cache is dropped under the merger\'s pending write')
    assert.equal(merged.length, 1)
    assert.match(await readFile(join(dir, 'mobile-stars.json'), 'utf-8'), /11952/, 'the local star survives')
  })

  test('an OLDER source still merges (its tombstones and stars count); the same source merges once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pm-'))
    await writeFile(join(dir, 'mobile-stars.json'), '{"trackIds":[]}')
    let n = 0
    const deps = {
      files: ['mobile-stars.json'], localDir: dir, nasDir: '/nonexistent',
      backendUrl: 'http://hub', nasAvailable: async () => true,
      fetchFn: httpServing({ 'mobile-stars.json': { mtimeMs: 1000, body: '{"trackIds":["9"]}' } }),
      merge: { 'mobile-stars.json': async () => { n++ } },
    }
    await refreshPhoneMirrors(deps)
    await refreshPhoneMirrors(deps)
    assert.equal(n, 1)
  })

  test('a torn payload never reaches the merger (NAS fallback gets its turn)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pm-'))
    let n = 0
    await refreshPhoneMirrors({
      files: ['mobile-stars.json'], localDir: dir, nasDir: '/nonexistent',
      backendUrl: 'http://hub', nasAvailable: async () => false,
      fetchFn: httpServing({ 'mobile-stars.json': { mtimeMs: 77, body: '{"trackIds":["9"' } }),
      merge: { 'mobile-stars.json': async () => { n++ } },
    })
    assert.equal(n, 0)
  })
})
