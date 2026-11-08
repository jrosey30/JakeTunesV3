/**
 * Bringing iPod songs back to this Mac (2026-11-08): the queue's order, the
 * disk floor, homemini down, music playing, and a download that resumes.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  fetchResumable, planPrefetch, prefetchLogLine, runPrefetchPass, verifyFetched,
  type FetchOneResult, type LocalKind, type PrefetchItem,
} from '../ipod-prefetch.ts'

const GB = 1024 ** 3
const colon = (id: number) => `:iPod_Control:Music:F01:imported_${id}.m4a`
const item = (id: number, bytes = 50e6): PrefetchItem => ({ id, colon: colon(id), bytes })

describe('planPrefetch', () => {
  it('keeps the keep set’s order, skips songs on this Mac and songs not in the library', async () => {
    const tracks = [1, 2, 3, 4].map((id) => ({ id, path: colon(id), fileSize: id * 1000, audioFingerprint: `sha1:${id}` }))
    const kinds: Record<string, LocalKind> = { [colon(1)]: 'local', [colon(2)]: 'streamed', [colon(3)]: 'missing', [colon(4)]: 'missing' }
    const plan = await planPrefetch([4, 1, 99, 2, 3, 2], tracks, async (c) => kinds[c], new Map([[colon(2), 'ab'.repeat(20)]]))
    assert.equal(plan.total, 4)
    assert.equal(plan.local, 1)
    assert.deepEqual(plan.items.map((i) => i.id), [4, 2, 3])
    assert.equal(plan.neededBytes, 9000)
    assert.equal(plan.items[1].fullSha1, 'ab'.repeat(20))
    assert.equal(plan.items[0].fingerprint, 'sha1:4')
  })
})

describe('runPrefetchPass', () => {
  const base = {
    reachable: async () => true,
    isPlaying: () => false,
    freeBytes: async () => 100 * GB,
  }

  it('fetches one at a time, in order', async () => {
    const order: number[] = []
    let inFlight = 0
    const r = await runPrefetchPass({
      ...base,
      items: [item(3), item(1), item(2)],
      fetchOne: async (i): Promise<FetchOneResult> => {
        inFlight++
        assert.equal(inFlight, 1, 'never two at once')
        await new Promise((res) => setTimeout(res, 5))
        order.push(i.id)
        inFlight--
        return { ok: true, bytes: 10 }
      },
    })
    assert.deepEqual(order, [3, 1, 2])
    assert.equal(r.fetched, 3)
    assert.equal(r.stoppedBecause, null)
  })

  it('stops at the disk floor and says how much is left', async () => {
    let free = 10 * GB + 180e6   // each 50 MB song needs 100 MB over the floor (counted twice): room for two
    const fetched: number[] = []
    const r = await runPrefetchPass({
      ...base,
      freeBytes: async () => free,
      items: [item(1), item(2), item(3)],
      fetchOne: async (i) => { fetched.push(i.id); free -= i.bytes; return { ok: true, bytes: i.bytes } },
    })
    assert.deepEqual(fetched, [1, 2])
    assert.match(String(r.stoppedBecause), /^not enough room on this Mac: free disk would drop below 10\.0 GB/)
    assert.equal(r.left, 1)
    assert.equal(r.leftBytes, 50e6)
    assert.match(prefetchLogLine({ total: 10, local: 7 }, r), /9 on this Mac · fetched 2 .* 1 still to fetch \(0\.0 GB\) · stopped: not enough room/)
  })

  it('an unreadable free-space answer fetches nothing', async () => {
    const r = await runPrefetchPass({ ...base, freeBytes: async () => { throw new Error('statfs') }, items: [item(1)], fetchOne: async () => assert.fail('no fetch') })
    assert.match(String(r.stoppedBecause), /not enough room/)
  })

  it('homemini down: skipped, nothing fetched', async () => {
    const r = await runPrefetchPass({ ...base, reachable: async () => false, items: [item(1), item(2)], fetchOne: async () => assert.fail('no fetch') })
    assert.equal(r.stoppedBecause, 'homemini isn’t answering')
    assert.equal(r.left, 2)
  })

  it('music playing: nothing starts; music starting mid-song stops the pass', async () => {
    const quiet = await runPrefetchPass({ ...base, isPlaying: () => true, items: [item(1)], fetchOne: async () => assert.fail('no fetch') })
    assert.equal(quiet.stoppedBecause, 'music is playing')
    const r = await runPrefetchPass({ ...base, items: [item(1), item(2)], fetchOne: async () => ({ ok: false, error: 'stopped', stopped: true }) })
    assert.equal(r.stoppedBecause, 'music started playing')
    assert.equal(r.left, 2)
    assert.equal(r.failed.length, 0)
  })

  it('a bad song is skipped; homemini dropping three in a row ends the pass', async () => {
    const r = await runPrefetchPass({
      ...base,
      items: [1, 2, 3, 4, 5].map((id) => item(id)),
      fetchOne: async (i) => i.id === 1 ? { ok: false, error: 'its fingerprint doesn’t match' } : { ok: false, error: 'reset', transport: true },
    })
    assert.equal(r.stoppedBecause, 'homemini stopped answering')
    assert.deepEqual(r.failed.map((f) => f.id), [1, 2, 3, 4])
    assert.equal(r.left, 5)
  })
})

describe('fetchResumable against a homemini-shaped server', () => {
  const body = Buffer.alloc(3 * 1024 * 1024)
  for (let i = 0; i < body.length; i++) body[i] = (i * 31 + 7) & 0xff
  let etag = '"v1"'
  let server: Server
  let url = ''
  const seen: Array<{ range?: string; ifRange?: string }> = []
  let dir = ''

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'jt-prefetch-'))
    server = createServer((req, res) => {
      const range = req.headers.range
      const ifRange = req.headers['if-range'] as string | undefined
      seen.push({ range, ifRange })
      const m = /^bytes=(\d+)-$/.exec(range || '')
      if (m && ifRange === etag) {
        const start = Number(m[1])
        res.writeHead(206, { 'Content-Range': `bytes ${start}-${body.length - 1}/${body.length}`, 'Content-Length': body.length - start, ETag: etag })
        res.end(body.subarray(start))
        return
      }
      res.writeHead(200, { 'Content-Length': body.length, ETag: etag })
      // Send in pieces so a stop can land mid-body.
      let off = 0
      const pump = (): void => {
        if (off >= body.length) { res.end(); return }
        res.write(body.subarray(off, off + 256 * 1024))
        off += 256 * 1024
        setTimeout(pump, 2)
      }
      pump()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const addr = server.address() as { port: number }
    url = `http://127.0.0.1:${addr.port}/audio/1`
  })
  after(async () => {
    server.closeAllConnections?.()
    await new Promise<void>((r) => server.close(() => r()))
    await rm(dir, { recursive: true, force: true })
  })

  it('a stop keeps the bytes; the next try asks for the rest and the file is whole', async () => {
    const part = join(dir, 'a.part')
    let chunks = 0
    const first = await fetchResumable({ url, partPath: part, fetchImpl: fetch, shouldStop: () => ++chunks > 3 })
    assert.equal(first.ok, false)
    assert.equal((first as { stopped?: boolean }).stopped, true)
    const kept = (await stat(part)).size
    assert.ok(kept > 0 && kept < body.length, `kept ${kept}`)
    seen.length = 0
    const second = await fetchResumable({ url, partPath: part, fetchImpl: fetch, shouldStop: () => false })
    assert.deepEqual(second, { ok: true, bytes: body.length })
    assert.deepEqual(seen, [{ range: `bytes=${kept}-`, ifRange: '"v1"' }])
    assert.ok((await readFile(part)).equals(body))
    const sha = createHash('sha1').update(body).digest('hex')
    assert.equal(await verifyFetched(part, { id: 1, colon: colon(1), bytes: body.length, fullSha1: sha }), null)
  })

  it('the file changed on homemini (new ETag): starts over instead of splicing', async () => {
    const part = join(dir, 'b.part')
    let chunks = 0
    await fetchResumable({ url, partPath: part, fetchImpl: fetch, shouldStop: () => ++chunks > 2 })
    etag = '"v2"'
    seen.length = 0
    const again = await fetchResumable({ url, partPath: part, fetchImpl: fetch, shouldStop: () => false })
    assert.deepEqual(again, { ok: true, bytes: body.length })
    assert.equal(seen[0].ifRange, '"v1"', 'asked with the old tag; the server answered the whole file')
    assert.ok((await readFile(part)).equals(body))
    etag = '"v1"'
  })

  it('identity: a wrong sha1 or fingerprint is refused; the right fingerprint passes', async () => {
    const part = join(dir, 'c.part')
    await writeFile(part, body)
    assert.match(String(await verifyFetched(part, { id: 1, colon: colon(1), bytes: 1, fullSha1: '0'.repeat(40) })), /sha1/)
    const fp = `sha1:${createHash('sha1').update(body.subarray(0, 256 * 1024)).digest('hex').slice(0, 16)}|1`
    assert.equal(await verifyFetched(part, { id: 1, colon: colon(1), bytes: 1, fingerprint: fp }), null)
    assert.match(String(await verifyFetched(part, { id: 1, colon: colon(1), bytes: 1, fingerprint: 'sha1:0000000000000000|1' })), /fingerprint/)
  })

  it('homemini unreachable is a transport failure, nothing written', async () => {
    const part = join(dir, 'd.part')
    const r = await fetchResumable({ url: 'http://127.0.0.1:1/audio/1', partPath: part, fetchImpl: fetch, shouldStop: () => false })
    assert.equal(r.ok, false)
    assert.equal((r as { transport?: boolean }).transport, true)
    await assert.rejects(stat(part))
  })
})
