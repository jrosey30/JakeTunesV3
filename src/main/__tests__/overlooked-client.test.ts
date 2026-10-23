/**
 * Overlooked document + client (2026-10-22).
 * ⚠️ Contract twin: JakeTunesMobile backend/src/routes/overlooked.ts.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { parseOverlooked } from '../../common/overlooked-doc.ts'
import { createOverlookedClient, MEMO_MS, type FetchLike } from '../overlooked-client.ts'

const doc = (lanes: unknown[]): unknown => ({ version: 1, generatedAt: 'x', day: '2026-10-22', lanes })
const item = (id: unknown, reason: unknown): unknown => ({ track: { id }, reason })

test('parse: keeps good songs, drops songs without an id or a reason and empty lanes', () => {
  const out = parseOverlooked(doc([
    { genre: null, items: [item(1, 'a'), item('2', 'b'), item(3, ''), item(4, '  why  ')] },
    { genre: 'Post-Punk', items: [item(NaN, 'x')] },
    { genre: ' Pop ', items: [item(5, 'c')] },
  ]))
  assert.deepEqual(out?.lanes, [
    { genre: null, items: [{ id: 1, reason: 'a' }, { id: 4, reason: 'why' }] },
    { genre: 'Pop', items: [{ id: 5, reason: 'c' }] },
  ])
})

test('parse: a wrong version, torn shape or no songs at all is no document', () => {
  assert.equal(parseOverlooked({ version: 2, lanes: [] }), null)
  assert.equal(parseOverlooked('<html>'), null)
  assert.equal(parseOverlooked(doc([])), null)
  assert.equal(parseOverlooked(doc([{ genre: 'x', items: [item(1, '')] }])), null)
})

const ok = (body: unknown): FetchLike => async () => ({ ok: true, status: 200, json: async () => body })

test('client: remembers an answer for the memo window, then asks again', async () => {
  let t = 1_000_000; let calls = 0
  const fetchImpl: FetchLike = async () => { calls++; return { ok: true, status: 200, json: async () => doc([{ genre: null, items: [item(1, 'a')] }]) } }
  const c = createOverlookedClient({ baseUrl: 'http://h:3000/', fetchImpl, now: () => t, warn: () => {} })
  assert.equal((await c.get()).source, 'homemini')
  assert.equal((await c.get()).source, 'memo')
  assert.equal(calls, 1)
  t += MEMO_MS + 1
  assert.equal((await c.get()).source, 'homemini')
  assert.equal(calls, 2)
})

test('client: homemini away → the last good document; with none, nothing', async () => {
  let down = false
  const fetchImpl: FetchLike = async () => {
    if (down) throw new Error('offline')
    return ok(doc([{ genre: null, items: [item(1, 'a')] }]))('')
  }
  let t = 5
  const c = createOverlookedClient({ baseUrl: 'http://h:3000', fetchImpl, now: () => t, warn: () => {} })
  down = true
  assert.deepEqual(await c.get(), { doc: null, source: 'none' })
  down = false
  await c.get()
  down = true; t += MEMO_MS + 1
  const s = await c.get()
  assert.equal(s.source, 'memo'); assert.equal(s.doc?.lanes[0]?.items[0]?.id, 1)
})

test('client: a reply that is not a document never replaces a good one', async () => {
  let bad = false; let t = 5
  const fetchImpl: FetchLike = async () => bad ? { ok: true, status: 200, json: async () => ({ version: 9 }) } : { ok: true, status: 200, json: async () => doc([{ genre: null, items: [item(7, 'z')] }]) }
  const c = createOverlookedClient({ baseUrl: 'http://h', fetchImpl, now: () => t, warn: () => {} })
  await c.get(); bad = true; t += MEMO_MS + 1
  assert.equal((await c.get()).doc?.lanes[0]?.items[0]?.id, 7)
})
