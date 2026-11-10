/**
 * Is homemini's playable copy ready? (2026-11-10, "transistor by 311 wont play").
 * Anything short of `ready` / `not-needed` keeps the file on this Mac.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  askFlacVariants, confirmPlayableOnHomemini, notPlayableMessage, parseVariantBody, playableIds, playableNow,
  type VariantReply, type VariantState,
} from '../flac-variant.ts'

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const answers = (m: Record<string, VariantState | null>): VariantReply => ({ kind: 'answers', byId: new Map(Object.entries(m)) })

describe('playableNow', () => {
  it('only a ready copy, or a song that needs none, is playable', () => {
    assert.equal(playableNow('ready'), true)
    assert.equal(playableNow('not-needed'), true)
    for (const s of ['building', 'absent', 'missing', 'waiting', 'no-room', 'failed'] as VariantState[]) assert.equal(playableNow(s), false, s)
    assert.equal(playableNow(null), false)
    assert.equal(playableNow(undefined), false)
  })
})

describe('parseVariantBody', () => {
  it('every asked id gets an entry, and an unknown state is not a state', () => {
    const got = parseVariantBody({ ok: true, variants: { '1': { state: 'ready', size: 9 }, '2': { state: 'READY' }, '3': 'ready', '4': { state: 'building' } } }, ['1', '2', '3', '4', '5'])
    assert.deepEqual([...got], [['1', 'ready'], ['2', null], ['3', null], ['4', 'building'], ['5', null]])
    assert.deepEqual([...parseVariantBody(null, ['1'])], [['1', null]])
    assert.deepEqual([...parseVariantBody({ variants: [] }, ['0'])], [['0', null]])
  })
})

describe('askFlacVariants', () => {
  it('asking is a GET; wanting is a POST to /want with the ids', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchImpl = async (url: string, init?: RequestInit) => { calls.push({ url, init }); return json({ ok: true, variants: { '7': { state: 'ready', size: 1 }, '8': { state: 'absent' } } }) }
    const asked = await askFlacVariants({ baseUrl: 'http://h:3000/', ids: [7, '8', 7, 'bad id'], want: false, fetchImpl, withInit: (i) => ({ ...i, headers: { ...(i.headers as Record<string, string>), 'X-Test': '1' } }) })
    assert.deepEqual(asked, answers({ '7': 'ready', '8': 'absent' }))
    assert.equal(calls[0].url, 'http://h:3000/api/flac-variant?ids=7,8')
    assert.equal(calls[0].init?.method, undefined)
    assert.equal((calls[0].init?.headers as Record<string, string>)['X-Test'], '1')
    await askFlacVariants({ baseUrl: 'http://h:3000', ids: [7, 8], want: true, fetchImpl })
    assert.equal(calls[1].url, 'http://h:3000/api/flac-variant/want')
    assert.equal(calls[1].init?.method, 'POST')
    assert.deepEqual(JSON.parse(String(calls[1].init?.body)), { ids: ['7', '8'] })
  })
  it('no ids asks nothing', async () => {
    let n = 0
    assert.deepEqual(await askFlacVariants({ baseUrl: 'http://h', ids: [], want: true, fetchImpl: async () => { n++; return json({}) } }), answers({}))
    assert.equal(n, 0)
  })
  it('a 404 is an older backend; anything else that isn’t an answer is no answer; neither says ready', async () => {
    assert.deepEqual(await askFlacVariants({ baseUrl: 'http://h', ids: [1], want: false, fetchImpl: async () => json({}, 404) }), { kind: 'unsupported' })
    assert.deepEqual(await askFlacVariants({ baseUrl: 'http://h', ids: [1], want: false, fetchImpl: async () => json({}, 503) }), { kind: 'unreachable' })
    assert.deepEqual(await askFlacVariants({ baseUrl: 'http://h', ids: [1], want: false, fetchImpl: async () => { throw new TypeError('fetch failed') } }), { kind: 'unreachable' })
    assert.deepEqual(await askFlacVariants({ baseUrl: 'http://h', ids: [1], want: false, fetchImpl: async () => new Response('<html>', { status: 200 }) }), { kind: 'unreachable' })
    assert.equal(playableIds({ kind: 'unsupported' }), null)
    assert.equal(playableIds({ kind: 'unreachable' }), null)
    assert.deepEqual([...playableIds(answers({ '1': 'ready', '2': 'building', '3': 'not-needed', '4': null }))!], ['1', '3'])
  })
  it('more ids than a chunk go in several requests', async () => {
    const urls: string[] = []
    const reply = await askFlacVariants({ baseUrl: 'http://h', ids: [1, 2, 3], want: false, chunk: 2, fetchImpl: async (url) => { urls.push(url); return json({ variants: { '1': { state: 'ready' }, '2': { state: 'ready' }, '3': { state: 'failed' } } }) } })
    assert.deepEqual(urls, ['http://h/api/flac-variant?ids=1,2', 'http://h/api/flac-variant?ids=3'])
    assert.deepEqual(reply, answers({ '1': 'ready', '2': 'ready', '3': 'failed' }))
  })
})

describe('confirmPlayableOnHomemini', () => {
  const run = (replies: VariantReply[], retries?: number) => {
    const sleeps: number[] = []
    let asks = 0
    return confirmPlayableOnHomemini({
      id: 14921, retries, waitMs: 10,
      ask: async () => { asks++; return replies[Math.min(asks - 1, replies.length - 1)] },
      sleep: async (ms) => { sleeps.push(ms) },
    }).then((result) => ({ result, asks, sleeps }))
  }
  it('ready, or needs none: the file may go', async () => {
    assert.deepEqual((await run([answers({ '14921': 'ready' })])).result, { ok: true })
    assert.deepEqual((await run([answers({ '14921': 'not-needed' })])).result, { ok: true })
  })
  it('in the background a copy still being built is a no, asked once', async () => {
    const r = await run([answers({ '14921': 'building' }), answers({ '14921': 'ready' })])
    assert.deepEqual(r.result, { ok: false, state: 'building' })
    assert.equal(r.asks, 1)
    assert.deepEqual(r.sleeps, [])
  })
  it('a request waits for the copy being built, and goes when it is ready', async () => {
    const r = await run([answers({ '14921': 'building' }), answers({ '14921': 'building' }), answers({ '14921': 'ready' })], 6)
    assert.deepEqual(r.result, { ok: true })
    assert.equal(r.asks, 3)
    assert.deepEqual(r.sleeps, [10, 10])
  })
  it('a request gives up after its retries', async () => {
    const r = await run([answers({ '14921': 'building' })], 2)
    assert.deepEqual(r.result, { ok: false, state: 'building' })
    assert.equal(r.asks, 3)
  })
  it('no room, a failed conversion, a missing file: no, and not waited on', async () => {
    for (const s of ['no-room', 'failed', 'missing', 'waiting'] as VariantState[]) {
      const r = await run([answers({ '14921': s }), answers({ '14921': 'ready' })], 6)
      assert.deepEqual(r.result, { ok: false, state: s }, s)
      assert.equal(r.asks, 1, s)
    }
  })
  it('no answer, an older backend, an id the answer leaves out, a throw: all no', async () => {
    assert.deepEqual((await run([{ kind: 'unreachable' }])).result, { ok: false, state: 'unreachable' })
    assert.deepEqual((await run([{ kind: 'unsupported' }])).result, { ok: false, state: 'unsupported' })
    assert.deepEqual((await run([answers({ '5': 'ready' })])).result, { ok: false, state: 'unknown' })
    const thrown = await confirmPlayableOnHomemini({ id: 1, ask: async () => { throw new Error('boom') } })
    assert.deepEqual(thrown, { ok: false, state: 'unreachable' })
  })
  it('each message says what happened', () => {
    assert.match(notPlayableMessage('building'), /still getting its playable copy/)
    assert.match(notPlayableMessage('no-room'), /no room/)
    assert.match(notPlayableMessage('unreachable'), /did not say/)
    for (const s of ['building', 'no-room', 'unreachable', 'failed'] as const) assert.match(notPlayableMessage(s), /kept local/)
  })
})
