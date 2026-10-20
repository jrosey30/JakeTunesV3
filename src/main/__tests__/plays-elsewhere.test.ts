// Plays heard elsewhere (2026-10-20) — the phone's and workmini's plays count on
// this Mac too (Jake: "count all of them", tape songs included). Covers the
// contract (src/common/plays-elsewhere.ts), the client (main/plays-elsewhere-client.ts),
// and the lock that matters most: these plays are DISPLAY ONLY. homemini adds
// them to the counts this Mac publishes, so one saved here would count twice.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parsePlaysElsewhere, overlayOf, withPlaysElsewhere, windowedElsewhere, addWindowed,
  playsEverywhere, lastPlayedEverywhere, NO_PLAYS_ELSEWHERE,
} from '../../common/plays-elsewhere.ts'
import { createPlaysElsewhereClient, PLAYS_ELSEWHERE_CACHE_FILE, type FetchLike } from '../plays-elsewhere-client.ts'

const T = Date.UTC(2026, 9, 20, 17, 57)

// What homemini sends: workmini's tape today (Halftime, "316") + a phone play.
const REMOTE = {
  version: 1,
  counts: { '204': 3, '9179': 1, '14': 2 },
  plays: [
    { id: '204', ts: T, from: 'workmini' },
    { id: '9179', ts: T - 3_600_000, from: 'workmini' },
    { id: '14', ts: T - 86_400_000, from: 'phone' },
  ],
}

describe('plays elsewhere: the contract', () => {
  it('parses the route: string ids to numbers, oldest first', () => {
    const doc = parsePlaysElsewhere(REMOTE)
    assert.ok(doc)
    assert.deepEqual(doc.counts, { '204': 3, '9179': 1, '14': 2 })
    assert.deepEqual(doc.plays.map((p) => [p.id, p.from]), [[14, 'phone'], [9179, 'workmini'], [204, 'workmini']])
  })

  it('rejects what is not the document; drops bad rows, never guesses', () => {
    assert.equal(parsePlaysElsewhere({ ...REMOTE, version: 2 }), null)
    assert.equal(parsePlaysElsewhere('<html>proxy</html>'), null)
    assert.equal(parsePlaysElsewhere({ version: 1, counts: [], plays: [] }), null)
    const doc = parsePlaysElsewhere({
      version: 1,
      counts: { '5': 2, x: 3, '6': -1, '7': 1.5, '8': '4' },
      plays: [{ id: 'nope', ts: T }, { id: 5, ts: 'later' }, null, { id: 5, ts: T }],
    })
    assert.deepEqual(doc, { counts: { '5': 2 }, plays: [{ id: 5, ts: T, from: 'elsewhere' }] })
  })

  it('a song reads its count everywhere; last played is the later of the two', () => {
    const o = overlayOf(parsePlaysElsewhere(REMOTE))
    assert.equal(playsEverywhere({ id: 204, playCount: 10 }, o), 13)
    assert.equal(playsEverywhere({ id: 999, playCount: 4 }, o), 4)
    assert.equal(lastPlayedEverywhere({ id: 204, lastPlayedAt: T - 5 * 86_400_000 }, o), T)
    assert.equal(lastPlayedEverywhere({ id: 14, lastPlayedAt: T }, o), T, 'this Mac played it later')
  })

  it('withPlaysElsewhere: new objects only for songs that change, inputs untouched, same array when empty', () => {
    const tracks = [
      { id: 204, playCount: 1, lastPlayedAt: T - 9 * 86_400_000 },
      { id: 999, playCount: 4, lastPlayedAt: T },
    ]
    const before = JSON.stringify(tracks)
    const out = withPlaysElsewhere(tracks, overlayOf(parsePlaysElsewhere(REMOTE)))
    assert.deepEqual(out[0], { id: 204, playCount: 4, lastPlayedAt: T })
    assert.equal(out[1], tracks[1], 'untouched song keeps its identity')
    assert.equal(JSON.stringify(tracks), before, 'the library is never mutated')
    assert.equal(withPlaysElsewhere(tracks, NO_PLAYS_ELSEWHERE), tracks)
  })

  it("Top 25's week/month: this Mac's windowed counts + elsewhere's", () => {
    const doc = parsePlaysElsewhere(REMOTE)
    const week = windowedElsewhere(doc, T - 7 * 86_400_000)
    assert.deepEqual(week, { '204': 1, '9179': 1, '14': 1 })
    assert.deepEqual(windowedElsewhere(doc, T - 1000), { '204': 1 })
    const mine = { '204': 2, '1': 5 }
    assert.deepEqual(addWindowed(mine, week), { '204': 3, '1': 5, '9179': 1, '14': 1 })
    assert.deepEqual(mine, { '204': 2, '1': 5 }, 'inputs are not mutated')
  })
})

interface Hub { mode: 'up' | 'down' | 'missing' | 'garbage'; etag: string; calls: Array<string | null> }

