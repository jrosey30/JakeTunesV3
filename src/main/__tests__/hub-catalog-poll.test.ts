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
  const calls: Array<{ url: string; method: string; header: string | null }> = []
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    const method = (init?.method ?? 'GET').toUpperCase()
    const header = new Headers(init?.headers).get(COMPANION_HEADER)
    calls.push({ url: u, method, header })
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
    if (u.endsWith('/api/library-version')) {
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
    } finally {
      hub.stop()
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
