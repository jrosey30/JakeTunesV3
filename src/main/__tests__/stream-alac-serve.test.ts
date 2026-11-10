/**
 * Where a streamed ALAC song's bytes come from (2026-11-10): this Mac's decoded
 * copy, else homemini's ready copy, else decoded here. One song, one source.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStreamedAlacServer, SOURCE_PIN_MS, type StreamedAlacDeps } from '../stream-alac-serve.ts'

function world(over: Partial<StreamedAlacDeps> & { cached?: boolean; ready?: boolean | 'throw'; flac?: 'ok' | 'null' | 'throw' } = {}) {
  const seen = { local: [] as string[], flac: [] as string[], wanted: [] as string[], readyAsks: 0, logs: [] as string[] }
  let now = 1000
  let cached = over.cached ?? false
  let ready = over.ready ?? false
  let flac = over.flac ?? 'ok'
  const server = createStreamedAlacServer({
    cachedLocally: async () => cached,
    serveLocal: async (id, range) => { seen.local.push(`${id}:${range}`); return new Response('local') },
    readyOnHomemini: async () => { seen.readyAsks++; if (ready === 'throw') throw new Error('timeout'); return ready },
    fetchFlac: async (id, range) => { seen.flac.push(`${id}:${range}`); if (flac === 'throw') throw new Error('net'); return flac === 'null' ? null : new Response('homemini') },
    want: (id) => { seen.wanted.push(id) },
    now: () => now,
    log: (m) => { seen.logs.push(m) },
    ...over,
  })
  return {
    server, seen,
    set: (v: { cached?: boolean; ready?: boolean; flac?: 'ok' | 'null' | 'throw' }) => { if (v.cached != null) cached = v.cached; if (v.ready != null) ready = v.ready; if (v.flac) flac = v.flac },
    advance: (ms: number) => { now += ms },
  }
}

describe('a streamed ALAC song', () => {
  it('already decoded on this Mac: served from disk, homemini is not asked', async () => {
    const w = world({ cached: true, ready: true })
    assert.equal(await (await w.server.serve(14921, 'bytes=0-')).text(), 'local')
    assert.equal(w.seen.readyAsks, 0)
    assert.deepEqual(w.seen.flac, [])
    assert.deepEqual(w.seen.wanted, [])
  })
  it('homemini’s copy is ready: it is played from homemini, nothing is downloaded whole', async () => {
    const w = world({ ready: true })
    assert.equal(await (await w.server.serve(14921, 'bytes=0-')).text(), 'homemini')
    assert.deepEqual(w.seen.flac, ['14921:bytes=0-'])
    assert.deepEqual(w.seen.local, [])
    assert.deepEqual(w.seen.wanted, [])
    assert.equal(w.server.sourceOf(14921), 'homemini')
  })
  it('not ready: decoded here as before, and homemini is asked to build its copy', async () => {
    const w = world({ ready: false })
    assert.equal(await (await w.server.serve(14921, null)).text(), 'local')
    assert.deepEqual(w.seen.local, ['14921:null'])
    assert.deepEqual(w.seen.wanted, ['14921'])
    assert.deepEqual(w.seen.flac, [])
  })
  it('homemini not answering the question is "not ready", never a failed play', async () => {
    const w = world({ ready: 'throw' })
    assert.equal(await (await w.server.serve(1, null)).text(), 'local')
  })
  it('ready but homemini doesn’t serve it: decoded here, and said so', async () => {
    for (const flac of ['null', 'throw'] as const) {
      const w = world({ ready: true, flac })
      assert.equal(await (await w.server.serve(1, null)).text(), 'local')
      assert.match(w.seen.logs.join('\n'), /decoding here instead/)
      assert.equal(w.server.sourceOf(1), 'local')
    }
  })
})

describe('one song, one source', () => {
  it('a song that started on homemini stays there for its later ranges, even once a decoded copy appears here', async () => {
    const w = world({ ready: true })
    await w.server.serve(7, 'bytes=0-')
    w.set({ cached: true, ready: false })
    assert.equal(await (await w.server.serve(7, 'bytes=900000-')).text(), 'homemini')
    assert.equal(w.seen.readyAsks, 1, 'the later range does not ask again')
  })
  it('a song that started on this Mac stays here, even once homemini’s copy is ready', async () => {
    const w = world({ ready: false })
    await w.server.serve(7, 'bytes=0-')
    w.set({ ready: true })
    assert.equal(await (await w.server.serve(7, 'bytes=900000-')).text(), 'local')
    assert.deepEqual(w.seen.flac, [])
  })
  it('after half an hour the song is looked at afresh', async () => {
    const w = world({ ready: false })
    await w.server.serve(7, null)
    w.set({ ready: true })
    w.advance(SOURCE_PIN_MS)
    assert.equal(await (await w.server.serve(7, null)).text(), 'homemini')
  })
  it('two songs don’t share a source', async () => {
    const w = world({ ready: true })
    await w.server.serve(1, null)
    w.set({ ready: false })
    assert.equal(await (await w.server.serve(2, null)).text(), 'local')
    assert.equal(w.server.sourceOf(1), 'homemini')
    assert.equal(w.server.sourceOf(2), 'local')
  })
})
