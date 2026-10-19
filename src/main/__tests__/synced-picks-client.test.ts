// Synced picks client (src/main/synced-picks-client.ts) — the desktop's
// GET/PUT client for the homemini Island Albums / Favorite Artists documents:
// fake-fetch hub for every branch (offline cache, outbox replay, the
// later-write-wins drop, 400 refusal, endpoint-not-deployed-yet, an edit made
// mid-PUT), then one pass against a real loopback HTTP server that speaks the
// contract.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createSyncedPicksClient, assertNoSyncedPicksPush, SYNCED_PICKS_BACKEND_FILES, type FetchLike } from '../synced-picks-client.ts'
import { mobileWritable, desktopOwned } from '../sidecar-contracts.ts'
import { nameKey } from '../../common/fold-text.ts'
import {
  ISLAND_ALBUMS_SPEC, FAVORITE_ARTISTS_SPEC,
  type IslandSlot, type PicksState, type PicksSpec,
} from '../../common/synced-picks.ts'

const nulls = <V,>(n: number): V[] => Array.from({ length: n }, () => null as V)
const islands = (...picks: Array<[number, string, string]>): IslandSlot[] => {
  const v = nulls<IslandSlot>(10)
  for (const [i, artist, album] of picks) v[i] = { artist, album }
  return v
}
const exists = async (p: string): Promise<boolean> => { try { await access(p); return true } catch { return false } }

// ── A fake homemini: the contract, validated independently of the client ──
interface FakeHub {
  doc: Record<string, unknown> | null
  mode: 'up' | 'down' | 'missing' | 'error'
  reject?: string
  hold?: Promise<void>
  serverNow: number
  calls: Array<{ method: string; url: string; body?: Record<string, unknown>; ifNoneMatch?: string }>
  notModified?: number
}

function serverValidate(field: string, count: number, body: Record<string, unknown>): string | null {
  const vals = body[field]
  if (!Array.isArray(vals) || vals.length !== count) return `${field} must be exactly ${count}`
  const seen = new Set<string>()
  for (const v of vals) {
    if (v === null) continue
    const key = field === 'slots'
      ? (() => { const o = v as { artist?: unknown; album?: unknown }; return typeof o?.artist === 'string' && o.artist && typeof o.album === 'string' && o.album ? `${nameKey(o.artist)}|${nameKey(o.album)}` : '' })()
      : (typeof v === 'string' && v ? nameKey(v) : '')
    if (!key) return 'empty string'
    if (seen.has(key)) return 'duplicate'
    seen.add(key)
  }
  return null
}

const etagFor = (doc: unknown): string => `"${createHash('sha1').update(JSON.stringify(doc)).digest('hex').slice(0, 20)}"`

function fakeFetch(hub: FakeHub, spec: PicksSpec<unknown>): FetchLike {
  // Same wire as backend routes/curatedSlots.ts: ETag on every doc, 304 on a
  // matching If-None-Match, 400 { error: "<sentence>" }.
  const resp = (status: number, json: unknown, etag?: string) => ({
    ok: status >= 200 && status < 300, status, json: async () => json,
    headers: { get: (n: string) => (n.toLowerCase() === 'etag' ? etag ?? null : null) },
  })
  return async (url, init) => {
    const method = String(init?.method ?? 'GET')
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined
    const inm = new Headers(init?.headers as HeadersInit | undefined).get('if-none-match')
    hub.calls.push({ method, url, body, ...(inm ? { ifNoneMatch: inm } : {}) })
    if (hub.mode === 'down') throw new TypeError('fetch failed')
    if (hub.mode === 'missing') return resp(404, { error: 'Not found' })
    if (hub.mode === 'error') return resp(503, { error: 'busy' })
    if (method === 'GET') {
      const doc = hub.doc ?? { version: 1, [spec.field]: nulls(spec.count), updatedAt: null, updatedBy: null }
      const etag = etagFor(doc)
      if (inm === etag) { hub.notModified = (hub.notModified ?? 0) + 1; return resp(304, null, etag) }
      return resp(200, doc, etag)
    }
    if (hub.hold) await hub.hold
    if (hub.reject) return resp(400, { error: hub.reject })
    const bad = serverValidate(spec.field, spec.count, body ?? {})
    if (bad) return resp(400, { error: bad })
    hub.doc = { version: 1, [spec.field]: body![spec.field], updatedAt: new Date(hub.serverNow).toISOString(), updatedBy: body!.updatedBy }
    return resp(200, hub.doc, etagFor(hub.doc))
  }
}

