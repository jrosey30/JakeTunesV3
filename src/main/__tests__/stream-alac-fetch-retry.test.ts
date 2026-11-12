/**
 * The raw download for a streamed ALAC song rides out a homemini restart
 * (2026-11-10 13:31:42Z: five plays failed with "fetch failed" as a deploy landed).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStreamAlacCache, downloadUrlToFile, RAW_FETCH_RETRY_WAITS_MS } from '../stream-alac-cache.ts'

async function inTmp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'alac-retry-'))
  try { await fn(dir) } finally { await rm(dir, { recursive: true, force: true }) }
}

describe('downloadUrlToFile', () => {
  it('refused twice (a restart), then answered: the file lands', async () => inTmp(async (dir) => {
    let calls = 0
    const sleeps: number[] = []
    await downloadUrlToFile('http://h/audio/1', join(dir, 'a'), async () => {
      calls++
      if (calls <= 2) throw new TypeError('fetch failed')
      return new Response('alac-bytes')
    }, { sleep: async (ms) => { sleeps.push(ms) } })
    assert.equal(calls, 3)
    assert.deepEqual(sleeps, RAW_FETCH_RETRY_WAITS_MS.slice(0, 2))
    assert.equal(await readFile(join(dir, 'a'), 'utf8'), 'alac-bytes')
  }))
  it('a 503 is retried like a refusal', async () => inTmp(async (dir) => {
    let calls = 0
    await downloadUrlToFile('http://h/audio/1', join(dir, 'a'), async () => (++calls === 1 ? new Response('busy', { status: 503 }) : new Response('ok')), { sleep: async () => {} })
    assert.equal(calls, 2)
  }))
  it('still refused after every wait: the original error, not a hang', async () => inTmp(async (dir) => {
    let calls = 0
    await assert.rejects(downloadUrlToFile('http://h/audio/1', join(dir, 'a'), async () => { calls++; throw new TypeError('fetch failed') }, { sleep: async () => {} }), /fetch failed/)
    assert.equal(calls, RAW_FETCH_RETRY_WAITS_MS.length + 1)
  }))
  it('a 404 is an answer: asked once', async () => inTmp(async (dir) => {
    let calls = 0
    await assert.rejects(downloadUrlToFile('http://h/audio/1', join(dir, 'a'), async () => { calls++; return new Response('no', { status: 404 }) }, { sleep: async () => {} }), /alac fetch 404/)
    assert.equal(calls, 1)
  }))
})

describe('the decode cache says what it holds without downloading', () => {
  it('has() is false before a decode and true after, and never fetches', async () => inTmp(async (dir) => {
    let fetched = 0
    const cache = createStreamAlacCache({
      dir,
      fetchRaw: async (_id, dest) => { fetched++; const { writeFile } = await import('node:fs/promises'); await writeFile(dest, 'raw') },
      transcode: async (_src, tmp) => { const { writeFile } = await import('node:fs/promises'); await writeFile(tmp, 'flac') },
      log: () => {},
    })
    assert.equal(await cache.has(7), false)
    assert.equal(fetched, 0)
    await cache.ensure(7)
    assert.equal(await cache.has(7), true)
    assert.equal(fetched, 1)
  }))
})
