// Home spotlight client (src/main/home-spotlight-client.ts) — launch page "G".
// A fake homemini for every branch: first fetch + cache, the If-None-Match →
// 304 poll, offline with a cache, offline with nothing cached (this Mac's own
// history through the rulebook), a stale cache, a reply that isn't a
// document, the route not deployed yet, coalescing, and the change push.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createHomeSpotlightClient, HOME_SPOTLIGHT_CACHE_FILE, MAX_CACHE_AGE_MS, type FetchLike,
} from '../home-spotlight-client.ts'
import { localSpotlightDoc, type HomeSpotlightDoc, type HomeSpotlightState } from '../../common/home-spotlight-doc.ts'
import { DAY_MS, type SpotTrack, type SpotPlay } from '../../common/home-spotlight.ts'

const NOW = Date.UTC(2026, 9, 18, 22, 0, 0)

const REMOTE = {
  version: 1,
  generatedAt: '2026-10-18T21:55:00.000Z',
  livingIn: { artist: 'Geese', album: 'Getting Killed', artworkHash: 'abc123', plays: 41, windowDays: 14 },
  spotlight: {
    artist: 'Geese', plays30: 81, topSong: { title: 'Taxes', plays: 22 }, firstHeard: '2026-08-09T12:00:00.000Z',
    days: Array.from({ length: 30 }, (_, i) => i % 4), headline: 'Geese has your attention.',
    statsLine: '81 plays in 30 days · “Taxes” on repeat · with you since Aug 9',
  },
  musicMan: { line: 'You keep coming back to Getting Killed. Tonight we do it properly — whole record, front to back.', generatedAt: '2026-10-18T21:55:00.000Z', source: 'ai' },
  nowDigging: [
    { artist: 'Geese', plays30: 81, days: Array.from({ length: 30 }, () => 2), firstHeard: '2026-08-09T12:00:00.000Z', topSong: { title: 'Taxes', plays: 22 }, debutYear: 2018, debutSource: 'musicbrainz' },
    { artist: 'beabadoobee', plays30: 16, days: [], firstHeard: '2026-07-01T12:00:00.000Z', topSong: { title: 'Nothing To Prove', plays: 5 }, debutYear: 2017, debutSource: 'musicbrainz' },
  ],
}

// This Mac's own history for the offline fallback: 6 plays of Hitachi in 3 days.
const LOCAL_TRACKS: SpotTrack[] = [
  { id: 4, title: 'Hitachi', artist: 'ADÉLA', album: 'Hitachi', dateAdded: '2026-09-05T12:00:00Z', year: 2026 },
]
const LOCAL_PLAYS: SpotPlay[] = Array.from({ length: 6 }, (_, i) => ({ id: 4, ts: NOW - (1 + (i % 3)) * DAY_MS }))

interface Hub {
  mode: 'up' | 'down' | 'missing' | 'garbage'
  body: unknown
  etag: string
  calls: Array<{ url: string; ifNoneMatch: string | null }>
  hold?: Promise<void>
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
    hub.calls.push({ url, ifNoneMatch: headerOf(init, 'If-None-Match') })
    if (hub.hold) await hub.hold
    if (hub.mode === 'down') throw new Error('connect ECONNREFUSED homemini:3000')
    if (hub.mode === 'missing') return { ok: false, status: 404, json: async () => ({ error: 'Not found' }) }
    if (hub.mode === 'garbage') return { ok: true, status: 200, json: async () => '<html>captive portal</html>', headers: { get: () => null } }
    if (headerOf(init, 'If-None-Match') === hub.etag) return { ok: false, status: 304, json: async () => null, headers: { get: (n) => (n.toLowerCase() === 'etag' ? hub.etag : null) } }
    return { ok: true, status: 200, json: async () => hub.body, headers: { get: (n) => (n.toLowerCase() === 'etag' ? hub.etag : null) } }
  }
}

