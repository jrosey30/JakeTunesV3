import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fetchHeadersWithin } from '../fetch-headers.ts'

describe('fetchHeadersWithin — body must outlive the header deadline', () => {
  it('returns a response whose body keeps flowing after the header timer would have fired', async () => {
    // Serve headers immediately, then drip the body for longer than the
    // header timeout. AbortSignal.timeout() would kill this body; our
    // helper must not.
    const server = await startDripServer({ headerDelayMs: 20, bodyDurationMs: 250, chunkMs: 40 })
    try {
      const res = await fetchHeadersWithin(server.url, undefined, 80)
      assert.equal(res.status, 200)
      const text = await res.text()
      assert.ok(text.length > 0, 'body was empty — header timer likely aborted the stream')
      assert.match(text, /chunk/, 'body did not contain dripped chunks')
    } finally {
      await server.close()
    }
  })

  it('still aborts when headers themselves never arrive', async () => {
    const server = await startDripServer({ headerDelayMs: 400, bodyDurationMs: 0, chunkMs: 0 })
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

async function startDripServer(opts: {
  headerDelayMs: number
  bodyDurationMs: number
  chunkMs: number
}): Promise<{ url: string; close: () => Promise<void> }> {
  const { createServer } = await import('node:http')
  const server = createServer(async (req, res) => {
    await delay(opts.headerDelayMs)
    if (opts.bodyDurationMs <= 0) {
      // Hang forever after... actually for header-never case we delay
      // headers past the timeout, so never write.
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    const endAt = Date.now() + opts.bodyDurationMs
    while (Date.now() < endAt) {
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
    close: () => new Promise((r, j) => server.close((e) => (e ? j(e) : r()))),
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
