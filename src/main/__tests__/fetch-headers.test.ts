import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fetchHeadersWithin } from '../fetch-headers.ts'

describe('fetchHeadersWithin — body must outlive the header deadline', () => {
  it('returns a response whose body keeps flowing after the header timer would have fired', async () => {
    // Serve headers immediately, then drip the body until the test says
    // stop — and it only says stop once the header timer is long past.
    // AbortSignal.timeout() would kill this body; our helper must not.
    //
    // Nothing here races the clock under load. The old 20ms-vs-80ms margin
    // blocked the very first gated commit (2026-08-16); a fixed 300ms drip
    // against a 150ms deadline failed when two worktrees ran the gate at
    // once (2026-10-17) — the busy box missed the 150ms HEADER deadline.
    // So the deadline is generous and the test, not a timer, ends the body.
    const HEADER_MS = 1000
    const server = await startDripServer({ chunkMs: 40 })
    try {
      const t0 = Date.now()
      const res = await fetchHeadersWithin(server.url, undefined, HEADER_MS)
      assert.equal(res.status, 200)
      await delay(Math.max(0, t0 + HEADER_MS + 100 - Date.now()))   // the timer would have fired by now
      server.finish()
      const text = await res.text()
      assert.match(text, /chunk/, 'body did not contain dripped chunks')
      assert.ok(text.endsWith('done'), 'body was cut short — header timer likely aborted the stream')
    } finally {
      await server.close()
    }
  })

  it('still aborts when headers themselves never arrive', async () => {
    const server = await startDripServer({ chunkMs: 0, neverRespond: true })
    try {
      await assert.rejects(
        () => fetchHeadersWithin(server.url, undefined, 80),
        (err: unknown) => err instanceof Error && /abort/i.test(String(err)),
      )
    } finally {
      await server.close()
    }
  })
})

/** Headers at once, then 'chunk-' every chunkMs until finish() (or
 *  close()), then 'done'. neverRespond: accept and never answer. */
async function startDripServer(opts: {
  chunkMs: number
  neverRespond?: boolean
}): Promise<{ url: string; finish: () => void; close: () => Promise<void> }> {
  const { createServer } = await import('node:http')
  let finished = false
  const server = createServer(async (req, res) => {
    if (opts.neverRespond) return
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    while (!finished) {
      res.write('chunk-')
      await delay(opts.chunkMs)
    }
    res.end('done')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  return {
    url: `http://127.0.0.1:${addr.port}/audio`,
    finish: () => { finished = true },
    close: () => { finished = true; return new Promise((r, j) => server.close((e) => (e ? j(e) : r()))) },
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
