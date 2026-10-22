// Daily AI tapes on the desktop (parity gap #9) — the wire parse and the two
// filters (src/common/ai-mixtapes.ts) and the client that reads and keeps
// them (src/main/ai-mixtapes-client.ts), against a fake homemini: first
// fetch + cache, offline with and without a cache, a reply that isn't the
// document, an empty list (truth, not failure), Keep on 200 / 404 / no
// answer, the companion header, and coalesced refreshes.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseAiMixtapes, dailyAiTapes, keptAiTapes, withAiTapeKept, aiTapeKeepPath, type AiMixtape, type AiMixtapesState,
} from '../../common/ai-mixtapes.ts'
import { createAiMixtapesClient, AI_MIXTAPES_CACHE_FILE, type FetchLike } from '../ai-mixtapes-client.ts'
import { COMPANION_HEADER, COMPANION_TOKEN_ENV } from '../hub-companion.ts'

// The shape homemini's GET /api/mixtapes sends (backend/src/routes/mixtapes.ts):
// AI tapes (source 'ai', kept) merged with this Mac's own published tapes.
const aiTape = (id: string, kept: boolean, ids: number[], title = `Tape ${id}`) => ({
  id, title, commentary: `about ${id}`, dedication: null, tapeLength: 90,
  createdAt: '2026-10-22T09:00:00.000Z', inkColor: null,
  sides: [{ side: 'A', cutMs: null, tracks: ids.map((n) => ({ id: n, title: `t${n}`, artist: 'a', album: null, durationMs: 1000, artworkHash: '', note: null, startOffsetMs: null })) }],
  trackCount: ids.length, artworkHash: '', source: 'ai', kept,
})
const dubbed = {
  id: 'mt-1720000000000', title: 'Summer Drive', commentary: '', dedication: null, tapeLength: 90,
  createdAt: '2026-07-18T12:00:00.000Z', inkColor: '#1d3f8f',
  sides: [{ side: 'A', cutMs: null, tracks: [{ id: 9, title: 't9', artist: 'b', album: null, durationMs: 1, artworkHash: '', note: null, startOffsetMs: null }] }],
  trackCount: 1, artworkHash: '',
}
const BODY = {
  items: [
    aiTape('ai-2026-10-22-mix-a', false, [11, 12, 13]),
    aiTape('ai-2026-10-22-mix-b', false, [21, 22]),
    dubbed,
    aiTape('ai-2026-10-19-mix-c', true, [31, 32]),
  ],
  total: 4,
}

describe('ai mixtapes — wire parse and filters', () => {
  it('keeps only the AI tapes, in homemini order, tracks in play order', () => {
    const tapes = parseAiMixtapes(BODY)
    assert.ok(tapes)
    assert.deepEqual(tapes.map((t) => t.id), ['ai-2026-10-22-mix-a', 'ai-2026-10-22-mix-b', 'ai-2026-10-19-mix-c'])
    assert.deepEqual(tapes[0].trackIds, [11, 12, 13])
    assert.equal(tapes[0].commentary, 'about ai-2026-10-22-mix-a')
    assert.equal(tapes[2].kept, true)
  })

  it('this Mac’s own tapes in the reply are never taken (the desktop has them from its own file)', () => {
    const tapes = parseAiMixtapes({ items: [dubbed] })
    assert.deepEqual(tapes, [])
  })

  it('a reply that is not the document is null; an empty list is a real answer', () => {
    assert.equal(parseAiMixtapes('<html>proxy</html>'), null)
    assert.equal(parseAiMixtapes({ error: 'boom' }), null)
    assert.equal(parseAiMixtapes(null), null)
    assert.deepEqual(parseAiMixtapes({ items: [], total: 0 }), [])
  })

  it('drops a tape with no playable tracks and a repeated id; kept is true only when homemini says so', () => {
    const tapes = parseAiMixtapes({ items: [
      aiTape('ai-x', false, []),
      { ...aiTape('ai-y', false, [1]), kept: 'yes' },
      aiTape('ai-y', true, [2]),
    ] })
    assert.ok(tapes)
    assert.deepEqual(tapes.map((t) => [t.id, t.kept, t.trackIds]), [['ai-y', false, [1]]])
  })

  it('the rail is the tapes not kept; the shelf is the kept ones (the phone’s dailyTapes / kept)', () => {
    const tapes = parseAiMixtapes(BODY) as AiMixtape[]
    assert.deepEqual(dailyAiTapes(tapes).map((t) => t.id), ['ai-2026-10-22-mix-a', 'ai-2026-10-22-mix-b'])
    assert.deepEqual(keptAiTapes(tapes).map((t) => t.id), ['ai-2026-10-19-mix-c'])
    const flipped = withAiTapeKept(tapes, 'ai-2026-10-22-mix-b', true)
    assert.deepEqual(keptAiTapes(flipped).map((t) => t.id), ['ai-2026-10-22-mix-b', 'ai-2026-10-19-mix-c'])
    assert.equal(tapes[1].kept, false, 'the flip never mutates the list it was given')
    assert.equal(withAiTapeKept(flipped, 'ai-2026-10-22-mix-b', false)[1].kept, false)
  })

  it('the keep route is the phone’s, with the id kept intact', () => {
    assert.equal(aiTapeKeepPath('ai-2026-10-22-mix-2026-10-22-0'), '/api/mixtapes/ai/ai-2026-10-22-mix-2026-10-22-0/keep')
    assert.equal(aiTapeKeepPath('a/b'), '/api/mixtapes/ai/a%2Fb/keep')
  })
})

