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
import { spoolReady, ensureSpool, serveSpoolRange, enforceSpoolCap } from '../stream-spool.ts'

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