let dir = ''
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'jt-synced-picks-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

function setup(opts: { mode?: FakeHub['mode']; doc?: Record<string, unknown> | null; now?: number } = {}) {
  const hub: FakeHub = { doc: opts.doc ?? null, mode: opts.mode ?? 'up', serverNow: Date.parse('2026-10-18T12:00:00.000Z'), calls: [] }
  let clientNow = opts.now ?? Date.parse('2026-10-18T12:00:00.000Z')
  const logs: string[] = []
  const client = createSyncedPicksClient<IslandSlot>({
    spec: ISLAND_ALBUMS_SPEC,
    baseUrl: 'http://homemini.test:3000/',
    dir,
    fetchImpl: fakeFetch(hub, ISLAND_ALBUMS_SPEC as PicksSpec<unknown>),
    now: () => clientNow,
    log: (m) => logs.push(m),
    warn: (_k, m) => logs.push(m),
  })
  const states: Array<PicksState<IslandSlot>> = []
  client.onChange((s) => states.push(s))
  return { hub, client, states, logs, setNow: (ms: number) => { clientNow = ms } }
}

/** A client that has seen homemini's document once (editing is unlocked),
 *  with the call log and change log cleared. */
async function seeded(opts: Parameters<typeof setup>[0] = {}) {
  // Default: a document someone has already written (empty) — island editing
  // waits for that first write (spec.awaitFirstWrite, the phone's migration).
  const t = setup({ doc: phoneDoc(islands(), '2026-10-18T09:00:00.000Z'), ...opts, mode: 'up' })
  await t.client.sync()
  t.hub.calls.length = 0
  t.states.length = 0
  if (opts.mode) t.hub.mode = opts.mode
  return t
}
const CACHE = 'island-albums.desktop-cache.json'
const OUTBOX = 'island-albums.desktop-outbox.json'

const phoneDoc = (slots: IslandSlot[], at: string) => ({ version: 1, slots, updatedAt: at, updatedBy: 'phone' })

describe('reads + offline cache', () => {
  it('a good GET is cached in userData and drawn; the cache draws later with homemini gone', async () => {
    const { hub, client } = setup({ doc: phoneDoc(islands([0, 'Radiohead', 'OK Computer']), '2026-10-18T11:00:00.000Z') })
    const s = await client.sync()
    assert.equal(s.reachable, true)
    assert.equal(s.pending, false)
    assert.deepEqual(s.values[0], { artist: 'Radiohead', album: 'OK Computer' })
    assert.equal(s.updatedBy, 'phone')
    assert.equal(hub.calls[0].url, 'http://homemini.test:3000/api/island-albums')

    const file = JSON.parse(await readFile(join(dir, CACHE), 'utf-8'))
    assert.deepEqual(file.doc.slots[0], { artist: 'Radiohead', album: 'OK Computer' }, 'cache holds the wire shape')

    hub.mode = 'down'
    const off = await client.sync()
    assert.equal(off.reachable, false)
    assert.deepEqual(off.values[0], { artist: 'Radiohead', album: 'OK Computer' }, 'offline = the cached shelf, not an empty one')
  })

  it('offline with no cache: ten empty slots, never a throw', async () => {
    const { client } = setup({ mode: 'down' })
    const s = await client.sync()
    assert.equal(s.values.length, 10)
    assert.ok(s.values.every((v) => v === null))
    assert.equal(s.reachable, false)
    assert.equal(s.syncedAt, null)
  })

  it('read() is disk-only — no network', async () => {
    const { hub, client } = setup()
    await client.read()
    assert.equal(hub.calls.length, 0)
  })

  it('a torn cache file reads as no cache', async () => {
    await writeFile(join(dir, CACHE), '{"doc": {"slots": [')
    const { client } = setup({ mode: 'down' })
    const s = await client.read()
    assert.ok(s.values.every((v) => v === null))
  })

  it('a GET that answers 200 with garbage does not overwrite the cache', async () => {
    const { hub, client } = setup({ doc: phoneDoc(islands([2, 'A', 'B']), '2026-10-18T11:00:00.000Z') })
    await client.sync()
    hub.doc = { nope: true }
    const s = await client.sync()
    assert.equal(s.reachable, false)
    assert.deepEqual(s.values[2], { artist: 'A', album: 'B' })
  })
})