interface Hub {
  mode: 'up' | 'down' | 'garbage' | 'error'
  body: unknown
  keepStatus: number
  calls: Array<{ url: string; method: string; body: string | null; companion: string | null; contentType: string | null }>
}

function header(init: Record<string, unknown> | undefined, name: string): string | null {
  const h = init?.headers as Headers | Record<string, string> | undefined
  if (!h) return null
  if (typeof (h as Headers).get === 'function') return (h as Headers).get(name)
  const hit = Object.entries(h).find(([k]) => k.toLowerCase() === name.toLowerCase())
  return hit ? hit[1] : null
}

function fakeFetch(hub: Hub): FetchLike {
  return async (url, init) => {
    const method = String(init?.method ?? 'GET')
    hub.calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : null, companion: header(init, COMPANION_HEADER), contentType: header(init, 'Content-Type') })
    if (hub.mode === 'down') throw new Error('connect ECONNREFUSED')
    if (method === 'POST') return { ok: hub.keepStatus >= 200 && hub.keepStatus < 300, status: hub.keepStatus, json: async () => ({}) }
    if (hub.mode === 'error') return { ok: false, status: 500, json: async () => ({ error: 'unwell' }) }
    if (hub.mode === 'garbage') return { ok: true, status: 200, json: async () => '<html>proxy</html>' }
    return { ok: true, status: 200, json: async () => hub.body }
  }
}

