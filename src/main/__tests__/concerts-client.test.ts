// Concerts client (src/main/concerts-client.ts) — the fallback chain behind
// Home › Shows and the Music Man: homemini → the cached copy → this Mac's own
// Bandsintown + venue-calendar path (venues.ts) → an older cache → nothing.
// A fake homemini for each branch: first fetch + cache, the If-None-Match →
// 304 poll, offline with a cache, offline with nothing cached, a cache past
// its week, the 503 "warming up" answer, a reply that isn't a document,
// /discover failing alone, pruning a cached copy as days pass, coalescing,
// and the change push.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createConcertsClient, CONCERTS_CACHE_FILE, MAX_CACHE_AGE_MS, LEGACY_TTL_MS, type FetchLike,
} from '../concerts-client.ts'
import { legacyConcertItems, DAY_MS, type ConcertItem, type ConcertsFeedState } from '../../common/concerts-feed.ts'

/** Mon Oct 19 2026, noon in Brooklyn. */
const NOW = Date.UTC(2026, 9, 19, 16, 0, 0)

const item = (id: string, rank: number, date: string, artist: string, extra: Record<string, unknown> = {}) => ({
  id, name: artist, url: `https://tix.example/${id}`, date, time: '20:00:00', venue: 'Elsewhere', city: 'Brooklyn', state: 'NY',
  artists: [artist], rsvp: null, rank, tier: 3, reason: 'Heavy rotation: 7 plays in 90 days', matchedArtist: artist, matchRole: 'headliner',
  relatedTo: null, headliners: [artist], support: [], onSale: null, soldOut: false, justAnnounced: false, firstSeenAt: '2026-10-19T14:00:00.000Z',
  neighbourhood: 'Bushwick', northBrooklyn: true, room: null, links: [], runNights: 1, runDates: [date],
  runShows: [{ id, date, time: '20:00:00', url: `https://tix.example/${id}`, soldOut: false, onSale: null, rsvp: null, runIndex: 1 }],
  ...extra,
})
const CONCERTS = {
  items: [item('a', 1, '2026-10-23', 'Thundercat'), item('b', 2, '2026-10-21', 'After'), item('c', 3, '2026-11-12', 'Jalen Ngonda')],
  total: 3, discoverTotal: 1, generatedAt: '2026-10-19T14:06:37.315Z', home: { label: 'Williamsburg', lat: 40.71093, lng: -73.95203 },
}
const DISCOVER = { items: [item('d', 1, '2026-10-23', 'Friko', { tier: 7, relatedTo: ['Cameron Winter'], reason: "You'd like this: like Cameron Winter" })], total: 1, generatedAt: '2026-10-19T14:06:37.315Z' }

interface Hub {
  mode: 'up' | 'down' | 'warming' | 'garbage' | 'discover-down'
  concerts: unknown
  discover: unknown
  etag: string
  calls: Array<{ url: string; ifNoneMatch: string | null }>
  hold?: Promise<void>
}

function headerOf(init: Record<string, unknown> | undefined, name: string): string | null {
  const h = init?.headers as Record<string, string> | undefined
  if (!h) return null
  const hit = Object.entries(h).find(([k]) => k.toLowerCase() === name.toLowerCase())
  return hit ? hit[1] : null
}

function fakeFetch(hub: Hub): FetchLike {
  return async (url, init) => {
    hub.calls.push({ url, ifNoneMatch: headerOf(init, 'If-None-Match') })
    if (hub.hold) await hub.hold
    const isDiscover = url.endsWith('/api/concerts/discover')
    if (hub.mode === 'down') throw new Error('connect ECONNREFUSED homemini:3000')
    if (hub.mode === 'warming') return { ok: false, status: 503, json: async () => ({ error: 'Concerts are warming up …' }) }
    if (hub.mode === 'garbage') return { ok: true, status: 200, json: async () => '<html>captive portal</html>', headers: { get: () => null } }
    if (hub.mode === 'discover-down' && isDiscover) return { ok: false, status: 500, json: async () => ({ error: 'boom' }) }
    const etag = `${hub.etag}${isDiscover ? '-d' : ''}`
    const headers = { get: (n: string) => (n.toLowerCase() === 'etag' ? etag : null) }
    if (headerOf(init, 'If-None-Match') === etag) return { ok: false, status: 304, json: async () => null, headers }
    return { ok: true, status: 200, json: async () => (isDiscover ? hub.discover : hub.concerts), headers }
  }
}

