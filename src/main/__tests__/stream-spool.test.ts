/**
 * Stream spool (2026-08-28) — the pins: a landed spool serves exact 206s
 * locally, a torn/short spool is NEVER served, failures cool down and fall
 * back to the live proxy, and the LRU cap evicts oldest-first.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtemp, writeFile, readFile, stat } from 'fs/promises'
import { spoolReady, ensureSpool, serveSpoolRange, enforceSpoolCap , spoolQueueState, spoolPaceFor } from '../stream-spool.ts'

const fakeAudio = (bytes: number) => Buffer.alloc(bytes, 7)

const fetchServing = (body: Buffer, headers: Record<string, string> = {}) => (async () => ({
  ok: true,
  headers: { get: (k: string) => ({ 'content-length': String(body.length), 'content-type': 'audio/flac', ...headers })[k.toLowerCase()] ?? null },
  body: new Blob([body]).stream(),
})) as unknown as typeof fetch

describe('ensureSpool → spoolReady', () => {
  test('downloads, lands, and reports ready with true byte count', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spool-'))
    const body = fakeAudio(50_000)
    ensureSpool(dir, 't1', 'http://hub/audio/1', fetchServing(body))
    await new Promise((r) => setTimeout(r, 300))
    const ready = await spoolReady(dir, 't1')
    assert.ok(ready, 'spool should have landed')
    assert.equal(ready.total, 50_000)
    assert.equal(ready.contentType, 'audio/flac')
    assert.equal((await readFile(ready.file)).length, 50_000)
  })

  test('a SHORT download never lands — torn spools are refused', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spool-'))
    const short = fakeAudio(10_000)
    ensureSpool(dir, 't2', 'http://hub/audio/2', fetchServing(short, { 'content-length': '99999' }))
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(await spoolReady(dir, 't2'), null)
  })

  test('a failed spool cools down instead of hammering', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spool-'))
    let calls = 0
    const failing = (async () => { calls++; throw new Error('down') }) as unknown as typeof fetch
    ensureSpool(dir, 't3', 'http://hub/audio/3', failing)
    await new Promise((r) => setTimeout(r, 150))
    ensureSpool(dir, 't3', 'http://hub/audio/3', failing)
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(calls, 1, 'second kick inside the cooldown must not refetch')
  })
})

describe('serveSpoolRange', () => {
  test('exact 206 with Content-Range; open-ended and bounded both correct', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spool-'))
    await writeFile(join(dir, 'x.done'), fakeAudio(1000))
    const ready = { file: join(dir, 'x.done'), contentType: 'audio/flac', total: 1000 }
    const r1 = serveSpoolRange(ready, 'bytes=100-199')
    assert.equal(r1.status, 206)
    assert.equal(r1.headers.get('Content-Range'), 'bytes 100-199/1000')
    assert.equal(r1.headers.get('Content-Length'), '100')
    const r2 = serveSpoolRange(ready, 'bytes=900-')
    assert.equal(r2.headers.get('Content-Range'), 'bytes 900-999/1000')
    const r3 = serveSpoolRange(ready, 'bytes=2000-')
    assert.equal(r3.status, 416)
    const r4 = serveSpoolRange(ready, null)
    assert.equal(r4.status, 200)
  })
})

describe('enforceSpoolCap', () => {
  test('oldest .done files evict past the cap; .part files untouched', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spool-'))
    await writeFile(join(dir, 'old.done'), fakeAudio(600))
    await writeFile(join(dir, 'old.meta.json'), '{}')
    await new Promise((r) => setTimeout(r, 30))
    await writeFile(join(dir, 'new.done'), fakeAudio(600))
    await writeFile(join(dir, 'keep.part.123'), fakeAudio(600))
    await enforceSpoolCap(dir, 1000)
    await assert.rejects(() => stat(join(dir, 'old.done')), 'oldest evicts')
    await stat(join(dir, 'new.done'))
    await stat(join(dir, 'keep.part.123'))
  })
})

test('a burst of tracks downloads one at a time, newest first', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jt-spool-burst-'))
  const started: string[] = []
  const finish = new Map<string, () => void>()

  // A fetch that never resolves until the test releases it, so we can see
  // exactly how many downloads are allowed to run at once.
  const fetchFn = (async (url: string) => {
    const id = String(url).split('/').pop() as string
    started.push(id)
    await new Promise<void>((resolve) => finish.set(id, resolve))
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'audio/mp4', 'content-length': '3' },
    })
  }) as unknown as typeof fetch

  for (const id of ['a', 'b', 'c', 'd']) ensureSpool(dir, id, `http://h/${id}`, fetchFn)
  await new Promise((r) => setTimeout(r, 20))

  // The whole point: a burst must not put the link into four-way contention.
  assert.equal(started.length, 1, 'only one download may run at a time')
  assert.equal(started[0], 'a', 'a lone request never waits — it takes the free slot')
  assert.equal(spoolQueueState().active, 1)
  assert.equal(spoolQueueState().waiting, 3)

  // The backlog drains NEWEST first: by the time a slot frees, the track the
  // listener is on is the one most recently asked for, not the stalest.
  finish.get('a')!()
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(started.length, 2)
  assert.equal(started[1], 'd', 'newest interest wins the freed slot')

  // Release every waiter as its turn comes (c, then b) — the spool queue is
  // module state, so a download left hanging here would block later tests.
  for (let round = 0; round < 4; round++) {
    for (const [, f] of finish) f()
    await new Promise((r) => setTimeout(r, 30))
  }
  assert.deepEqual(spoolQueueState(), { active: 0, waiting: 0 })
})

// Thin-link pacing (workmini 2026-10-19: one wire-speed spool held the
// office↔home tunnel at 0.5–2 s round trips; quit → ~60 ms). The pace is an
// AVERAGE held between Range requests (range-chunk-download.test.ts covers
// the mechanism); these pin the spool's side of it.
describe('thin-link spool pacing', () => {
  /** A homemini-shaped /audio: honours Range with 206 + Content-Range. */
  const rangeServing = (body: Buffer, seen: string[]) => (async (_url: string, init?: RequestInit) => {
    const range = new Headers(init?.headers).get('range')
    seen.push(range ?? '(none)')
    const m = /^bytes=(\d+)-(\d+)$/.exec(range ?? '')
    if (!m) return new Response(body, { status: 200, headers: { 'content-type': 'audio/mp4', 'content-length': String(body.length) } })
    const start = Number(m[1]), end = Math.min(Number(m[2]), body.length - 1)
    return new Response(body.subarray(start, end + 1), {
      status: 206,
      headers: { 'content-type': 'audio/mp4', 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${body.length}` },
    })
  }) as unknown as typeof fetch

  test('a 256 kbps link spools at 3× its stream rate (96 KB/s)', () => {
    assert.equal(spoolPaceFor(256), 96_000)
  })

  test('a paced spool lands byte-identical through sequential Range chunks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spool-ranged-'))
    const body = Buffer.from(Array.from({ length: 2_500_000 }, (_, i) => (i * 7) % 251))
    const seen: string[] = []
    ensureSpool(dir, 'ranged', 'http://hub/audio/r', rangeServing(body, seen), 20_000_000)
    let ready = null
    for (let i = 0; i < 200 && !ready; i++) { await new Promise((r) => setTimeout(r, 10)); ready = await spoolReady(dir, 'ranged') }
    assert.ok(ready, 'ranged spool landed')
    assert.equal(ready.contentType, 'audio/mp4')
    assert.ok((await readFile(ready.file)).equals(body))
    // 20 MB/s → 1 MiB requests: three of them, in order, no gaps or overlaps.
    assert.deepEqual(seen, ['bytes=0-1048575', 'bytes=1048576-2097151', 'bytes=2097152-2499999'])
  })

  test('a paced spool against a server without Range support still lands (one 200)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spool-paced-'))
    const body = Buffer.from(Array.from({ length: 40_000 }, (_, i) => i % 251))
    ensureSpool(dir, 'paced', 'http://hub/audio/p', fetchServing(body), 20_000_000)
    let ready = null
    for (let i = 0; i < 100 && !ready; i++) { await new Promise((r) => setTimeout(r, 10)); ready = await spoolReady(dir, 'paced') }
    assert.ok(ready, 'paced spool landed')
    assert.ok((await readFile(ready.file)).equals(body))
  })

  test('fat link (0): one plain request, no Range header — exactly as before', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spool-fat-'))
    const body = Buffer.alloc(30_000, 3)
    const seen: string[] = []
    ensureSpool(dir, 'fat', 'http://hub/audio/f', rangeServing(body, seen), 0)
    let ready = null
    for (let i = 0; i < 100 && !ready; i++) { await new Promise((r) => setTimeout(r, 10)); ready = await spoolReady(dir, 'fat') }
    assert.ok(ready, 'fat-link spool landed')
    assert.deepEqual(seen, ['(none)'])
  })
})