describe('ai mixtapes client', () => {
  let dir = ''
  let hub: Hub
  const savedToken = process.env[COMPANION_TOKEN_ENV]
  const make = () => createAiMixtapesClient({ baseUrl: 'http://homemini:3000/', dir, fetchImpl: fakeFetch(hub), log: () => {}, warn: () => {} })

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ai-mixtapes-'))
    hub = { mode: 'up', body: BODY, keepStatus: 200, calls: [] }
    delete process.env[COMPANION_TOKEN_ENV]
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
    if (savedToken === undefined) delete process.env[COMPANION_TOKEN_ENV]
    else process.env[COMPANION_TOKEN_ENV] = savedToken
  })

  it('reads homemini’s /api/mixtapes, caches the AI tapes, and says where they came from', async () => {
    const c = make()
    assert.deepEqual(await c.read(), { tapes: [], source: 'none', reachable: null })
    const s = await c.refresh()
    assert.equal(hub.calls[0].url, 'http://homemini:3000/api/mixtapes')
    assert.equal(hub.calls[0].method, 'GET')
    assert.equal(s.source, 'homemini')
    assert.equal(s.reachable, true)
    assert.equal(s.tapes.length, 3)
    const cached = JSON.parse(await readFile(join(dir, AI_MIXTAPES_CACHE_FILE), 'utf-8')) as { tapes: AiMixtape[] }
    assert.deepEqual(cached.tapes.map((t) => t.id), s.tapes.map((t) => t.id))
  })

  it('homemini away: the cached tapes, then nothing when there is no cache (fail quietly)', async () => {
    await make().refresh()
    hub.mode = 'down'
    const c = make()
    const s = await c.refresh()
    assert.equal(s.source, 'cache')
    assert.equal(s.reachable, false)
    assert.deepEqual(s.tapes.map((t) => t.id), ['ai-2026-10-22-mix-a', 'ai-2026-10-22-mix-b', 'ai-2026-10-19-mix-c'])
    await rm(join(dir, AI_MIXTAPES_CACHE_FILE))
    assert.deepEqual(await make().refresh(), { tapes: [], source: 'none', reachable: false })
  })

  it('a reply that is not the document, or a 500, never replaces a good cache', async () => {
    await make().refresh()
    for (const mode of ['garbage', 'error'] as const) {
      hub.mode = mode
      const s = await make().refresh()
      assert.equal(s.source, 'cache')
      assert.equal(s.tapes.length, 3)
    }
  })

  it('an empty list is the truth: it clears the cache instead of repainting stale tapes', async () => {
    await make().refresh()
    hub.body = { items: [dubbed], total: 1 }
    const s = await make().refresh()
    assert.equal(s.source, 'homemini')
    assert.deepEqual(s.tapes, [])
    assert.deepEqual((await make().read()).tapes, [])
  })

  it('a torn cache file reads as no cache', async () => {
    await writeFile(join(dir, AI_MIXTAPES_CACHE_FILE), '{"tapes": [', 'utf-8')
    assert.deepEqual(await make().read(), { tapes: [], source: 'none', reachable: null })
  })

  it('Keep POSTs { kept } to the phone’s route; a 200 flips the cache and tells the listeners', async () => {
    const c = make()
    await c.refresh()
    const seen: AiMixtapesState[] = []
    c.onChange((s) => seen.push(s))
    const r = await c.keep('ai-2026-10-22-mix-b', true)
    assert.deepEqual(r, { ok: true })
    const post = hub.calls.find((x) => x.method === 'POST')
    assert.ok(post)
    assert.equal(post.url, 'http://homemini:3000/api/mixtapes/ai/ai-2026-10-22-mix-b/keep')
    assert.deepEqual(JSON.parse(post.body ?? 'null'), { kept: true })
    assert.equal(post.contentType, 'application/json')
    const after = await c.read()
    assert.equal(after.tapes.find((t) => t.id === 'ai-2026-10-22-mix-b')?.kept, true)
    assert.equal(seen.length, 1)
    assert.equal(seen[0].tapes.find((t) => t.id === 'ai-2026-10-22-mix-b')?.kept, true)
    // …and un-keep sends kept: false.
    await c.keep('ai-2026-10-22-mix-b', false)
    assert.deepEqual(JSON.parse(hub.calls.filter((x) => x.method === 'POST')[1].body ?? 'null'), { kept: false })
    assert.equal((await c.read()).tapes.find((t) => t.id === 'ai-2026-10-22-mix-b')?.kept, false)
  })

  it('only a 200 is a Keep: a 404 (rolled over) or no answer leaves the cache alone', async () => {
    const c = make()
    await c.refresh()
    hub.keepStatus = 404
    assert.equal((await c.keep('ai-2026-10-22-mix-a', true)).ok, false)
    hub.keepStatus = 204
    assert.equal((await c.keep('ai-2026-10-22-mix-a', true)).ok, false)
    hub.mode = 'down'
    assert.deepEqual(await c.keep('ai-2026-10-22-mix-a', true), { ok: false, error: 'unreachable' })
    assert.equal((await c.read()).tapes.find((t) => t.id === 'ai-2026-10-22-mix-a')?.kept, false)
  })

  it('sends the companion header on the read and the Keep when a token is set, and none otherwise', async () => {
    await make().refresh()
    assert.equal(hub.calls[0].companion, null)
    process.env[COMPANION_TOKEN_ENV] = 'scratch-token'
    const c = make()
    await c.refresh()
    await c.keep('ai-2026-10-22-mix-a', true)
    assert.equal(hub.calls[1].companion, 'scratch-token')
    assert.equal(hub.calls[2].companion, 'scratch-token')
  })

  it('refreshes that overlap share one GET', async () => {
    const c = make()
    const [a, b] = await Promise.all([c.refresh(), c.refresh()])
    assert.equal(hub.calls.length, 1)
    assert.deepEqual(a, b)
  })
})