describe('edits', () => {
  it('online save: drawn instantly, PUT straight away (no GET first), lands → outbox gone, cache = stored doc', async () => {
    const { hub, client, states } = await seeded()
    const r = await client.save(islands([0, 'Björk', 'Homogenic']))
    assert.equal(r.ok, true)
    assert.equal(states[0].pending, true, 'the first thing drawn is the local edit, before the network')
    assert.deepEqual(states[0].values[0], { artist: 'Björk', album: 'Homogenic' })
    assert.deepEqual(hub.calls.map((c) => c.method), ['PUT'])
    assert.deepEqual(hub.calls[0].body, { slots: islands([0, 'Björk', 'Homogenic']), updatedBy: 'desktop' })
    assert.equal(r.state.pending, false)
    assert.equal(r.state.updatedBy, 'desktop')
    assert.equal(r.state.updatedAt, '2026-10-18T12:00:00.000Z', "homemini's stored timestamp, not ours")
    assert.equal(await exists(join(dir, OUTBOX)), false)
  })

  it('offline save: queued + drawn; homemini back → the queued edit replays and lands', async () => {
    const { hub, client, setNow } = await seeded({ mode: 'down' })
    setNow(Date.parse('2026-10-18T12:00:00.000Z'))
    const r = await client.save(islands([3, 'Talking Heads', 'Remain in Light']))
    assert.equal(r.ok, true)
    assert.equal(r.state.pending, true)
    assert.deepEqual(r.state.values[3], { artist: 'Talking Heads', album: 'Remain in Light' })
    assert.equal(await exists(join(dir, OUTBOX)), true)

    hub.mode = 'up'
    hub.doc = phoneDoc(islands(), '2026-10-18T09:00:00.000Z')   // older than the edit
    hub.serverNow = Date.parse('2026-10-18T12:05:00.000Z')
    hub.calls.length = 0
    const s = await client.sync()
    assert.deepEqual(hub.calls.map((c) => c.method), ['GET', 'PUT'])
    assert.equal(s.pending, false)
    assert.deepEqual((hub.doc!.slots as IslandSlot[])[3], { artist: 'Talking Heads', album: 'Remain in Light' })
    assert.equal(await exists(join(dir, OUTBOX)), false)
  })

  it('a queued edit OLDER than the phone\'s latest save is dropped — the later write wins, nothing is clobbered', async () => {
    const { hub, client, logs } = await seeded({ mode: 'down', now: Date.parse('2026-10-18T08:00:00.000Z') })
    await client.save(islands([0, 'Desktop', 'Stale Pick']))
    hub.mode = 'up'
    hub.doc = phoneDoc(islands([0, 'Phone', 'Newer Pick']), '2026-10-18T10:00:00.000Z')
    hub.calls.length = 0
    const s = await client.sync()
    assert.deepEqual(hub.calls.map((c) => c.method), ['GET'], 'no PUT')
    assert.deepEqual(s.values[0], { artist: 'Phone', album: 'Newer Pick' })
    assert.equal(s.pending, false)
    assert.ok(logs.some((l) => /later write wins/.test(l)))
  })

  it('a 404 from homemini (route gone / not deployed on this box) keeps the edit queued until it answers', async () => {
    const { hub, client } = await seeded({ mode: 'missing' })
    const r = await client.save(islands([1, 'A', 'B']))
    assert.equal(r.state.pending, true)
    assert.equal((await client.sync()).pending, true)
    hub.mode = 'up'
    const s = await client.sync()
    assert.equal(s.pending, false)
    assert.deepEqual((hub.doc!.slots as IslandSlot[])[1], { artist: 'A', album: 'B' })
  })

  it('a 5xx keeps the edit queued', async () => {
    const { client } = await seeded({ mode: 'error' })
    const r = await client.save(islands([1, 'A', 'B']))
    assert.equal(r.state.pending, true)
  })

  it('400 from homemini: the edit is dropped, its { error } sentence is the save\'s answer, the stored doc drawn; the next good edit clears it', async () => {
    const { hub, client } = await seeded({ doc: phoneDoc(islands([0, 'Kept', 'Album']), '2026-10-18T11:00:00.000Z') })
    hub.reject = 'The same album is in slot 1 and slot 2 ("Y" by X). Each album may appear once.'
    const r = await client.save(islands([0, 'X', 'Y']))
    assert.equal(r.ok, false, 'the desktop accepted it; homemini refused — and the save says so')
    if (!r.ok) assert.equal(r.error, 'The same album is in slot 1 and slot 2 ("Y" by X). Each album may appear once.')
    assert.equal(r.state.pending, false)
    assert.equal(r.state.rejected, 'The same album is in slot 1 and slot 2 ("Y" by X). Each album may appear once.')
    assert.deepEqual(r.state.values[0], { artist: 'Kept', album: 'Album' })
    assert.equal(await exists(join(dir, OUTBOX)), false)
    hub.reject = undefined
    const r2 = await client.save(islands([0, 'X', 'Y']))
    assert.equal(r2.state.rejected, undefined)
    assert.deepEqual(r2.state.values[0], { artist: 'X', album: 'Y' })
  })

  it('an invalid edit never queues and never reaches the network', async () => {
    const { hub, client } = await seeded()
    const r = await client.save(islands([0, 'A', 'B'], [4, 'a', 'b']))
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.error, /slots 1 and 5/)
    const r2 = await client.save(nulls(9))
    assert.equal(r2.ok, false)
    assert.equal(hub.calls.length, 0)
    assert.equal(await exists(join(dir, OUTBOX)), false)
  })

  it('an edit made while a PUT is on the wire survives it and lands after it', async () => {
    const { hub, client, states } = await seeded()
    let release!: () => void
    hub.hold = new Promise<void>((r) => { release = r })
    const pA = client.save(islands([0, 'First', 'Edit']))
    while (!hub.calls.some((c) => c.method === 'PUT')) await new Promise((r) => setTimeout(r, 2))
    const pB = client.save(islands([0, 'Second', 'Edit']))
    await new Promise((r) => setTimeout(r, 10))
    hub.hold = undefined
    release()
    const [a, b] = await Promise.all([pA, pB])
    assert.equal(a.ok && b.ok, true)
    assert.deepEqual((hub.doc!.slots as IslandSlot[])[0], { artist: 'Second', album: 'Edit' }, 'the newer edit is the last write')
    assert.equal(await client.hasPending(), false)
    assert.ok(!states.some((s, i) => i > 0 && (s.values[0] as { artist: string } | null)?.artist === 'First' && states.slice(0, i).some((p) => (p.values[0] as { artist: string } | null)?.artist === 'Second')),
      'never flicks back to the older edit once the newer one is drawn')
    assert.deepEqual(hub.calls.filter((c) => c.method === 'PUT').map((c) => (c.body!.slots as IslandSlot[])[0]!.artist), ['First', 'Second'])
  })

  it('concurrent syncs coalesce — three calls, at most two passes', async () => {
    const { hub, client } = setup()
    await Promise.all([client.sync(), client.sync(), client.sync()])
    assert.ok(hub.calls.length <= 2, `${hub.calls.length} GETs`)
  })

  it('the outbox survives a restart: a new client on the same userData replays it', async () => {
    const first = await seeded({ mode: 'down' })
    await first.client.save(islands([9, 'Last', 'Slot']))
    const second = setup()
    assert.equal(await second.client.hasPending(), true)
    const before = await second.client.read()
    assert.equal(before.pending, true)
    assert.deepEqual(before.values[9], { artist: 'Last', album: 'Slot' })
    const s = await second.client.sync()
    assert.equal(s.pending, false)
    assert.deepEqual((second.hub.doc!.slots as IslandSlot[])[9], { artist: 'Last', album: 'Slot' })
  })

  it('unchanged polls push nothing (onChange fires on change only)', async () => {
    const { client, states } = setup({ doc: phoneDoc(islands([0, 'A', 'B']), '2026-10-18T11:00:00.000Z') })
    await client.sync()
    await client.sync()
    await client.sync()
    assert.equal(states.length, 1)
  })
})

