import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createTop1000Client, type FetchLike } from '../top1000-client.ts'
import { parseQuizNext } from '../../common/top1000-doc.ts'

const progress = { answered: 3, settled: 200, moving: 800 }
const track = (id: number) => ({ id, title: `Song ${id}`, artist: 'A', album: 'B', duration: 200000 })

function fake(replies: Record<string, { status: number; body: unknown }>, seen: Array<{ url: string; init?: Record<string, unknown> }> = []): FetchLike {
  return async (url, init) => {
    seen.push({ url, init })
    const key = Object.keys(replies).find((k) => url.endsWith(k))
    if (!key) throw new Error('offline')
    const r = replies[key]!
    return { ok: r.status === 200, status: r.status, json: async () => r.body }
  }
}

describe('top1000 doc', () => {
  it('parses a question and refuses the wrong number of songs', () => {
    const ok = parseQuizNext({ question: { kind: 'pick', songs: [{ track: track(1), hookMs: 60000 }, { track: track(2), hookMs: 0 }] }, progress })
    assert.equal(ok?.question?.songs[0]?.hookMs, 60000)
    assert.equal(parseQuizNext({ question: { kind: 'pick', songs: [{ track: track(1), hookMs: 1 }] }, progress }), null)
    assert.equal(parseQuizNext({ question: { kind: 'nope', songs: [] }, progress }), null)
    assert.deepEqual(parseQuizNext({ question: null, progress }), { question: null, progress })
  })
})

describe('top1000 client', () => {
  it('next → question; answer posts JSON and returns progress', async () => {
    const seen: Array<{ url: string; init?: Record<string, unknown> }> = []
    const c = createTop1000Client({
      baseUrl: 'http://homemini:3000/',
      warn: () => {},
      fetchImpl: fake({
        '/api/top1000/next': { status: 200, body: { question: { kind: 'inout', songs: [{ track: track(9), hookMs: 50000 }] }, progress } },
        '/api/top1000/answer': { status: 200, body: { ok: true, progress: { ...progress, answered: 4 } } },
      }, seen),
    })
    const n = await c.next()
    assert.ok(n.ok && n.value.question?.kind === 'inout')
    const a = await c.answer({ kind: 'inout', ids: ['9'], choice: 'in' })
    assert.ok(a.ok && a.value.answered === 4)
    const post = seen.find((s) => s.url.endsWith('/answer'))!
    assert.equal(post.init?.method, 'POST')
    assert.deepEqual(JSON.parse(String(post.init?.body)), { kind: 'inout', ids: ['9'], choice: 'in' })
    assert.equal(seen[0]!.url, 'http://homemini:3000/api/top1000/next')
  })

  it('says plainly when an answer was not saved', async () => {
    const offline = createTop1000Client({ baseUrl: 'http://x', warn: () => {}, fetchImpl: fake({}) })
    const a = await offline.answer({ kind: 'pick', ids: ['1', '2'], choice: '1' })
    assert.ok(!a.ok && /wasn’t saved/.test(a.error))
    const gone = createTop1000Client({ baseUrl: 'http://x', warn: () => {}, fetchImpl: fake({ '/answer': { status: 409, body: { ok: false, error: 'that song is no longer in the quiz' } } }) })
    const b = await gone.answer({ kind: 'pick', ids: ['1', '2'], choice: '1' })
    assert.ok(!b.ok && /no longer in the quiz/.test(b.error))
    const n = await offline.next()
    assert.ok(!n.ok && /homemini/.test(n.error))
  })
})
