/**
 * Brief 161 — the stream-body inactivity budget.
 *
 * The failure being locked out: headers arrive, the body wedges, zero
 * bytes forever, and the track hangs with no error anywhere. The
 * wrapper must (a) pass a healthy stream through byte-for-byte, (b)
 * error a stalled stream shortly after the budget, and (c) never cut
 * a slow-but-alive stream whose gaps stay under the budget.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { withBodyInactivityTimeout } from '../stream-body-timeout.ts'

function streamOf(chunks: Uint8Array[], gapMs: number, stallAfter = false): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i >= chunks.length) {
        if (stallAfter) return // never enqueue, never close — the wedge
        controller.close()
        return
      }
      const chunk = chunks[i++]
      await new Promise((r) => setTimeout(r, gapMs))
      controller.enqueue(chunk)
    },
  })
}

async function collect(body: ReadableStream<Uint8Array>): Promise<number[]> {
  const reader = body.getReader()
  const out: number[] = []
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return out
    out.push(...value)
  }
}

describe('withBodyInactivityTimeout', () => {
  test('a healthy stream passes through untouched', async () => {
    const body = streamOf([new Uint8Array([1, 2]), new Uint8Array([3])], 5)
    const out = await collect(withBodyInactivityTimeout(body, 500))
    assert.deepEqual(out, [1, 2, 3])
  })

  test('a stalled body errors after the inactivity budget', async () => {
    const body = streamOf([new Uint8Array([9])], 1, true)
    let timeouts = 0
    const guarded = withBodyInactivityTimeout(body, 60, () => { timeouts++ })
    const reader = guarded.getReader()
    const first = await reader.read()
    assert.deepEqual([...(first.value ?? [])], [9])
    await assert.rejects(reader.read(), /no bytes for 60ms/)
    assert.equal(timeouts, 1, 'onTimeout fires exactly once')
  })

  test('gaps under the budget never cut a slow stream', async () => {
    // 40ms between chunks, 150ms budget: total transfer ~120ms and the
    // stream must complete — the timer is per-gap, not a total deadline.
    const body = streamOf([new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])], 40)
    const out = await collect(withBodyInactivityTimeout(body, 150))
    assert.deepEqual(out, [1, 2, 3])
  })

  test('a source error propagates instead of becoming a stall', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.error(new Error('source died')) },
    })
    await assert.rejects(collect(withBodyInactivityTimeout(body, 500)), /source died/)
  })
})