describe('home spotlight client', () => {
  let dir: string
  let hub: Hub
  let clock: number
  let localCalls: number
  const make = () => createHomeSpotlightClient({
    baseUrl: 'http://homemini:3000/',
    dir,
    fetchImpl: fakeFetch(hub),
    now: () => clock,
    log: () => {},
    warn: () => {},
    computeLocal: async () => { localCalls++; return localSpotlightDoc(LOCAL_TRACKS, LOCAL_PLAYS, NOW) },
  })

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'home-spotlight-'))
    hub = { mode: 'up', body: REMOTE, etag: '"v1"', calls: [] }
    clock = NOW
    localCalls = 0
  })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('first refresh: GETs /api/home-spotlight, caches it with its ETag, draws homemini', async () => {
    const c = make()
    const s = await c.refresh()
    assert.equal(hub.calls[0].url, 'http://homemini:3000/api/home-spotlight')
    assert.equal(hub.calls[0].ifNoneMatch, null)
    assert.equal(s.source, 'homemini')
    assert.equal(s.reachable, true)
    assert.equal(s.doc?.livingIn?.album, 'Getting Killed')
    assert.deepEqual(s.doc?.spotlight?.topSong, { title: 'Taxes', plays: 22 })   // the backend's object shape
    assert.deepEqual(s.doc?.nowDigging[1].topSong, { title: 'Nothing To Prove', plays: 5 })
    assert.equal(s.doc?.livingIn?.artworkHash, 'abc123')
    assert.equal(s.doc?.musicMan?.source, 'ai')
    const file = JSON.parse(await readFile(join(dir, HOME_SPOTLIGHT_CACHE_FILE), 'utf-8'))
    assert.equal(file.etag, '"v1"')
    assert.equal(file.confirmedAt, NOW)
    assert.equal(localCalls, 0)
  })

  it('the poll sends If-None-Match; 304 keeps the cached document and restarts its age', async () => {
    const c = make()
    await c.refresh()
    clock = NOW + 10 * 60_000
    const s = await c.refresh()
    assert.equal(hub.calls[1].ifNoneMatch, '"v1"')
    assert.equal(s.source, 'homemini')
    assert.equal(s.doc?.spotlight?.headline, 'Geese has your attention.')
    const file = JSON.parse(await readFile(join(dir, HOME_SPOTLIGHT_CACHE_FILE), 'utf-8'))
    assert.equal(file.confirmedAt, NOW + 10 * 60_000)
  })

  it('a changed document replaces the cache (new ETag)', async () => {
    const c = make()
    await c.refresh()
    hub.body = { ...REMOTE, livingIn: { ...REMOTE.livingIn, album: '3D Country' } }
    hub.etag = '"v2"'
    const s = await c.refresh()
    assert.equal(s.doc?.livingIn?.album, '3D Country')
    const file = JSON.parse(await readFile(join(dir, HOME_SPOTLIGHT_CACHE_FILE), 'utf-8'))
    assert.equal(file.etag, '"v2"')
  })

  it('offline with a cache: draws the cached copy (a fresh client, as after a restart)', async () => {
    await make().refresh()
    hub.mode = 'down'
    const c = make()
    const before = await c.read()
    assert.equal(before.source, 'cache')                                    // no network yet this session
    const s = await c.refresh()
    assert.equal(s.source, 'cache')
    assert.equal(s.reachable, false)
    assert.equal(s.doc?.musicMan?.line.startsWith('You keep coming back'), true)
    assert.equal(localCalls, 0)
  })

  it('offline with nothing cached: this Mac’s own history through the rulebook, no Music Man', async () => {
    hub.mode = 'down'
    const s = await make().refresh()
    assert.equal(s.source, 'local')
    assert.equal(s.doc?.livingIn?.artist, 'ADÉLA')
    assert.equal(s.doc?.livingIn?.album, 'Hitachi')
    assert.equal(s.doc?.livingIn?.artworkHash, null)
    assert.equal(s.doc?.musicMan, null)
    assert.equal(s.doc?.spotlight?.statsLine, '6 plays in 30 days · “Hitachi” on repeat · with you since Sep 5')
    assert.equal(localCalls, 1)
  })

  it('the route not deployed yet (404) is the same fallback, and stays quiet with no history', async () => {
    hub.mode = 'missing'
    const c = createHomeSpotlightClient({
      baseUrl: 'http://homemini:3000', dir, fetchImpl: fakeFetch(hub), now: () => clock, log: () => {}, warn: () => {},
      computeLocal: async () => localSpotlightDoc(LOCAL_TRACKS, [], NOW),     // nothing played here
    })
    const s = await c.refresh()
    assert.deepEqual(s, { doc: null, source: 'none', reachable: false, fetchedAt: null } satisfies HomeSpotlightState)
  })

  it('a reply that is not a document never replaces a good cache', async () => {
    const c = make()
    await c.refresh()
    hub.mode = 'garbage'
    hub.etag = '"v9"'                                                       // so the 304 path can't answer
    const s = await c.refresh()
    assert.equal(s.source, 'cache')
    assert.equal(s.doc?.livingIn?.album, 'Getting Killed')
    hub.mode = 'up'
    hub.body = { ...REMOTE, version: 2 }                                    // an unknown version is not guessed at
    assert.equal((await c.refresh()).doc?.livingIn?.album, 'Getting Killed')
  })

  it('a cache homemini has not confirmed for over a week is stale facts → local', async () => {
    await make().refresh()
    hub.mode = 'down'
    clock = NOW + MAX_CACHE_AGE_MS + 1
    const s = await make().refresh()
    assert.equal(s.source, 'local')
    assert.equal(s.doc?.livingIn?.album, 'Hitachi')
  })

  it('a torn cache file is treated as absent', async () => {
    await writeFile(join(dir, HOME_SPOTLIGHT_CACHE_FILE), '{"doc": {"version": 1, "livingIn"')
    hub.mode = 'down'
    assert.equal((await make().read()).source, 'local')
  })

  it('refreshes coalesce into one GET; the change push fires once per real change', async () => {
    let release!: () => void
    hub.hold = new Promise<void>((r) => { release = r })
    const c = make()
    const seen: HomeSpotlightState[] = []
    c.onChange((s) => seen.push(s))
    const a = c.refresh()
    const b = c.refresh()
    release()
    const [sa, sb] = await Promise.all([a, b])
    assert.equal(hub.calls.length, 1)
    assert.equal(sa, sb)
    assert.equal(seen.length, 1)
    hub.hold = undefined
    clock += 60_000
    await c.refresh()                                                       // 304: nothing to redraw
    assert.equal(seen.length, 1)
    hub.mode = 'down'
    await c.refresh()                                                       // homemini → cache: the source changed
    assert.equal(seen.length, 2)
    assert.equal(seen[1].source, 'cache')
  })

  it('a throwing local fallback degrades to quiet, never a crash', async () => {
    hub.mode = 'down'
    const c = createHomeSpotlightClient({
      baseUrl: 'http://homemini:3000', dir, fetchImpl: fakeFetch(hub), now: () => clock, log: () => {}, warn: () => {},
      computeLocal: async (): Promise<HomeSpotlightDoc | null> => { throw new Error('library.json unreadable') },
    })
    assert.equal((await c.refresh()).source, 'none')
  })
})
