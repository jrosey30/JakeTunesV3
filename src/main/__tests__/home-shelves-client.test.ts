// Home shelves client (src/main/home-shelves-client.ts) — the three rows under
// launch page "G". A fake homemini for every branch: first fetch + cache, the
// If-None-Match → 304 poll, offline with a cache, offline with nothing (the
// renderer then builds local rows), a stale cache, a reply that isn't a
// document, the route not deployed yet, and the change push.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createHomeShelvesClient, HOME_SHELVES_CACHE_FILE, MAX_CACHE_AGE_MS, type FetchLike,
} from '../home-shelves-client.ts'
import type { HomeShelvesState } from '../../common/home-shelves-doc.ts'

const NOW = Date.UTC(2026, 9, 20, 16)

const REMOTE = {
  version: 1,
  generatedAt: '2026-10-20T15:50:00.000Z',
  day: '2026-10-20',
  listenMore: { items: [{ track: { id: 6011, title: 'Inside Us All' }, reason: 'You starred “Higher” on this album' }] },
  listeningALot: { windowDays: 30, items: [{ track: { id: 1 }, plays: 7, lastPlayedAt: '2026-10-17T15:13:00.000Z' }] },
  recentlyAdded: { items: [{ album: { artist: 'Gooseberry', album: 'Simple Sucker' }, dateAdded: '2026-10-19T19:11:00.000Z', trackIds: [21, 22] }], playlist: { id: 'ipod-recently-added', name: 'Recently Added' } },
}

interface Hub {
  mode: 'up' | 'down' | 'missing' | 'garbage'
  body: unknown
  etag: string
  calls: Array<{ url: string; ifNoneMatch: string | null }>
}

function headerOf(init: Record<string, unknown> | undefined, name: string): string | null {
  const h = init?.headers as Headers | Record<string, string> | undefined
  if (!h) return null
  if (typeof (h as Headers).get === 'function') return (h as Headers).get(name)
  const hit = Object.entries(h).find(([k]) => k.toLowerCase() === name.toLowerCase())
  return hit ? hit[1] : null
}

function fakeFetch(hub: Hub): FetchLike {
  return async (url, init) => {
    const inm = headerOf(init, 'If-None-Match')
    hub.calls.push({ url, ifNoneMatch: inm })
    if (hub.mode === 'down') throw new Error('connect ECONNREFUSED')
    if (hub.mode === 'missing') return { ok: false, status: 404, json: async () => ({ error: 'not found' }) }
    if (hub.mode === 'garbage') return { ok: true, status: 200, json: async () => '<html>proxy</html>' }
    if (inm === hub.etag) return { ok: false, status: 304, json: async () => null }
    return { ok: true, status: 200, json: async () => hub.body, headers: { get: (n: string) => (n.toLowerCase() === 'etag' ? hub.etag : null) } }
  }
}

describe('home shelves client', () => {
  let dir = ''
  let clock = NOW
  let hub: Hub
  const make = () => createHomeShelvesClient({
    baseUrl: 'http://homemini:3000/', dir, fetchImpl: fakeFetch(hub), now: () => clock, log: () => {}, warn: () => {},
  })
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'home-shelves-'))
    clock = NOW
    hub = { mode: 'up', body: REMOTE, etag: '"e1"', calls: [] }
  })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('first fetch draws homemini\'s document and caches it; the next poll is a conditional 304', async () => {
    const c = make()
    const s = await c.refresh()
    assert.equal(s.source, 'homemini')
    assert.equal(hub.calls[0]!.url, 'http://homemini:3000/api/home-shelves')
    assert.equal(hub.calls[0]!.ifNoneMatch, null)
    assert.deepEqual(s.doc?.listenMore, [{ id: 6011, reason: 'You starred “Higher” on this album' }])
    assert.deepEqual(s.doc?.recentlyAdded[0]?.trackIds, [21, 22])
    const cached = JSON.parse(await readFile(join(dir, HOME_SHELVES_CACHE_FILE), 'utf-8')) as { etag: string }
    assert.equal(cached.etag, '"e1"')
    clock += 60_000
    const again = await c.refresh()
    assert.equal(hub.calls[1]!.ifNoneMatch, '"e1"')
    assert.equal(again.source, 'homemini')
    assert.equal(again.fetchedAt, clock, 'a 304 restarts the cache\'s age')
    assert.deepEqual((await c.read()).doc, s.doc, 'the re-written cache still reads as the same rows')
  })

  it('homemini away: the cache draws while it is under a day old, then nothing (the renderer goes local)', async () => {
    await make().refresh()
    hub.mode = 'down'
    const c = make()
    clock += 3_600_000
    const s = await c.refresh()
    assert.equal(s.source, 'cache')
    assert.equal(s.reachable, false)
    assert.equal(s.doc?.listeningALot[0]?.plays, 7)
    clock = NOW + MAX_CACHE_AGE_MS + 1
    const stale = await c.refresh()
    assert.deepEqual(stale, { doc: null, source: 'none', reachable: false, fetchedAt: null })
  })

  it('never cached and unreachable → none (read() never touches the network)', async () => {
    hub.mode = 'down'
    const c = make()
    assert.deepEqual(await c.read(), { doc: null, source: 'none', reachable: null, fetchedAt: null })
    assert.equal(hub.calls.length, 0)
    assert.equal((await c.refresh()).source, 'none')
  })

  it('a reply that is not a document, or a route not deployed yet, never replaces a good cache', async () => {
    await make().refresh()
    for (const mode of ['garbage', 'missing'] as const) {
      hub.mode = mode
      const s = await make().refresh()
      assert.equal(s.source, 'cache', mode)
      assert.equal(s.doc?.listenMore?.[0]?.id, 6011, mode)
    }
    await writeFile(join(dir, HOME_SHELVES_CACHE_FILE), '{"doc": tor')
    hub.mode = 'down'
    assert.equal((await make().read()).source, 'none', 'a torn cache file reads as absent')
  })

  it('onChange fires when what to draw changes, not on every poll', async () => {
    const c = make()
    const seen: HomeShelvesState[] = []
    c.onChange((s) => seen.push(s))
    await c.refresh()
    clock += 60_000
    await c.refresh()
    assert.equal(seen.length, 1)
    hub.body = { ...REMOTE, listeningALot: { windowDays: 30, items: [{ track: { id: 1 }, plays: 8 }] } }
    hub.etag = '"e2"'
    await c.refresh()
    assert.equal(seen.length, 2)
    assert.equal(seen[1]!.doc?.listeningALot[0]?.plays, 8)
  })
})