function fakeFetch(hub: Hub): FetchLike {
  return async (_url, init) => {
    const h = init?.headers as Headers | Record<string, string> | undefined
    const inm = h ? (typeof (h as Headers).get === 'function' ? (h as Headers).get('If-None-Match') : (h as Record<string, string>)['If-None-Match'] ?? null) : null
    hub.calls.push(inm)
    if (hub.mode === 'down') throw new Error('connect ECONNREFUSED')
    if (hub.mode === 'missing') return { ok: false, status: 404, json: async () => ({ error: 'not found' }) }
    if (hub.mode === 'garbage') return { ok: true, status: 200, json: async () => '<html>proxy</html>' }
    if (inm === hub.etag) return { ok: false, status: 304, json: async () => null }
    return { ok: true, status: 200, json: async () => REMOTE, headers: { get: (n: string) => (n.toLowerCase() === 'etag' ? hub.etag : null) } }
  }
}

describe('plays elsewhere: the client', () => {
  let dir = ''
  let hub: Hub
  let replica = false
  const make = () => createPlaysElsewhereClient({
    baseUrl: 'http://homemini:3000/', dir, isReplica: async () => replica, fetchImpl: fakeFetch(hub), now: () => T, log: () => {}, warn: () => {},
  })
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'plays-elsewhere-'))
    hub = { mode: 'up', etag: '"abc"', calls: [] }
    replica = false
  })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('fetches, caches, then polls with If-None-Match (304 keeps the copy)', async () => {
    const c = make()
    assert.deepEqual(await c.read(), { doc: null, source: 'none', fetchedAt: null })
    const first = await c.refresh()
    assert.equal(first.source, 'homemini')
    assert.equal(first.doc?.counts['204'], 3)
    await c.refresh()
    assert.deepEqual(hub.calls, [null, '"abc"'])
    assert.equal((await c.read()).doc?.plays.length, 3)
  })

  it('homemini away, not deployed yet, or a proxy page: the cached copy still counts', async () => {
    await make().refresh()
    for (const mode of ['down', 'missing', 'garbage'] as const) {
      hub.mode = mode
      const s = await make().refresh()
      assert.equal(s.source, 'cache', mode)
      assert.equal(s.doc?.counts['204'], 3, mode)
    }
  })

  it('on a replica it is off and never asks — its own plays are already in the feed', async () => {
    replica = true
    const c = make()
    assert.deepEqual(await c.refresh(), { doc: null, source: 'off', fetchedAt: null })
    assert.deepEqual(hub.calls, [])
  })

  it('writes ONLY its own cache file', async () => {
    await make().refresh()
    assert.deepEqual(await readdir(dir), [PLAYS_ELSEWHERE_CACHE_FILE])
    assert.ok(JSON.parse(await readFile(join(dir, PLAYS_ELSEWHERE_CACHE_FILE), 'utf-8')).doc)
  })

  it('pushes a change once, not on every identical poll', async () => {
    const c = make()
    const seen: string[] = []
    c.onChange((s) => seen.push(s.source))
    await c.refresh()
    await c.refresh()
    assert.deepEqual(seen, ['homemini'])
  })
})

// The lock. A play heard elsewhere must never reach a saved count.
describe('plays elsewhere: display only (wiring lock)', () => {
  const ROOT = join(import.meta.dirname, '..', '..', '..')
  const read = (p: string) => readFile(join(ROOT, p), 'utf-8')

  it('the paths that SAVE plays, or sync the iPod, never see them', async () => {
    for (const p of [
      'src/renderer/context/LibraryContext.tsx',
      'src/renderer/context/PlaybackContext.tsx',
      'src/renderer/hooks/useAudio.ts',
      'src/renderer/utils/smartPlaylists.ts',     // also builds the iPod's smart playlists
      'src/renderer/utils/workoutIpodSync.ts',
      'src/renderer/views/DeviceView.tsx',
      'src/renderer/App.tsx',
    ]) {
      const src = await read(p)
      assert.ok(!/plays-elsewhere|playsElsewhere|PlaysElsewhere/.test(src), `${p} must not read plays heard elsewhere`)
    }
  })

  it('the overlaid tracks are built in ONE place, and the smart view hands back the library’s own objects', async () => {
    const renderer = await read('src/renderer/playsElsewhere.ts')
    assert.match(renderer, /withPlaysElsewhere\(tracks, o\)/)
    const smart = await read('src/renderer/views/SmartPlaylistView.tsx')
    assert.match(smart, /return own\(evaluateSmartPlaylist\(playlistId, everywhere\)\)/)
    assert.ok(!/withPlaysElsewhere/.test(smart), 'views read useTracksEverywhere, not the raw overlay builder')
  })

  it('the client never touches library.json or the overrides', async () => {
    const src = await read('src/main/plays-elsewhere-client.ts')
    const ipc = await read('src/main/ipc/plays-elsewhere-ipc.ts')
    for (const s of [src, ipc]) {
      assert.ok(!/library\.json|metadata-overrides|saveMetadataOverride|UPDATE_TRACKS/.test(s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')))
    }
    assert.equal((src.match(/writeJsonAtomic\(/g) ?? []).length, 1, 'one write: its own cache')
  })
})