const LEGACY_TOUR = [
  { artist: 'Geese', date: '2026-12-11T01:00:00.000Z', venue: 'Brooklyn Paramount', city: 'Brooklyn, NY', url: 'https://bit/1' },
  // Bandsintown reaches 18 mi into New Jersey; the rows are New York City only.
  { artist: 'Geese', date: '2026-11-06T00:00:00.000Z', venue: 'The Stone Pony', city: 'Asbury Park, NJ', url: 'https://bit/2' },
]
const LEGACY_VENUES = [{ artist: 'Chat Pile', date: '2026-11-10', venue: 'Brooklyn Steel', venueKey: 'brooklyn-steel', city: 'Brooklyn, NY', url: 'https://v/1', known: false }]

describe('concerts client — the fallback chain', () => {
  let dir: string
  let hub: Hub
  let clock: number
  let legacyCalls: number
  let legacyItems: () => ConcertItem[]
  const make = () => createConcertsClient({
    baseUrl: 'http://homemini:3000/',
    dir,
    fetchImpl: fakeFetch(hub),
    now: () => clock,
    log: () => {},
    warn: () => {},
    legacy: async () => { legacyCalls++; return legacyItems() },
  })
  const names = (s: ConcertsFeedState) => s.items.map((i) => i.name)

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'concerts-'))
    hub = { mode: 'up', concerts: CONCERTS, discover: DISCOVER, etag: 'W/"v1"', calls: [] }
    clock = NOW
    legacyCalls = 0
    legacyItems = () => legacyConcertItems(LEGACY_TOUR, LEGACY_VENUES, clock)
  })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('homemini: GETs both routes, caches them with their ETags, draws the ranked feed in its order', async () => {
    const s = await make().refresh()
    assert.deepEqual(hub.calls.map((c) => c.url).sort(), ['http://homemini:3000/api/concerts', 'http://homemini:3000/api/concerts/discover'])
    assert.equal(s.source, 'homemini')
    assert.equal(s.reachable, true)
    assert.deepEqual(names(s), ['After', 'Thundercat', 'Jalen Ngonda'], 'date order, not rank order (2026-10-28)')
    assert.deepEqual(s.discover.map((i) => i.name), ['Friko'])
    assert.equal(s.home, 'Williamsburg')
    const file = JSON.parse(await readFile(join(dir, CONCERTS_CACHE_FILE), 'utf-8'))
    assert.equal(file.concerts.etag, 'W/"v1"')
    assert.equal(file.discover.etag, 'W/"v1"-d')
    assert.equal(file.confirmedAt, NOW)
    assert.equal(legacyCalls, 0, 'the fallback is never asked while homemini answers')
  })

  it('the poll sends If-None-Match; a 304 keeps the cached copy and restarts its age', async () => {
    const c = make()
    await c.refresh()
    clock = NOW + 30 * 60_000
    const s = await c.refresh()
    assert.deepEqual(hub.calls.slice(2).map((x) => x.ifNoneMatch).sort(), ['W/"v1"', 'W/"v1"-d'])
    assert.equal(s.source, 'homemini')
    assert.deepEqual(names(s), ['After', 'Thundercat', 'Jalen Ngonda'])
    const file = JSON.parse(await readFile(join(dir, CONCERTS_CACHE_FILE), 'utf-8'))
    assert.equal(file.confirmedAt, NOW + 30 * 60_000)
  })

  it('homemini → cache: offline, the saved copy draws — not the fallback', async () => {
    await make().refresh()
    hub.mode = 'down'
    clock = NOW + 3 * DAY_MS                          // Thu Oct 22
    const c = make()                                  // a fresh launch
    const r = await c.read()
    assert.equal(r.source, 'cache')
    const s = await c.refresh()
    assert.equal(s.source, 'cache')
    assert.equal(s.reachable, false)
    assert.deepEqual(names(s), ['Thundercat', 'Jalen Ngonda'], "Oct 21's show has passed; the rest stay in date order")
    assert.deepEqual(s.discover.map((i) => i.name), ['Friko'])
    assert.equal(s.fetchedAt, NOW)
    assert.equal(legacyCalls, 0)
  })

  it('cache → venues.ts: offline with nothing saved, this Mac asks Bandsintown + the venue calendars', async () => {
    hub.mode = 'down'
    const c = make()
    assert.equal((await c.read()).source, 'none', 'read alone never touches the network')
    const s = await c.refresh()
    assert.equal(s.source, 'fallback')
    assert.deepEqual(names(s), ['Chat Pile', 'Geese'], 'by date; the Asbury Park date is not New York City')
    assert.deepEqual(s.items.map((i) => i.reason), ['At one of your rooms', 'In your library'])
    assert.deepEqual(s.discover, [])
    assert.equal(legacyCalls, 1)
    await c.refresh()
    assert.equal(legacyCalls, 1, `its answer is reused for ${LEGACY_TTL_MS / 60_000} minutes`)
    clock += LEGACY_TTL_MS + 1
    await c.refresh()
    assert.equal(legacyCalls, 2)
  })

  it('a cache past its week gives way to the fallback — and comes back if the fallback has nothing', async () => {
    await make().refresh()
    hub.mode = 'down'
    clock = NOW + MAX_CACHE_AGE_MS + 60_000           // Oct 26: Thundercat and After have passed
    const s = await make().refresh()
    assert.equal(s.source, 'fallback')
    assert.deepEqual(names(s), ['Chat Pile', 'Geese'], 'by date; the Asbury Park date is not New York City')

    legacyItems = () => []
    const t = await make().refresh()
    assert.equal(t.source, 'cache', 'an old copy beats an empty section')
    assert.deepEqual(names(t), ['Jalen Ngonda'])
  })

  it('nothing anywhere → none, and the section stays quiet', async () => {
    hub.mode = 'down'
    legacyItems = () => []
    const s = await make().refresh()
    assert.equal(s.source, 'none')
    assert.deepEqual(s.items, [])
  })

  it('a fallback that throws is the next step down, not a crash', async () => {
    hub.mode = 'down'
    const c = createConcertsClient({ baseUrl: 'http://homemini:3000', dir, fetchImpl: fakeFetch(hub), now: () => clock, log: () => {}, warn: () => {}, legacy: async () => { throw new Error('bandsintown 403') } })
    assert.equal((await c.refresh()).source, 'none')
  })

  it('503 "warming up" and a reply that is not a document never replace a good cache', async () => {
    await make().refresh()
    for (const mode of ['warming', 'garbage'] as const) {
      hub.mode = mode
      const s = await make().refresh()
      assert.equal(s.source, 'cache', mode)
      assert.deepEqual(names(s), ['After', 'Thundercat', 'Jalen Ngonda'], mode)
      assert.equal(legacyCalls, 0, `${mode}: a fresh cache means no fallback`)
    }
    const file = JSON.parse(await readFile(join(dir, CONCERTS_CACHE_FILE), 'utf-8'))
    assert.equal(file.confirmedAt, NOW, 'not re-confirmed by a bad answer')
  })

  it('503 with nothing cached goes to the fallback', async () => {
    hub.mode = 'warming'
    assert.equal((await make().refresh()).source, 'fallback')
  })

  it('/discover failing alone keeps the last "You\'d like this" and still counts as live', async () => {
    await make().refresh()
    hub.mode = 'discover-down'
    hub.concerts = { ...CONCERTS, items: [CONCERTS.items[2], CONCERTS.items[0]] }   // an older homemini, ranked
    hub.etag = 'W/"v2"'
    const s = await make().refresh()
    assert.equal(s.source, 'homemini')
    assert.deepEqual(names(s), ['Thundercat', 'Jalen Ngonda'], 'drawn by date whatever order the wire had')
    assert.deepEqual(s.discover.map((i) => i.name), ['Friko'])
  })

  it('/discover failing with nothing cached is an empty row, not a failure', async () => {
    hub.mode = 'discover-down'
    const s = await make().refresh()
    assert.equal(s.source, 'homemini')
    assert.equal(s.items.length, 3)
    assert.deepEqual(s.discover, [])
  })

  it('refreshes in flight are coalesced into one GET pair', async () => {
    let release!: () => void
    hub.hold = new Promise((r) => { release = r })
    const c = make()
    const a = c.refresh()
    const b = c.refresh()
    release()
    const [sa, sb] = await Promise.all([a, b])
    assert.equal(hub.calls.length, 2)
    assert.equal(sa, sb)
  })

  it('pushes a change once — a 304 that changes nothing does not redraw', async () => {
    const c = make()
    const seen: ConcertsFeedState[] = []
    c.onChange((s) => seen.push(s))
    await c.refresh()
    clock += 60_000
    await c.refresh()
    assert.equal(seen.length, 1)
    hub.concerts = { ...CONCERTS, items: CONCERTS.items.slice(0, 1) }
    hub.etag = 'W/"v3"'
    await c.refresh()
    assert.equal(seen.length, 2)
    assert.deepEqual(names(seen[1]), ['Thundercat'])
  })
})

