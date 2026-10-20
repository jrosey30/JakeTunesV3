/**
 * Range-chunk downloads (2026-10-19) — the replacement for receive-side
 * pacing. workmini, same evening: the 2.9 MB cover aa82bc48… came down 3/3
 * at full speed, but read at 96 KB/s it failed 2 of 3 at ~30.7 s with
 * UND_ERR_SOCKET. These pin the new mechanism: sequential ranges read at
 * wire speed, the average held by sleeping BETWEEN requests, a 200 fallback,
 * resume at the exact byte, abort cleanup, and a verified final size.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import {
  downloadInRangeChunks, fetchInRangeChunks, chunkBytesFor, parseContentRange, RangeHttpError,
  CHUNK_MIN_BYTES, CHUNK_MAX_BYTES,
} from '../range-chunk-download.ts'

const fileOf = (n: number): Buffer => Buffer.from(Array.from({ length: n }, (_, i) => (i * 31 + 7) % 251))

interface Served { range: string | null; at: number }

/** A homemini-shaped server: 206 + Content-Range for `bytes=a-b`, 200 otherwise.
 *  `tweak(k, start, end)` can replace response k (0-based) for fault cases. */
function rangeServer(body: Buffer, served: Served[], clock: () => number = () => 0, tweak?: (k: number, start: number, end: number) => Response | null): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const range = new Headers(init?.headers).get('range')
    const k = served.length
    served.push({ range, at: clock() })
    const m = /^bytes=(\d+)-(\d+)$/.exec(range ?? '')
    if (!m) return new Response(body, { status: 200, headers: { 'content-type': 'audio/mp4', 'content-length': String(body.length) } })
    const start = Number(m[1]), end = Math.min(Number(m[2]), body.length - 1)
    const t = tweak?.(k, start, end)
    if (t) return t
    return new Response(body.subarray(start, end + 1), {
      status: 206,
      headers: { 'content-type': 'audio/mp4', 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${body.length}` },
    })
  }) as unknown as typeof fetch
}

const fakeClock = () => {
  let t = 1_000
  return { now: () => t, sleep: async (ms: number) => { t += ms }, at: () => t }
}

const collect = () => {
  const parts: Uint8Array[] = []
  return { sink: (c: Uint8Array) => { parts.push(c) }, bytes: () => Buffer.concat(parts) }
}

describe('chunk size', () => {
  test('about a second of the budget, 256 KiB–1 MiB', () => {
    assert.equal(chunkBytesFor(96_000), CHUNK_MIN_BYTES, 'daytime thin link: 256 KiB')
    assert.equal(chunkBytesFor(1_000_000), 1_000_000, 'night pace: ~1 MB')
    assert.equal(chunkBytesFor(20_000_000), CHUNK_MAX_BYTES)
    assert.equal(chunkBytesFor(0), CHUNK_MAX_BYTES)
  })

  test('Content-Range parsing', () => {
    assert.deepEqual(parseContentRange('bytes 0-262143/4785323'), { start: 0, end: 262143, total: 4785323 })
    assert.equal(parseContentRange('bytes 0-9/*'), null)
    assert.equal(parseContentRange('bytes */100'), null)
    assert.equal(parseContentRange(null), null)
    assert.equal(parseContentRange('bytes 5-4/10'), null)
  })
})

describe('fetchInRangeChunks', () => {
  test('requests sequential, contiguous ranges; the total comes from Content-Range', async () => {
    const body = fileOf(1_000_000)
    const served: Served[] = []
    const out = collect()
    const clock = fakeClock()
    const got = await fetchInRangeChunks('http://hub/audio/1', out.sink, {
      fetchFn: rangeServer(body, served), bytesPerSec: 96_000, now: clock.now, sleep: clock.sleep,
    })
    const C = CHUNK_MIN_BYTES
    assert.deepEqual(served.map((s) => s.range), [
      `bytes=0-${C - 1}`, `bytes=${C}-${2 * C - 1}`, `bytes=${2 * C}-${3 * C - 1}`, `bytes=${3 * C}-999999`,
    ])
    assert.ok(out.bytes().equals(body), 'bytes land in order, unchanged')
    assert.equal(got.total, 1_000_000)
    assert.equal(got.bytes, 1_000_000)
    assert.equal(got.ranged, true)
    assert.equal(got.requests, 4)
    assert.equal(got.contentType, 'audio/mp4')
  })

  test('the average holds at the target rate on a fake clock (waits are BETWEEN requests)', async () => {
    const body = fileOf(2_000_000)
    const clock = fakeClock()
    const served: Served[] = []
    const t0 = clock.at()
    const got = await fetchInRangeChunks('http://hub/a', collect().sink, {
      fetchFn: rangeServer(body, served, clock.now), bytesPerSec: 96_000, now: clock.now, sleep: clock.sleep,
    })
    // Request k starts exactly at its share of the budget: offset / rate.
    for (const s of served) {
      const from = Number(/^bytes=(\d+)-/.exec(s.range ?? '')![1])
      assert.ok(Math.abs(s.at - t0 - (from / 96_000) * 1000) < 1e-6, `request at byte ${from} started at +${s.at - t0} ms`)
    }
    // And the leftover share of the LAST chunk is owed to the caller.
    const elapsed = clock.at() - t0 + got.paceDebtMs
    assert.ok(Math.abs(elapsed - (2_000_000 / 96_000) * 1000) <= 1, `2 MB at 96 KB/s ≈ 20.8 s, got ${elapsed} ms`)
  })

  test('a link slower than the pace is never made to wait', async () => {
    const body = fileOf(600_000)
    let t = 0
    const waits: number[] = []
    // Every body chunk takes 5 s of fake time to read — far slower than 96 KB/s.
    await fetchInRangeChunks('http://hub/slow', () => { t += 5_000 }, {
      fetchFn: rangeServer(body, []), bytesPerSec: 96_000, now: () => t, sleep: async (ms) => { waits.push(ms); t += ms },
    })
    assert.deepEqual(waits, [])
  })

  test('a 200 (no Range support) falls back to one whole-file request, and reports the pace debt', async () => {
    const body = fileOf(2_939_437)   // aa82bc48…: homemini's /artwork ignores Range
    const clock = fakeClock()
    const served: Served[] = []
    const server = (async (_u: string, init?: RequestInit) => {
      served.push({ range: new Headers(init?.headers).get('range'), at: clock.now() })
      return new Response(body, { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': String(body.length) } })
    }) as unknown as typeof fetch
    const out = collect()
    const got = await fetchInRangeChunks('http://hub/artwork/x', out.sink, { fetchFn: server, bytesPerSec: 96_000, now: clock.now, sleep: clock.sleep })
    assert.equal(served.length, 1, 'one request — the 200 IS the file')
    assert.equal(got.ranged, false)
    assert.ok(out.bytes().equals(body))
    // Arrived "instantly" (wire speed): the whole 30.6 s share is owed before the next download.
    assert.equal(got.paceDebtMs, Math.round((body.length / 96_000) * 1000))
  })

  test('bytesPerSec 0: one plain request, no Range header, no debt (fat links)', async () => {
    const body = fileOf(700_000)
    const served: Served[] = []
    const got = await fetchInRangeChunks('http://hub/fat', collect().sink, { fetchFn: rangeServer(body, served), bytesPerSec: 0 })
    assert.deepEqual(served.map((s) => s.range), [null])
    assert.equal(got.bytes, 700_000)
    assert.equal(got.paceDebtMs, 0)
  })

  test('a dropped request resumes at the exact byte it reached', async () => {
    const body = fileOf(800_000)
    const served: Served[] = []
    const C = CHUNK_MIN_BYTES
    // Request 1 (the second chunk) sends 1,000 bytes and then the socket dies.
    const tweak = (k: number, start: number, end: number): Response | null => {
      if (k !== 1) return null
      let pulls = 0
      const rs = new ReadableStream<Uint8Array>({
        pull(c) { if (pulls++ === 0) c.enqueue(new Uint8Array(body.subarray(start, start + 1000))); else c.error(new TypeError('terminated')) },
      })
      return new Response(rs, { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${body.length}` } })
    }
    const clock = fakeClock()
    const out = collect()
    const got = await fetchInRangeChunks('http://hub/drop', out.sink, {
      fetchFn: rangeServer(body, served, clock.now, tweak), bytesPerSec: 96_000, now: clock.now, sleep: clock.sleep,
    })
    assert.deepEqual(served.map((s) => s.range).slice(0, 3), [`bytes=0-${C - 1}`, `bytes=${C}-${2 * C - 1}`, `bytes=${C + 1000}-${2 * C - 1}`])
    assert.ok(out.bytes().equals(body), 'the stitched file is byte-identical')
    assert.equal(got.bytes, body.length)
  })

  test('a chunk that keeps failing gives up after its attempts; 5xx retried, 4xx not', async () => {
    const body = fileOf(600_000)
    const clock = fakeClock()
    const served: Served[] = []
    const always503 = (k: number): Response | null => (k >= 1 ? new Response('busy', { status: 503 }) : null)
    await assert.rejects(
      fetchInRangeChunks('http://hub/5xx', collect().sink, { fetchFn: rangeServer(body, served, clock.now, always503), bytesPerSec: 96_000, now: clock.now, sleep: clock.sleep }),
      (e: unknown) => e instanceof RangeHttpError && e.status === 503,
    )
    assert.equal(served.length, 4, 'first chunk + 3 attempts at the second')
    const served404: Served[] = []
    await assert.rejects(
      fetchInRangeChunks('http://hub/404', collect().sink, { fetchFn: rangeServer(body, served404, clock.now, () => new Response('nf', { status: 404 })), bytesPerSec: 96_000, now: clock.now, sleep: clock.sleep }),
      (e: unknown) => e instanceof RangeHttpError && e.status === 404,
    )
    assert.equal(served404.length, 1, 'a 404 is an answer, not a blip')
  })

  test('the file changing mid-download (total moves) fails instead of stitching two files', async () => {
    const body = fileOf(600_000)
    const tweak = (k: number, start: number, end: number): Response | null => (k === 1
      ? new Response(body.subarray(start, end + 1), { status: 206, headers: { 'content-range': `bytes ${start}-${end}/700000` } })
      : null)
    const clock = fakeClock()
    await assert.rejects(
      fetchInRangeChunks('http://hub/changed', collect().sink, { fetchFn: rangeServer(body, [], clock.now, tweak), bytesPerSec: 96_000, now: clock.now, sleep: clock.sleep }),
      /file changed mid-download/,
    )
  })

  test('a server that stops honouring Range mid-download is refused', async () => {
    const body = fileOf(600_000)
    const tweak = (k: number): Response | null => (k === 1 ? new Response(body, { status: 200 }) : null)
    const clock = fakeClock()
    await assert.rejects(
      fetchInRangeChunks('http://hub/flip', collect().sink, { fetchFn: rangeServer(body, [], clock.now, tweak), bytesPerSec: 96_000, now: clock.now, sleep: clock.sleep }),
      /range support vanished/,
    )
  })

  test('maxBytes refuses an oversized file from its Content-Range, before reading it', async () => {
    const body = fileOf(600_000)
    const served: Served[] = []
    const clock = fakeClock()
    await assert.rejects(
      fetchInRangeChunks('http://hub/big', collect().sink, { fetchFn: rangeServer(body, served), bytesPerSec: 96_000, maxBytes: 500_000, now: clock.now, sleep: clock.sleep }),
      /oversized/,
    )
    assert.equal(served.length, 1)
  })

  test('onFirstResponse can refuse the download (the mirror\'s content-type gate)', async () => {
    const body = fileOf(1000)
    await assert.rejects(
      fetchInRangeChunks('http://hub/x', collect().sink, {
        fetchFn: rangeServer(body, []), bytesPerSec: 96_000,
        onFirstResponse: ({ contentType }) => { if (!contentType.startsWith('image/')) throw new Error(`HTTP 206 ${contentType}`) },
      }),
      /HTTP 206 audio\/mp4/,
    )
  })

  test('a body that goes silent mid-chunk is cut by the stall guard and resumed', async () => {
    const body = fileOf(300_000)
    const served: Served[] = []
    const tweak = (k: number, start: number, end: number): Response | null => (k === 1
      ? new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(body.subarray(start, start + 10))) } }), { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${body.length}` } })
      : null)
    const got = await fetchInRangeChunks('http://hub/stall', collect().sink, {
      fetchFn: rangeServer(body, served, Date.now, tweak), bytesPerSec: 50_000_000, chunkBytes: 200_000, stallMs: 30, retryDelayMs: 1,
    })
    assert.equal(got.bytes, body.length)
    assert.deepEqual(served.map((s) => s.range), ['bytes=0-199999', 'bytes=200000-299999', 'bytes=200010-299999'])
  })
})

describe('downloadInRangeChunks (to a .part file)', () => {
  test('lands the file and verifies its size on disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rcd-'))
    const body = fileOf(900_000)
    const clock = fakeClock()
    const dest = join(dir, 'x.part')
    const got = await downloadInRangeChunks('http://hub/x', dest, { fetchFn: rangeServer(body, []), bytesPerSec: 96_000, now: clock.now, sleep: clock.sleep })
    assert.equal(got.bytes, 900_000)
    assert.ok((await readFile(dest)).equals(body))
  })

  test('a short whole-file body is refused and its .part removed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rcd-short-'))
    const short = (async () => new Response(fileOf(10_000), { status: 200, headers: { 'content-length': '99999' } })) as unknown as typeof fetch
    await assert.rejects(downloadInRangeChunks('http://hub/s', join(dir, 's.part'), { fetchFn: short, bytesPerSec: 0 }))
    assert.deepEqual(await readdir(dir), [])
  })

  test('a ranged download whose last chunk never completes is refused and its .part removed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rcd-trunc-'))
    const body = fileOf(600_000)
    // Every attempt at chunk 2 ends cleanly but 100 bytes short.
    const tweak = (k: number, start: number, end: number): Response | null => (k >= 2
      ? new Response(body.subarray(start, end - 99), { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${body.length}` } })
      : null)
    const clock = fakeClock()
    await assert.rejects(
      downloadInRangeChunks('http://hub/t', join(dir, 't.part'), { fetchFn: rangeServer(body, [], clock.now, tweak), bytesPerSec: 96_000, now: clock.now, sleep: clock.sleep }),
      /ended early/,
    )
    assert.deepEqual(await readdir(dir), [])
  })

  test('abort mid-chunk: rejects promptly and the .part is gone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rcd-abort-'))
    const body = fileOf(900_000)
    const ac = new AbortController()
    // The second chunk's body sends a little, then hangs until aborted.
    const tweak = (k: number, start: number, end: number): Response | null => {
      if (k !== 1) return null
      setTimeout(() => ac.abort(), 20)
      const rs = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(body.subarray(start, start + 500))) } })
      return new Response(rs, { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${body.length}` } })
    }
    const t0 = Date.now()
    await assert.rejects(downloadInRangeChunks('http://hub/a', join(dir, 'a.part'), {
      fetchFn: rangeServer(body, [], Date.now, tweak), bytesPerSec: 50_000_000, chunkBytes: 200_000, signal: ac.signal,
    }))
    assert.ok(Date.now() - t0 < 2_000, 'abort is not held up by a hung body')
    assert.deepEqual(await readdir(dir), [])
  })

  test('abort during the wait between requests: rejects and the .part is gone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rcd-abort-sleep-'))
    const body = fileOf(900_000)
    const ac = new AbortController()
    const served: Served[] = []
    // The wait after chunk 1 never ends on its own; only the abort ends it.
    setTimeout(() => ac.abort(), 30)
    const t0 = Date.now()
    await assert.rejects(downloadInRangeChunks('http://hub/w', join(dir, 'w.part'), {
      fetchFn: rangeServer(body, served), bytesPerSec: 96_000, signal: ac.signal, sleep: () => new Promise<void>(() => {}),
    }))
    assert.ok(Date.now() - t0 < 1_000, 'the sleep between requests is abortable')
    assert.equal(served.length, 1)
    assert.deepEqual(await readdir(dir), [])
  })
})
