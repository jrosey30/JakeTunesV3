import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseHubPoolBody, HUB_POOL_PLAYLIST_ID } from '../../common/hub-pool.ts'
import { createHubPoolMirror, HUB_POOL_FILE } from '../hub-pool-mirror.ts'

const body = (ids: Array<number | string>) => ({ id: HUB_POOL_PLAYLIST_ID, name: 'iPod Pool', tracks: ids.map((id) => ({ id })) })
const resp = (status: number, json?: unknown) =>
  ({ status, ok: status >= 200 && status < 300, json: async () => json }) as unknown as Response

describe('parseHubPoolBody: the phone\'s iPod Pool playlist, read by a replica', () => {
  it('keeps the hub\'s order, takes string or number ids, drops dupes and junk', () => {
    assert.deepEqual(parseHubPoolBody(body([5, '3', 5, 'x', '', 9])), [5, 3, 9])
  })
  it('refuses anything that is not a playlist body', () => {
    assert.equal(parseHubPoolBody(null), null)
    assert.equal(parseHubPoolBody('<html>'), null)
    assert.equal(parseHubPoolBody({ error: 'nope' }), null)
  })
  it('uses the phone\'s playlist id (NOT the iPod\'s own ipod-pool)', () => {
    assert.equal(HUB_POOL_PLAYLIST_ID, 'jaketunes-ipod-pool')
  })
})

describe('createHubPoolMirror', () => {
  const setup = async () => ({ dir: await mkdtemp(join(tmpdir(), 'hubpool-')) })

  it('is inert on the hub itself (not a replica): no fetch, null', async () => {
    const { dir } = await setup()
    let called = 0
    const m = createHubPoolMirror({ stateDir: dir, hubBase: async () => null, fetchImpl: (async () => { called++; return resp(200) }) as never })
    assert.equal(await m.get(), null)
    assert.equal(called, 0)
  })

  it('GETs the hub\'s pool playlist and returns its ids in order; writes only its own file', async () => {
    const { dir } = await setup()
    await writeFile(join(dir, 'activity-pool.json'), '{"ids":[1,2,3]}')
    const urls: string[] = []
    const inits: Array<RequestInit | undefined> = []
    const m = createHubPoolMirror({
      stateDir: dir, hubBase: async () => 'http://hub:3000',
      fetchImpl: (async (u: string, init?: RequestInit) => { urls.push(u); inits.push(init); return resp(200, body([30, 10, 20])) }) as never,
    })
    assert.deepEqual(await m.get(), [30, 10, 20])
    assert.deepEqual(urls, ['http://hub:3000/api/playlists/jaketunes-ipod-pool'])
    assert.notEqual(inits[0]?.method, 'POST')
    assert.equal(await readFile(join(dir, 'activity-pool.json'), 'utf-8'), '{"ids":[1,2,3]}')   // never touched
    assert.deepEqual(JSON.parse(await readFile(join(dir, HUB_POOL_FILE), 'utf-8')).ids, [30, 10, 20])
  })

  it('caches within the TTL, refetches after it', async () => {
    const { dir } = await setup()
    let n = 0; let t = 0
    const m = createHubPoolMirror({
      stateDir: dir, hubBase: async () => 'http://hub', ttlMs: 1000, now: () => t,
      fetchImpl: (async () => { n++; return resp(200, body([n])) }) as never,
    })
    assert.deepEqual(await m.get(), [1]); t = 500
    assert.deepEqual(await m.get(), [1]); t = 1500
    assert.deepEqual(await m.get(), [2])
  })

  it('hub unreachable or erroring: keeps the last good list (never blanks the pool)', async () => {
    const { dir } = await setup()
    let mode: 'ok' | 'throw' | '500' | 'junk' = 'ok'; let t = 0
    const m = createHubPoolMirror({
      stateDir: dir, hubBase: async () => 'http://hub', ttlMs: 10, now: () => t,
      fetchImpl: (async () => {
        if (mode === 'throw') throw new Error('ECONNREFUSED')
        if (mode === '500') return resp(500)
        if (mode === 'junk') return resp(200, { surprise: true })
        return resp(200, body([7, 8]))
      }) as never,
    })
    assert.deepEqual(await m.get(), [7, 8])
    for (const next of ['throw', '500', 'junk'] as const) { mode = next; t += 100; assert.deepEqual(await m.get(), [7, 8]) }
  })

  it('cold start offline: serves the last mirrored copy from disk', async () => {
    const { dir } = await setup()
    await writeFile(join(dir, HUB_POOL_FILE), JSON.stringify({ ids: [4, 5, 6] }))
    const m = createHubPoolMirror({ stateDir: dir, hubBase: async () => 'http://hub', fetchImpl: (async () => { throw new Error('offline') }) as never })
    assert.deepEqual(await m.get(), [4, 5, 6])
  })

  it('a 404 is the hub saying the pool is empty', async () => {
    const { dir } = await setup()
    let status = 200; let t = 0
    const m = createHubPoolMirror({
      stateDir: dir, hubBase: async () => 'http://hub', ttlMs: 1, now: () => t,
      fetchImpl: (async () => status === 200 ? resp(200, body([1])) : resp(404, { error: 'Playlist not found' })) as never,
    })
    assert.deepEqual(await m.get(), [1]); status = 404; t += 10
    assert.deepEqual(await m.get(), [])
  })

  it('leaves no temp files behind', async () => {
    const { dir } = await setup()
    const m = createHubPoolMirror({ stateDir: dir, hubBase: async () => 'http://hub', fetchImpl: (async () => resp(200, body([1]))) as never })
    await m.get()
    assert.deepEqual((await readdir(dir)).sort(), [HUB_POOL_FILE])
  })
})

describe('replica pool is display-only (wiring locks)', () => {
  const ipc = readFileSync(new URL('../ipc/activity-pool-ipc.ts', import.meta.url), 'utf-8')
  it('every editing handler refuses on a replica before touching the file', () => {
    for (const ch of ['activity-pool-swap', 'activity-pool-add', 'activity-pool-remove', 'activity-pool-clear']) {
      const i = ipc.indexOf(`'${ch}'`)
      assert.ok(i > 0, ch)
      const head = ipc.slice(i, i + 400)
      assert.ok(/replicaIds\(\)\) return \{ ok: false/.test(head), `${ch} must refuse on a replica`)
    }
  })
  it('the mirror module never writes activity-pool.json', () => {
    const src = readFileSync(new URL('../hub-pool-mirror.ts', import.meta.url), 'utf-8')
    assert.ok(!/['"`]activity-pool\.json/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')))
  })
})