describe('WIRING — the tested feed is the live one', () => {
  const read = (...p: string[]) => readFileSync(join(import.meta.dirname, '..', ...p), 'utf-8')
  it('index.ts registers the concerts IPC and hands the feed to the Music Man; the old channels are gone', () => {
    const idx = read('index.ts')
    assert.match(idx, /const concerts = registerConcertsIpc\(ipc, \{ libraryCache, mbThrottle \}\)/)
    assert.match(idx, /concertFeed: concerts\.forMusicMan,/)
    assert.doesNotMatch(idx, /'get-tour-dates'|'get-venue-shows'/)
  })
  it('the Record Store passes it through to the day-theme context, which narrows it with musicManShows', () => {
    assert.match(read('record-store', 'index.ts'), /concertFeed: deps\.concertFeed,/)
    assert.match(read('record-store', 'external-context.ts'), /musicManShows\(feedItems, now\.getTime\(\), \{ days: FEED_SHOW_WINDOW_DAYS, limit: FEED_SHOW_LIMIT \}\)/)
  })
  it('the Home draws HomeShows from concerts:get / concerts:refresh, and no concert label clips', () => {
    const home = read('..', 'renderer', 'views', 'HomeView.tsx')
    assert.match(home, /<HomeShows state=\{concerts\} openLink=\{openLink\} \/>/)
    assert.match(home, /window\.electronAPI\.concertsRefresh\?\.\(\)/)
    const preload = read('..', 'preload', 'index.ts')
    assert.match(preload, /ipcRenderer\.invoke\('concerts:get'\)/)
    assert.match(preload, /ipcRenderer\.invoke\('concerts:refresh'\)/)
    const css = read('..', 'renderer', 'styles', 'home.css')
    const rules = [...css.matchAll(/\.home-concert-[a-z-]+[^{]*\{[^}]*\}/g)].map((m) => m[0])
    assert.ok(rules.length >= 10, 'found the concert card rules')
    for (const r of rules) assert.doesNotMatch(r, /text-overflow|nowrap|line-clamp/, `names never clip: ${r.split('{')[0].trim()}`)
  })
})
