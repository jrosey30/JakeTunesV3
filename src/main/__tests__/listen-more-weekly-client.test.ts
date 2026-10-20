// Listen More Weekly client (src/main/listen-more-weekly-client.ts) — the
// desktop's copy of homemini's weekly playlist. A fake homemini for every
// branch: first fetch + cache, offline with a cache, a stale cache, the route
// not deployed yet, a reply that isn't the playlist, and the change push.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createListenMoreWeeklyClient, parseWeeklyPlaylist, LISTEN_MORE_WEEKLY_CACHE_FILE, LISTEN_MORE_WEEKLY_PATH,
  MAX_CACHE_AGE_MS, type FetchLike, type ListenMoreWeeklyState,
} from '../listen-more-weekly-client.ts'

const NOW = Date.UTC(2026, 9, 20, 16)
const REMOTE = { id: 'jaketunes-listen-more-weekly', name: 'Listen More Weekly', tracks: [{ id: 2436, title: 'On Mercury' }, { id: '512' }, { id: 77 }] }

interface Hub { mode: 'up' | 'down' | 'missing' | 'garbage'; body: unknown; urls: string[] }

function fakeFetch(hub: Hub): FetchLike {
  return async (url) => {
    hub.urls.push(url)
    if (hub.mode === 'down') throw new Error('connect ECONNREFUSED')
    if (hub.mode === 'missing') return { ok: false, status: 404, json: async () => ({ error: 'Playlist not found' }) }
    if (hub.mode === 'garbage') return { ok: true, status: 200, json: async () => '<html>proxy</html>' }
    return { ok: true, status: 200, json: async () => hub.body }
  }
}

describe('listen more weekly client', () => {
  let dir = ''
  let clock = NOW
  let hub: Hub
  const make = () => createListenMoreWeeklyClient({ baseUrl: 'http://homemini:3000/', dir, fetchImpl: fakeFetch(hub), now: () => clock, warn: () => {} })

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lmw-'))
    clock = NOW
    hub = { mode: 'up', body: REMOTE, urls: [] }
  })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('parses the playlist reply: ids in order, numeric, de-duplicated; nothing usable → null', () => {
    assert.deepEqual(parseWeeklyPlaylist(REMOTE), { name: 'Listen More Weekly', trackIds: [2436, 512, 77] })
    assert.deepEqual(parseWeeklyPlaylist({ tracks: [{ id: 5 }, { id: 5 }, { id: 'x' }, { id: -1 }] })?.trackIds, [5])
    assert.equal(parseWeeklyPlaylist({ tracks: [] }), null)
    assert.equal(parseWeeklyPlaylist('<html>'), null)
    assert.equal(parseWeeklyPlaylist({ error: 'Playlist not found' }), null)
  })

  it('first refresh fetches the weekly playlist from homemini and caches it', async () => {
    const c = make()
    assert.deepEqual(await c.read(), { playlist: null, source: 'none', fetchedAt: null }, 'nothing before the first answer')
    const s = await c.refresh()
    assert.equal(hub.urls[0], `http://homemini:3000${LISTEN_MORE_WEEKLY_PATH}`)
    assert.equal(s.source, 'homemini')
    assert.deepEqual(s.playlist?.trackIds, [2436, 512, 77])
    const cached = JSON.parse(await readFile(join(dir, LISTEN_MORE_WEEKLY_CACHE_FILE), 'utf-8'))
    assert.deepEqual(cached.playlist.trackIds, [2436, 512, 77])
  })

  it('homemini away: the cached week is drawn (source cache) until it is over a week old', async () => {
    await make().refresh()
    hub.mode = 'down'
    const c = make()
    const s = await c.refresh()
    assert.equal(s.source, 'cache')
    assert.deepEqual(s.playlist?.trackIds, [2436, 512, 77])
    clock = NOW + MAX_CACHE_AGE_MS + 1
    assert.deepEqual(await c.read(), { playlist: null, source: 'none', fetchedAt: null }, 'a stale week is dropped')
  })

  it('a 404 or a reply that is not the playlist never replaces a good cache', async () => {
    await make().refresh()
    for (const mode of ['missing', 'garbage'] as const) {
      hub.mode = mode
      const s = await make().refresh()
      assert.deepEqual(s.playlist?.trackIds, [2436, 512, 77], mode)
      assert.equal(s.source, 'cache', mode)
    }
  })

  it('pushes a change once when the week changes, not on every poll', async () => {
    const c = make()
    const seen: ListenMoreWeeklyState[] = []
    c.onChange((s) => seen.push(s))
    await c.refresh()
    await c.refresh()
    assert.equal(seen.length, 1)
    hub.body = { ...REMOTE, tracks: [{ id: 9 }] }
    await c.refresh()
    assert.equal(seen.length, 2)
    assert.deepEqual(seen[1]!.playlist?.trackIds, [9])
  })
})