describe('first run, ETag polling, the single-writer fence', () => {
  it('never edits blind: with no cache and nothing queued, a save is refused and nothing is sent', async () => {
    const { hub, client } = setup({ mode: 'missing' })     // first run on a new Mac / endpoint not deployed yet
    await client.sync()
    hub.calls.length = 0
    const r = await client.save(islands([0, 'Would', 'Wipe']))
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.error, /Not synced with homemini yet/)
    assert.equal(hub.calls.length, 0)
    assert.equal(await exists(join(dir, OUTBOX)), false)
  })

  it('island albums stay read-only until someone has written the document — the phone\'s migration goes first', async () => {
    const { hub, client } = setup({ doc: { version: 1, slots: nulls(10), updatedAt: null, updatedBy: null } })
    await client.sync()
    hub.calls.length = 0
    const r = await client.save(islands([0, 'Desktop', 'First']))
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.error, /Waiting for your phone/)
    assert.equal(hub.calls.length, 0)
    hub.doc = phoneDoc(islands([0, 'Migrated', 'Pick']), '2026-10-18T12:01:00.000Z')   // the phone migrates
    await client.sync()
    const r2 = await client.save(islands([0, 'Migrated', 'Pick'], [1, 'Desktop', 'Second']))
    assert.equal(r2.ok, true)
    assert.deepEqual((hub.doc!.slots as IslandSlot[])[1], { artist: 'Desktop', album: 'Second' })
  })

  it('an empty server + an empty desktop never PUTs an empty list (no-op edits are not sent)', async () => {
    const { hub, client } = await seeded()
    const r = await client.save(nulls(10))
    assert.equal(r.ok, true)
    assert.equal(hub.calls.length, 0)
    assert.equal(r.state.pending, false)
  })

  it('the poll sends If-None-Match and a 304 keeps the cached doc (no rewrite, no push)', async () => {
    const { hub, client, states } = await seeded({ doc: phoneDoc(islands([0, 'A', 'B']), '2026-10-18T11:00:00.000Z') })
    const s = await client.sync()
    assert.equal(hub.calls[0].ifNoneMatch, etagFor(hub.doc), 'the ETag from the first GET goes back')
    assert.equal(hub.notModified, 1)
    assert.equal(s.reachable, true)
    assert.deepEqual(s.values[0], { artist: 'A', album: 'B' })
    assert.equal(states.length, 0, 'nothing changed — nothing pushed')
    // The phone writes: the old ETag no longer matches → a full 200.
    hub.doc = phoneDoc(islands([0, 'C', 'D']), '2026-10-18T11:30:00.000Z')
    const s2 = await client.sync()
    assert.deepEqual(s2.values[0], { artist: 'C', album: 'D' })
    assert.equal(hub.notModified, 1)
  })

  it('a queued edit is still judged against homemini\'s timestamp on a 304 (the cache IS the doc)', async () => {
    const { hub, client } = await seeded({ doc: phoneDoc(islands([0, 'A', 'B']), '2026-10-18T11:00:00.000Z'), now: Date.parse('2026-10-18T12:00:00.000Z') })
    hub.mode = 'down'
    await client.save(islands([0, 'Newer', 'Desk Edit']))
    hub.mode = 'up'
    hub.calls.length = 0
    const s = await client.sync()
    assert.deepEqual(hub.calls.map((c) => c.method), ['GET', 'PUT'])
    assert.equal(hub.notModified, 1)
    assert.equal(s.pending, false)
    assert.deepEqual(s.values[0], { artist: 'Newer', album: 'Desk Edit' })
  })

  it('the desktop cache/outbox never use the backend\'s file names', async () => {
    const { client } = await seeded({ mode: 'down' })
    await client.save(islands([0, 'A', 'B']))
    for (const f of SYNCED_PICKS_BACKEND_FILES) assert.equal(await exists(join(dir, f)), false, f)
    assert.equal(await exists(join(dir, CACHE)), true)
    assert.equal(await exists(join(dir, OUTBOX)), true)
  })

  it('island-albums.json + favorite-artists.json are phone-backend files: mobileWritable, never desktopOwned, never pushed', async () => {
    for (const f of SYNCED_PICKS_BACKEND_FILES) {
      assert.ok((mobileWritable as readonly string[]).includes(f), `${f} in contracts mobileWritable`)
      assert.ok(!(desktopOwned as readonly string[]).includes(f), `${f} not desktopOwned`)
    }
    assert.throws(() => assertNoSyncedPicksPush(['library.json', 'island-albums.json'], 'TEST'), /must not push island-albums\.json/)
    assert.doesNotThrow(() => assertNoSyncedPicksPush(['library.json', 'live-sets.json'], 'TEST'))
    const idx = await readFile(join(import.meta.dirname, '../index.ts'), 'utf-8')
    assert.match(idx, /assertNoSyncedPicksPush\(\[\.\.\.STATE_FILE_NAMES, \.\.\.PHONE_AUTHORED_FILES\]/, 'the boot fence is wired')
    for (const script of ['jaketunes-homemini-sync.sh', 'jaketunes-workmini-deploy.sh']) {
      const sh = await readFile(join(import.meta.dirname, '../../../Dr. Claude/scripts', script), 'utf-8')
      for (const f of SYNCED_PICKS_BACKEND_FILES) assert.ok(!sh.includes(f), `${script} must not carry ${f}`)
    }
  })
})

