/**
 * Replica hub poll: phone edits, phone imports, and live sets move the
 * change key on their own, and an unchanged hub does not fetch the delta
 * again. The companion header is attached only when a token is set.
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PHONE_EDIT_SIDECAR,
  PHONE_IMPORT_SIDECAR,
  conditionalStampHeaders,
  emptyStampValidator,
  hubCatalogChangeKey,
  liveSetStamp,
  phoneSidecarStamp,
  startHubCatalogPoll,
} from '../hub-catalog.ts'
import { COMPANION_HEADER, COMPANION_TOKEN_ENV } from '../hub-companion.ts'

const savedToken = process.env[COMPANION_TOKEN_ENV]

afterEach(() => {
  if (savedToken === undefined) delete process.env[COMPANION_TOKEN_ENV]
  else process.env[COMPANION_TOKEN_ENV] = savedToken
})

describe('sidecar stamps', () => {
  const headers = (pairs: Record<string, string>) => ({
    get: (name: string) => pairs[name.toLowerCase()] ?? null,
  })

  it('phone edits and imports key off mtimeMs, and a validator header wins when the hub sends one', () => {
    assert.equal(phoneSidecarStamp(200, headers({}), JSON.stringify({ mtimeMs: 10, body: '{}' })), 'mtime:10')
    assert.equal(phoneSidecarStamp(200, headers({ etag: '"e1"' }), ''), 'etag:"e1"')
    assert.equal(phoneSidecarStamp(404, headers({}), ''), '')
    assert.equal(phoneSidecarStamp(500, headers({}), ''), null)
    assert.equal(phoneSidecarStamp(304, headers({ etag: '"e1"' }), JSON.stringify({ mtimeMs: 99 })), null)
  })

  it('live sets use ETag, then Last-Modified, then mtimeMs, then a hash of the body', () => {
    assert.equal(liveSetStamp(200, headers({ etag: '"live"' }), ''), 'etag:"live"')
    assert.equal(liveSetStamp(200, headers({ 'last-modified': 'Tue, 08 Oct 2026 00:00:00 GMT' }), ''), 'lm:Tue, 08 Oct 2026 00:00:00 GMT')
    assert.equal(liveSetStamp(200, headers({}), JSON.stringify({ mtimeMs: 4 })), 'mtime:4')
    const hashed = liveSetStamp(200, headers({}), '{"sets":[1]}')
    assert.ok(hashed?.startsWith('sha256:'))
    assert.notEqual(hashed, liveSetStamp(200, headers({}), '{"sets":[2]}'))
    assert.equal(liveSetStamp(404, headers({}), ''), 'http:404')
    assert.equal(liveSetStamp(503, headers({}), ''), null)
    assert.equal(liveSetStamp(304, headers({ etag: '"live"' }), '{"sets":[9]}'), null)
  })

  it('a stored ETag is sent as If-None-Match, and Last-Modified is the fallback', () => {
    assert.deepEqual(conditionalStampHeaders(emptyStampValidator()), { accept: 'application/json' })
    const both = conditionalStampHeaders({ etag: '"e"', lastModified: 'Tue, 08 Oct 2026 00:00:00 GMT' })
    assert.equal(both['If-None-Match'], '"e"')
    assert.equal(both['If-Modified-Since'], undefined)
    const lm = conditionalStampHeaders({ etag: null, lastModified: 'Tue, 08 Oct 2026 00:00:00 GMT' })
    assert.equal(lm['If-Modified-Since'], 'Tue, 08 Oct 2026 00:00:00 GMT')
    assert.equal(lm['If-None-Match'], undefined)
  })

  it('the change key moves when only a phone or live-set stamp moves', () => {
    const ver = { library: 'L', tracks: '1', stars: 'S', plays: 'P' }
    const base = { phoneEdits: 'mtime:1', phoneImports: 'mtime:2', liveSets: 'mtime:3' }
    const key = hubCatalogChangeKey(ver, base)
    assert.equal(hubCatalogChangeKey(ver, base), key)
    assert.notEqual(hubCatalogChangeKey(ver, { ...base, phoneEdits: 'mtime:9' }), key)
    assert.notEqual(hubCatalogChangeKey(ver, { ...base, phoneImports: 'mtime:9' }), key)
    assert.notEqual(hubCatalogChangeKey(ver, { ...base, liveSets: 'etag:x' }), key)
    assert.notEqual(hubCatalogChangeKey({ ...ver, plays: 'Q' }, base), key)
  })
})

interface HubState {
  edits: number
  imports: number
  live: number
  liveEtag?: string
  plays: string
}

function fakeHub(state: HubState) {
  const calls: Array<{ url: string; method: string; header: string | null; inm: string | null; ims: string | null }> = []
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    const method = (init?.method ?? 'GET').toUpperCase()
    const sent = new Headers(init?.headers)
    const header = sent.get(COMPANION_HEADER)
    calls.push({
      url: u,
      method,
      header,
      inm: sent.get('if-none-match'),
      ims: sent.get('if-modified-since'),
    })
    const respond = (body: unknown, status = 200, extra?: Record<string, string>) => {
      const text = JSON.stringify(body)
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers(extra),
        text: async () => text,
        json: async () => body,
      }
    }
    if (u.includes('/api/library-version')) {
      return respond({ library: 'L', tracks: '9', stars: 'S', plays: state.plays })
    }
    if (u.includes('/api/phone-sidecars/')) {
      const name = decodeURIComponent(u.split('/api/phone-sidecars/')[1] || '')
      const mtime = name === PHONE_EDIT_SIDECAR ? state.edits : name === PHONE_IMPORT_SIDECAR ? state.imports : 0
      if (method === 'HEAD') return respond(null, 200)
      return respond({ mtimeMs: mtime, body: '{}' })
    }
    if (u.endsWith('/api/live-sets')) {
      if (method === 'HEAD' && state.liveEtag) return respond(null, 200, { etag: state.liveEtag })
      if (method === 'HEAD') return respond(null, 200)
      return respond({ mtimeMs: state.live })
    }
    if (u.includes('/api/tracks/delta')) return respond({ unchanged: true, version: 'hub-v1' })
    return respond({ error: u }, 500)
  }) as typeof fetch
  const deltas = () => calls.filter((c) => c.url.includes('/api/tracks/delta'))
  return { calls, fetchImpl, deltas }
}

async function poller(state: HubState, log: (m: string) => void = () => {}) {
  const dir = await mkdtemp(join(tmpdir(), 'hub-poll-'))
  const hub = fakeHub(state)
  const handle = startHubCatalogPoll({
    stateDir: dir,
    hubBase: async () => 'http://hub',
    send: () => true,
    isLocked: () => null,
    fetchImpl: hub.fetchImpl,
    intervalMs: 60 * 60_000,
    log,
  })
  return { ...hub, dir, stop: handle.stop, tick: handle.tick }
}

describe('hub catalog poll notices phone-side changes', () => {
  it('a phone edit, import, or live-set change alone fetches the delta; an unchanged hub does not', async () => {
    delete process.env[COMPANION_TOKEN_ENV]
    const state: HubState = { edits: 10, imports: 20, live: 30, plays: 'P' }
    const hub = await poller(state)
    try {
      await hub.tick()
      assert.equal(hub.deltas().length, 1, 'first poll fetches the catalog')
      assert.ok(hub.calls.some((c) => c.url.includes(PHONE_EDIT_SIDECAR) && c.method === 'GET'))
      assert.ok(hub.calls.some((c) => c.url.includes(PHONE_IMPORT_SIDECAR) && c.method === 'GET'))
      assert.ok(hub.calls.some((c) => c.url.endsWith('/api/live-sets') && c.method === 'GET'))

      await hub.tick()
      assert.equal(hub.deltas().length, 1, 'unchanged hub does not fetch again')

      state.edits = 11
      await hub.tick()
      assert.equal(hub.deltas().length, 2, 'phone edit mtime alone fetches')

      await hub.tick()
      assert.equal(hub.deltas().length, 2)

      state.imports = 21
      await hub.tick()
      assert.equal(hub.deltas().length, 3, 'phone import mtime alone fetches')

      state.live = 31
      await hub.tick()
      assert.equal(hub.deltas().length, 4, 'live-set mtime alone fetches')

      state.plays = 'P2'
      await hub.tick()
      assert.equal(hub.deltas().length, 5, 'a play change still fetches')

      await hub.tick()
      assert.equal(hub.deltas().length, 5)
      assert.ok(hub.calls.every((c) => c.header === null))
    } finally {
      hub.stop()
    }
  })

  it('uses the live-set ETag when the hub sends one, and does not download the body', async () => {
    delete process.env[COMPANION_TOKEN_ENV]
    const state: HubState = { edits: 1, imports: 1, live: 1, liveEtag: '"a"', plays: 'P' }
    const hub = await poller(state)
    try {
      await hub.tick()
      assert.equal(hub.deltas().length, 1)
      assert.equal(hub.calls.filter((c) => c.url.endsWith('/api/live-sets') && c.method === 'GET').length, 0)
      state.live = 99
      await hub.tick()
      assert.equal(hub.deltas().length, 1, 'body mtime is unused while the ETag holds')
      state.liveEtag = '"b"'
      await hub.tick()
      assert.equal(hub.deltas().length, 2, 'a new live-set ETag fetches')
      const liveGets = hub.calls.filter((c) => c.url.endsWith('/api/live-sets') && c.method === 'GET')
      assert.equal(liveGets.length, 0, 'HEAD already carried a validator, so GET never runs')
      const liveHeads = hub.calls.filter((c) => c.url.endsWith('/api/live-sets') && c.method === 'HEAD')
      assert.equal(liveHeads[1]?.inm, '"a"', 'the second poll sends the stored live-set ETag')
    } finally {
      hub.stop()
    }
  })

  it('a 304 keeps the stamp and does not fetch the delta; the second poll sends the conditional header and the companion token', async () => {
    process.env[COMPANION_TOKEN_ENV] = 'test-token'
    const dir = await mkdtemp(join(tmpdir(), 'hub-poll-304-'))
    const importLm = 'Tue, 08 Oct 2026 00:00:00 GMT'
    let editGen = 1
    const calls: Array<{ url: string; method: string; inm: string | null; ims: string | null; header: string | null }> = []
    const bodyReads: string[] = []
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      const method = (init?.method ?? 'GET').toUpperCase()
      const sent = new Headers(init?.headers)
      const inm = sent.get('if-none-match')
      const ims = sent.get('if-modified-since')
      calls.push({ url: u, method, inm, ims, header: sent.get(COMPANION_HEADER) })
      const pack = (status: number, extra: Record<string, string>, body: unknown) => ({
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers(extra),
        text: async () => {
          bodyReads.push(`${method} ${u}`)
          return JSON.stringify(body)
        },
        json: async () => body,
      })
      if (u.includes('/api/library-version')) {
        return pack(200, {}, { library: 'L', tracks: '9', stars: 'S', plays: 'P' })
      }
      if (u.includes(PHONE_EDIT_SIDECAR)) {
        const etag = `W/"edits-${editGen}"`
        // HEAD carries no validator, which is the case that used to download the body every poll.
        if (method === 'HEAD') return pack(200, {}, null)
        if (inm === etag) return pack(304, { etag }, null)
        return pack(200, { etag }, { mtimeMs: editGen, body: '{}' })
      }
      if (u.includes(PHONE_IMPORT_SIDECAR)) {
        if (method === 'HEAD') return pack(200, {}, null)
        if (ims === importLm) return pack(304, { 'last-modified': importLm }, null)
        return pack(200, { 'last-modified': importLm }, { mtimeMs: 2, body: '{}' })
      }
      if (u.endsWith('/api/live-sets')) {
        const etag = '"live"'
        if (method === 'GET') throw new Error('GET /api/live-sets ran after HEAD returned a validator')
        if (inm === etag) return pack(304, { etag }, null)
        return pack(200, { etag }, null)
      }
      if (u.includes('/api/tracks/delta')) return pack(200, {}, { unchanged: true, version: 'hub-v1' })
      return pack(500, {}, { error: u })
    }) as typeof fetch
    const handle = startHubCatalogPoll({
      stateDir: dir,
      hubBase: async () => 'http://hub',
      send: () => true,
      isLocked: () => null,
      fetchImpl,
      intervalMs: 60 * 60_000,
    })
    const deltas = () => calls.filter((c) => c.url.includes('/api/tracks/delta')).length
    try {
      await handle.tick()
      assert.equal(deltas(), 1)
      assert.equal(bodyReads.length, 2, 'the first poll still reads a body when HEAD has no validator')
      assert.equal(calls.filter((c) => c.url.endsWith('/api/live-sets') && c.method === 'GET').length, 0)

      const marked = calls.length
      const reads = bodyReads.length
      await handle.tick()
      assert.equal(deltas(), 1, '304 keeps the stamp and does not fetch the delta')
      assert.equal(bodyReads.length, reads, '304 does not download the body')
      const second = calls.slice(marked)
      const editGets = second.filter((c) => c.url.includes(PHONE_EDIT_SIDECAR) && c.method === 'GET')
      assert.equal(editGets.length, 1)
      assert.equal(editGets[0].inm, 'W/"edits-1"')
      assert.equal(editGets[0].ims, null)
      assert.equal(editGets[0].header, 'test-token')
      const importGets = second.filter((c) => c.url.includes(PHONE_IMPORT_SIDECAR) && c.method === 'GET')
      assert.equal(importGets.length, 1)
      assert.equal(importGets[0].ims, importLm)
      assert.equal(importGets[0].inm, null)
      assert.equal(importGets[0].header, 'test-token')
      const liveHeads = second.filter((c) => c.url.endsWith('/api/live-sets') && c.method === 'HEAD')
      assert.equal(liveHeads.length, 1)
      assert.equal(liveHeads[0].inm, '"live"')
      assert.equal(liveHeads[0].header, 'test-token')
      assert.equal(second.filter((c) => c.url.endsWith('/api/live-sets') && c.method === 'GET').length, 0)
      assert.ok(second.every((c) => c.header === 'test-token'))

      editGen = 2
      await handle.tick()
      assert.equal(deltas(), 2, 'a 200 recomputes the stamp and fetches the delta')
      assert.ok(bodyReads.length > reads)
    } finally {
      handle.stop()
    }
  })

  it('sends the companion header on every hub poll request when a token is set, and does not log it', async () => {
    process.env[COMPANION_TOKEN_ENV] = 'test-token'
    const lines: string[] = []
    const methods = ['log', 'info', 'warn', 'error', 'debug'] as const
    const prev = methods.map((m) => console[m])
    for (const m of methods) {
      console[m] = (...args: unknown[]) => {
        lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
      }
    }
    const state: HubState = { edits: 1, imports: 1, live: 1, plays: 'P' }
    const notes: string[] = []
    const hub = await poller(state, (m) => notes.push(m))
    try {
      await hub.tick()
      await hub.tick()
      assert.ok(hub.calls.length > 0)
      assert.ok(hub.calls.every((c) => c.header === 'test-token'))
      assert.equal([...lines, ...notes].join('\n').includes('test-token'), false)
    } finally {
      methods.forEach((m, i) => { console[m] = prev[i] })
      hub.stop()
    }
  })
})

// 2026-10-19 — "why arent the full live concerts on the workmini??". The hub's
// default list hid all 171 concert rows; the replica now asks for the include
// view. ⚠️ TWIN: ~/JakeTunesMobile backend/src/util/catalogView.ts
describe('replica asks the hub for the include view (concerts kept)', () => {
  function includeHub(opts: { honoursView: boolean; deltaFor: (url: string) => Record<string, unknown> }) {
    const urls: string[] = []
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      const method = (init?.method ?? 'GET').toUpperCase()
      urls.push(`${method} ${u}`)
      const pack = (body: unknown, status = 200) => ({
        ok: status >= 200 && status < 300, status, headers: new Headers(),
        text: async () => JSON.stringify(body), json: async () => body,
      })
      if (u.includes('/api/library-version')) {
        const include = opts.honoursView && u.includes('concerts=include')
        return pack({ ...(include ? { view: 'include' } : {}), library: 'L', tracks: include ? 11676 : 11505, stars: 'S', plays: 'P' })
      }
      if (u.includes('/api/phone-sidecars/')) return method === 'HEAD' ? pack(null) : pack({ mtimeMs: 1, body: '{}' })
      if (u.endsWith('/api/live-sets')) return method === 'HEAD' ? pack(null) : pack({ mtimeMs: 1 })
      if (u.includes('/api/tracks/delta')) return pack(opts.deltaFor(u))
      return pack({ error: u }, 500)
    }) as typeof fetch
    return { urls, fetchImpl }
  }

  it('library-version and tracks/delta both carry ?concerts=include', async () => {
    const hub = includeHub({ honoursView: true, deltaFor: () => ({ unchanged: true, version: 'libci-1' }) })
    const dir = await mkdtemp(join(tmpdir(), 'hub-include-'))
    const h = startHubCatalogPoll({ stateDir: dir, hubBase: async () => 'http://hub', send: () => true, isLocked: () => null, fetchImpl: hub.fetchImpl, intervalMs: 3_600_000 })
    try {
      await h.tick()
      const lv = hub.urls.find((u) => u.includes('/api/library-version'))
      const d = hub.urls.find((u) => u.includes('/api/tracks/delta'))
      assert.ok(lv?.includes('?concerts=include'), lv)
      assert.ok(d?.includes('&concerts=include'), d)
      assert.match(d!, /since=[^&]*&concerts=include$/)
    } finally { h.stop() }
  })

  it('the hub starting to honour the view moves the key, so a running replica re-fetches', async () => {
    // An already-running replica; the hub deploys under it. Nothing in the
    // library changed — only `view` (and the include count) appear.
    const opts = { honoursView: false, deltaFor: () => ({ unchanged: true, version: opts.honoursView ? 'libci-1' : 'libc-1' }) }
    const hub = includeHub(opts)
    const dir = await mkdtemp(join(tmpdir(), 'hub-include-'))
    const h = startHubCatalogPoll({ stateDir: dir, hubBase: async () => 'http://hub', send: () => true, isLocked: () => null, fetchImpl: hub.fetchImpl, intervalMs: 3_600_000 })
    const deltas = () => hub.urls.filter((u) => u.includes('/api/tracks/delta')).length
    try {
      await h.tick()
      await h.tick()
      assert.equal(deltas(), 1, 'an old hub ignores the parameter: unchanged, no refetch loop')
      opts.honoursView = true
      await h.tick()
      assert.equal(deltas(), 2, 'the hub deploy alone moves the key and fetches the delta')
      await h.tick()
      assert.equal(deltas(), 2, 'and then settles')
    } finally { h.stop() }
  })

  it('a FULL include reply carrying concert rows is handed to the renderer whole', async () => {
    const concert = [{ id: 9290, title: 'Go to Nassau — Full Set', artist: 'Grateful Dead' }, { id: 9267, title: 'Jack Straw', artist: 'Grateful Dead' }]
    const regular = [{ id: 1, title: 'A', artist: 'X' }]
    const hub = includeHub({ honoursView: true, deltaFor: () => ({ full: true, version: 'libci-2', total: 3, items: [...regular, ...concert] }) })
    const dir = await mkdtemp(join(tmpdir(), 'hub-include-'))
    const payloads: Array<{ full: boolean; version: string; upserts: Array<{ id: number | string }> }> = []
    const h = startHubCatalogPoll({
      stateDir: dir, hubBase: async () => 'http://hub', isLocked: () => null, fetchImpl: hub.fetchImpl, intervalMs: 3_600_000,
      send: (_ch, p) => { payloads.push(p as unknown as { full: boolean; version: string; upserts: Array<{ id: number | string }> }); return true },
    })
    try {
      await h.tick()
      assert.equal(payloads.length, 1)
      assert.equal(payloads[0].full, true)
      assert.equal(payloads[0].version, 'libci-2')
      assert.deepEqual(payloads[0].upserts.map((u) => u.id).sort((a, b) => Number(a) - Number(b)), [1, 9267, 9290])
    } finally { h.stop() }
  })
})

// 2026-10-20 — at boot the renderer lays the replica's own (stale, deploy-copied)
// metadata-overrides.json over library.json; a delta never revisits the songs it
// re-planted (measured: 2,479 genres from before the 10-18 re-file). So the
// first delta of each launch asks with since='' and the hub answers FULL.
describe('first poll of each launch re-reads the whole hub catalog', () => {
  function fullHub() {
    const deltaUrls: string[] = []
    let gen = 1
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      const method = (init?.method ?? 'GET').toUpperCase()
      const pack = (body: unknown) => ({ ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(body), json: async () => body })
      if (u.includes('/api/library-version')) return pack({ library: `L${gen}`, tracks: '1', stars: 'S', plays: 'P' })
      if (u.includes('/api/phone-sidecars/')) return method === 'HEAD' ? pack(null) : pack({ mtimeMs: 1, body: '{}' })
      if (u.endsWith('/api/live-sets')) return method === 'HEAD' ? pack(null) : pack({ mtimeMs: 1 })
      if (u.includes('/api/tracks/delta')) {
        deltaUrls.push(u)
        const since = new URL(u).searchParams.get('since') ?? ''
        if (!since) return pack({ full: true, version: `v${gen}`, total: 1, items: [{ id: 1, title: 'A', artist: 'X' }] })
        return pack({ full: false, unchanged: false, version: `v${gen}`, upserts: [{ id: 1, title: 'A2', artist: 'X' }], removedIds: [] })
      }
      return pack({ error: u })
    }) as typeof fetch
    return { deltaUrls, fetchImpl, bump: () => { gen++ } }
  }
  const sinceOf = (u: string) => new URL(u).searchParams.get('since')

  it('asks since="" even with an adopted version on disk, then deltas from the acked version', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hub-full-boot-'))
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(dir, 'hub-catalog-state.json'), JSON.stringify({ version: 'v0-from-last-launch', adoptedAt: '2026-10-19T00:00:00.000Z', seenIds: ['1'] }))
    const hub = fullHub()
    const sent: Array<{ full: boolean; version: string }> = []
    const h = startHubCatalogPoll({
      stateDir: dir, hubBase: async () => 'http://hub', isLocked: () => null, fetchImpl: hub.fetchImpl, intervalMs: 3_600_000,
      send: (_c, p) => { sent.push({ full: p.full, version: p.version }); return true },
    })
    try {
      await h.tick()
      assert.equal(sinceOf(hub.deltaUrls[0]), '', 'first poll of the launch ignores the stored cursor')
      assert.deepEqual(sent[0], { full: true, version: 'v1' })
      await h.adopted('v1')
      hub.bump()
      await h.tick()
      assert.equal(sinceOf(hub.deltaUrls[1]), 'v1', 'after the full ack, a normal delta from the acked version')
      assert.equal(sent[1].full, false)
    } finally { h.stop() }
  })

  it('keeps asking for the full snapshot until one is acked', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hub-full-unacked-'))
    const hub = fullHub()
    const h = startHubCatalogPoll({
      stateDir: dir, hubBase: async () => 'http://hub', isLocked: () => null, fetchImpl: hub.fetchImpl, intervalMs: 3_600_000,
      // No window yet (the renderer is still booting): nothing is delivered.
      send: () => false,
    })
    try {
      await h.tick()
      hub.bump()
      await h.tick()
      assert.equal(hub.deltaUrls.length, 2)
      assert.ok(hub.deltaUrls.every((u) => sinceOf(u) === ''), 'an undelivered full snapshot is asked for again, whole')
    } finally { h.stop() }
  })
})
