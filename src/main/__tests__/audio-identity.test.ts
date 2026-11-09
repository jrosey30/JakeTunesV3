/**
 * Asking homemini what it holds instead of downloading it (2026-11-09).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { askAudioIdentity, hubBaseFromAudioBase, identityKey, isPending, oneIdentity, parseIdentityBody, parseIdentityEntry } from '../audio-identity.ts'

const good = { size: 11124599, sha1: 'ab'.repeat(20), etag: '"a9bf77-19e6c96fcd8"' }
type Call = { url: string; header: string | null }
const server = (calls: Call[], reply: (url: string) => Response | Promise<Response>) => async (url: string, init?: RequestInit): Promise<Response> => {
  calls.push({ url, header: new Headers(init?.headers).get('X-JakeTunes-Companion') })
  return reply(url)
}
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('audio identity', () => {
  it('only a whole answer is an answer', () => {
    assert.deepEqual(parseIdentityEntry(good), good)
    assert.deepEqual(parseIdentityEntry({ ...good, sha1: 'AB'.repeat(20) }), good, 'hex case is not a difference')
    assert.equal(parseIdentityEntry({ ...good, sha1: 'ab'.repeat(8) }), null, 'a 16-hex prefix is not the file’s sha1')
    assert.equal(parseIdentityEntry({ ...good, size: 0 }), null)
    assert.equal(parseIdentityEntry({ ...good, size: '12x' }), null)
    assert.equal(parseIdentityEntry({ ...good, etag: '' }), null)
    assert.equal(parseIdentityEntry({ size: good.size, sha1: good.sha1 }), null)
    assert.equal(parseIdentityEntry({ missing: true }), null)
    assert.equal(parseIdentityEntry({ missing: true, ...good }), null, 'missing wins')
    // not hashed yet: said so by homemini, never guessed from a half answer
    assert.deepEqual(parseIdentityEntry({ pending: true, size: 5, etag: '"5-1"' }), { pending: true, size: 5, etag: '"5-1"' })
    assert.deepEqual(parseIdentityEntry({ pending: true }), { pending: true })
    assert.deepEqual(parseIdentityEntry({ pending: true, sha1: good.sha1, size: 5, etag: '"x"' }), { pending: true, size: 5, etag: '"x"' }, 'pending is never an identity')
    assert.equal(isPending(parseIdentityEntry({ pending: true })), true)
    assert.equal(isPending(good), false)
    assert.equal(isPending(null), false)
    assert.equal(parseIdentityEntry(null), null)
    assert.equal(parseIdentityEntry('x'), null)
  })

  it('every asked id gets an entry, whatever wraps the rows', () => {
    const want = new Map([['518', good], ['9', null]])
    assert.deepEqual(parseIdentityBody({ 518: good }, [518, 9]), want)
    // the backend's own shape (routes/audioIdentity.ts)
    assert.deepEqual(
      parseIdentityBody({ ok: true, files: { 518: good, 9: { missing: true }, 7: { pending: true, size: 3, etag: '"3-1"' } } }, [518, 9, 7]),
      new Map<string, unknown>([['518', good], ['9', null], ['7', { pending: true, size: 3, etag: '"3-1"' }]]),
    )
    assert.deepEqual(parseIdentityBody({ ids: { 518: good, 9: null } }, [518, 9]), want)
    assert.deepEqual(parseIdentityBody({ identities: { 518: good, 9: { error: 'not found' } } }, [518, 9]), want)
    assert.deepEqual(parseIdentityBody([{ id: 518, ...good }], [518, 9]), want)
    assert.deepEqual(parseIdentityBody({ items: [{ id: '518', ...good }] }, [518, 9]), want)
    assert.deepEqual(parseIdentityBody(null, [518]), new Map([['518', null]]))
    assert.equal(parseIdentityBody({ 518: good, 7: good }, [518]).has('7'), false, 'an id nobody asked about is not taken')
  })

  it('asks in chunks, with the companion header, and joins the answers', async () => {
    const calls: Call[] = []
    const answer = await askAudioIdentity({
      baseUrl: 'http://homemini:3000/',
      ids: [1, 2, 2, 3, 'bad id', 4, 5],
      chunk: 2,
      withInit: (init) => ({ ...init, headers: { 'X-JakeTunes-Companion': 't' } }),
      fetchImpl: server(calls, (url) => {
        const ids = new URL(url).searchParams.get('ids')!.split(',')
        return json(Object.fromEntries(ids.filter((id) => id !== '4').map((id) => [id, { ...good, size: Number(id) }])))
      }),
    })
    assert.deepEqual(calls.map((c) => c.url), [
      'http://homemini:3000/api/audio-identity?ids=1,2',
      'http://homemini:3000/api/audio-identity?ids=3,4',
      'http://homemini:3000/api/audio-identity?ids=5',
    ])
    assert.ok(calls.every((c) => c.header === 't'))
    assert.equal(answer.kind, 'answers')
    assert.deepEqual(oneIdentity(answer, 3), { ...good, size: 3 })
    assert.equal(oneIdentity(answer, 4), null, 'homemini has no file for it')
    assert.equal(oneIdentity(answer, 99), null)
  })

  it('404 is an older backend; anything else decides nothing', async () => {
    const ask = (reply: () => Response | Promise<Response>) => askAudioIdentity({ baseUrl: 'http://h', ids: [1], fetchImpl: server([], reply) })
    assert.deepEqual(await ask(() => new Response('Not Found', { status: 404 })), { kind: 'unsupported' })
    assert.deepEqual(await ask(() => new Response('no', { status: 401 })), { kind: 'unreachable' })
    assert.deepEqual(await ask(() => json({ ok: false, error: 'at most 200 ids per request' }, 400)), { kind: 'unreachable' })
    assert.deepEqual(await ask(() => new Response('no', { status: 500 })), { kind: 'unreachable' })
    assert.deepEqual(await ask(() => new Response('<html>', { status: 200 })), { kind: 'unreachable' })
    assert.deepEqual(await ask(() => { throw new Error('down') }), { kind: 'unreachable' })
    assert.equal(oneIdentity({ kind: 'unsupported' }, 1), 'unsupported')
    assert.equal(oneIdentity({ kind: 'unreachable' }, 1), 'unreachable')
  })

  it('a later chunk failing fails the whole ask: half an answer is not used', async () => {
    let n = 0
    const answer = await askAudioIdentity({ baseUrl: 'http://h', ids: [1, 2], chunk: 1, fetchImpl: server([], () => (++n === 1 ? json({ 1: good }) : new Response('no', { status: 502 }))) })
    assert.deepEqual(answer, { kind: 'unreachable' })
  })

  it('nothing to ask asks nothing', async () => {
    const calls: Call[] = []
    assert.equal((await askAudioIdentity({ baseUrl: 'http://h', ids: [], fetchImpl: server(calls, () => json({})) })).kind, 'answers')
    assert.equal(calls.length, 0)
  })

  it('the key moves when homemini’s copy does', () => {
    assert.notEqual(identityKey(good), identityKey({ ...good, etag: '"a9bf77-19e6c96ffff"' }))
    assert.notEqual(identityKey(good), identityKey({ ...good, sha1: 'cd'.repeat(20) }))
    assert.notEqual(identityKey(good), identityKey({ ...good, size: 1 }))
    assert.equal(hubBaseFromAudioBase('http://homemini:3000/audio/'), 'http://homemini:3000')
  })
})