describe('favorite artists', () => {
  it('PUTs { artists, updatedBy } to /api/favorite-artists and dedupes by nameKey before it ever sends', async () => {
    const hub: FakeHub = { doc: null, mode: 'up', serverNow: Date.parse('2026-10-18T12:00:00.000Z'), calls: [] }
    const client = createSyncedPicksClient({
      spec: FAVORITE_ARTISTS_SPEC, baseUrl: 'http://homemini.test:3000', dir,
      fetchImpl: fakeFetch(hub, FAVORITE_ARTISTS_SPEC as PicksSpec<unknown>), log: () => {}, warn: () => {},
    })
    await client.sync()
    hub.calls.length = 0
    const r = await client.save(['Radiohead', null, 'Björk', null, null])
    assert.equal(r.ok, true)
    assert.equal(hub.calls[0].url, 'http://homemini.test:3000/api/favorite-artists')
    assert.deepEqual(hub.calls[0].body, { artists: ['Radiohead', null, 'Björk', null, null], updatedBy: 'desktop' })
    assert.equal((await client.save(['Björk', null, 'BJORK', null, null])).ok, false)
    assert.equal(hub.calls.length, 1)
  })
})

describe('against a real loopback server speaking the contract', () => {
  it('save → PUT lands → a fresh client GETs it back; a phone write shows up on the next refresh', async () => {
    const { createServer } = await import('node:http')
    let stored: Record<string, unknown> = { version: 1, slots: nulls(10), updatedAt: '2026-10-18T09:00:00.000Z', updatedBy: 'phone' }
    const server = createServer((req, res) => {
      if (req.url !== '/api/island-albums') { res.writeHead(404).end(); return }
      if (req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(stored)); return }
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown>
        const bad = serverValidate('slots', 10, body)
        if (bad) { res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ message: bad })); return }
        stored = { version: 1, slots: body.slots, updatedAt: new Date().toISOString(), updatedBy: body.updatedBy }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(stored))
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    try {
      const addr = server.address()
      if (!addr || typeof addr === 'string') throw new Error('no port')
      const baseUrl = `http://127.0.0.1:${addr.port}`
      const desk = createSyncedPicksClient<IslandSlot>({ spec: ISLAND_ALBUMS_SPEC, baseUrl, dir, log: () => {}, warn: () => {} })
      await desk.sync()
      const r = await desk.save(islands([0, 'Radiohead', 'OK Computer']))
      assert.equal(r.ok, true)
      assert.equal(r.state.pending, false)
      assert.equal((stored.slots as IslandSlot[])[0]!.album, 'OK Computer')
      assert.equal(stored.updatedBy, 'desktop')

      // The phone moves it to slot 2 (a write that isn't ours).
      stored = { version: 1, slots: islands([1, 'Radiohead', 'OK Computer']), updatedAt: new Date(Date.now() + 1000).toISOString(), updatedBy: 'phone' }
      const s = await desk.sync()
      assert.equal(s.values[0], null)
      assert.deepEqual(s.values[1], { artist: 'Radiohead', album: 'OK Computer' })
      assert.equal(s.updatedBy, 'phone')
    } finally {
      server.closeAllConnections()                   // keep-alive sockets would hold close() open
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})
